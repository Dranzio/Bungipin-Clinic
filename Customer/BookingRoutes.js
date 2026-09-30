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

            // Existing bookings for this dentist on this date block out the
            // time they actually occupy (time_slot -> end_time), not just
            // their exact start — a 90-minute booking at 9:00 must also
            // block the 9:30 and 10:00 slots, not just 9:00 itself.
            // Cancelled bookings don't block; pending/approved/completed do,
            // since a pending request still holds the slot until staff act on it.
            const [bookedRows] = await db.query(
                `SELECT time_slot, end_time FROM appointments
                 WHERE employee_id = ? AND appointment_date = ? AND appointment_status != 'cancelled'`,
                [doctorId, date]
            );

            const toMinutes = t => {
                if (!t) return 0;
                const [h, m] = t.split(':').map(Number);
                return h * 60 + m;
            };

            const bookedRanges = bookedRows.map(r => ({
                start: toMinutes(r.time_slot),
                end: toMinutes(r.end_time)
            }));

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

                // Two ranges [sM,eM) and [start,end) overlap when sM < end AND start < eM
                const overlapsBooking = bookedRanges.some(r => sM < r.end && r.start < eM);

                let isAvailable = true;
                let reason = 'Available';

                if (hasBreak && sM < breakEnd && eM > breakStart) {
                    isAvailable = false;
                    reason = 'Doctor Lunch Break';
                } else if (overlapsBooking) {
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

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            // Price AND duration both come from the database, never the
            // client — look up every selected service in one go.
            const [serviceRows] = await connection.query(
                'SELECT service_id, price, duration_minutes, is_available FROM services WHERE service_id IN (?)',
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

            // Compute the real end time this booking occupies, from the
            // authoritative summed duration — not whatever the client
            // estimated for the UI preview.
            const [startH, startM] = time_slot.split(':').map(Number);
            const totalStartMins = startH * 60 + startM;
            const totalEndMins = totalStartMins + totalDuration;
            const endH = Math.floor(totalEndMins / 60);
            const endM = totalEndMins % 60;
            const endTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;

            // Re-check for an overlapping booking inside the transaction
            // (FOR UPDATE) rather than relying only on the unique constraint
            // below — two requests hitting this at the same instant would
            // otherwise both pass the frontend's earlier /available-slots
            // check. This blocks by overlapping RANGE, not just an exact
            // start-time match, since a 90-minute booking must also block
            // slots that start partway through it.
            const [clashRows] = await connection.query(
                `SELECT appointment_id FROM appointments
                 WHERE employee_id = ? AND appointment_date = ?
                   AND appointment_status != 'cancelled'
                   AND time_slot < ? AND ? < end_time
                 FOR UPDATE`,
                [employeeId, appointment_date, endTime, time_slot]
            );
            if (clashRows.length > 0) {
                await connection.rollback();
                return res.status(409).json({ message: 'That time slot is no longer available' });
            }

            // employee_id is the dentist the patient actually selected and
            // whose real schedule/availability the slot was validated
            // against (see /api/doctors/:id/available-slots) — leaving this
            // NULL meant the row never blocked that dentist's slot for
            // anyone else. service_id keeps the first selected service as
            // the appointment's primary record; the full duration/price
            // across ALL selected services is still what's stored in
            // end_time and payments.amount below.
            const [result] = await connection.query(
                `INSERT INTO appointments
                 (patient_id, employee_id, service_id, appointment_date, time_slot, end_time, appointment_status, patient_note)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
                [patientId, employeeId, allServiceIds[0], appointment_date, time_slot, endTime, patient_note || null]
            );
            const appointmentId = result.insertId;

            await connection.query(
                `INSERT INTO payments (appointment_id, amount, method, status)
                 VALUES (?, ?, ?, 'pending')`,
                [appointmentId, totalPrice, payment_method]
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