const authenticateToken = require('../authMiddleware');
const { logActivity } = require('../Admin/auditLogRoutes');
const { sendAppointmentEmail } = require('../AppointmentEmails');

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}

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

            // Existing bookings for this dentist on this date block out the time they occupy

            // eli: updated query to use BLOCKING_SQL to block temporary "awaiting_payment"
            const [bookedRows] = await db.query(
                `SELECT a.time_slot, a.end_time, s.duration_minutes
                 FROM appointments a
                          LEFT JOIN services s ON a.service_id = s.service_id
                 WHERE a.employee_id = ? AND a.appointment_date = ?
                   AND a.appointment_status IN ('pending', 'approved')`,
                [doctorId, date]
            );

            const toMinutes = t => {
                if (!t) return 0;
                const [h, m] = String(t).split(':').map(Number);
                return h * 60 + (m || 0);
            };

            // Calculate exact booked intervals, falling back to the service's
            // own duration if end_time is ever missing or corrupt.
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
                    // Check Overlap with active appointments — ranges [sM,eM) and
                // [b.start,b.end) overlap when sM < b.end AND b.start < eM.
                else if (bookedIntervals.some(b => sM < b.end && b.start < eM)) {
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
        const { appointment_date, time_slot, service_id, service_ids, doctor_id, patient_note, payment_method } = req.body;

        // service_ids (array) is what Booking.js actually sends when the
        // patient picks several treatments in one visit — service_id alone
        // used to be trusted for both price AND duration, silently dropping
        // every service after the first from billing and from the time the
        // appointment actually occupies. Accept either, but always resolve
        // to the full list.
        const allServiceIds = Array.isArray(service_ids) && service_ids.length > 0
            ? service_ids
            : (service_id ? [service_id] : []);

        if (!appointment_date || !time_slot || allServiceIds.length === 0 || !payment_method || !doctor_id) {
            return res.status(400).json({ message: 'Missing required booking fields' });
        }

        const employeeId = Number(doctor_id);
        if (!Number.isInteger(employeeId) || employeeId <= 0) {
            return res.status(400).json({ message: 'Invalid doctor selected' });
        }

        // no past dates
        const appointmentDateTime = new Date(`${appointment_date}T${time_slot}`);
        if (Number.isNaN(appointmentDateTime.getTime()) || appointmentDateTime <= new Date()) {
            return res.status(400).json({ message: 'Appointments must be scheduled for a future date and time' });
        }


        // eli: check if payment is online to set status and holds properly
        const methodEnum = ['cash', 'card', 'online'].includes(String(payment_method).toLowerCase())
            ? String(payment_method).toLowerCase()
            : 'online';
        const isOnline = methodEnum === 'online';

        // 2. Enforce Max Advance Booking Limit (e.g. 6 Months from today)
        const maxAllowedDate = new Date();
        maxAllowedDate.setMonth(maxAllowedDate.getMonth() + MAX_ADVANCE_MONTHS);
        maxAllowedDate.setHours(23, 59, 59, 999);

        if (appointmentDateTime > maxAllowedDate) {
            return res.status(400).json({
                message: `Appointments can only be scheduled up to ${MAX_ADVANCE_MONTHS} months in advance.`
            });
        }

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            // Active-bookings cap (Max 3)
            // eli: update active count check to use BLOCKING_SQL so holds count against patient limits
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

            // Look up every selected service
            // Price AND duration both come from the database, never the client — look up every selected service in one go
            // eli: select 'label" column with price n duration for paymongo checkout session
            const [serviceRows] = await connection.query(
                'SELECT service_id, label, price, duration_minutes, is_available FROM services WHERE service_id IN (?)',
                [allServiceIds]
            );

            if (serviceRows.length !== allServiceIds.length) {
                await connection.rollback();
                return res.status(404).json({ message: 'One or more selected services were not found' });
            }
            const unavailable = serviceRows.find(s => !s.is_available);
            if (unavailable) {
                await connection.rollback();
                return res.status(400).json({ message: 'One or more selected services are currently unavailable' });
            }

            const totalPrice = serviceRows.reduce((sum, s) => sum + Number(s.price), 0);
            const totalDuration = serviceRows.reduce((sum, s) => sum + Number(s.duration_minutes || 30), 0);

            const [doctorRows] = await connection.query(
                `SELECT ep.employee_id
                 FROM employee_profiles ep
                          JOIN users u ON ep.employee_id = u.user_id
                 WHERE ep.employee_id = ? AND ep.position = 'Dentist' AND u.account_status = 'active'
                     FOR UPDATE`,
                [employeeId]
            );
            if (doctorRows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ message: 'Selected dentist is not available' });
            }

            // Compute exact booking end time
            const [startH, startM] = time_slot.split(':').map(Number);
            const totalStartMins = startH * 60 + startM;
            const totalEndMins = totalStartMins + totalDuration;
            const endH = Math.floor(totalEndMins / 60);
            const endM = totalEndMins % 60;
            const endTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;

            // Check for overlapping bookings inside the transaction
            // eli: updated query to use BLOCKING_SQL to block temporary "awaiting_payment"
            const [clashRows] = await connection.query(
                `SELECT appointment_id FROM appointments
                 WHERE employee_id = ? AND appointment_date = ?
                   AND appointment_status IN ('pending', 'approved')
                   AND time_slot < ? AND ? < end_time
                     FOR UPDATE`,
                [employeeId, appointment_date, endTime, time_slot]
            );
            if (clashRows.length > 0) {
                await connection.rollback();
                return res.status(409).json({ message: 'This time slot has just been reserved by another patient. Please choose a different slot.' });
            }



            // eli: insert appointment status as 'awaiting_payment' + hold_expires_at if online
            const statusVal = isOnline ? 'awaiting_payment' : 'pending';
            const [result] = await connection.query(
                `INSERT INTO appointments
                 (patient_id, employee_id, service_id, appointment_date, time_slot, end_time, appointment_status, hold_expires_at, queue_status, reschedule_status, reschedule_count, patient_note)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ${isOnline ? 'DATE_ADD(NOW(), INTERVAL ? MINUTE)' : 'NULL'}, 'pending', 'none', 0, ?)`,
                [
                    patientId, employeeId, allServiceIds[0], appointment_date, time_slot, endTime,
                    isOnline ? 'awaiting_payment' : 'pending',
                    ...(isOnline ? [HOLD_MINUTES] : []),
                    patient_note || null
                ]
            );
            const appointmentId = result.insertId;

            // Normalize payment_method against the DB enum rather than
            // trusting the client value verbatim — an unexpected string here
            // would otherwise throw a DB error instead of failing gracefully.
            const methodEnum = ['cash', 'card', 'online'].includes(String(payment_method).toLowerCase())
                ? String(payment_method).toLowerCase()
                : 'online';

            await connection.query(
                `INSERT INTO payments (appointment_id, amount, payment_date, method, status)
                 VALUES (?, ?, CURDATE(), ?, 'pending')`,
                [appointmentId, totalPrice, methodEnum]
            );

            await connection.commit();

            await logActivity(db, {
                user_id: patientId,
                user_role: 'patient',
                action: 'BOOK_APPOINTMENT',
                target_table: 'appointments',
                target_id: appointmentId,
                notes: `Booked ${allServiceIds.length > 1 ? allServiceIds.length + ' services' : 'an appointment'} for ${appointment_date} at ${time_slot}.`,
                ip_address: getIp(req)
            });

            await sendAppointmentEmail(db, appointmentId, 'booked', {
                // appointments only stores the first service; list them all in the email
                service: serviceRows.map(sv => sv.label).filter(Boolean).join(', ')
            });

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

    // Automatically cancel past pending appointments that were never attended/approved
    async function autoCancelExpiredAppointments(db, io = null) {
        try {
            const [result] = await db.query(`
                UPDATE appointments
                SET appointment_status = 'cancelled',
                    patient_note = CONCAT(COALESCE(patient_note, ''), ' [System: Auto-cancelled due to expired schedule]')
                WHERE appointment_status = 'pending'
                  AND (
                    appointment_date < CURDATE()
                        OR (appointment_date = CURDATE() AND end_time < CURTIME())
                    )
            `);

            if (result.affectedRows > 0 && io) {
                io.emit('appointment-updated');
            }
        } catch (err) {
            console.error('Auto-cancel expired appointments error:', err);
        }
    }

}

module.exports = registerBookingRoute;