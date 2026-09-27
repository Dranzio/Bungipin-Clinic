const authenticateToken = require('../authMiddleware');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function registerBookingRoute(app, db) {

    // GET /api/doctors
    // Any dentist listed in employee_profiles is bookable. Restricted to
    // active accounts only, same principle as login already enforces via
    // account_status.
    app.get('/api/doctors', authenticateToken, async (req, res) => {
        try {
            const [rows] = await db.query(
                `SELECT ep.employee_id AS doctor_id, ep.position,
                        CONCAT(u.first_name, ' ', u.last_name) AS name
                 FROM employee_profiles ep
                 JOIN users u ON ep.employee_id = u.user_id
                 WHERE ep.position = 'Dentist' AND u.account_status = 'active'
                 ORDER BY u.first_name`
            );
            res.json(rows);
        } catch (err) {
            console.error('Load doctors error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // GET /api/doctors/:id/available-slots?date=YYYY-MM-DD&duration=30
    // Reads the dentist's doctor_schedules row for that day of week, then
    // generates slots the same way the frontend's generateLocalSlots()
    // fallback does — but additionally excludes times already taken by an
    // existing pending/approved/completed appointment for that dentist,
    // which the frontend's local fallback never checked at all.
    app.get('/api/doctors/:id/available-slots', authenticateToken, async (req, res) => {
        const doctorId = Number(req.params.id);
        const { date } = req.query;
        const duration = Number(req.query.duration) || 30;

        if (!Number.isInteger(doctorId) || doctorId <= 0) {
            return res.status(400).json({ message: 'Invalid doctor id' });
        }
        if (!date || !DATE_PATTERN.test(date)) {
            return res.status(400).json({ message: 'A valid date (YYYY-MM-DD) is required' });
        }

        const targetDate = new Date(`${date}T00:00:00`);
        if (Number.isNaN(targetDate.getTime())) {
            return res.status(400).json({ message: 'Invalid date' });
        }
        const dayOfWeek = targetDate.getDay();

        try {
            const [scheduleRows] = await db.query(
                `SELECT start_time, end_time, break_start, break_end, is_active
                 FROM doctor_schedules
                 WHERE employee_id = ? AND day_of_week = ?`,
                [doctorId, dayOfWeek]
            );

            const schedule = scheduleRows[0];
            if (!schedule || !schedule.is_active) {
                const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dayOfWeek];
                return res.json({ is_working_day: false, slots: [], message: `Dentist is not on duty on ${dayName}s.` });
            }

            // Existing bookings for this dentist on this date block out their
            // start times regardless of status, except cancelled ones —
            // pending requests still hold the slot until staff reject them.
            const [bookedRows] = await db.query(
                `SELECT time_slot FROM appointments
                 WHERE employee_id = ? AND appointment_date = ? AND appointment_status != 'cancelled'`,
                [doctorId, date]
            );
            const bookedTimes = new Set(bookedRows.map(r => r.time_slot));

            const toMinutes = t => {
                if (!t) return 0;
                const [h, m] = t.split(':').map(Number);
                return h * 60 + m;
            };

            const startMins = toMinutes(schedule.start_time);
            const endMins = toMinutes(schedule.end_time);
            const hasBreak = !!(schedule.break_start && schedule.break_end);
            const breakStart = hasBreak ? toMinutes(schedule.break_start) : null;
            const breakEnd = hasBreak ? toMinutes(schedule.break_end) : null;
            const step = 30;

            const now = new Date();
            const isToday = targetDate.toDateString() === now.toDateString();

            const slots = [];
            for (let cur = startMins; cur + duration <= endMins; cur += step) {
                const sM = cur;
                const eM = cur + duration;
                const startH = Math.floor(sM / 60), startM = sM % 60;
                const endH = Math.floor(eM / 60), endM = eM % 60;
                const timeSlot = `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}:00`;
                const endTimeSlot = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;

                let isAvailable = true;
                let reason = 'Available';

                if (hasBreak && sM < breakEnd && eM > breakStart) {
                    isAvailable = false;
                    reason = 'Doctor Lunch Break';
                } else if (bookedTimes.has(timeSlot)) {
                    isAvailable = false;
                    reason = 'Already Booked';
                } else if (isToday) {
                    const slotDateTime = new Date(`${date}T${timeSlot}`);
                    if (slotDateTime <= now) {
                        isAvailable = false;
                        reason = 'Past Time';
                    }
                }

                slots.push({ time_slot: timeSlot, end_time_slot: endTimeSlot, is_available: isAvailable, reason });
            }

            res.json({ is_working_day: true, slots });
        } catch (err) {
            console.error('Available slots error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    app.post('/api/appointments', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Only patients can book appointments' });
        }

        const patientId = req.user.user_id;
        const { appointment_date, time_slot, service_id, patient_note, payment_method } = req.body;

        if (!appointment_date || !time_slot || !service_id || !payment_method) {
            return res.status(400).json({ message: 'Missing required booking fields' });
        }

        // no past dates
        const appointmentDateTime = new Date(`${appointment_date}T${time_slot}`);
        if (Number.isNaN(appointmentDateTime.getTime()) || appointmentDateTime <= new Date()) {
            return res.status(400).json({ message: 'Appointments must be scheduled for a future date and time' });
        }

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            // Price comes from the database, never from the client — the
            // HTML comment in Booking.html already called this out as a
            // requirement, and the old Booking.js violated it by sending
            // its own client-computed amount.
            const [serviceRows] = await connection.query(
                'SELECT price, is_available FROM services WHERE service_id = ?',
                [service_id]
            );

            if (serviceRows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ message: 'Service not found' });
            }
            if (!serviceRows[0].is_available) {
                await connection.rollback();
                return res.status(400).json({ message: 'This service is currently unavailable' });
            }

            const price = serviceRows[0].price;

            // employee_id is left NULL — staff assigns a dentist after
            // reviewing the request, matching the earlier design decision.
            const [result] = await connection.query(
                `INSERT INTO appointments
                 (patient_id, employee_id, service_id, appointment_date, time_slot, appointment_status, patient_note)
                 VALUES (?, NULL, ?, ?, ?, 'pending', ?)`,
                [patientId, service_id, appointment_date, time_slot, patient_note || null]
            );
            const appointmentId = result.insertId;

            await connection.query(
                `INSERT INTO payments (appointment_id, amount, method, status)
                 VALUES (?, ?, ?, 'pending')`,
                [appointmentId, price, payment_method]
            );

            await connection.commit();
            res.status(201).json({
                message: 'Booking successfully recorded!',
                appointment_id: appointmentId
            });

        } catch (err) {
            await connection.rollback();
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ message: 'That time slot is no longer available' });
            }
            console.error('Booking error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });
}

module.exports = registerBookingRoute;