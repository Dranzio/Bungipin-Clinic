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
}

module.exports = registerHistoryRoutes;