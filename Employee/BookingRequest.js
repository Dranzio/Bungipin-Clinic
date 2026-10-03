const authenticateToken = require('../authMiddleware');
const { logActivity } = require('../Admin/auditLogRoutes');
const { sendAppointmentEmail } = require('../AppointmentEmails');

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}

const MAX_ADVANCE_MONTHS = 6; // Limit reschedules up to 6 months in advance

// Auto-cancel past pending appointments that were never served/approved
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

function registerBookingRequestRoutes(app, db, io) {

    function getDurationForService(serviceLabel) {
        const l = String(serviceLabel || '').toLowerCase();
        if (l.includes('root') || l.includes('canal')) return 90;
        if (l.includes('whiten')) return 60;
        if (l.includes('clean') || l.includes('prophylaxis')) return 45;
        if (l.includes('pasta') || l.includes('filling')) return 30;
        return 30;
    }

    function calculateEndTime(timeSlot, durationMins) {
        if (!timeSlot) return null;
        const [hStr, mStr] = String(timeSlot).split(':');
        const startMins = parseInt(hStr, 10) * 60 + parseInt(mStr || '0', 10);
        const endMins = startMins + durationMins;
        const endH = Math.floor(endMins / 60);
        const endM = endMins % 60;
        return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;
    }

    function timeToMins(timeStr) {
        if (!timeStr) return 0;
        const [h, m] = String(timeStr).split(':').map(Number);
        return h * 60 + (m || 0);
    }

    // ── 1. GET /api/appointments — Booking requests & approved appointments list ──
    app.get('/api/appointments', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        // Automatically clear expired pending appointments before loading list
        await autoCancelExpiredAppointments(db, io);

        const { status } = req.query;

        try {
            let query = `
                SELECT
                    a.appointment_id,
                    a.appointment_status,
                    a.queue_status,
                    a.appointment_date,
                    a.time_slot,
                    a.end_time AS end_time_slot,
                    a.reschedule_status,
                    COALESCE(a.reschedule_count, 0) AS reschedule_count,
                    a.requested_date,
                    a.requested_time,
                    a.reschedule_reason,
                    a.patient_note,
                    a.dentist_note,
                    a.created_at,
                    u.user_id AS patient_id,
                    u.public_id,
                    u.first_name,
                    u.last_name,
                    u.email AS patient_email,
                    u.phone AS patient_phone,
                    s.service_id,
                    s.label AS service_label,
                    s.price AS service_price,
                    p.payment_id,
                    p.status AS payment_status,
                    p.method AS payment_method,
                    p.amount AS payment_amount,
                    doc.user_id AS dentist_id,
                    doc.first_name AS dentist_first_name,
                    doc.last_name AS dentist_last_name
                FROM appointments a
                         JOIN users u ON a.patient_id = u.user_id
                         JOIN services s ON a.service_id = s.service_id
                         LEFT JOIN payments p ON a.appointment_id = p.appointment_id
                         LEFT JOIN users doc ON a.employee_id = doc.user_id
            `;
            const params = [];

            if (status && status !== 'all') {
                if (status === 'reschedule_requested') {
                    query += ' WHERE a.reschedule_status = \'requested\'';
                } else {
                    query += ' WHERE a.appointment_status = ?';
                    params.push(status);
                }
            }

            query += ' ORDER BY (a.reschedule_status = \'requested\') DESC, a.created_at DESC';

            const [rows] = await db.query(query, params);
            res.json(rows);
        } catch (err) {
            console.error('Load bookings error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 2. GET /api/appointments/occupied — Blocked/taken slots for calendar ──
    app.get('/api/appointments/occupied', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        try {
            const [rows] = await db.query(
                `SELECT appointment_id, appointment_date, time_slot, end_time AS end_time_slot
                 FROM appointments
                 WHERE appointment_status IN ('pending', 'approved')
                   AND appointment_date >= CURDATE()`
            );
            res.json(rows);
        } catch (err) {
            console.error('Load occupied slots error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // ── 3. PATCH /api/appointments/:id/status — Accept or decline pending booking ──
    app.patch('/api/appointments/:id/status', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { appointment_status } = req.body;
        const validStatuses = ['approved', 'cancelled'];
        if (!validStatuses.includes(appointment_status)) {
            return res.status(400).json({ message: 'Invalid appointment_status value' });
        }

        const appointmentId = req.params.id;
        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            const [apptRows] = await connection.query(
                'SELECT patient_id, appointment_status FROM appointments WHERE appointment_id = ? FOR UPDATE',
                [appointmentId]
            );
            if (apptRows.length === 0) {
                await connection.rollback();
                return res.status(404).json({ message: 'Appointment not found' });
            }

            if (apptRows[0].appointment_status === 'awaiting_payment') {
                await connection.rollback();
                return res.status(409).json({ message: 'This booking is still awaiting online payment.' });
            }

            if (appointment_status === 'approved') {
                const assignedEmployeeId = req.user.role === 'employee' ? req.user.user_id : null;
                await connection.query(
                    `UPDATE appointments
                     SET appointment_status = 'approved',
                         employee_id = COALESCE(employee_id, ?),
                         queue_status = 'pending'
                     WHERE appointment_id = ?`,
                    [assignedEmployeeId, appointmentId]
                );
            } else {
                await connection.query(
                    `UPDATE appointments
                     SET appointment_status = 'cancelled'
                     WHERE appointment_id = ?`,
                    [appointmentId]
                );

                await connection.query(
                    `UPDATE payments SET status = CASE WHEN status = 'paid' THEN 'refund_pending' ELSE status END
                     WHERE appointment_id = ?`,
                    [appointmentId]
                );
            }

            const notifTitle = appointment_status === 'approved' ? 'Appointment Approved' : 'Appointment Declined';
            const notifMessage = appointment_status === 'approved'
                ? 'Your appointment request has been approved and confirmed!'
                : 'Your appointment request has been declined. Please contact the clinic or choose a different slot.';

            await connection.query(
                `INSERT INTO notifications (user_id, type, title, message, appointment_id)
                 VALUES (?, 'appointment_status', ?, ?, ?)`,
                [apptRows[0].patient_id, notifTitle, notifMessage, appointmentId]
            );

            await connection.commit();

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: appointment_status === 'approved' ? 'APPROVE_APPOINTMENT' : 'CANCEL_APPOINTMENT',
                target_table: 'appointments',
                target_id: appointmentId,
                notes: appointment_status === 'approved' ? 'Booking request approved.' : 'Booking request declined.',
                ip_address: getIp(req)
            });

            await sendAppointmentEmail(
                db,
                appointmentId,
                appointment_status === 'approved' ? 'approved' : 'cancelled',
                { cancelledBy: 'clinic', declined: apptRows[0].appointment_status === 'pending' }
            );

            if (io) {
                io.emit('appointment-updated', { appointment_id: appointmentId, status: appointment_status });
                io.emit('queue_updated');
            }

            res.json({ message: `Appointment ${appointment_status} successfully` });

        } catch (err) {
            await connection.rollback();
            console.error('Update appointment status error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });

    // ── 4. PATCH /api/appointments/:id/reschedule-review — Staff Decision on Customer Reschedule Requests ──
    app.patch('/api/appointments/:id/reschedule-review', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const appointmentId = req.params.id;
        const { action, decline_reason } = req.body;

        if (!['approve', 'decline'].includes(action)) {
            return res.status(400).json({ message: 'Action must be "approve" or "decline"' });
        }

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            const [apptRows] = await connection.query(
                `SELECT a.appointment_id, a.patient_id, a.appointment_date, a.time_slot,
                        a.reschedule_status, a.requested_date, a.requested_time, s.label AS service_label
                 FROM appointments a
                          JOIN services s ON a.service_id = s.service_id
                 WHERE a.appointment_id = ? FOR UPDATE`,
                [appointmentId]
            );

            if (!apptRows.length) {
                await connection.rollback();
                return res.status(404).json({ message: 'Appointment not found' });
            }

            const appt = apptRows[0];
            if (appt.reschedule_status !== 'requested') {
                await connection.rollback();
                return res.status(400).json({ message: 'No active reschedule request for this appointment' });
            }

            if (action === 'approve') {
                const duration = getDurationForService(appt.service_label);
                const reqStart = timeToMins(appt.requested_time);
                const reqEnd = reqStart + duration;
                const calculatedEnd = calculateEndTime(appt.requested_time, duration);

                const [existing] = await connection.query(
                    `SELECT appointment_id, time_slot, end_time FROM appointments
                     WHERE appointment_date = ?
                       AND appointment_status = 'approved'
                       AND appointment_id != ?`,
                    [appt.requested_date, appointmentId]
                );

                const hasOverlap = existing.some(b => {
                    const bStart = timeToMins(b.time_slot);
                    const bEnd = b.end_time ? timeToMins(b.end_time) : bStart + 30;
                    return reqStart < bEnd && reqEnd > bStart;
                });

                if (hasOverlap) {
                    await connection.rollback();
                    return res.status(409).json({
                        message: 'Requested slot is already booked by another confirmed patient. Please use "Pick Other Slot".'
                    });
                }

                // ✅ Customer-requested reschedule counts toward limit (+1)
                await connection.query(
                    `UPDATE appointments
                     SET appointment_date = requested_date,
                         time_slot = requested_time,
                         end_time = ?,
                         reschedule_status = 'approved',
                         reschedule_count = reschedule_count + 1,
                         requested_date = NULL,
                         requested_time = NULL,
                         reschedule_reason = NULL
                     WHERE appointment_id = ?`,
                    [calculatedEnd, appointmentId]
                );

                const notifMsg = `Your request to reschedule to ${appt.requested_date} at ${appt.requested_time} has been APPROVED!`;
                await connection.query(
                    `INSERT INTO notifications (user_id, type, title, message, appointment_id)
                     VALUES (?, 'reschedule_approved', 'Reschedule Approved', ?, ?)`,
                    [appt.patient_id, notifMsg, appointmentId]
                );

            } else {
                await connection.query(
                    `UPDATE appointments
                     SET reschedule_status = 'declined',
                         requested_date = NULL,
                         requested_time = NULL
                     WHERE appointment_id = ?`,
                    [appointmentId]
                );

                const reasonText = decline_reason ? ` Note: ${decline_reason}` : '';
                const notifMsg = `Your reschedule request was declined. Your confirmed appointment remains on ${appt.appointment_date} at ${appt.time_slot}.${reasonText}`;

                await connection.query(
                    `INSERT INTO notifications (user_id, type, title, message, appointment_id)
                     VALUES (?, 'reschedule_declined', 'Reschedule Request Declined', ?, ?)`,
                    [appt.patient_id, notifMsg, appointmentId]
                );
            }

            await connection.commit();

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: action === 'approve' ? 'APPROVE_RESCHEDULE' : 'DECLINE_RESCHEDULE',
                target_table: 'appointments',
                target_id: appointmentId,
                notes: action === 'approve'
                    ? `Reschedule approved — moved to ${appt.requested_date} at ${appt.requested_time}.`
                    : `Reschedule request declined.${decline_reason ? ' Reason: ' + decline_reason : ''}`,
                ip_address: getIp(req)
            });

            if (io) {
                io.emit('appointment-updated', { appointment_id: appointmentId });
            }

            if (action === 'approve') {
                await sendAppointmentEmail(db, appointmentId, 'rescheduleApproved', {
                    previousDate: appt.appointment_date,
                    previousTime: appt.time_slot
                });
            }

            res.json({
                success: true,
                message: action === 'approve' ? 'Reschedule request approved.' : 'Reschedule request declined.'
            });

        } catch (err) {
            await connection.rollback();
            console.error('Reschedule review error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });

    // ── 5. PATCH /api/appointments/:id/reschedule — Staff Direct Reschedule (Pick Other Slot) ──
    app.patch('/api/appointments/:id/reschedule', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const appointmentId = req.params.id;
        const { appointment_date, time_slot, reason } = req.body;

        if (!appointment_date || !time_slot) {
            return res.status(400).json({ message: 'appointment_date and time_slot are required' });
        }

        // Enforce 6-Month Advance Limit
        const reschedDateTime = new Date(`${appointment_date}T${time_slot}`);
        const maxAllowedDate = new Date();
        maxAllowedDate.setMonth(maxAllowedDate.getMonth() + MAX_ADVANCE_MONTHS);
        maxAllowedDate.setHours(23, 59, 59, 999);

        if (reschedDateTime > maxAllowedDate) {
            return res.status(400).json({
                message: `Appointments can only be scheduled up to ${MAX_ADVANCE_MONTHS} months in advance.`
            });
        }

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            const [apptRows] = await connection.query(
                `SELECT a.patient_id, a.appointment_status, a.appointment_date, a.time_slot, s.label AS service_label
                 FROM appointments a
                          JOIN services s ON a.service_id = s.service_id
                 WHERE a.appointment_id = ? FOR UPDATE`,
                [appointmentId]
            );
            if (!apptRows.length) {
                await connection.rollback();
                return res.status(404).json({ message: 'Appointment not found' });
            }

            const duration = getDurationForService(apptRows[0].service_label);
            const slotStart = timeToMins(time_slot);
            const slotEnd = slotStart + duration;
            const calculatedEnd = calculateEndTime(time_slot, duration);

            const [existing] = await connection.query(
                `SELECT appointment_id, time_slot, end_time FROM appointments
                 WHERE appointment_date = ?
                   AND appointment_status = 'approved'
                   AND appointment_id != ?`,
                [appointment_date, appointmentId]
            );

            const hasOverlap = existing.some(b => {
                const bStart = timeToMins(b.time_slot);
                const bEnd = b.end_time ? timeToMins(b.end_time) : bStart + 30;
                return slotStart < bEnd && slotEnd > bStart;
            });

            if (hasOverlap) {
                await connection.rollback();
                return res.status(409).json({ message: 'This time slot overlaps with another confirmed patient.' });
            }

            // ⭐ Employee/Staff reschedule does NOT increment reschedule_count (limit is customer-only)
            await connection.query(
                `UPDATE appointments
                 SET appointment_date = ?,
                     time_slot = ?,
                     end_time = ?,
                     reschedule_status = 'approved',
                     requested_date = NULL,
                     requested_time = NULL,
                     reschedule_reason = NULL
                 WHERE appointment_id = ?`,
                [appointment_date, time_slot, calculatedEnd, appointmentId]
            );

            const notifMsg = `Your appointment has been rescheduled by our clinic staff to ${appointment_date} at ${time_slot}.${reason ? ` Reason: ${reason}` : ''}`;
            await connection.query(
                `INSERT INTO notifications (user_id, type, title, message, appointment_id)
                 VALUES (?, 'appointment_rescheduled', 'Appointment Rescheduled', ?, ?)`,
                [apptRows[0].patient_id, notifMsg, appointmentId]
            );

            await connection.commit();

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: 'RESCHEDULE_APPOINTMENT',
                target_table: 'appointments',
                target_id: appointmentId,
                notes: `Rescheduled by staff to ${appointment_date} at ${time_slot}.${reason ? ' Reason: ' + reason : ''}`,
                ip_address: getIp(req)
            });

            if (io) {
                io.emit('appointment-updated', { appointment_id: appointmentId });
            }

            await sendAppointmentEmail(db, appointmentId, 'rescheduled', {
                previousDate: apptRows[0].appointment_date,
                previousTime: apptRows[0].time_slot,
                reason
            });

            res.json({ success: true, message: 'Appointment rescheduled successfully.' });

        } catch (err) {
            await connection.rollback();
            console.error('Direct reschedule error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });
}

module.exports = registerBookingRequestRoutes;