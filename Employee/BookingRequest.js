const authenticateToken = require('../authMiddleware');

function registerBookingRequestRoutes(app, db) {

    // GET /api/appointments?status=pending — used by the booking request list
    app.get('/api/appointments', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { status } = req.query;

        try {
            let query = `
                SELECT a.appointment_id, u.public_id, u.first_name, u.last_name,
                       s.label AS service_label, a.appointment_date, a.time_slot,
                       a.created_at, p.status AS payment_status
                FROM appointments a
                         JOIN patient_profiles pp ON a.patient_id = pp.patient_id
                         JOIN users u ON pp.patient_id = u.user_id
                         JOIN services s ON a.service_id = s.service_id
                         LEFT JOIN payments p ON a.appointment_id = p.appointment_id
            `;
            const params = [];

            if (status) {
                query += ' WHERE a.appointment_status = ?';
                params.push(status);
            }
            query += ' ORDER BY a.created_at DESC';

            const [rows] = await db.query(query, params);
            res.json(rows);
        } catch (err) {
            console.error('Load bookings error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // GET /api/appointments/occupied — every taken slot (pending + approved),
    // used to block off the reschedule calendar so staff can't double-book
    // a slot that's already confirmed for someone else.
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
    // PATCH /api/appointments/:id/status — accept or decline a pending booking.
    // Accepting assigns the accepting staff member as the dentist and sends
    // the patient a notification; declining just notifies them.
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
                'SELECT patient_id, appointment_status FROM appointments WHERE appointment_id = ?',
                [appointmentId]
            );
            if (apptRows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ message: 'Appointment not found' });
            }
            if (apptRows[0].appointment_status !== 'pending') {
                await connection.rollback();
                return res.status(409).json({ message: 'This booking is no longer pending' });
            }

            if (appointment_status === 'approved') {
                // Accepting is what assigns the dentist — whoever clicked Accept
                await connection.query(
                    `UPDATE appointments SET appointment_status = 'approved', employee_id = ? WHERE appointment_id = ?`,
                    [req.user.user_id, appointmentId]
                );
            } else {
                await connection.query(
                    `UPDATE appointments SET appointment_status = 'cancelled' WHERE appointment_id = ?`,
                    [appointmentId]
                );
            }

            const notifTitle = appointment_status === 'approved' ? 'Appointment Approved' : 'Appointment Declined';
            const notifMessage = appointment_status === 'approved'
                ? 'Your appointment request has been approved.'
                : 'Your appointment request has been declined. Please contact the clinic or book a new slot.';

            await connection.query(
                `INSERT INTO notifications (user_id, type, title, message, appointment_id)
                 VALUES (?, 'appointment_status', ?, ?, ?)`,
                [apptRows[0].patient_id, notifTitle, notifMessage, appointmentId]
            );

            await connection.commit();
            res.json({ message: `Appointment ${appointment_status} successfully` });

        } catch (err) {
            await connection.rollback();
            console.error('Update appointment status error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });
}

module.exports = registerBookingRequestRoutes;