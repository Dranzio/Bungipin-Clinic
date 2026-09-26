const bcrypt = require('bcrypt');
const crypto = require('crypto');
const authenticateToken = require('../authmiddleware');
// LOGIN ATTEMPT SECURITY
const loginAttempts = require('../loginAttemptStore');

const SALT_ROUNDS = 10;

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Admins only' });
    }
    next();
}

// One shape for every user the frontend receives (list, edit response).
const USER_SELECT = `
    SELECT u.user_id, u.public_id, u.first_name, u.last_name, u.email, u.phone,
           u.sex, u.role, u.account_status,
           ep.position, ep.staff_code,
           ap.permission_level
    FROM users u
    LEFT JOIN employee_profiles ep ON ep.employee_id = u.user_id
    LEFT JOIN admin_profiles ap ON ap.admin_id = u.user_id`;

async function fetchUser(conn, userId) {
    const [rows] = await conn.query(`${USER_SELECT} WHERE u.user_id = ?`, [userId]);

    // LOGIN ATTEMPT SECURITY
    // checks if the email of that user is locked for attempts
    return rows[0]
        ? { ...rows[0], login_locked: Boolean(loginAttempts.isLocked(rows[0].email)) }
        : null;
}

function registerUserManagementRoutes(app, db) {

    // GET /api/users — powers the User Management list
    app.get('/api/users', authenticateToken, requireAdmin, async (req, res) => {
        try {
            const [rows] = await db.query(`${USER_SELECT} ORDER BY u.user_id`);

            // LOGIN ATTEMPT SECURITY
            // checks if the email of that user is locked for attempts
            res.json(rows.map(user => ({
                ...user,
                login_locked: Boolean(loginAttempts.isLocked(user.email))
            })));
        } catch (err) {
            console.error('User list error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // POST /api/users — creates an employee or admin account.
    // Patients still self-register through /api/auth/register.
    app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
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

            // Random temporary password (shown once to the admin). It used to be the
            // public ID (e.g. EMP-0007), which is guessable and nothing forced a change.
            const tempPassword = crypto.randomBytes(9).toString('base64url');
            const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

            await connection.query(
                'CALL sp_register_user(?, ?, ?, ?, ?, ?, ?, @new_id)',
                [first_name, last_name, email, phone, passwordHash, sex, role]
            );
            const [[{ '@new_id': newUserId }]] = await connection.query('SELECT @new_id AS `@new_id`');

            const [[created]] = await connection.query(
                'SELECT public_id FROM users WHERE user_id = ?',
                [newUserId]
            );

            // sp_register_user already created the empty profile row.
            if (role === 'employee') {
                await connection.query(
                    'UPDATE employee_profiles SET position = ?, staff_code = ? WHERE employee_id = ?',
                    [position, created.public_id, newUserId]
                );
            } else {
                await connection.query(
                    'UPDATE admin_profiles SET permission_level = ? WHERE admin_id = ?',
                    [permission_level, newUserId]
                );
            }

            await connection.commit();

            const user = await fetchUser(db, newUserId);
            res.status(201).json({ ...user, temp_password: tempPassword });

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

    // PATCH /api/users/:id — edit modal. Returns the full updated user row.
    app.patch('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId)) {
            return res.status(400).json({ message: 'Invalid user id' });
        }

        const { first_name, last_name, email, phone, position, permission_level } = req.body;
        if (!first_name || !last_name || !email) {
            return res.status(400).json({ message: 'First name, last name and email are required' });
        }

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            const [[existing]] = await connection.query(
                'SELECT role FROM users WHERE user_id = ? FOR UPDATE',
                [userId]
            );
            if (!existing) {
                await connection.rollback();
                return res.status(404).json({ message: 'User not found' });
            }

            await connection.query(
                'UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ? WHERE user_id = ?',
                [first_name, last_name, email, phone || null, userId]
            );

            if (existing.role === 'employee' && position) {
                await connection.query(
                    'UPDATE employee_profiles SET position = ? WHERE employee_id = ?',
                    [position, userId]
                );
            } else if (existing.role === 'admin' && permission_level) {
                await connection.query(
                    'UPDATE admin_profiles SET permission_level = ? WHERE admin_id = ?',
                    [permission_level, userId]
                );
            }

            await connection.commit();
            res.json(await fetchUser(db, userId));

        } catch (err) {
            await connection.rollback();
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ message: 'An account with this email already exists.' });
            }
            console.error('User update error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });

    // PATCH /api/users/:id/status — disable / re-enable
    app.patch('/api/users/:id/status', authenticateToken, requireAdmin, async (req, res) => {
        const userId = Number(req.params.id);
        const { account_status } = req.body;

        if (!Number.isInteger(userId)) {
            return res.status(400).json({ message: 'Invalid user id' });
        }
        if (!['active', 'suspended'].includes(account_status)) {
            return res.status(400).json({ message: "account_status must be 'active' or 'suspended'" });
        }
        if (userId === req.user.user_id) {
            return res.status(400).json({ message: 'You cannot change your own account status' });
        }

        try {
            const [result] = await db.query(
                'UPDATE users SET account_status = ? WHERE user_id = ?',
                [account_status, userId]
            );
            if (result.affectedRows === 0) {
                return res.status(404).json({ message: 'User not found' });
            }
            res.json({ user_id: userId, account_status });
        } catch (err) {
            console.error('Status update error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // LOGIN ATTEMPT SECURITY
    // POST /api/users/:id/reset-login-lock — clear the server-side login lock.
    app.post('/api/users/:id/reset-login-lock', authenticateToken, requireAdmin, async (req, res) => {
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId)) {
            return res.status(400).json({ message: 'Invalid user id' });
        }

        try {
            const [rows] = await db.query('SELECT email FROM users WHERE user_id = ?', [userId]);
            if (rows.length === 0) {
                return res.status(404).json({ message: 'User not found' });
            }

            loginAttempts.clear(rows[0].email);
            res.json({ message: 'Login session reset successfully', user_id: userId });
        } catch (err) { 
            console.error('Login lock reset error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // DELETE /api/users/:id
    app.delete('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
        const userId = Number(req.params.id);

        if (!Number.isInteger(userId)) {
            return res.status(400).json({ message: 'Invalid user id' });
        }
        if (userId === req.user.user_id) {
            return res.status(400).json({ message: 'You cannot delete your own account' });
        }

        try {
            const [result] = await db.query('DELETE FROM users WHERE user_id = ?', [userId]);
            if (result.affectedRows === 0) {
                return res.status(404).json({ message: 'User not found' });
            }
            res.json({ message: 'User deleted' });
        } catch (err) {
            // e.g. an employee who uploaded X-rays (xrays.uploaded_by is ON DELETE RESTRICT)
            if (err.code === 'ER_ROW_IS_REFERENCED_2') {
                return res.status(409).json({
                    message: 'This user still has records linked to them (e.g. uploaded X-rays). Disable the account instead.'
                });
            }
            console.error('User delete error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });
}

module.exports = registerUserManagementRoutes;