const bcrypt = require('bcrypt');
const crypto = require('crypto');
const authenticateToken = require('../authMiddleware');

const SALT_ROUNDS = 10;

function registerUserManagementRoutes(app, db) {

    // GET /api/users — admin only, powers the User Management list
    app.get('/api/users', authenticateToken, async (req, res) => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Only admins can view the user list' });
        }

        try {
            const [rows] = await db.query(
                `SELECT u.user_id, u.public_id, u.first_name, u.last_name, u.email, u.phone,
                        u.sex, u.role, u.account_status,
                        ep.position, ep.staff_code,
                        ap.permission_level
                 FROM users u
                 LEFT JOIN employee_profiles ep ON ep.employee_id = u.user_id
                 LEFT JOIN admin_profiles ap ON ap.admin_id = u.user_id
                 ORDER BY u.user_id`
            );
            res.json(rows);
        } catch (err) {
            console.error('User list error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // POST /api/users — admin only, creates an employee or admin account.
    // Patients still self-register through /api/auth/register — this route
    // deliberately refuses role: 'patient'.
    app.post('/api/users', authenticateToken, async (req, res) => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Only admins can create accounts' });
        }

        const { first_name, last_name, email, phone, sex, role, position, permission_level } = req.body;

        if (!first_name || !last_name || !email || !phone || !sex || !role) {
            return res.status(400).json({ message: 'Missing required fields' });
        }
        if (role !== 'employee' && role !== 'admin') {
            return res.status(400).json({ message: "Role must be 'employee' or 'admin'. Patients self-register." });
        }
        if (role === 'employee' && !position) {
            return res.status(400).json({ message: 'Position is required for employee accounts' });
        }
        if (role === 'admin' && !permission_level) {
            return res.status(400).json({ message: 'Permission level is required for admin accounts' });
        }

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            // We don't know the public_id (and therefore the temp password)
            // until after the insert, so the row is created with a random,
            // unguessable placeholder hash first and then re-hashed below.
            const placeholder_hash = await bcrypt.hash(crypto.randomBytes(20).toString('hex'), SALT_ROUNDS);

            await connection.query(
                'CALL sp_register_user(?, ?, ?, ?, ?, ?, ?, @new_id)',
                [first_name, last_name, email, phone, placeholder_hash, sex, role]
            );
            const [[{ '@new_id': newUserId }]] = await connection.query('SELECT @new_id AS `@new_id`');

            const [[createdUser]] = await connection.query(
                'SELECT public_id FROM users WHERE user_id = ?',
                [newUserId]
            );
            const publicId = createdUser.public_id;

            // Temp password matches the generated system ID (e.g. EMP-0007) —
            // the account owner must change it on first login.
            const temp_password_hash = await bcrypt.hash(publicId, SALT_ROUNDS);
            await connection.query(
                'UPDATE users SET password_hash = ? WHERE user_id = ?',
                [temp_password_hash, newUserId]
            );

            if (role === 'employee') {
                await connection.query(
                    'UPDATE employee_profiles SET position = ?, staff_code = ? WHERE employee_id = ?',
                    [position, publicId, newUserId]
                );
            } else if (role === 'admin') {
                await connection.query(
                    'UPDATE admin_profiles SET permission_level = ? WHERE admin_id = ?',
                    [permission_level, newUserId]
                );
            }

            await connection.commit();

            res.status(201).json({
                user_id: newUserId,
                public_id: publicId,
                first_name,
                last_name,
                email,
                phone,
                sex,
                role,
                position: role === 'employee' ? position : null,
                permission_level: role === 'admin' ? permission_level : null,
                account_status: 'active',
                temp_password: publicId
            });

        } catch (err) {
            await connection.rollback();
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ message: 'An account with this email already exists.' });
            }
            console.error('User creation error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });
}

module.exports = registerUserManagementRoutes;