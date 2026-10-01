const bcrypt = require('bcrypt');
const authenticateToken = require('../authMiddleware');
const { logActivity } = require('../Admin/auditLogRoutes');

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}

const SALT_ROUNDS = 10;

function registerEmployeeProfileRoute(app, db) {

    // GET /api/employee-profile
    app.get('/api/employee-profile', authenticateToken, async (req, res) => {
        if (req.user.role !== 'employee') {
            return res.status(403).json({ message: 'Only employees can access this profile' });
        }

        try {
            const [rows] = await db.query('CALL sp_get_employee_record(?)', [req.user.user_id]);
            if (!rows[0] || rows[0].length === 0) {
                return res.status(404).json({ message: 'Profile not found' });
            }
            const record = rows[0][0].employee_record;
            res.json(typeof record === 'string' ? JSON.parse(record) : record);
        } catch (err) {
            console.error('Profile load error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // PATCH /api/employee-profile
    app.patch('/api/employee-profile', authenticateToken, async (req, res) => {
        if (req.user.role !== 'employee') {
            return res.status(403).json({ message: 'Only employees can update this profile' });
        }

        const employeeId = req.user.user_id;
        const { birthday, phone, new_password } = req.body;

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            if (new_password) {
                const password_hash = await bcrypt.hash(new_password, SALT_ROUNDS);
                await connection.query(
                    'UPDATE users SET phone = ?, password_hash = ? WHERE user_id = ?',
                    [phone, password_hash, employeeId]
                );
            } else {
                await connection.query(
                    'UPDATE users SET phone = ? WHERE user_id = ?',
                    [phone, employeeId]
                );
            }

            await connection.query(
                `UPDATE employee_profiles
                 SET birthday = ?
                 WHERE employee_id = ?`,
                [birthday || null, employeeId]
            );

            await connection.commit();

            await logActivity(db, {
                user_id: employeeId,
                user_role: 'employee',
                action: 'UPDATE_PROFILE',
                target_table: 'employee_profiles',
                target_id: employeeId,
                ip_address: getIp(req)
            });

            res.json({ message: 'Profile updated successfully' });

        } catch (err) {
            await connection.rollback();
            console.error('Profile update error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });
}

module.exports = registerEmployeeProfileRoute;