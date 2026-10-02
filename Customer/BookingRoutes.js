const authenticateToken = require('../authMiddleware');
const { logActivity } = require('../Admin/auditLogRoutes');
const { sendAppointmentEmail } = require('../AppointmentEmails');
const { createCheckoutSession, BLOCKING_SQL, HOLD_MINUTES } = require('../Services/paymongo');
const MAX_ADVANCE_MONTHS = 6;

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}
function getNow(tz = process.env.CLINIC_TIMEZONE || 'Asia/Manila') {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return {
        todayDateStr: `${yyyy}-${mm}-${dd}`,
        currentMinutes: now.getHours() * 60 + now.getMinutes()
    };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ACTIVE_BOOKINGS_LIMIT = 3;

function registerBookingRoute(app, db) {

    // ── 1. GET /api/doctors ──
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

    // ── 2. GET /api/doctors/:id/available-slots ──
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

            const [bookedRows] = await db.query(
                `SELECT a.time_slot, a.end_time, s.duration_minutes
                 FROM appointments a
                          LEFT JOIN services s ON a.service_id = s.service_id
                 WHERE a.employee_id = ? AND a.appointment_date = ?
                   AND ${BLOCKING_SQL}`,
                [doctorId, date]
            );

            const toMinutes = t => {
                if (!t) return 0;
                const [h, m] = String(t).split(':').map(Number);
                return h * 60 + (m || 0);
            };

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
            const step = 30;

            const { todayDateStr, currentMinutes } = getNow();
            const isToday = (date === todayDateStr);

            const slots = [];
            for (let cur = startMins; cur + step <= endMins; cur += step) {
                const sM = cur;
                const eM = cur + duration;

                const startH = Math.floor(sM / 60), startM = sM % 60;
                const endH = Math.floor(eM / 60), endM = eM % 60;
                const timeSlot = `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}:00`;
                const endTimeSlot = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;

                let isAvailable = true;
                let reason = 'Available';

                // 1. Slot is in the past for today (Philippine Time)
                if (isToday && sM <= currentMinutes) {
                    isAvailable = false;
                    reason = 'Past Time';
                }
                // 2. Doctor Lunch Break
                else if (hasBreak && sM >= breakStart && sM < breakEnd) {
                    isAvailable = false;
                    reason = 'Doctor Lunch Break';
                }
                // 3. Morning appointment running into lunch
                else if (hasBreak && sM < breakStart && eM > breakStart) {
                    isAvailable = false;
                    reason = 'Too Long Before Lunch';
                }
                // 4. Exceeds shift closing
                else if (eM > endMins) {
                    isAvailable = false;
                    reason = 'Exceeds Dentist Shift'; 
                }
                // 5. Already booked
                else if (bookedIntervals.some(b => sM < b.end && b.start < eM)) {
                    isAvailable = false;
                    reason = 'Already Booked';
                }

                slots.push({
                    time_slot: timeSlot,
                    end_time_slot: endTimeSlot,
                    is_available: isAvailable,
                    reason
                });
            }

            res.json({ is_working_day: true, slots });
        } catch (err) {
            console.error('Available slots error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 3. POST /api/appointments ──
    app.post('/api/appointments', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Only patients can book appointments' });
        }

        const patientId = req.user.user_id;
        const { appointment_date, time_slot, service_id, service_ids, doctor_id, patient_note, payment_method } = req.body;

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

        const appointmentDateTime = new Date(`${appointment_date}T${time_slot}`);
        if (Number.isNaN(appointmentDateTime.getTime()) || appointmentDateTime <= new Date()) {
            return res.status(400).json({ message: 'Appointments must be scheduled for a future date and time' });
        }

        const methodEnum = ['cash', 'card', 'online'].includes(String(payment_method).toLowerCase())
            ? String(payment_method).toLowerCase()
            : 'online';
        const isOnline = methodEnum === 'online';

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

            const [activeRows] = await connection.query(
                `SELECT COUNT(*) AS active_count
                 FROM appointments a
                 WHERE a.patient_id = ?
                   AND ${BLOCKING_SQL}`,
                [patientId]
            );

            if (activeRows[0].active_count >= MAX_ACTIVE_BOOKINGS_LIMIT) {
                await connection.rollback();
                return res.status(429).json({
                    message: `You already have ${MAX_ACTIVE_BOOKINGS_LIMIT} active appointments. Please complete or cancel an existing appointment before booking a new one.`
                });
            }

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

            const [startH, startM] = time_slot.split(':').map(Number);
            const totalStartMins = startH * 60 + startM;
            const totalEndMins = totalStartMins + totalDuration;
            const endH = Math.floor(totalEndMins / 60);
            const endM = totalEndMins % 60;
            const endTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;

            const [clashRows] = await connection.query(
                `SELECT a.appointment_id FROM appointments a
                 WHERE a.employee_id = ? AND a.appointment_date = ?
                   AND ${BLOCKING_SQL}
                   AND a.time_slot < ? AND ? < a.end_time
                     FOR UPDATE`,
                [employeeId, appointment_date, endTime, time_slot]
            );
            if (clashRows.length > 0) {
                await connection.rollback();
                return res.status(409).json({ message: 'This time slot has just been reserved by another patient. Please choose a different slot.' });
            }

            const [result] = await connection.query(
                `INSERT INTO appointments
                 (patient_id, employee_id, service_id, appointment_date, time_slot, end_time, appointment_status, hold_expires_at, queue_status, reschedule_status, reschedule_count, patient_note)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ${isOnline ? 'DATE_ADD(NOW(), INTERVAL ? MINUTE)' : 'NULL'}, 'pending', 'none', 0, ?)`,
                [
                    patientId, employeeId, allServiceIds[0], appointment_date, time_slot, endTime,
                    'pending',
                    ...(isOnline ? [HOLD_MINUTES] : []),
                    patient_note || null
                ]
            );
            const appointmentId = result.insertId;

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

            if (isOnline) {
                const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
                try {
                    const session = await createCheckoutSession({
                        appointmentId,
                        items: [{
                            name: `Bungipin Dental Clinic - Appointment #${appointmentId} (${serviceRows.map(s => s.label).join(', ')})`,
                            price: totalPrice
                        }],
                        successUrl: `${base}/Customer/Paymentsuccess.html?appointment_id=${appointmentId}`,
                        cancelUrl: `${base}/Customer/Booking.html`
                    });
                    await db.query(
                        `UPDATE payments SET paymongo_session_id = ?, checkout_url = ? WHERE appointment_id = ?`,
                        [session.id, session.checkoutUrl, appointmentId]
                    );
                    return res.status(201).json({
                        success: true,
                        appointment_id: appointmentId,
                        checkout_url: session.checkoutUrl,
                        hold_minutes: HOLD_MINUTES
                    });
                } catch (payErr) {
                    console.error('Checkout session error:', payErr.details ? JSON.stringify(payErr.details) : payErr);
                    await db.query(
                        `UPDATE appointments SET appointment_status = 'cancelled', hold_expires_at = NULL WHERE appointment_id = ?`,
                        [appointmentId]
                    );
                    return res.status(502).json({ message: 'Could not start online payment. Please try again or choose Pay in Clinic.' });
                }
            }

            await sendAppointmentEmail(db, appointmentId, 'booked', {
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