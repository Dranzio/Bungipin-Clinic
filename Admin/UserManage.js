const bcrypt = require('bcrypt');
const crypto = require('crypto');
const authenticateToken = require('../authMiddleware');
const { logActivity } = require('./auditLogRoutes');
const { staffAccountCreated, notify } = require('../EmailTemplates');

const SALT_ROUNDS = 10;

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}

const CREATABLE_ROLES = ['employee', 'admin'];
const ALLOWED_POSITIONS = ['Dentist', 'Receptionist'];
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

// Shared validation patterns (kept identical to the ones used on the page)
const NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ]+([ '-][A-Za-zÀ-ÖØ-öø-ÿ]+)*$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const PHONE_RE = /^09\d{9}$/;
const TEMP_PASSWORD_RE = /^[A-Za-z0-9_-]{8,64}$/;

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Admins only' });
    }
    next();
}

// An audit-log failure must never turn a successful action into a 500 response.
async function safeLog(db, entry) {
    try {
        await logActivity(db, entry);
    } catch (err) {
        console.error('Audit log error:', err);
    }
}

async function safeRollback(connection) {
    if (!connection) return;
    try {
        await connection.rollback();
    } catch (err) {
        console.error('Rollback error:', err);
    }
}

function duplicateMessage(err) {
    const detail = String(err.sqlMessage || '').toLowerCase();
    return detail.includes('phone')
        ? 'An account with this phone number already exists.'
        : 'An account with this email already exists.';
}

function validateName(raw, label) {
    // Phone keyboards often insert a typographic apostrophe, treat it as a normal one.
    const value = typeof raw === 'string' ? raw.replace(/[\u2018\u2019]/g, "'").trim() : '';

    if (!value) return { error: `${label} is required` };
    if (value.length < 2 || value.length > 50) {
        return { error: `${label} must be between 2 and 50 characters` };
    }
    if (!NAME_RE.test(value)) {
        return { error: `${label} may only contain letters, single spaces, hyphens and apostrophes, and must start and end with a letter` };
    }
    if (/(.)\1{2,}/i.test(value) || /(.{2,})\1{2,}/i.test(value)) {
        return { error: `${label} cannot contain 3 repeating characters or repetitive patterns (e.g., ababab)` };
    }
    return { value };
}

function validateEmail(raw) {
    const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!email || email.length > 100 || email.includes('..') || !EMAIL_RE.test(email)) return null;

    const local = email.split('@')[0];
    if (local.length > 64 || local.startsWith('.') || local.endsWith('.')) return null;
    return email;
}

/**
 * Strict Input Validation and Sanitization for User Management
 */
