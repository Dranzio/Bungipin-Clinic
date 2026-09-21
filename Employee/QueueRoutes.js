const authenticateToken = require('../authMiddleware');

function registerQueueRoutes(app, db) {

    // GET /api/appointments/queue — today's approved appointments only.
    // Field names (first_name, last_name, phone, label) match what
    // queue.html's renderTable() actually reads.
    app.get('/api/appointments/queue', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        try {
            const [rows] = await db.query(
                `SELECT
                     a.appointment_id,
                     u.first_name,
                     u.last_name,
                     u.phone,
                     s.label,
                     COALESCE(a.queue_status, 'pending') AS queue_status
                 FROM appointments a
                          JOIN patient_profiles pp ON a.patient_id = pp.patient_id
                          JOIN users u ON pp.patient_id = u.user_id
                          JOIN services s ON a.service_id = s.service_id
                 WHERE a.appointment_status = 'approved'
                   AND a.appointment_date = CURDATE()
                 ORDER BY a.time_slot`
            );
            res.json(rows);
        } catch (err) {
            console.error('Load queue error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // PUT /api/appointments/:id — updates queue_status.
    // Matches the exact method/path/body shape from queue.html's
    // already-written (commented-out) updateAppointmentStatus().
    app.put('/api/appointments/:id', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { queue_status } = req.body;
        const validStatuses = ['pending', 'waiting', 'ongoing', 'completed'];

        if (!validStatuses.includes(queue_status)) {
            return res.status(400).json({ message: 'Invalid queue_status value' });
        }

        try {
            const [result] = await db.query(
                'UPDATE appointments SET queue_status = ? WHERE appointment_id = ?',
                [queue_status, req.params.id]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ message: 'Appointment not found' });
            }

            res.json({ message: 'Queue status updated successfully' });
        } catch (err) {
            console.error('Update queue status error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });
}

module.exports = registerQueueRoutes;