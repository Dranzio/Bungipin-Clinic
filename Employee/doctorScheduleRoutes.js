const authenticateToken = require('../authMiddleware');

function registerDoctorScheduleRoutes(app, db, io) {

    // Helper: Default 7-day schedule if database has no records yet
    const DEFAULT_SCHEDULES = [1, 2, 3, 4, 5, 6].map(d => ({
        day_of_week: d,
        start_time: '08:00:00',
        end_time: '17:00:00',
        break_start: '12:00:00',
        break_end: '13:00:00',
        is_active: 1
    })).concat([{
        day_of_week: 0,
        start_time: '08:00:00',
        end_time: '17:00:00',
        break_start: '12:00:00',
        break_end: '13:00:00',
        is_active: 0
    }]);

    // ── 1. GET /api/doctors — List all active dentists ──
    app.get('/api/doctor-schedule/doctors', authenticateToken, async (req, res) => {
        try {
            const [doctors] = await db.query(`
                SELECT
                    u.user_id,
                    u.public_id,
                    u.first_name,
                    u.last_name,
                    u.email,
                    u.phone,
                    COALESCE(ep.position, 'Dentist') AS position,
                    ep.staff_code
                FROM users u
                LEFT JOIN employee_profiles ep ON ep.employee_id = u.user_id
                WHERE u.role IN ('employee', 'admin') 
                  AND (ep.position = 'Dentist' OR ep.position LIKE '%Dentist%' OR ep.position IS NULL)
                  AND u.account_status = 'active'
                ORDER BY u.first_name ASC, u.last_name ASC
            `);
            res.json(doctors);
        } catch (err) {
            console.error('Error fetching doctors:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 2. GET /api/doctor/my-profile — Current logged-in user profile ──
    app.get('/api/doctor/my-profile', authenticateToken, async (req, res) => {
        try {
            const [[doc]] = await db.query(`
                SELECT
                    u.user_id,
                    u.public_id,
                    u.first_name,
                    u.last_name,
                    u.email,
                    u.phone,
                    u.role,
                    COALESCE(ep.position, CASE WHEN u.role = 'admin' THEN 'Super Admin' ELSE 'Dentist' END) AS position,
                    ep.staff_code
                FROM users u
                         LEFT JOIN employee_profiles ep ON ep.employee_id = u.user_id
                WHERE u.user_id = ?
            `, [req.user.user_id]);

            if (!doc) {
                return res.status(404).json({ message: 'Doctor profile not found' });
            }
            res.json(doc);
        } catch (err) {
            console.error('Doctor profile error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 3. GET /api/doctors/:id/schedule — Weekly assigned duty shifts ──
    app.get('/api/doctor-schedule/:id/schedule', authenticateToken, async (req, res) => {
        const employeeId = Number(req.params.id);
        if (!Number.isInteger(employeeId)) {
            return res.status(400).json({ message: 'Invalid doctor ID' });
        }

        try {
            const [schedules] = await db.query(`
                SELECT 
                    schedule_id,
                    employee_id,
                    day_of_week,
                    start_time,
                    end_time,
                    break_start,
                    break_end,
                    is_active
                FROM doctor_schedules
                WHERE employee_id = ?
                ORDER BY day_of_week ASC
            `, [employeeId]);

            // If doctor has no saved schedule in DB yet, return default Mon-Sat preset
            if (!schedules || schedules.length === 0) {
                return res.json(DEFAULT_SCHEDULES.map(s => ({ ...s, employee_id: employeeId })));
            }

            res.json(schedules);
        } catch (err) {
            console.error('Doctor schedule fetch error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 4. PUT /api/doctor-schedule/:id/schedule — Save weekly shift timecards ──
    //     NOTE: intentionally a different path from Admin/UserManage.js's
    //     PUT /api/doctors/:id/schedule (admin-only).
    app.put('/api/doctor-schedule/:id/schedule', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const employeeId = Number(req.params.id);
        const { schedules } = req.body;

        if (!Array.isArray(schedules) || schedules.length === 0) {
            return res.status(400).json({ message: 'Valid schedules array is required' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            for (const s of schedules) {
                await connection.query(`
                    INSERT INTO doctor_schedules (
                        employee_id, day_of_week, start_time, end_time, break_start, break_end, is_active
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        start_time = VALUES(start_time),
                        end_time = VALUES(end_time),
                        break_start = VALUES(break_start),
                        break_end = VALUES(break_end),
                        is_active = VALUES(is_active)
                `, [
                    employeeId,
                    s.day_of_week,
                    s.start_time || null,
                    s.end_time || null,
                    s.break_start || null,
                    s.break_end || null,
                    s.is_active ? 1 : 0
                ]);
            }

            await connection.commit();
            res.json({ message: 'Doctor shift schedule updated successfully' });
        } catch (err) {
            await connection.rollback();
            console.error('Update schedule error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });

    // ── 5. GET /api/doctors/:id/appointments — Today & Future approved customer bookings ──
    app.get('/api/doctor/:id/appointments', authenticateToken, async (req, res) => {
        const employeeId = Number(req.params.id);

        try {
            // Checks if user is admin (can view all) or specific doctor
            const isAdmin = req.user.role === 'admin';

            let sql = `
                SELECT 
                    a.appointment_id,
                    DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS appointment_date,
                    TIME_FORMAT(a.time_slot, '%H:%i:%s') AS time_slot,
                    a.appointment_status,
                    a.queue_status,
                    a.patient_note,
                    a.dentist_note,
                    a.created_at,
                    a.employee_id,
                    p.user_id AS patient_id,
                    p.public_id AS patient_public_id,
                    p.first_name AS patient_first_name,
                    p.last_name AS patient_last_name,
                    p.phone AS patient_phone,
                    p.email AS patient_email,
                    s.service_id,
                    s.label AS service_label,
                    s.price AS service_price,
                    pay.payment_id,
                    pay.amount,
                    pay.method AS payment_method,
                    pay.status AS payment_status
                FROM appointments a
                JOIN users p ON p.user_id = a.patient_id
                JOIN services s ON s.service_id = a.service_id
                LEFT JOIN payments pay ON pay.appointment_id = a.appointment_id
                WHERE (a.employee_id = ? OR a.employee_id IS NULL OR ? = 1)
                  AND a.appointment_status IN ('approved', 'completed')
                  AND a.appointment_date >= CURDATE()
                ORDER BY a.appointment_date ASC, a.time_slot ASC
            `;

            const [appointments] = await db.query(sql, [employeeId, isAdmin ? 1 : 0]);
            res.json(appointments);

        } catch (err) {
            console.error('Fetch doctor appointments error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 6. PATCH /api/doctor-schedule/appointments/:id/complete — Mark an approved
    //     booking as Completed with Clinical Notes (Dentist Schedule page).
    //     NOTE: intentionally a different path from PatientRecords.js's
    //     PATCH /api/appointments/:id/complete, which requires an ongoing
    //     queue session. This one just needs 'approved' — it's for closing
    //     out any approved booking shown on the Dentist Schedule page,
    //     whether or not a queue session was ever started.
    app.patch('/api/doctor-schedule/appointments/:id/complete', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const appointmentId = Number(req.params.id);
        const { dentist_note } = req.body;

        if (!Number.isInteger(appointmentId)) {
            return res.status(400).json({ message: 'Invalid appointment ID' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            const [[appt]] = await connection.query(
                'SELECT appointment_id, patient_id FROM appointments WHERE appointment_id = ? FOR UPDATE',
                [appointmentId]
            );

            if (!appt) {
                await connection.rollback();
                return res.status(404).json({ message: 'Appointment not found' });
            }

            // Update appointment to completed & queue to paid/completed
            await connection.query(`
                UPDATE appointments
                SET appointment_status = 'completed',
                    queue_status = 'completed',
                    dentist_note = ?
                WHERE appointment_id = ?
            `, [dentist_note || null, appointmentId]);

            // Notify patient dashboard
            await connection.query(`
                INSERT INTO notifications (user_id, type, title, message, appointment_id)
                VALUES (?, 'appointment_status', 'Treatment Completed', 'Your dental treatment has been marked as completed. Thank you!', ?)
            `, [appt.patient_id, appointmentId]);

            await connection.commit();

            // Broadcast real-time update across all tabs (Queue, BookingRequest, DoctorSchedule)
            if (io) {
                io.emit('appointment-updated', { appointment_id: appointmentId, status: 'completed' });
                io.emit('queue-updated');
            }

            res.json({ message: 'Appointment marked as completed successfully', appointment_id: appointmentId });

        } catch (err) {
            await connection.rollback();
            console.error('Complete appointment error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });
}

module.exports = registerDoctorScheduleRoutes;