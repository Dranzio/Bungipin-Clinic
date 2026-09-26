const authenticateToken = require('../authmiddleware');

function registerBookingRoute(app, db) {
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