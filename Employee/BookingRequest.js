const authenticateToken = require('../authMiddleware');
const { logActivity } = require('../Admin/auditLogRoutes');

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}

function registerBookingRequestRoutes(app, db, io) {

    // ── 1. GET /api/appointments — Booking requests & approved appointments list ──
    app.get('/api/appointments', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { status } = req.query;

        try {
            let query = `
                SELECT 
                    a.appointment_id, 
                    a.appointment_status,
                    a.queue_status,
                    a.appointment_date, 
                    a.time_slot,
                    a.reschedule_status,
                    a.requested_date,
                    a.requested_time,
                    a.reschedule_reason,
                    a.patient_note,
                    a.dentist_note,
                    a.created_at,
                    u.user_id AS patient_id,
                    u.public_id, 
                    u.first_name, 
                    u.last_name,
                    u.email AS patient_email,
                    u.phone AS patient_phone,
                    s.service_id,
                    s.label AS service_label,
                    s.price AS service_price,
                    p.payment_id,
                    p.status AS payment_status,
                    p.method AS payment_method,
                    p.amount AS payment_amount,
                    doc.user_id AS dentist_id,
                    doc.first_name AS dentist_first_name,
                    doc.last_name AS dentist_last_name
                FROM appointments a
                JOIN users u ON a.patient_id = u.user_id
                JOIN services s ON a.service_id = s.service_id
                LEFT JOIN payments p ON a.appointment_id = p.appointment_id
                LEFT JOIN users doc ON a.employee_id = doc.user_id
            `;
            const params = [];

            // FIX: Check if status is NOT 'all'
            if (status && status !== 'all') {
                if (status === 'reschedule_requested') {
                    query += ' WHERE a.reschedule_status = \'requested\'';
                } else {
                    query += ' WHERE a.appointment_status = ?';
                    params.push(status);
                }
            }

            query += ' ORDER BY (a.reschedule_status = \'requested\') DESC, a.created_at DESC';

            const [rows] = await db.query(query, params);
            res.json(rows);
        } catch (err) {
            console.error('Load bookings error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 2. GET /api/appointments/occupied — Blocked/taken slots for calendar ──
    app.get('/api/appointments/occupied', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        try {
            const [rows] = await db.query(
                `SELECT appointment_id, appointment_date, time_slot
                 FROM appointments
                 WHERE appointment_status IN ('pending', 'approved')
                   AND appointment_date >= CURDATE()`
            );
            res.json(rows);
        } catch (err) {
            console.error('Load occupied slots error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 3. PATCH /api/appointments/:id/status — Accept or decline pending booking ──
    app.patch('/api/appointments/:id/status', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { appointment_status } = req.body;
        const validStatuses = ['approved', 'cancelled'];
        if (!validStatuses.includes(appointment_status)) {
            return res.status(400).json({ message: 'Invalid appointment_status value' });
        }

        const appointmentId = req.params.id;
        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            const [apptRows] = await connection.query(
                'SELECT patient_id, appointment_status FROM appointments WHERE appointment_id = ? FOR UPDATE',
                [appointmentId]
            );
            if (apptRows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ message: 'Appointment not found' });
            }

            if (appointment_status === 'approved') {
                await connection.query(
                    `UPDATE appointments 
                     SET appointment_status = 'approved', 
                         employee_id = COALESCE(employee_id, ?),
                         queue_status = 'pending'
                     WHERE appointment_id = ?`,
                    [req.user.user_id, appointmentId]
                );
            } else {
                await connection.query(
                    `UPDATE appointments 
                     SET appointment_status = 'cancelled' 
                     WHERE appointment_id = ?`,
                    [appointmentId]
                );
            }

            const notifTitle = appointment_status === 'approved' ? 'Appointment Approved' : 'Appointment Declined';
            const notifMessage = appointment_status === 'approved'
                ? 'Your appointment request has been approved and confirmed!'
                : 'Your appointment request has been declined. Please contact the clinic or choose a different slot.';

            await connection.query(
                `INSERT INTO notifications (user_id, type, title, message, appointment_id)
                 VALUES (?, 'appointment_status', ?, ?, ?)`,
                [apptRows[0].patient_id, notifTitle, notifMessage, appointmentId]
            );

            await connection.commit();

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: appointment_status === 'approved' ? 'APPROVE_APPOINTMENT' : 'CANCEL_APPOINTMENT',
                target_table: 'appointments',
                target_id: appointmentId,
                notes: appointment_status === 'approved' ? 'Booking request approved.' : 'Booking request declined.',
                ip_address: getIp(req)
            });

            // Real-time broadcast
            if (io) {
                io.emit('appointment-updated', { appointment_id: appointmentId, status: appointment_status });
            }

            res.json({ message: `Appointment ${appointment_status} successfully` });

        } catch (err) {
            await connection.rollback();
            console.error('Update appointment status error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });

    // ── 4. PATCH /api/appointments/:id/reschedule-review — Staff Decision on Reschedule Requests ──
    app.patch('/api/appointments/:id/reschedule-review', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const appointmentId = req.params.id;
        const { action, decline_reason } = req.body;

        if (!['approve', 'decline'].includes(action)) {
            return res.status(400).json({ message: 'Action must be "approve" or "decline"' });
        }

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            const [apptRows] = await connection.query(
                `SELECT appointment_id, patient_id, appointment_date, time_slot,
                        reschedule_status, requested_date, requested_time
                 FROM appointments
                 WHERE appointment_id = ? FOR UPDATE`,
                [appointmentId]
            );

            if (!apptRows.length) {
                await connection.rollback();
                return res.status(404).json({ message: 'Appointment not found' });
            }

            const appt = apptRows[0];
            if (appt.reschedule_status !== 'requested') {
                await connection.rollback();
                return res.status(400).json({ message: 'No active reschedule request for this appointment' });
            }

            if (action === 'approve') {
                // Check if requested slot is already taken by another confirmed booking
                const [conflict] = await connection.query(
                    `SELECT appointment_id FROM appointments
                     WHERE appointment_date = ? 
                       AND time_slot = ? 
                       AND appointment_status = 'approved'
                       AND appointment_id != ?`,
                    [appt.requested_date, appt.requested_time, appointmentId]
                );

                if (conflict.length > 0) {
                    await connection.rollback();
                    return res.status(409).json({
                        message: 'Requested slot is already booked by another confirmed patient. Please use "Pick Other Slot".'
                    });
                }

                // Move schedule to requested date and clear request flag
                await connection.query(
                    `UPDATE appointments 
                     SET appointment_date = requested_date,
                         time_slot = requested_time,
                         reschedule_status = 'approved',
                         requested_date = NULL,
                         requested_time = NULL,
                         reschedule_reason = NULL
                     WHERE appointment_id = ?`,
                    [appointmentId]
                );

                const notifMsg = `Your request to reschedule to ${appt.requested_date} at ${appt.requested_time} has been APPROVED!`;
                await connection.query(
                    `INSERT INTO notifications (user_id, type, title, message, appointment_id)
                     VALUES (?, 'reschedule_approved', 'Reschedule Approved', ?, ?)`,
                    [appt.patient_id, notifMsg, appointmentId]
                );

            } else {
                // Action is decline: keep original confirmed date, clear request flag
                await connection.query(
                    `UPDATE appointments 
                     SET reschedule_status = 'declined',
                         requested_date = NULL,
                         requested_time = NULL
                     WHERE appointment_id = ?`,
                    [appointmentId]
                );

                const reasonText = decline_reason ? ` Note: ${decline_reason}` : '';
                const notifMsg = `Your reschedule request was declined. Your confirmed appointment remains on ${appt.appointment_date} at ${appt.time_slot}.${reasonText}`;

                await connection.query(
                    `INSERT INTO notifications (user_id, type, title, message, appointment_id)
                     VALUES (?, 'reschedule_declined', 'Reschedule Request Declined', ?, ?)`,
                    [appt.patient_id, notifMsg, appointmentId]
                );
            }

            await connection.commit();

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: action === 'approve' ? 'APPROVE_RESCHEDULE' : 'DECLINE_RESCHEDULE',
                target_table: 'appointments',
                target_id: appointmentId,
                notes: action === 'approve'
                    ? `Reschedule approved — moved to ${appt.requested_date} at ${appt.requested_time}.`
                    : `Reschedule request declined.${decline_reason ? ' Reason: ' + decline_reason : ''}`,
                ip_address: getIp(req)
            });

            // Real-time broadcast
            if (io) {
                io.emit('appointment-updated', { appointment_id: appointmentId });
            }

            res.json({
                success: true,
                message: action === 'approve' ? 'Reschedule request approved.' : 'Reschedule request declined.'
            });

        } catch (err) {
            await connection.rollback();
            console.error('Reschedule review error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });

    // ── 5. PATCH /api/appointments/:id/reschedule — Staff Direct Reschedule (Pick Other Slot) ──
    app.patch('/api/appointments/:id/reschedule', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const appointmentId = req.params.id;
        const { appointment_date, time_slot, reason } = req.body;

        if (!appointment_date || !time_slot) {
            return res.status(400).json({ message: 'appointment_date and time_slot are required' });
        }

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            const [apptRows] = await connection.query(
                'SELECT patient_id, appointment_status FROM appointments WHERE appointment_id = ? FOR UPDATE',
                [appointmentId]
            );
            if (!apptRows.length) {
                await connection.rollback();
                return res.status(404).json({ message: 'Appointment not found' });
            }

            // Check conflicts
            const [conflict] = await connection.query(
                `SELECT appointment_id FROM appointments
                 WHERE appointment_date = ? 
                   AND time_slot = ? 
                   AND appointment_status = 'approved'
                   AND appointment_id != ?`,
                [appointment_date, time_slot, appointmentId]
            );

            if (conflict.length > 0) {
                await connection.rollback();
                return res.status(409).json({ message: 'This date and time slot is already occupied.' });
            }

            await connection.query(
                `UPDATE appointments 
                 SET appointment_date = ?,
                     time_slot = ?,
                     reschedule_status = 'approved',
                     requested_date = NULL,
                     requested_time = NULL,
                     reschedule_reason = NULL
                 WHERE appointment_id = ?`,
                [appointment_date, time_slot, appointmentId]
            );

            const notifMsg = `Your appointment has been rescheduled by our clinic staff to ${appointment_date} at ${time_slot}.${reason ? ` Reason: ${reason}` : ''}`;
            await connection.query(
                `INSERT INTO notifications (user_id, type, title, message, appointment_id)
                 VALUES (?, 'appointment_rescheduled', 'Appointment Rescheduled', ?, ?)`,
                [apptRows[0].patient_id, notifMsg, appointmentId]
            );

            await connection.commit();

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: 'RESCHEDULE_APPOINTMENT',
                target_table: 'appointments',
                target_id: appointmentId,
                notes: `Rescheduled by staff to ${appointment_date} at ${time_slot}.${reason ? ' Reason: ' + reason : ''}`,
                ip_address: getIp(req)
            });

            if (io) {
                io.emit('appointment-updated', { appointment_id: appointmentId });
            }

            res.json({ success: true, message: 'Appointment rescheduled successfully.' });

        } catch (err) {
            await connection.rollback();
            console.error('Direct reschedule error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });


}

module.exports = registerBookingRequestRoutes;