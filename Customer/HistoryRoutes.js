const authenticateToken = require('../authMiddleware');

function registerHistoryRoutes(app, db) {

    // GET /api/appointments/mine — the logged-in patient's own appointments,
    // shaped for History.js's card + receipt-modal rendering. Deliberately a
    // different path from GET /api/appointments (registered in
    // Employee/BookingRequest.js for staff) rather than branching on role
    // inside that handler — Express only runs the first matching route for a
    // given path/method, so reusing the same path here would mean patient
    // requests never even reach a role check.
    app.get('/api/appointments/mine', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Only patients can view their own appointment history' });
        }

        try {
            const [rows] = await db.query(
                `SELECT
                     a.appointment_id,
                     s.label,
                     a.appointment_date,
                     a.time_slot,
                     a.created_at,
                     a.appointment_status,
                     a.dentist_note,
                     a.reschedule_status,
                     a.requested_date,
                     a.requested_time,
                     a.reschedule_reason,
                     pay.amount,
                     pay.method,
                     pay.status AS payment_status,
                     emp.first_name AS dentist_first_name,
                     emp.last_name  AS dentist_last_name,
                     u.public_id,
                     u.phone,
                     u.email,
                     pp.address
                 FROM appointments a
                          JOIN services s ON a.service_id = s.service_id
                          JOIN users u ON a.patient_id = u.user_id
                          JOIN patient_profiles pp ON a.patient_id = pp.patient_id
                          LEFT JOIN payments pay ON a.appointment_id = pay.appointment_id
                          LEFT JOIN users emp ON a.employee_id = emp.user_id
                 WHERE a.patient_id = ?
                 ORDER BY a.appointment_date DESC, a.time_slot DESC`,
                [req.user.user_id]
            );

            res.json(rows);
        } catch (err) {
            console.error('Load patient history error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // PUT /api/appointments/:id/cancel — patient cancels their own
    // still-pending appointment. Only allowed while pending, matching the
    // Cancel button only being shown for pending appointments in History.html.
    // Notifies every employee/admin, since there is no "receptionist" role
    // and employee_id is still NULL at this stage.
    app.put('/api/appointments/:id/cancel', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const appointmentId = req.params.id;
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

            if (apptRows[0].appointment_status !== 'pending') {
                await connection.rollback();
                return res.status(409).json({ message: 'Only pending appointments can be cancelled' });
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
                                  WHEN status = 'paid' THEN 'refunded'
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
                             'A patient has cancelled a pending appointment.', ?)`,
                    [member.user_id, appointmentId]
                );
            }

            await connection.commit();

            res.json({
                message: 'Appointment cancelled successfully',
                appointment_id: Number(appointmentId)
            });

        } catch (err) {
            if (connection) {
                await connection.rollback();
            }

            console.error('Cancel appointment error:', err);
            res.status(500).json({ message: 'Internal Server Error' });

        } finally {
            if (connection) {
                connection.release();
            }
        }
    });

    const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
    const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
    const RESCHEDULABLE_STATUSES = ['pending', 'approved'];

    // GET /api/appointments/occupied/mine — every time slot the current
    // patient already holds (across all their own non-cancelled
    // appointments). Used only by the reschedule calendar to stop a patient
    // from picking a slot they're already booked into themselves; it is not
    // a dentist-availability check (the reschedule flow doesn't pin a
    // dentist's schedule the way booking's /available-slots does — see
    // History.js's fixed `clinicSlots` list).
    app.get('/api/appointments/occupied/mine', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        try {
            const [rows] = await db.query(
                `SELECT appointment_id, appointment_date, time_slot
                 FROM appointments
                 WHERE patient_id = ? AND appointment_status != 'cancelled'`,
                [req.user.user_id]
            );

            res.json(rows);
        } catch (err) {
            console.error('Load occupied slots error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // PATCH /api/appointments/:id/request-reschedule — patient proposes a new
    // date/time. This only records the request; appointment_date/time_slot
    // are left untouched until staff review and approve it elsewhere, which
    // is why requested_date/requested_time are separate columns rather than
    // overwriting the confirmed schedule outright.
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
            return res.status(400).json({ message: 'A valid requested_time (HH:MM:SS) is required' });
        }
        if (!reschedule_reason || !reschedule_reason.trim()) {
            return res.status(400).json({ message: 'A reschedule reason is required' });
        }
        if (reschedule_reason.length > 255) {
            return res.status(400).json({ message: 'Reschedule reason is too long' });
        }

        const requestedDateTime = new Date(`${requested_date}T${requested_time}`);
        if (Number.isNaN(requestedDateTime.getTime()) || requestedDateTime <= new Date()) {
            return res.status(400).json({ message: 'Requested date and time must be in the future' });
        }

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

            if (!RESCHEDULABLE_STATUSES.includes(apptRows[0].appointment_status)) {
                await connection.rollback();
                return res.status(409).json({ message: 'Only pending or approved appointments can be rescheduled' });
            }

            await connection.query(
                `UPDATE appointments
                 SET reschedule_status = 'requested',
                     requested_date = ?,
                     requested_time = ?,
                     reschedule_reason = ?
                 WHERE appointment_id = ?`,
                [requested_date, requested_time, reschedule_reason.trim(), appointmentId]
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

            res.json({
                message: 'Your reschedule request has been submitted. Our clinic team will review and approve your request shortly.',
                appointment_id: Number(appointmentId)
            });

        } catch (err) {
            if (connection) {
                await connection.rollback();
            }

            console.error('Request reschedule error:', err);
            res.status(500).json({ message: 'Internal Server Error' });

        } finally {
            if (connection) {
                connection.release();
            }
        }
    });
}

module.exports = registerHistoryRoutes;