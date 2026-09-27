const authenticateToken = require('../authMiddleware');

function registerDashboardRoutes(app, db) {

    app.get('/api/admin/dashboard', authenticateToken, async (req, res) => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Admins only' });
        }

        const period = req.query.period || 'weekly';

        if (!['weekly', 'monthly', 'yearly'].includes(period)) {
            return res.status(400).json({ message: 'Invalid period' });
        }

        try {
            let patientLabels;
            let patientRows;
            let transactionLabels;
            let transactionRows;

            if (period === 'weekly') {
                patientLabels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
                transactionLabels = [...patientLabels];

                [patientRows] = await db.query(`
                    SELECT WEEKDAY(appointment_date) AS bucket,
                           COUNT(DISTINCT patient_id) AS total
                    FROM appointments
                    WHERE appointment_date >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
                      AND appointment_date < DATE_ADD(
                          DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY),
                          INTERVAL 7 DAY
                      )
                    GROUP BY WEEKDAY(appointment_date)
                `);

                [transactionRows] = await db.query(`
                    SELECT WEEKDAY(COALESCE(p.payment_date, a.appointment_date)) AS bucket,
                           COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0 END), 0) AS total
                    FROM payments p
                    JOIN appointments a ON p.appointment_id = a.appointment_id
                    WHERE COALESCE(p.payment_date, a.appointment_date)
                          >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
                      AND COALESCE(p.payment_date, a.appointment_date)
                          < DATE_ADD(
                              DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY),
                              INTERVAL 7 DAY
                          )
                    GROUP BY WEEKDAY(COALESCE(p.payment_date, a.appointment_date))
                `);

            } else if (period === 'monthly') {
                patientLabels = ['Week 1', 'Week 2', 'Week 3', 'Week 4', 'Week 5'];
                transactionLabels = [...patientLabels];

                [patientRows] = await db.query(`
                    SELECT FLOOR((DAY(appointment_date) - 1) / 7) AS bucket,
                           COUNT(DISTINCT patient_id) AS total
                    FROM appointments
                    WHERE YEAR(appointment_date) = YEAR(CURDATE())
                      AND MONTH(appointment_date) = MONTH(CURDATE())
                    GROUP BY FLOOR((DAY(appointment_date) - 1) / 7)
                `);

                [transactionRows] = await db.query(`
                    SELECT FLOOR((DAY(COALESCE(p.payment_date, a.appointment_date)) - 1) / 7) AS bucket,
                           COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0 END), 0) AS total
                    FROM payments p
                    JOIN appointments a ON p.appointment_id = a.appointment_id
                    WHERE YEAR(COALESCE(p.payment_date, a.appointment_date)) = YEAR(CURDATE())
                      AND MONTH(COALESCE(p.payment_date, a.appointment_date)) = MONTH(CURDATE())
                    GROUP BY FLOOR((DAY(COALESCE(p.payment_date, a.appointment_date)) - 1) / 7)
                `);

            } else {
                const currentYear = new Date().getFullYear();

                patientLabels = [
                    String(currentYear - 4),
                    String(currentYear - 3),
                    String(currentYear - 2),
                    String(currentYear - 1),
                    String(currentYear)
                ];

                transactionLabels = [...patientLabels];

                [patientRows] = await db.query(`
                    SELECT YEAR(appointment_date) AS bucket,
                           COUNT(DISTINCT patient_id) AS total
                    FROM appointments
                    WHERE YEAR(appointment_date) BETWEEN ? AND ?
                    GROUP BY YEAR(appointment_date)
                `, [currentYear - 4, currentYear]);

                [transactionRows] = await db.query(`
                    SELECT YEAR(COALESCE(p.payment_date, a.appointment_date)) AS bucket,
                           COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0 END), 0) AS total
                    FROM payments p
                    JOIN appointments a ON p.appointment_id = a.appointment_id
                    WHERE YEAR(COALESCE(p.payment_date, a.appointment_date)) BETWEEN ? AND ?
                    GROUP BY YEAR(COALESCE(p.payment_date, a.appointment_date))
                `, [currentYear - 4, currentYear]);
            }

            const patientData = patientLabels.map((label, index) => {
                const bucket = period === 'yearly'
                    ? Number(label)
                    : index;

                const row = patientRows.find(r => Number(r.bucket) === bucket);
                return row ? Number(row.total) : 0;
            });

            const transactionData = transactionLabels.map((label, index) => {
                const bucket = period === 'yearly'
                    ? Number(label)
                    : index;

                const row = transactionRows.find(r => Number(r.bucket) === bucket);
                return row ? Number(row.total) : 0;
            });

            const [appointmentRows] = await db.query(`
                SELECT appointment_status, COUNT(*) AS total
                FROM appointments
                GROUP BY appointment_status
            `);

            const appointmentStatuses = ['pending', 'approved', 'completed', 'cancelled'];

            const appointmentData = {
                labels: ['Pending', 'Approved', 'Completed', 'Cancelled'],
                data: appointmentStatuses.map(status => {
                    const row = appointmentRows.find(r => r.appointment_status === status);
                    return row ? Number(row.total) : 0;
                })
            };

            const [serviceRows] = await db.query(`
                SELECT s.label, COUNT(a.appointment_id) AS total
                FROM services s
                LEFT JOIN appointments a ON s.service_id = a.service_id
                GROUP BY s.service_id, s.label
                ORDER BY total DESC
            `);

            res.json({
                patients: {
                    labels: patientLabels,
                    data: patientData
                },
                transactions: {
                    labels: transactionLabels,
                    data: transactionData
                },
                appointments: appointmentData,
                services: {
                    labels: serviceRows.map(row => row.label),
                    data: serviceRows.map(row => Number(row.total))
                }
            });

        } catch (err) {
            console.error('Admin dashboard error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });
}

module.exports = registerDashboardRoutes;