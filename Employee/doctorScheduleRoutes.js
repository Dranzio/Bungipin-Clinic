const authenticateToken = require('../authMiddleware');

function registerDoctorScheduleRoutes(app, db) {

    // ── 1. GET /api/doctors — List all active dentists ──
    app.get('/api/doctors', authenticateToken, async (req, res) => {
        try {
            const [doctors] = await db.query(`
                SELECT 
                    u.user_id,
                    u.public_id,
                    u.first_name,
                    u.last_name,
                    u.email,
                    u.phone,
                    ep.position,
                    ep.staff_code
                FROM users u
                JOIN employee_profiles ep ON ep.employee_id = u.user_id
                WHERE u.role = 'employee' 
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

    // ── 2. GET /api/doctor/my-profile — Doctor's own profile ──
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
                    ep.position,
                    ep.staff_code
                FROM users u
                LEFT JOIN employee_profiles ep ON ep.employee_id = u.user_id
                WHERE u.user_id = ?
            `, [req.user.user_id]);

            if (!doc) return res.status(404).json({ message: 'Doctor profile not found' });
            res.json(doc);
        } catch (err) {
            console.error('Doctor profile error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 3. GET /api/doctors/:id/schedule — Weekly assigned duty shifts (doctor_schedules) ──
    app.get('/api/doctors/:id/schedule', authenticateToken, async (req, res) => {
        const employeeId = Number(req.params.id);
        if (!Number.isInteger(employeeId)) {
            return res.status(400).json({ message: 'Invalid doctor/employee ID' });
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

            res.json(schedules);
        } catch (err) {
            console.error('Doctor schedule fetch error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 4. PUT /api/doctors/:id/schedule — Save weekly shift timecards ──
    app.put('/api/doctors/:id/schedule', authenticateToken, async (req, res) => {
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
    app.get('/api/doctors/:id/appointments', authenticateToken, async (req, res) => {
        const employeeId = Number(req.params.id);
        if (!Number.isInteger(employeeId)) {
            return res.status(400).json({ message: 'Invalid doctor ID' });
        }

        try {
            const [appointments] = await db.query(`
                SELECT 
                    a.appointment_id,
                    a.appointment_date,
                    a.time_slot,
                    a.appointment_status,
                    a.queue_status,
                    a.patient_note,
                    a.dentist_note,
                    a.created_at,
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
                WHERE a.employee_id = ?
                  AND a.appointment_status = 'approved'
                  AND a.appointment_date >= CURDATE()
                ORDER BY a.appointment_date ASC, a.time_slot ASC
            `, [employeeId]);

            res.json(appointments);
        } catch (err) {
            console.error('Fetch doctor appointments error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 6. PATCH /api/appointments/:id/complete — Mark as Completed with Clinical Notes ──
    app.patch('/api/appointments/:id/complete', authenticateToken, async (req, res) => {
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
                'SELECT appointment_id, patient_id, appointment_status FROM appointments WHERE appointment_id = ? FOR UPDATE',
                [appointmentId]
            );

            if (!appt) {
                await connection.rollback();
                return res.status(404).json({ message: 'Appointment not found' });
            }

            await connection.query(`
                UPDATE appointments
                SET appointment_status = 'completed',
                    queue_status = 'completed',
                    dentist_note = ?
                WHERE appointment_id = ?
            `, [dentist_note || null, appointmentId]);

            // Create notification for the patient
            await connection.query(`
                INSERT INTO notifications (user_id, type, title, message, appointment_id)
                VALUES (?, 'appointment_status', 'Treatment Completed', 'Your dental appointment has been marked as completed. Thank you!', ?)
            `, [appt.patient_id, appointmentId]);

            await connection.commit();
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
