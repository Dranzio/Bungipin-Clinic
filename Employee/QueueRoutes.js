const authenticateToken = require('../authMiddleware');
const { logActivity } = require('../Admin/auditLogRoutes');

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}

// ── Auto-cancel past unserved appointments automatically ──
async function autoCancelExpiredAppointments(db, io = null) {
    try {
        const [result] = await db.query(`
            UPDATE appointments
            SET appointment_status = 'cancelled',
                patient_note = CONCAT(COALESCE(patient_note, ''), ' [System: Auto-cancelled - scheduled date/time has passed]')
            WHERE appointment_status IN ('pending', 'approved')
              AND (
                  appointment_date < CURDATE()
                  OR (appointment_date = CURDATE() AND (end_time < CURTIME() OR time_slot < CURTIME()))
              )
              AND (queue_status IS NULL OR queue_status NOT IN ('completed', 'ongoing'))
        `);

        if (result.affectedRows > 0 && io) {
            io.emit('appointment-updated');
            io.emit('queue_updated');
        }
    } catch (err) {
        console.error('Auto-cancel expired appointments error:', err);
    }
}

function registerQueueRoutes(app, db, io = null) {

    // GET /api/appointments/queue — Supports 'today', 'tomorrow', 'upcoming', 'all', or specific 'YYYY-MM-DD'
    app.get('/api/appointments/queue', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        // Clean out past unserved appointments automatically
        await autoCancelExpiredAppointments(db, io);

        try {
            const { date = 'today' } = req.query;
            let dateCondition = 'a.appointment_date = CURDATE()';
            const params = [];

            if (date === 'tomorrow') {
                dateCondition = 'a.appointment_date = CURDATE() + INTERVAL 1 DAY';
            } else if (date === 'upcoming') {
                // All future and today's approved bookings
                dateCondition = 'a.appointment_date >= CURDATE()';
            } else if (date === 'all') {
                dateCondition = '1=1'; // Include past & future
            } else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                dateCondition = 'a.appointment_date = ?';
                params.push(date);
            }

            const [rows] = await db.query(
                `SELECT
                     a.appointment_id,
                     a.appointment_date,
                     a.time_slot,
                     a.end_time,
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
                   AND ${dateCondition}
                 ORDER BY a.appointment_date ASC, (a.queue_status = 'completed') ASC, a.time_slot ASC`,
                params
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