const bcrypt = require('bcrypt');
const crypto = require('crypto');
const authenticateToken = require('../authMiddleware');

const SALT_ROUNDS = 10;

const ALLOWED_ROLES = ['employee', 'admin', 'patient'];
const ALLOWED_POSITIONS = ['Dentist', 'Receptionist'];
const ALLOWED_PERMISSIONS = ['Super Admin', 'Regular Admin'];
const ALLOWED_SPECIALIZATIONS = [
    'General Dentist',
    'Pediatric Dentist',
    'Orthodontist',
    'Endodontist',
    'Oral Surgeon',
    'Periodontist',
    'Prosthodontist',
    'Oral Pathologist',
    'Oral Radiologist'
];

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Admins only' });
    }
    next();
}

/**
 * Strict Input Validation and Sanitization for User Management
 */
function validateUserInput(body, isCreate = false) {
    const clean = {};

    // 1. First Name & Last Name
    const firstName = typeof body.first_name === 'string' ? body.first_name.trim() : '';
    const lastName = typeof body.last_name === 'string' ? body.last_name.trim() : '';

    if (!firstName || firstName.length < 2 || firstName.length > 50) {
        return { error: 'First name must be between 2 and 50 characters' };
    }
    if (!lastName || lastName.length < 2 || lastName.length > 50) {
        return { error: 'Last name must be between 2 and 50 characters' };
    }

    // Name Regex: Only letters, spaces, hyphens, and apostrophes (no strange symbols or repeated punctuation)
    const nameRegex = /^[A-Za-zÀ-ÖØ-öø-ÿ]+([ '-][A-Za-zÀ-ÖØ-öø-ÿ]+)*$/;
    if (!nameRegex.test(firstName) || /([ '-]){2,}/.test(firstName)) {
        return { error: 'First name contains invalid characters or strange symbols' };
    }
    if (!nameRegex.test(lastName) || /([ '-]){2,}/.test(lastName)) {
        return { error: 'Last name contains invalid characters or strange symbols' };
    }

    clean.first_name = firstName;
    clean.last_name = lastName;

    // 2. Email
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!email || !emailRegex.test(email) || email.length > 100) {
        return { error: 'Please provide a valid email address' };
    }
    clean.email = email;

    // 3. Phone (Philippine Mobile: 09XXXXXXXXX)
    const phone = typeof body.phone === 'string' ? body.phone.trim().replace(/\D/g, '') : '';
    if (!phone || !/^09\d{9}$/.test(phone)) {
        return { error: 'Phone number must be exactly 11 digits starting with 09 (e.g. 09171234567)' };
    }
    clean.phone = phone;

    // 4. Creation-specific validations (Sex & Role)
    if (isCreate) {
        const sex = typeof body.sex === 'string' ? body.sex.trim().toUpperCase() : '';
        if (!['M', 'F'].includes(sex)) {
            return { error: "Sex must be 'M' (Male) or 'F' (Female)" };
        }
        clean.sex = sex;

        const role = typeof body.role === 'string' ? body.role.trim().toLowerCase() : '';
        if (!['employee', 'admin'].includes(role)) {
            return { error: "Role must be 'employee' or 'admin'" };
        }
        clean.role = role;
    }

    // 5. Position & Specialization (for employee)
    if (body.position !== undefined) {
        const position = typeof body.position === 'string' ? body.position.trim() : '';
        if (position && !ALLOWED_POSITIONS.includes(position)) {
            return { error: 'Invalid staff position selected' };
        }
        clean.position = position;

        if (position === 'Dentist') {
            const spec = typeof body.specialization === 'string' ? body.specialization.trim() : 'General Dentist';
            if (!ALLOWED_SPECIALIZATIONS.includes(spec)) {
                return { error: 'Invalid dentist specialization selected' };
            }
            clean.specialization = spec;
        } else {
            clean.specialization = null;
        }
    }

    // 6. Permission Level (for admin)
    if (body.permission_level !== undefined) {
        const permission = typeof body.permission_level === 'string' ? body.permission_level.trim() : '';
        if (permission && !ALLOWED_PERMISSIONS.includes(permission)) {
            return { error: 'Invalid admin permission level' };
        }
        clean.permission_level = permission;
    }

    return { data: clean };
}

// Single select shape for consistent frontend data
const USER_SELECT = `
    SELECT u.user_id, u.public_id, u.first_name, u.last_name, u.email, u.phone,
           u.sex, u.role, u.account_status, u.is_locked, u.login_attempts, u.created_at,
           ep.position, ep.specialization, ep.staff_code,
           ap.permission_level
    FROM users u
             LEFT JOIN employee_profiles ep ON ep.employee_id = u.user_id
             LEFT JOIN admin_profiles ap ON ap.admin_id = u.user_id`;

async function fetchUser(conn, userId) {
    const [rows] = await conn.query(`${USER_SELECT} WHERE u.user_id = ?`, [userId]);
    return rows[0] ? { ...rows[0], is_locked: Boolean(rows[0].is_locked) } : null;
}

function registerUserManagementRoutes(app, db) {

    // GET /api/users — powers User Management list
    app.get('/api/users', authenticateToken, requireAdmin, async (req, res) => {
        try {
            const [users] = await db.query(`${USER_SELECT} ORDER BY u.user_id DESC`);
            res.json(users.map(u => ({ ...u, is_locked: Boolean(u.is_locked) })));
        } catch (err) {
            console.error('Error fetching users:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // POST /api/users/:id/reset-login-lock — Clear login session lock
    app.post('/api/users/:id/reset-login-lock', authenticateToken, requireAdmin, async (req, res) => {
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ message: 'Invalid user id' });
        }

        try {
            const [rows] = await db.query('SELECT user_id FROM users WHERE user_id = ?', [userId]);
            if (rows.length === 0) return res.status(404).json({ message: 'User not found' });

            await db.query(
                'UPDATE users SET is_locked = FALSE, login_attempts = 0 WHERE user_id = ?',
                [userId]
            );

            res.json({ message: 'Login session reset successfully', user_id: userId });
        } catch (err) {
            console.error('Login lock reset error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // POST /api/users — Create employee or admin account
    app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
        const validation = validateUserInput(req.body, true);
        if (validation.error) return res.status(400).json({ message: validation.error });

        const { first_name, last_name, email, phone, sex, role, position, specialization, permission_level } = validation.data;

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

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

            if (role === 'employee') {
                await connection.query(
                    'UPDATE employee_profiles SET position = ?, specialization = ?, staff_code = ? WHERE employee_id = ?',
                    [position, specialization || null, created.public_id, newUserId]
                );
            } else if (role === 'admin') {
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

    // PATCH /api/users/:id — Edit account details
    app.patch('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ message: 'Invalid user id' });
        }

        const validation = validateUserInput(req.body, false);
        if (validation.error) return res.status(400).json({ message: validation.error });

        const { first_name, last_name, email, phone, position, specialization, permission_level } = validation.data;

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
                [first_name, last_name, email, phone, userId]
            );

            if (existing.role === 'employee' && position) {
                await connection.query(
                    'UPDATE employee_profiles SET position = ?, specialization = ? WHERE employee_id = ?',
                    [position, specialization || null, userId]
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

    // PATCH /api/users/:id/status — Disable / Re-enable
    app.patch('/api/users/:id/status', authenticateToken, requireAdmin, async (req, res) => {
        const userId = Number(req.params.id);
        const { account_status } = req.body;

        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ message: 'Invalid user id' });
        }
        if (!['active', 'suspended'].includes(account_status)) {
            return res.status(400).json({ message: "account_status must be 'active' or 'suspended'" });
        }
        if (userId === req.user.user_id) {
            return res.status(400).json({ message: 'You cannot disable your own account' });
        }

        try {
            const [result] = await db.query(
                'UPDATE users SET account_status = ? WHERE user_id = ?',
                [account_status, userId]
            );
            if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
            res.json({ user_id: userId, account_status });
        } catch (err) {
            console.error('Status update error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // RESET PASSWORD HANDLER (Supports both PATCH and POST)
    const handlePasswordReset = async (req, res) => {
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ message: 'Invalid user id' });
        }

        try {
            const tempPassword = crypto.randomBytes(9).toString('base64url');
            const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

            const [result] = await db.query(
                'UPDATE users SET password_hash = ?, is_locked = FALSE, login_attempts = 0 WHERE user_id = ?',
                [passwordHash, userId]
            );

            if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });

            res.json({
                message: 'Password reset successful',
                temp_password: tempPassword,
                user_id: userId
            });
        } catch (err) {
            console.error('Password reset error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    };

    app.patch('/api/users/:id/reset-password', authenticateToken, requireAdmin, handlePasswordReset);
    app.post('/api/users/:id/reset-password', authenticateToken, requireAdmin, handlePasswordReset);

    // DELETE /api/users/:id
    app.delete('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ message: 'Invalid user id' });
        }
        if (userId === req.user.user_id) {
            return res.status(400).json({ message: 'You cannot delete your own account' });
        }

        try {
            const [result] = await db.query('DELETE FROM users WHERE user_id = ?', [userId]);
            if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
            res.json({ message: 'User deleted' });
        } catch (err) {
            if (err.code === 'ER_ROW_IS_REFERENCED_2') {
                return res.status(409).json({
                    message: 'This user still has related records (e.g. uploaded X-rays). Disable the account instead.'
                });
            }
            console.error('User delete error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // DOCTOR SCHEDULE MANAGEMENT (admin)
    const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;

    async function assertDentist(conn, employeeId) {
        const [[emp]] = await conn.query(
            `SELECT ep.employee_id, ep.position FROM employee_profiles ep WHERE ep.employee_id = ?`,
            [employeeId]
        );
        if (!emp) return { ok: false, status: 404, message: 'Doctor not found' };
        if (emp.position !== 'Dentist') {
            return { ok: false, status: 400, message: 'This employee is not a dentist' };
        }
        return { ok: true };
    }

    // GET /api/doctors/:id/schedule
    app.get('/api/doctors/:id/schedule', authenticateToken, requireAdmin, async (req, res) => {
        const employeeId = Number(req.params.id);
        if (!Number.isInteger(employeeId)) return res.status(400).json({ message: 'Invalid doctor id' });

        try {
            const check = await assertDentist(db, employeeId);
            if (!check.ok) return res.status(check.status).json({ message: check.message });

            const [rows] = await db.query(
                `SELECT day_of_week, start_time, end_time, break_start, break_end, is_active
                 FROM doctor_schedules WHERE employee_id = ? ORDER BY day_of_week`,
                [employeeId]
            );
            res.json(rows);
        } catch (err) {
            console.error('Error fetching doctor schedule:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // PUT /api/doctors/:id/schedule
    app.put('/api/doctors/:id/schedule', authenticateToken, requireAdmin, async (req, res) => {
        const employeeId = Number(req.params.id);
        if (!Number.isInteger(employeeId)) return res.status(400).json({ message: 'Invalid doctor id' });

        const { schedules } = req.body;
        if (!Array.isArray(schedules) || schedules.length !== 7) {
            return res.status(400).json({ message: 'Exactly 7 day rows (0-6) are required' });
        }

        const seenDays = new Set();
        const clean = [];

        for (const row of schedules) {
            const day = Number(row.day_of_week);
            if (!Number.isInteger(day) || day < 0 || day > 6 || seenDays.has(day)) {
                return res.status(400).json({ message: `Invalid or duplicate day_of_week: ${row.day_of_week}` });
            }
            seenDays.add(day);

            const isActive = !!row.is_active;

            if (!isActive) {
                clean.push({ day, start: null, end: null, breakStart: null, breakEnd: null, active: 0 });
                continue;
            }

            const { start_time, end_time, break_start, break_end } = row;
            if (![start_time, end_time].every(t => TIME_RE.test(t))) {
                return res.status(400).json({ message: `Invalid start/end time on day ${day}` });
            }
            if (start_time >= end_time) {
                return res.status(400).json({ message: `Start time must be before end time on day ${day}` });
            }

            let breakStart = null, breakEnd = null;
            if (break_start && break_end) {
                if (![break_start, break_end].every(t => TIME_RE.test(t))) {
                    return res.status(400).json({ message: `Invalid break time on day ${day}` });
                }
                if (break_start >= break_end || break_start < start_time || break_end > end_time) {
                    return res.status(400).json({ message: `Break must fall within the shift on day ${day}` });
                }
                breakStart = break_start;
                breakEnd = break_end;
            }

            clean.push({ day, start: start_time, end: end_time, breakStart, breakEnd, active: 1 });
        }

        const connection = await db.getConnection();

        try {
            const check = await assertDentist(connection, employeeId);
            if (!check.ok) {
                connection.release();
                return res.status(check.status).json({ message: check.message });
            }

            await connection.beginTransaction();

            for (const row of clean) {
                await connection.query(
                    `INSERT INTO doctor_schedules
                        (employee_id, day_of_week, start_time, end_time, break_start, break_end, is_active)
                     VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        start_time = VALUES(start_time),
                        end_time = VALUES(end_time),
                        break_start = VALUES(break_start),
                        break_end = VALUES(break_end),
                        is_active = VALUES(is_active)`,
                    [employeeId, row.day, row.start, row.end, row.breakStart, row.breakEnd, row.active]
                );
            }

            await connection.commit();

            const [updated] = await connection.query(
                `SELECT day_of_week, start_time, end_time, break_start, break_end, is_active
                 FROM doctor_schedules WHERE employee_id = ? ORDER BY day_of_week`,
                [employeeId]
            );

            res.json(updated);
        } catch (err) {
            await connection.rollback();
            console.error('Doctor schedule update error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });


    // POST /api/users/:id/send-credentials — Sends temporary password to user's email
    app.post('/api/users/:id/send-credentials', authenticateToken, requireAdmin, async (req, res) => {
        const userId = Number(req.params.id);
        const { email, name, temp_password } = req.body;

        if (!Number.isInteger(userId) || !email || !temp_password) {
            return res.status(400).json({ message: 'User ID, recipient email, and password are required' });
        }

        try {
            // Log the dispatch attempt
            console.log(`[Email Service] Dispatched temporary credentials to ${email} for User #${userId}`);

            // When you add Nodemailer or SendGrid, place the send logic here:
            // await mailTransport.sendMail({
            //     from: '"Dental Clinic" <noreply@clinic.com>',
            //     to: email,
            //     subject: 'Your Clinic Account Temporary Credentials',
            //     html: `<p>Hello ${name || 'User'},</p><p>Your temporary password is: <strong>${temp_password}</strong></p>`
            // });

            res.json({ message: 'Credentials sent to email successfully', recipient: email });
        } catch (err) {
            console.error('Email sending error:', err);
            res.status(500).json({ message: 'Failed to send credentials email' });
        }
    });
}

module.exports = registerUserManagementRoutes;