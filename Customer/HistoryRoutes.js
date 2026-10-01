const authenticateToken = require('../authMiddleware');
const { logActivity } = require('../Admin/auditLogRoutes');

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}

const MAX_RESCHEDULE_LIMIT = 2; // Maximum allowed reschedules per appointment
const MAX_ADVANCE_MONTHS = 6;   // Maximum advance reschedule limit (6 months / 1 year)

function registerHistoryRoutes(app, db, io) {

    // ── 1. GET /api/appointments/mine — Patient's personal appointment history ──
    app.get('/api/appointments/mine', authenticateToken, async (req, res) => {
        await autoCancelExpiredAppointments(db, io);
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Only patients can view their own appointment history' });
        }

        try {
            const [rows] = await db.query(
                `SELECT
                     a.appointment_id,
                     s.service_id,
                     s.label,
                     a.appointment_date,
                     a.time_slot,
                     a.end_time AS end_time_slot,
                     a.created_at,
                     a.appointment_status,
                     a.dentist_note,
                     a.patient_note,
                     a.reschedule_status,
                     COALESCE(a.reschedule_count, 0) AS reschedule_count,
                     a.requested_date,
                     a.requested_time,
                     a.reschedule_reason,
                     pay.amount,
                     pay.method,
                     pay.status AS payment_status,
                     emp.user_id AS dentist_id,
                     emp.first_name AS dentist_first_name,
                     emp.last_name  AS dentist_last_name,
                     u.public_id,
                     u.first_name AS patient_first_name,
                     u.last_name  AS patient_last_name,
                     u.phone,
                     u.email,
                     pp.address
                 FROM appointments a
                          JOIN services s ON a.service_id = s.service_id
                          JOIN users u ON a.patient_id = u.user_id
                          LEFT JOIN patient_profiles pp ON a.patient_id = pp.patient_id
                          LEFT JOIN payments pay ON a.appointment_id = pay.appointment_id
                          LEFT JOIN users emp ON a.employee_id = emp.user_id
                 WHERE a.patient_id = ?
                 ORDER BY a.created_at DESC, a.appointment_id DESC`,
                [req.user.user_id]
            );

            res.json(rows);
        } catch (err) {
            console.error('Load patient history error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 2. PUT /api/appointments/:id/cancel — Patient Cancels Appointment ──
    app.put('/api/appointments/:id/cancel', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const appointmentId = req.params.id;
        const { reason } = req.body;
        let connection;

        try {
            connection = await db.getConnection();
            await connection.beginTransaction();

            const [apptRows] = await connection.query(
                `SELECT patient_id, appointment_status
                 FROM appointments
                 WHERE appointment_id = ?
                     FOR UPDATE`,
                [appointmentId]
            );

            if (apptRows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ message: 'Appointment not found' });
            }

            if (Number(apptRows[0].patient_id) !== Number(req.user.user_id)) {
                await connection.rollback();
                return res.status(403).json({ message: 'Not authorized' });
            }

            if (apptRows[0].appointment_status !== 'pending' && apptRows[0].appointment_status !== 'approved') {
                await connection.rollback();
                return res.status(409).json({ message: 'Only active appointments can be cancelled' });
            }

            await connection.query(
                `UPDATE appointments
                 SET appointment_status = 'cancelled'
                 WHERE appointment_id = ?`,
                [appointmentId]
            );

            await connection.query(
                `UPDATE payments
                 SET status = CASE
                                  WHEN status = 'paid' THEN 'refund_pending'
                                  ELSE status
                     END
                 WHERE appointment_id = ?`,
                [appointmentId]
            );

            const [staff] = await connection.query(
                `SELECT user_id FROM users WHERE role IN ('employee', 'admin')`
            );

            for (const member of staff) {
                await connection.query(
                    `INSERT INTO notifications
                         (user_id, type, title, message, appointment_id)
                     VALUES (?, 'appointment_cancelled', 'Appointment Cancelled',
                             ?, ?)`,
                    [member.user_id, `A patient has cancelled an appointment.${reason ? ` Reason: ${reason}` : ''}`, appointmentId]
                );
            }

            await connection.commit();

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: 'patient',
                action: 'CANCEL_APPOINTMENT',
                target_table: 'appointments',
                target_id: Number(appointmentId),
                notes: `Cancelled by patient.${reason ? ' Reason: ' + reason : ''}`,
                ip_address: getIp(req)
            });

            if (io) {
                io.emit('appointment-updated', { appointment_id: Number(appointmentId) });
            }

            res.json({
                message: 'Appointment cancelled successfully',
                appointment_id: Number(appointmentId)
            });

        } catch (err) {
            if (connection) await connection.rollback();
            console.error('Cancel appointment error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            if (connection) connection.release();
        }
    });

    const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
    const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;
    const RESCHEDULABLE_STATUSES = ['pending', 'approved'];

    // ── 3. GET /api/appointments/occupied/mine ──
    app.get('/api/appointments/occupied/mine', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        try {
            const [rows] = await db.query(
                `SELECT appointment_id, appointment_date, time_slot, end_time AS end_time_slot
                 FROM appointments
                 WHERE appointment_status NOT IN ('cancelled', 'declined')`
            );
            res.json(rows);
        } catch (err) {
            console.error('Load occupied slots error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 4. PATCH /api/appointments/:id/request-reschedule ──
    app.patch('/api/appointments/:id/request-reschedule', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const appointmentId = req.params.id;
        const { requested_date, requested_time, reschedule_reason } = req.body;

        if (!requested_date || !DATE_PATTERN.test(requested_date)) {
            return res.status(400).json({ message: 'A valid requested_date (YYYY-MM-DD) is required' });
        }
        if (!requested_time || !TIME_PATTERN.test(requested_time)) {
            return res.status(400).json({ message: 'A valid requested_time (HH:MM:SS or HH:MM) is required' });
        }
        if (!reschedule_reason || !reschedule_reason.trim()) {
            return res.status(400).json({ message: 'A reschedule reason is required' });
        }

        // ⚠️ Enforce future date and max advance booking limit (6 months)
        const reschedDateTime = new Date(`${requested_date}T${requested_time}`);
        if (Number.isNaN(reschedDateTime.getTime()) || reschedDateTime <= new Date()) {
            return res.status(400).json({ message: 'Rescheduled appointments must be set for a future date and time' });
        }

        const maxAllowedDate = new Date();
        maxAllowedDate.setMonth(maxAllowedDate.getMonth() + MAX_ADVANCE_MONTHS);
        maxAllowedDate.setHours(23, 59, 59, 999);

        if (reschedDateTime > maxAllowedDate) {
            return res.status(400).json({ 
                message: `Rescheduling can only be requested up to ${MAX_ADVANCE_MONTHS} months in advance.` 
            });
        }

        let connection;

        try {
            connection = await db.getConnection();
            await connection.beginTransaction();

            const [apptRows] = await connection.query(
                `SELECT patient_id, appointment_status, reschedule_status, COALESCE(reschedule_count, 0) AS reschedule_count
                 FROM appointments
                 WHERE appointment_id = ?
                     FOR UPDATE`,
                [appointmentId]
            );

            if (apptRows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ message: 'Appointment not found' });
            }

            const appt = apptRows[0];

            if (Number(appt.patient_id) !== Number(req.user.user_id)) {
                await connection.rollback();
                return res.status(403).json({ message: 'Not authorized' });
            }

            if (!RESCHEDULABLE_STATUSES.includes(appt.appointment_status)) {
                await connection.rollback();
                return res.status(409).json({ message: 'Only pending or approved appointments can be rescheduled' });
            }

            // Enforce maximum 2 reschedules limit
            if (appt.reschedule_count >= MAX_RESCHEDULE_LIMIT && appt.reschedule_status !== 'requested') {
                await connection.rollback();
                return res.status(400).json({
                    message: `You have reached the maximum reschedule limit (${MAX_RESCHEDULE_LIMIT} times) for this appointment.`
                });
            }

            const normalizedTime = requested_time.length === 5 ? `${requested_time}:00` : requested_time;

            await connection.query(
                `UPDATE appointments
                 SET reschedule_status = 'requested',
                     requested_date = ?,
                     requested_time = ?,
                     reschedule_reason = ?
                 WHERE appointment_id = ?`,
                [requested_date, normalizedTime, reschedule_reason.trim(), appointmentId]
            );

            const [staff] = await connection.query(
                `SELECT user_id FROM users WHERE role IN ('employee', 'admin')`
            );

            for (const member of staff) {
                await connection.query(
                    `INSERT INTO notifications
                         (user_id, type, title, message, appointment_id)
                     VALUES (?, 'reschedule_requested', 'Reschedule Requested',
                             'A patient has requested to reschedule an appointment.', ?)`,
                    [member.user_id, appointmentId]
                );
            }

            await connection.commit();

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: 'patient',
                action: 'RESCHEDULE_REQUESTED',
                target_table: 'appointments',
                target_id: Number(appointmentId),
                notes: `Requested reschedule to ${requested_date} at ${requested_time}. Reason: ${reschedule_reason.trim()}`,
                ip_address: getIp(req)
            });

            if (io) {
                io.emit('appointment-updated', { appointment_id: Number(appointmentId) });
            }

            res.json({
                message: 'Your reschedule request has been submitted. Our clinic team will review and approve your request shortly.',
                appointment_id: Number(appointmentId)
            });

        } catch (err) {
            if (connection) await connection.rollback();
            console.error('Request reschedule error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            if (connection) connection.release();
        }
    });

    // ── 5. PATCH /api/appointments/:id/cancel-reschedule ──
    app.patch('/api/appointments/:id/cancel-reschedule', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const appointmentId = req.params.id;
        let connection;

        try {
            connection = await db.getConnection();
            await connection.beginTransaction();

            const [apptRows] = await connection.query(
                `SELECT patient_id, reschedule_status
                 FROM appointments
                 WHERE appointment_id = ?
                     FOR UPDATE`,
                [appointmentId]
            );

            if (apptRows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ message: 'Appointment not found' });
            }

            if (Number(apptRows[0].patient_id) !== Number(req.user.user_id)) {
                await connection.rollback();
                return res.status(403).json({ message: 'Not authorized' });
            }

            if (apptRows[0].reschedule_status !== 'requested') {
                await connection.rollback();
                return res.status(400).json({ message: 'No pending reschedule request to cancel.' });
            }

            await connection.query(
                `UPDATE appointments
                 SET reschedule_status = 'none',
                     requested_date = NULL,
                     requested_time = NULL,
                     reschedule_reason = NULL
                 WHERE appointment_id = ?`,
                [appointmentId]
            );

            await connection.commit();

            if (io) {
                io.emit('appointment-updated', { appointment_id: Number(appointmentId) });
            }

            res.json({ success: true, message: 'Reschedule request cancelled successfully.' });
        } catch (err) {
            if (connection) await connection.rollback();
            console.error('Cancel reschedule error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            if (connection) connection.release();
        }
    });

    // Automatically cancel past pending appointments
    async function autoCancelExpiredAppointments(db, io = null) {
        try {
            const [result] = await db.query(`
                UPDATE appointments
                SET appointment_status = 'cancelled',
                    patient_note = CONCAT(COALESCE(patient_note, ''), ' [System: Auto-cancelled due to expired schedule]')
                WHERE appointment_status = 'pending'
                  AND (
                      appointment_date < CURDATE()
                      OR (appointment_date = CURDATE() AND end_time < CURTIME())
                  )
            `);

            if (result.affectedRows > 0 && io) {
                io.emit('appointment-updated');
            }
        } catch (err) {
            console.error('Auto-cancel expired appointments error:', err);
        }
    }
}

module.exports = registerHistoryRoutes;