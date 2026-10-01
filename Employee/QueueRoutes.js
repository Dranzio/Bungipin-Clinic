const authenticateToken = require('../authMiddleware');
const { logActivity } = require('../Admin/auditLogRoutes');

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}

function registerQueueRoutes(app, db, io = null) {

    // GET /api/appointments/queue — Today's approved AND completed queue appointments
    app.get('/api/appointments/queue', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        try {
            const [rows] = await db.query(
                `SELECT
                     a.appointment_id,
                     u.public_id,
                     u.first_name,
                     u.last_name,
                     u.phone,
                     s.label,
                     COALESCE(a.queue_status, 'pending') AS queue_status,
                     a.appointment_status
                 FROM appointments a
                          JOIN users u ON a.patient_id = u.user_id
                          JOIN services s ON a.service_id = s.service_id
                          LEFT JOIN patient_profiles pp ON a.patient_id = pp.patient_id
                 WHERE a.appointment_status IN ('approved', 'completed')
                   AND (
                       a.appointment_date = CURDATE()
                       OR DATE(a.appointment_date) = CURDATE()
                   )
                 ORDER BY (a.queue_status = 'completed') ASC, a.time_slot ASC`
            );
            res.json(rows);
        } catch (err) {
            console.error('Load queue error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // PUT /api/appointments/:id — Updates queue status & marks visit completed
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
            if (queue_status === 'completed') {
                const [result] = await db.query(
                    `UPDATE appointments 
                     SET queue_status = 'completed', 
                         appointment_status = 'completed' 
                     WHERE appointment_id = ?`,
                    [req.params.id]
                );
                if (result.affectedRows === 0) {
                    return res.status(404).json({ message: 'Appointment not found' });
                }
            } else {
                const [result] = await db.query(
                    `UPDATE appointments 
                     SET queue_status = ?,
                         appointment_status = 'approved'
                     WHERE appointment_id = ?`,
                    [queue_status, req.params.id]
                );
                if (result.affectedRows === 0) {
                    return res.status(404).json({ message: 'Appointment not found' });
                }
            }

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: queue_status === 'completed' ? 'COMPLETE_TREATMENT' : `QUEUE_${queue_status.toUpperCase()}`,
                target_table: 'appointments',
                target_id: req.params.id,
                notes: `Queue status set to "${queue_status}".`,
                ip_address: getIp(req)
            });

            if (io) {
                io.emit('queue_updated');
                io.emit('appointment-updated', { appointment_id: req.params.id, queue_status });
            }

            res.json({ message: 'Queue status updated successfully' });
        } catch (err) {
            console.error('Update queue status error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });
}

module.exports = registerQueueRoutes;