function validateUserInput(body, isCreate = false) {
    body = body && typeof body === 'object' ? body : {};
    const clean = {};

    // 1. First Name & Last Name
    const first = validateName(body.first_name, 'First name');
    if (first.error) return { error: first.error };
    const last = validateName(body.last_name, 'Last name');
    if (last.error) return { error: last.error };

    clean.first_name = first.value;
    clean.last_name = last.value;

    // 2. Email
    const email = validateEmail(body.email);
    if (!email) {
        return { error: 'Please provide a valid email address' };
    }
    clean.email = email;

    // 3. Phone (Philippine Mobile: 09XXXXXXXXX)
    const phone = typeof body.phone === 'string' ? body.phone.trim().replace(/[\s-]/g, '') : '';
    if (!PHONE_RE.test(phone)) {
        return { error: 'Phone number must be exactly 11 digits starting with 09 (e.g. 09171234567)' };
    }
    clean.phone = phone;

    // 4. Sex Validation (Required on Create, optional on Edit)
    if (isCreate || body.sex !== undefined) {
        const sex = typeof body.sex === 'string' ? body.sex.trim().toUpperCase() : '';
        if (!['M', 'F'].includes(sex)) {
            return { error: "Please select a valid sex ('M' for Male or 'F' for Female)" };
        }
        clean.sex = sex;
    }

    // Role (only allowed on create)
    if (isCreate) {
        const role = typeof body.role === 'string' ? body.role.trim().toLowerCase() : '';
        if (!CREATABLE_ROLES.includes(role)) {
            return { error: "Role must be 'employee' or 'admin'" };
        }
        clean.role = role;
    }

    // 5. Position & Multiple Specializations
    // On create this is required for employees (and ignored for admins).
    // On edit it is only processed when the page sends a position.
    const needsPosition = isCreate ? clean.role === 'employee' : body.position !== undefined;

    if (needsPosition) {
        const position = typeof body.position === 'string' ? body.position.trim() : '';
        if (!ALLOWED_POSITIONS.includes(position)) {
            return { error: 'Please select a valid staff position (Dentist or Receptionist)' };
        }
        clean.position = position;

        if (position === 'Dentist') {
            let specList = [];
            if (Array.isArray(body.specialization)) {
                specList = body.specialization.map(s => String(s).trim()).filter(Boolean);
            } else if (typeof body.specialization === 'string') {
                specList = body.specialization.split(',').map(s => s.trim()).filter(Boolean);
            }

            specList = [...new Set(specList)];

            if (specList.length === 0) {
                return { error: 'Please select at least one dentist specialization' };
            }

            for (const s of specList) {
                if (!ALLOWED_SPECIALIZATIONS.includes(s)) {
                    return { error: `Invalid dentist specialization selected: ${s}` };
                }
            }
            clean.specialization = specList.join(', ');
        } else {
            clean.specialization = null;
        }
    }

    // 6. Permission Level
    // eli change: removed the block that forced clean.permission_level = 'Admin'. The level is no longer
    // taken from the request body, and editing an admin must never overwrite it (that would demote a super admin).

    return { data: clean };
}

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

    // eli change: guard for every route that acts on ANOTHER account (:id).
    // If the target account is an admin (or super admin), only a super admin may continue.
    // Looks the target up in the DB, so it cannot be bypassed by editing the request.
    // Self-delete / self-disable are already blocked in their own routes, so at least one super admin always remains.
    async function guardAdminTarget(req, res, next) {
        try {
            const targetId = Number(req.params.id);
            if (!Number.isInteger(targetId) || targetId <= 0) return next(); // the route reports the bad id
            const [rows] = await db.query('SELECT role FROM users WHERE user_id = ?', [targetId]);
            if (rows.length === 0) return next(); // the route reports 404
            if (rows[0].role === 'admin' && !authenticateToken.isSuperAdmin(req.user)) {
                return res.status(403).json({ message: 'Only a super admin can manage admin accounts.' });
            }
            next();
        } catch (err) {
            console.error('guardAdminTarget error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    }

    // Re-checks the LOGGED-IN admin's own password before a destructive action (disable / delete).
    // Wrong guesses are counted per admin so a stolen, unattended session can't be used to brute-force it.
    // (In-memory counter: it resets when the server restarts. Use a shared store if you run several instances.)
    const PASSWORD_ATTEMPT_LIMIT = 5;
    const PASSWORD_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
    const passwordAttempts = new Map(); // admin user_id -> { count, resetAt }

    // Returns true when the password is correct.
    // Otherwise it has already sent the error response and returns false, so the caller just returns.
    async function confirmAdminPassword(req, res) {
        const adminId = Number(req.user.user_id);
        const password = req.body ? req.body.password : undefined;

        if (typeof password !== 'string' || password.length === 0 || password.length > 128) {
            res.status(400).json({
                message: 'Please enter your password to confirm this action.',
                code: 'PASSWORD_REQUIRED'
            });
            return false;
        }

        const now = Date.now();
        let entry = passwordAttempts.get(adminId);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + PASSWORD_ATTEMPT_WINDOW_MS };
            passwordAttempts.set(adminId, entry);
        }

        if (entry.count >= PASSWORD_ATTEMPT_LIMIT) {
            const minutes = Math.max(1, Math.ceil((entry.resetAt - now) / 60000));
            res.status(429).json({
                message: `Too many incorrect password attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
                code: 'TOO_MANY_ATTEMPTS'
            });
            return false;
        }

        const [rows] = await db.query('SELECT password_hash FROM users WHERE user_id = ?', [adminId]);
        const hash = rows.length > 0 ? rows[0].password_hash : null;
        const matches = Boolean(hash) && await bcrypt.compare(password, hash);

        if (!matches) {
            entry.count += 1;
            // 403 (not 401) on purpose: a wrong password must not look like an expired login session.
            res.status(403).json({ message: 'Incorrect password.', code: 'INVALID_PASSWORD' });
            return false;
        }

        passwordAttempts.delete(adminId);
        return true;
    }

    // GET /api/users — powers User Management list
    app.get('/api/users', authenticateToken, requireAdmin, async (req, res) => {
        try {
            const [users] = await db.query(`${USER_SELECT} ORDER BY u.user_id DESC`);
            // eli change: can_manage tells the page whether to show action buttons for each row
            // (admin accounts can only be managed by a super admin). The server enforces this too.
            const callerIsSuper = authenticateToken.isSuperAdmin(req.user);
            res.json(users.map(u => ({
                ...u,
                is_locked: Boolean(u.is_locked),
                can_manage: u.role !== 'admin' || callerIsSuper
            })));
        } catch (err) {
            console.error('Error fetching users:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // POST /api/users/:id/reset-login-lock — Clear login session lock
    app.post('/api/users/:id/reset-login-lock', authenticateToken, requireAdmin, guardAdminTarget, async (req, res) => { // eli change: guardAdminTarget
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

            await safeLog(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: 'ACCOUNT_UNLOCKED',
                target_table: 'users',
                target_id: userId,
                notes: 'Login lock cleared by admin.',
                ip_address: getIp(req)
            });

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

        const { first_name, last_name, email, phone, sex, role, position, specialization } = validation.data;

        // eli change: only a super admin may create another admin account (admins can still create employees)
        if (role === 'admin' && !authenticateToken.isSuperAdmin(req.user)) {
            return res.status(403).json({ message: 'Only a super admin can create admin accounts.' });
        }

        let connection;

        try {
            // Hash first so the transaction (and its locks) stays as short as possible.
            const tempPassword = crypto.randomBytes(9).toString('base64url');
            const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

            connection = await db.getConnection();
            await connection.beginTransaction();

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
                // eli change: a NEW admin starts at the standard 'Admin' level (never super admin from the UI)
                await connection.query(
                    'UPDATE admin_profiles SET permission_level = ? WHERE admin_id = ?',
                    ['Admin', newUserId]
                );
            }

            await connection.commit();

            await safeLog(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: 'CREATE_USER',
                target_table: 'users',
                target_id: newUserId,
                notes: `Created ${role} account for ${first_name} ${last_name} (${email}).`,
                ip_address: getIp(req)
            });

            const user = await fetchUser(db, newUserId);

            // The account already exists at this point, so a mail failure must not fail the request.
            let emailSent = false;
            try {
                emailSent = Boolean(await notify(email, staffAccountCreated({
                    firstName: first_name,
                    role,
                    email,
                    tempPassword
                })));
            } catch (mailErr) {
                console.error('Welcome email error:', mailErr);
            }

            res.status(201).json({ ...user, temp_password: tempPassword, email_sent: emailSent });

        } catch (err) {
            await safeRollback(connection);
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ message: duplicateMessage(err) });
            }
            console.error('User creation error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            if (connection) connection.release();
        }
    });

    // PATCH /api/users/:id — Edit account details
    app.patch('/api/users/:id', authenticateToken, requireAdmin, guardAdminTarget, async (req, res) => { // eli change: guardAdminTarget
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ message: 'Invalid user id' });
        }

        const validation = validateUserInput(req.body, false);
        if (validation.error) return res.status(400).json({ message: validation.error });

        const { first_name, last_name, email, phone, sex, position, specialization } = validation.data;

        let connection;

        try {
            connection = await db.getConnection();
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
                'UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ?, sex = COALESCE(?, sex) WHERE user_id = ?',
                [first_name, last_name, email, phone, sex || null, userId]
            );

            if (existing.role === 'employee' && position) {
                await connection.query(
                    'UPDATE employee_profiles SET position = ?, specialization = ? WHERE employee_id = ?',
                    [position, specialization || null, userId]
                );
            }
            // eli change: removed the `else if (existing.role === 'admin')` branch that reset permission_level
            // to 'Admin' on every edit. It would have silently demoted the super admin.

            await connection.commit();

            await safeLog(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: 'UPDATE_USER',
                target_table: 'users',
                target_id: userId,
                notes: `Updated account details for ${first_name} ${last_name} (${email}).`,
                ip_address: getIp(req)
            });

            res.json(await fetchUser(db, userId));

        } catch (err) {
            await safeRollback(connection);
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ message: duplicateMessage(err) });
            }
            console.error('User update error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            if (connection) connection.release();
        }
    });

    // PATCH /api/users/:id/status — Disable / Re-enable
    // Disabling requires the admin's own password (body.password). Re-enabling does not.
    app.patch('/api/users/:id/status', authenticateToken, requireAdmin, guardAdminTarget, async (req, res) => { // eli change: guardAdminTarget
        const userId = Number(req.params.id);
        const account_status = req.body ? req.body.account_status : undefined;

        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ message: 'Invalid user id' });
        }
        if (!['active', 'suspended'].includes(account_status)) {
            return res.status(400).json({ message: "account_status must be 'active' or 'suspended'" });
        }
        if (userId === Number(req.user.user_id)) {
            return res.status(400).json({ message: 'You cannot disable your own account' });
        }

        try {
            if (account_status === 'suspended' && !(await confirmAdminPassword(req, res))) return;

            const [result] = await db.query(
                'UPDATE users SET account_status = ? WHERE user_id = ?',
                [account_status, userId]
            );
            if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });

            // A suspended account is logged out right away.
            if (account_status === 'suspended') {
                await db.query(
                    'UPDATE users SET current_session_id = NULL, session_expires_at = NULL WHERE user_id = ?',
                    [userId]
                );
            }

            await safeLog(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: account_status === 'suspended' ? 'DEACTIVATE_USER' : 'ACTIVATE_USER',
                target_table: 'users',
                target_id: userId,
                notes: account_status === 'suspended' ? 'Account suspended by admin.' : 'Account re-activated by admin.',
                ip_address: getIp(req)
            });

            res.json({ user_id: userId, account_status });
        } catch (err) {
            console.error('Status update error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // RESET PASSWORD HANDLER
    const handlePasswordReset = async (req, res) => {
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ message: 'Invalid user id' });
        }

        try {
            const tempPassword = crypto.randomBytes(9).toString('base64url');
            const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

            const [result] = await db.query(
                'UPDATE users SET password_hash = ?, is_locked = FALSE, login_attempts = 0, current_session_id = NULL, session_expires_at = NULL WHERE user_id = ?',
                [passwordHash, userId]
            );

            if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });

            await safeLog(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: 'PASSWORD_CHANGED',
                target_table: 'users',
                target_id: userId,
                notes: 'Password reset by admin (temporary password issued).',
                ip_address: getIp(req)
            });

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

    // eli change: guardAdminTarget added to both reset-password routes
    app.patch('/api/users/:id/reset-password', authenticateToken, requireAdmin, guardAdminTarget, handlePasswordReset);
    app.post('/api/users/:id/reset-password', authenticateToken, requireAdmin, guardAdminTarget, handlePasswordReset);

    // DELETE /api/users/:id — requires the admin's own password (body.password)
    app.delete('/api/users/:id', authenticateToken, requireAdmin, guardAdminTarget, async (req, res) => { // eli change: guardAdminTarget
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ message: 'Invalid user id' });
        }
        if (userId === Number(req.user.user_id)) {
            return res.status(400).json({ message: 'You cannot delete your own account' });
        }

        try {
            if (!(await confirmAdminPassword(req, res))) return;

            const [result] = await db.query('DELETE FROM users WHERE user_id = ?', [userId]);
            if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });

            await safeLog(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: 'DELETE_USER',
                target_table: 'users',
                target_id: userId,
                notes: 'Account permanently deleted by admin.',
                ip_address: getIp(req)
            });

            res.json({ message: 'User deleted' });
        } catch (err) {
            if (err.code === 'ER_ROW_IS_REFERENCED_2') {
                return res.status(409).json({
                    message: 'This user still has related records (e.g. appointments or uploaded X-rays). Disable the account instead.'
                });
            }
            console.error('User delete error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // DOCTOR SCHEDULE MANAGEMENT (admin)
    const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;
    const DAYS_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    // Returns 'HH:MM:SS' for a valid time, '' for an empty value, and null for an invalid one.
    // Normalising first means 'HH:MM' and 'HH:MM:SS' values can be compared safely as strings.
    function normalizeTime(value) {
        const s = value === null || value === undefined ? '' : String(value).trim();
        if (!s) return '';
        const m = TIME_RE.exec(s);
        if (!m) return null;
        return `${m[1]}:${m[2]}:${m[4] || '00'}`;
    }

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
        if (!Number.isInteger(employeeId) || employeeId <= 0) {
            return res.status(400).json({ message: 'Invalid doctor id' });
        }

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
        if (!Number.isInteger(employeeId) || employeeId <= 0) {
            return res.status(400).json({ message: 'Invalid doctor id' });
        }

        const schedules = req.body ? req.body.schedules : undefined;
        if (!Array.isArray(schedules) || schedules.length !== 7) {
            return res.status(400).json({ message: 'Exactly 7 day rows (0-6) are required' });
        }

        const seenDays = new Set();
        const clean = [];

        for (const row of schedules) {
            if (!row || typeof row !== 'object') {
                return res.status(400).json({ message: 'Each schedule row must be an object' });
            }

            const day = Number(row.day_of_week);
            if (!Number.isInteger(day) || day < 0 || day > 6 || seenDays.has(day)) {
                return res.status(400).json({ message: `Invalid or duplicate day: ${row.day_of_week}` });
            }
            seenDays.add(day);

            const isActive = row.is_active === true || Number(row.is_active) === 1;

            if (!isActive) {
                clean.push({ day, start: null, end: null, breakStart: null, breakEnd: null, active: 0 });
                continue;
            }

            const startTime = normalizeTime(row.start_time);
            const endTime = normalizeTime(row.end_time);

            if (!startTime || !endTime) {
                return res.status(400).json({ message: `Invalid shift hours on ${DAYS_NAMES[day]}` });
            }
            if (startTime >= endTime) {
                return res.status(400).json({ message: `Start time must be before end time on ${DAYS_NAMES[day]}` });
            }

            const breakStart = normalizeTime(row.break_start);
            const breakEnd = normalizeTime(row.break_end);

            if (breakStart === null || breakEnd === null) {
                return res.status(400).json({ message: `Invalid lunch break time on ${DAYS_NAMES[day]}` });
            }
            if (Boolean(breakStart) !== Boolean(breakEnd)) {
                return res.status(400).json({ message: `Set both lunch start and end on ${DAYS_NAMES[day]}, or leave both empty` });
            }

            let cleanBreakStart = null;
            let cleanBreakEnd = null;

            if (breakStart && breakEnd) {
                if (breakStart >= breakEnd || breakStart < startTime || breakEnd > endTime) {
                    return res.status(400).json({ message: `Lunch break must fall within the shift hours on ${DAYS_NAMES[day]}` });
                }
                cleanBreakStart = breakStart;
                cleanBreakEnd = breakEnd;
            }

            clean.push({ day, start: startTime, end: endTime, breakStart: cleanBreakStart, breakEnd: cleanBreakEnd, active: 1 });
        }

        let connection;

        try {
            connection = await db.getConnection();

            const check = await assertDentist(connection, employeeId);
            if (!check.ok) {
                // The finally block releases the connection (releasing here too would release it twice).
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
            await safeRollback(connection);
            console.error('Doctor schedule update error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            if (connection) connection.release();
        }
    });

    // POST /api/users/:id/send-credentials
    app.post('/api/users/:id/send-credentials', authenticateToken, requireAdmin, guardAdminTarget, async (req, res) => { // eli change: guardAdminTarget
        const userId = Number(req.params.id);
        const temp_password = req.body ? req.body.temp_password : undefined;

        if (!Number.isInteger(userId) || userId <= 0 || !temp_password) {
            return res.status(400).json({ message: 'User ID and temporary password are required' });
        }
        if (typeof temp_password !== 'string' || !TEMP_PASSWORD_RE.test(temp_password)) {
            return res.status(400).json({ message: 'Invalid temporary password format' });
        }

        try {
            const user = await fetchUser(db, userId);
            if (!user) return res.status(404).json({ message: 'User not found' });

            const sent = await notify(user.email, staffAccountCreated({
                firstName: user.first_name,
                role: user.role,
                email: user.email,
                tempPassword: temp_password,
                variant: 'resent'
            }));

            if (!sent) {
                return res.status(502).json({
                    message: 'The email could not be sent. Please check the mail configuration and try again.'
                });
            }

            await safeLog(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: 'SEND_CREDENTIALS_EMAIL',
                target_table: 'users',
                target_id: userId,
                notes: `Temporary credentials emailed to ${user.email}.`,
                ip_address: getIp(req)
            });

            res.json({ message: 'Credentials sent to email successfully', recipient: user.email });
        } catch (err) {
            console.error('Email sending error:', err);
            res.status(500).json({ message: 'Failed to send credentials email' });
        }
    });
}

module.exports = registerUserManagementRoutes;
