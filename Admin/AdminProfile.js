const bcrypt = require('bcrypt');
const authenticateToken = require('../authMiddleware');
const { logActivity } = require('../Admin/auditLogRoutes');
const { isPasswordReused, REUSE_MESSAGE } = require('../Utils/passwordHistory');

const SALT_ROUNDS = 10;

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Admins only' });
    }
    next();
}

// ⏱️ 5-Minute Password Cooldown Tracker (5 mins = 300,000 ms)
const PASSWORD_COOLDOWN_MS = 5 * 60 * 1000;
const adminPasswordCooldowns = new Map();

function registerAdminProfileRoute(app, db) {

    // GET /api/admin-profile — powers AdminProfile.html and Admin_Sidebar.js
    app.get('/api/admin-profile', authenticateToken, requireAdmin, async (req, res) => {
        try {
            const [rows] = await db.query(
                `SELECT u.user_id, u.public_id, u.first_name, u.last_name, u.email, u.phone, u.sex,
                        ap.permission_level, ap.birthday
                 FROM users u
                 LEFT JOIN admin_profiles ap ON ap.admin_id = u.user_id
                 WHERE u.user_id = ?`,
                [req.user.user_id]
            );

            if (rows.length === 0) {
                return res.status(404).json({ message: 'Admin profile not found' });
            }

            res.json(rows[0]);
        } catch (err) {
            console.error('Admin profile load error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // PATCH /api/admin-profile — handles profile updates
    app.patch('/api/admin-profile', authenticateToken, requireAdmin, async (req, res) => {
        const adminId = req.user.user_id;
        const { birthday, phone, new_password } = req.body;

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            if (new_password) {
                // ⏱️ 5-Minute Cooldown Check
                const lastChanged = adminPasswordCooldowns.get(adminId);
                if (lastChanged && (Date.now() - lastChanged < PASSWORD_COOLDOWN_MS)) {
                    const remainingMins = Math.ceil((PASSWORD_COOLDOWN_MS - (Date.now() - lastChanged)) / 60000);
                    await connection.rollback();
                    return res.status(429).json({
                        message: `You recently changed your password. For security, please wait ${remainingMins} minute(s) before changing it again.`
                    });
                }

                // Block the new password if it matches the current one
                if (await isPasswordReused(connection, adminId, new_password)) {
                    await connection.rollback();
                    return res.status(400).json({ message: REUSE_MESSAGE });
                }

                const password_hash = await bcrypt.hash(new_password, SALT_ROUNDS);
                await connection.query(
                    'UPDATE users SET phone = ?, password_hash = ? WHERE user_id = ?',
                    [phone, password_hash, adminId]
                );

                adminPasswordCooldowns.set(adminId, Date.now());
            } else {
                await connection.query(
                    'UPDATE users SET phone = ? WHERE user_id = ?',
                    [phone, adminId]
                );
            }

            // Update admin_profiles table
            await connection.query(
                `UPDATE admin_profiles
                 SET birthday = ?
                 WHERE admin_id = ?`,
                [birthday || null, adminId]
            );

            await connection.commit();

            await logActivity(db, {
                user_id: adminId,
                user_role: 'admin',
                action: 'UPDATE_PROFILE',
                target_table: 'admin_profiles',
                target_id: adminId,
                ip_address: getIp(req)
            });

            res.json({ message: 'Admin profile updated successfully' });

        } catch (err) {
            await connection.rollback();
            console.error('Admin profile update error:', err);
            res.status(500).json({ message: err.message || 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });
}

module.exports = registerAdminProfileRoute;