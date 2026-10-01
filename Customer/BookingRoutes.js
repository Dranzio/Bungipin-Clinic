const authenticateToken = require('../authMiddleware');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ACTIVE_BOOKINGS_LIMIT = 3; // Max active (pending/approved) bookings per patient

function registerBookingRoute(app, db) {

    // ── 1. GET /api/doctors (Includes Specialization) ──
    app.get('/api/doctors', authenticateToken, async (req, res) => {
        try {
            const [rows] = await db.query(
                `SELECT ep.employee_id AS doctor_id, ep.position,
                        COALESCE(ep.specialization, 'General Dentist') AS specialization,
                        CONCAT('Dr. ', u.first_name, ' ', u.last_name) AS name
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

    // ── 2. GET /api/doctors/:id/available-slots (Accurate Overlap & Instant Reopening) ──
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
        const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

        try {
            // 1. Get Doctor's Working Schedule for this day
            const [scheduleRows] = await db.query(
                `SELECT start_time, end_time, break_start, break_end, is_active
                 FROM doctor_schedules
                 WHERE employee_id = ? AND day_of_week = ?`,
                [doctorId, dayOfWeek]
            );

            const schedule = scheduleRows[0];
            if (!schedule || !schedule.is_active || !schedule.start_time || !schedule.end_time) {
                return res.json({ 
                    is_working_day: false, 
                    slots: [], 
                    message: `Dentist is not on duty on ${dayNames[dayOfWeek]}s (Closed).` 
                });
            }

            // 2. Fetch ACTIVE booked appointments (EXCLUDES 'cancelled' so cancelled slots IMMEDIATELY REOPEN)
            const [bookedRows] = await db.query(
                `SELECT a.time_slot, a.end_time, s.duration_minutes
                 FROM appointments a
                 LEFT JOIN services s ON a.service_id = s.service_id
                 WHERE a.employee_id = ?
                   AND DATE(a.appointment_date) = DATE(?)
                   AND a.appointment_status IN ('pending', 'approved')`,
                [doctorId, date]
            );

            const toMinutes = t => {
                if (!t) return 0;
                const [h, m] = String(t).split(':').map(Number);
                return h * 60 + (m || 0);
            };

            // Calculate exact booked intervals using database end_time
            const bookedIntervals = bookedRows.map(r => {
                const bStart = toMinutes(r.time_slot);
                let bEnd = r.end_time ? toMinutes(r.end_time) : 0;
                if (bEnd <= bStart) {
                    bEnd = bStart + (r.duration_minutes || 30);
                }
                return { start: bStart, end: bEnd };
            });

            const startMins = toMinutes(schedule.start_time);
            const endMins = toMinutes(schedule.end_time);
            const hasBreak = !!(schedule.break_start && schedule.break_end);
            const breakStart = hasBreak ? toMinutes(schedule.break_start) : null;
            const breakEnd = hasBreak ? toMinutes(schedule.break_end) : null;
            const step = 30; // Clean 30-minute start interval

            const now = new Date();
            const isToday = targetDate.toDateString() === now.toDateString();

            const slots = [];
            // Generate clean 30-min start intervals
            for (let cur = startMins; cur + duration <= endMins; cur += step) {
                const sM = cur;
                const eM = cur + duration;

                const startH = Math.floor(sM / 60), startM = sM % 60;
                const endH = Math.floor(eM / 60), endM = eM % 60;
                const timeSlot = `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}:00`;
                const endTimeSlot = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;

                let isAvailable = true;
                let reason = 'Available';

                // Check Closing Time
                if (eM > endMins) {
                    isAvailable = false;
                    reason = 'Exceeds Shift Closing';
                }
                // Check Lunch Break
                else if (hasBreak && ((sM >= breakStart && sM < breakEnd) || (sM < breakEnd && eM > breakStart))) {
                    isAvailable = false;
                    reason = 'Doctor Lunch Break';
                }
                // Check Overlap with active appointments
                else if (bookedIntervals.some(b => sM < b.end && eM > b.start)) {
                    isAvailable = false;
                    reason = 'Already Booked';
                }
                // Check Past Time today
                else if (isToday) {
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

    // ── 3. POST /api/appointments (Active Booking Limit + Overlap Protection + end_time) ──
    app.post('/api/appointments', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Only patients can book appointments' });
        }

        const patientId = req.user.user_id;
        const { 
            appointment_date, 
            time_slot, 
            end_time, 
            end_time_slot, 
            service_id, 
            patient_note, 
            payment_method, 
            doctor_id 
        } = req.body;

        if (!appointment_date || !time_slot || !service_id || !payment_method) {
            return res.status(400).json({ message: 'Missing required booking fields' });
        }

        const finalEndTime = end_time || end_time_slot || time_slot;
        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            // 🛡️ 1. ACTIVE APPOINTMENTS LIMIT (Max 3 active per patient)
            const [activeRows] = await connection.query(
                `SELECT COUNT(*) AS active_count 
                 FROM appointments 
                 WHERE patient_id = ? 
                   AND appointment_status IN ('pending', 'approved')`,
                [patientId]
            );

            if (activeRows[0].active_count >= MAX_ACTIVE_BOOKINGS_LIMIT) {
                await connection.rollback();
                return res.status(429).json({ 
                    message: `You already have ${MAX_ACTIVE_BOOKINGS_LIMIT} active appointments. Please complete or cancel an existing appointment before booking a new one.` 
                });
            }

            // 🛡️ 2. CONFLICT & OVERLAP CHECK
            if (doctor_id) {
                const [conflict] = await connection.query(
                    `SELECT appointment_id FROM appointments
                     WHERE employee_id = ?
                       AND appointment_date = ?
                       AND appointment_status IN ('pending', 'approved')
                       AND (time_slot < ? AND end_time > ?)`,
                    [doctor_id, appointment_date, finalEndTime, time_slot]
                );

                if (conflict.length > 0) {
                    await connection.rollback();
                    return res.status(409).json({ 
                        message: 'This time slot has just been reserved by another patient. Please choose a different slot.' 
                    });
                }
            }

            // 3. FETCH SERVICE PRICE
            const [serviceRows] = await connection.query(
                'SELECT price, is_available FROM services WHERE service_id = ?',
                [service_id]
            );

            if (serviceRows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ message: 'Service not found' });
            }

            const price = serviceRows[0].price;

            // 4. INSERT INTO APPOINTMENTS (Using exact schema column `end_time`)
            const [result] = await connection.query(
                `INSERT INTO appointments
                (patient_id, employee_id, service_id, appointment_date, time_slot, end_time, appointment_status, queue_status, reschedule_status, reschedule_count, patient_note)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', 'none', 0, ?)`,
                [patientId, doctor_id || null, service_id, appointment_date, time_slot, finalEndTime, patient_note || null]
            );
            const appointmentId = result.insertId;

            // 5. INSERT PAYMENT RECORD
            const methodEnum = ['cash', 'card', 'online'].includes(payment_method.toLowerCase()) 
                ? payment_method.toLowerCase() 
                : 'online';

            await connection.query(
                `INSERT INTO payments (appointment_id, amount, payment_date, method, status)
                 VALUES (?, ?, CURDATE(), ?, 'pending')`,
                [appointmentId, price, methodEnum]
            );

            await connection.commit();

            res.status(201).json({
                success: true,
                message: 'Booking successfully recorded!',
                appointment_id: appointmentId
            });

        } catch (err) {
            await connection.rollback();
            console.error('Booking error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });
}

module.exports = registerBookingRoute;