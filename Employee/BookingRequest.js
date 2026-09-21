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
}

module.exports = registerBookingRequestRoutes;