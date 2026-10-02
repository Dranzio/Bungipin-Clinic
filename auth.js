const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();
const db = require('./db');
const { sendEmail } = require('./Mailer');
const { passwordReset, verifyRegistration } = require('./EmailTemplates');
const authenticateToken = require('./authMiddleware');
const { clearAuthCookie, extractToken } = authenticateToken;
const { logActivity } = require('./Admin/auditLogRoutes');

const SALT_ROUNDS = 10;
const RESET_TOKEN_TTL_MINUTES = 30;
const VERIFY_TOKEN_TTL_HOURS = 24;
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7d — must match jwt.sign's expiresIn below
// Failed logins allowed before the account locks. Matches login.html, which
// locks its form on the 4th failed attempt (failedAttempts > 3).
const MAX_LOGIN_ATTEMPTS = 4;
const LOCKED_MESSAGE = 'Please contact an administrator to reset your session.';

// Letters (incl. accented), spaces, hyphens, apostrophes, periods — covers
// real names ("O'Brien", "Anne-Marie", "José") while rejecting anything
// that could carry HTML/script content, since angle brackets, quotes used
// for attribute-breakout, and semicolons are never valid in a name anyway.
const NAME_PATTERN = /^[a-zA-Z\u00C0-\u017F\s'\-.]{1,50}$/;
const PHONE_PATTERN = /^[0-9]{7,15}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Sets the httpOnly auth cookie. Attributes must match exactly what
// clearAuthCookie in authMiddleware.js uses to clear it, or the browser
// won't recognize it as the same cookie on logout.
function setAuthCookie(res, token) {
    const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
    res.setHeader(
        'Set-Cookie',
        `authToken=${token}; HttpOnly; Path=/; Max-Age=${TOKEN_TTL_SECONDS}; SameSite=Lax${isProd ? '; Secure' : ''}`
    );
}

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}

// Names allow apostrophes (O'Brien), so escape before putting them in HTML.
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// Asks Google whether a captcha token from the form is genuine and unused.
// The secret key stays on the server (RECAPTCHA_SECRET_KEY in the environment);
// the page only ever has the public site key, so a bot that skips the page
// and POSTs here directly can't produce a valid token.
async function verifyCaptcha(token) {
    const secret = process.env.RECAPTCHA_SECRET_KEY;
    if (!secret) {
        console.error('RECAPTCHA_SECRET_KEY is not set');
        return false;
    }
    try {
        const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ secret, response: token })
        });
        const data = await resp.json();
        if (!data.success) console.error('reCAPTCHA rejected:', data['error-codes']);
        return data.success === true;
    } catch (err) {
        console.error('reCAPTCHA verification failed:', err);
        return false;
    }
}

// POST /api/auth/register — patient self-registration only.
// Does NOT create the account yet. The validated signup (with the password
// already hashed) is parked in pending_registrations, and an emailed link
// finishes the job via POST /verify-registration. Nothing is inserted into
// `users` until the email address is proven to belong to the registrant.
router.post('/register', async (req, res) => {
    let { first_name, last_name, email, phone, password, sex, captcha_token } = req.body;
    const ip_address = getIp(req);

    if (!first_name || !last_name || !email || !password || !sex) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    first_name = first_name.trim();
    last_name = last_name.trim();
    email = email.trim();
    phone = (phone || '').trim();

    if (!NAME_PATTERN.test(first_name) || !NAME_PATTERN.test(last_name)) {
        return res.status(400).json({ error: 'Names may only contain letters, spaces, hyphens, apostrophes, and periods.' });
    }
    if (!EMAIL_PATTERN.test(email) || email.length > 150) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (phone && !PHONE_PATTERN.test(phone)) {
        return res.status(400).json({ error: 'Phone number may only contain digits.' });
    }
    if (!['M', 'F'].includes(sex)) {
        return res.status(400).json({ error: 'Invalid value for sex.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    // Checked last on purpose: a captcha token is single-use, so a typo in the
    // form above shouldn't burn it.
    if (!captcha_token || typeof captcha_token !== 'string' || !(await verifyCaptcha(captcha_token))) {
        return res.status(400).json({ error: 'Please complete the captcha and try again.' });
    }

    try {
        // Fail fast if a real account already exists (same behavior as before).
        const [existing] = await db.query('SELECT user_id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(409).json({ error: 'An account with this email already exists.' });
        }

        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

        // Raw token goes in the emailed link; only its hash is stored.
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_HOURS * 60 * 60 * 1000);

        // Housekeeping + "latest signup wins": re-submitting the form for the
        // same email replaces the earlier pending row, so only the newest
        // link works (this doubles as "resend verification email").
        await db.query('DELETE FROM pending_registrations WHERE expires_at < NOW() OR email = ?', [email]);
        await db.query(
            `INSERT INTO pending_registrations
             (first_name, last_name, email, phone, password_hash, sex, token_hash, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [first_name, last_name, email, phone, password_hash, sex, tokenHash, expiresAt]
        );

        const verifyLink = `${process.env.APP_BASE_URL || 'http://localhost:3000'}/LogInRegister/VerifyEmail.html?token=${rawToken}`;
        const safeName = escapeHtml(first_name);

        try {
            await sendEmail({
                to: email,
                ...verifyRegistration({ firstName: first_name, link: verifyLink, hours: VERIFY_TOKEN_TTL_HOURS })
            });
        } catch (mailErr) {
            // Don't leave a pending row nobody can ever activate.
            await db.query('DELETE FROM pending_registrations WHERE token_hash = ?', [tokenHash]);
            console.error('Verification email failed to send:', mailErr);
            return res.status(502).json({ error: 'We could not send the confirmation email. Please check the address and try again.' });
        }

        await logActivity(db, {
            user_id: null,
            user_email: email,
            user_role: 'unregistered',
            action: 'CREATE_USER',
            target_table: 'pending_registrations',
            notes: `Registration started for ${first_name} ${last_name}; awaiting email confirmation.`,
            ip_address
        });

        res.status(202).json({
            message: 'Almost done! We sent a confirmation link to your email. Open it to finish creating your account.'
        });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/auth/verify-registration
// Called by VerifyEmail.html with the token from the emailed link. This is
// where the real `users` row gets created. POST (not GET) on purpose: email
// security scanners auto-"click" links with GET requests, which would burn
// a single-use token before the person ever sees it.
router.post('/verify-registration', async (req, res) => {
    const { token } = req.body;
    const ip_address = getIp(req);

    if (!token || typeof token !== 'string') {
        return res.status(400).json({ error: 'Missing verification token.' });
    }

    try {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        const [pendingRows] = await db.query(
            `SELECT pending_id, first_name, last_name, email, phone, password_hash, sex
             FROM pending_registrations
             WHERE token_hash = ? AND expires_at > NOW()`,
            [tokenHash]
        );

        if (pendingRows.length === 0) {
            return res.status(400).json({ error: 'This confirmation link is invalid or has expired. Please register again.' });
        }

        const p = pendingRows[0];

        // role is hardcoded to 'patient'
        await db.query(
            'CALL sp_register_user(?, ?, ?, ?, ?, ?, ?, @new_id)',
            [p.first_name, p.last_name, p.email, p.phone, p.password_hash, p.sex, 'patient']
        );
        const [[{ '@new_id': newUserId }]] = await db.query('SELECT @new_id AS `@new_id`');

        // Single-use: remove the pending row now that the account exists.
        await db.query('DELETE FROM pending_registrations WHERE pending_id = ?', [p.pending_id]);

        const [rows] = await db.query('SELECT user_id, role FROM users WHERE user_id = ?', [newUserId]);
        const newUser = rows[0];

        await logActivity(db, {
            user_id: newUser.user_id,
            user_email: p.email,
            user_role: newUser.role,
            action: 'CREATE_USER',
            target_table: 'users',
            target_id: newUser.user_id,
            notes: `New patient confirmed email and registered (${p.first_name} ${p.last_name}).`,
            ip_address
        });

        // No auth cookie here: the person logs in normally afterwards.
        res.status(201).json({ message: 'Email confirmed! Your account is ready. You can now log in.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            // Link was already used (double-click) or the email was
            // registered some other way in the meantime.
            return res.status(409).json({ error: 'This account has already been confirmed. You can log in.' });
        }
        console.error('Verify registration error:', err);
        res.status(500).json({ error: 'Something went wrong. Please try again later.' });
    }
});

// GET /api/auth/login
router.get('/login', async (req, res) => {
    // eli: fixed destructuring bug that caused 400 error on load
    const email = req.query.email;

    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }

    try {
        // eli to eli: we now query the DB to return 429 if locked, which tells the frontend to keep fields disabled on refresh
        const [rows] = await db.query('SELECT is_locked FROM users WHERE email = ?', [email]);
        if (rows.length > 0 && rows[0].is_locked) {
            return res.status(429).json({ error: 'Account is locked' });
        }
        return res.status(200).json({ status: "ok" });
    } catch (err) {
        console.error('Check locked status error:', err);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});


// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const ip_address = getIp(req);

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        const user = rows[0];

        if (!user) {
            await logActivity(db, {
                user_id: null,
                user_email: email,
                user_role: 'unregistered',
                action: 'FAILED_LOGIN',
                target_table: 'users',
                notes: 'Login attempt for an email with no matching account.',
                ip_address
            });
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        if (user.account_status === 'suspended') {
            await logActivity(db, {
                user_id: user.user_id,
                user_email: user.email,
                user_role: user.role,
                action: 'FAILED_LOGIN',
                target_table: 'users',
                target_id: user.user_id,
                notes: 'Login attempt blocked — account is suspended.',
                ip_address
            });
            return res.status(403).json({ error: 'This account has been suspended. Please contact the clinic.' });
        }

        // eli to eli: locked user can't keep guessing password even correct password isn't accepted
        if (user.is_locked) {
            await logActivity(db, {
                user_id: user.user_id,
                user_email: user.email,
                user_role: user.role,
                action: 'FAILED_LOGIN',
                target_table: 'users',
                target_id: user.user_id,
                notes: 'Login attempt blocked — account is locked.',
                ip_address
            });
            return res.status(429).json({ error: LOCKED_MESSAGE });
        }

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            // Increment, then read the new value back. (Not done as one
            // UPDATE with a comparison, because assignments inside a single
            // UPDATE are evaluated left-to-right and that ordering is easy
            // to get subtly wrong.)

            const newAttempts = user.login_attempts + 1;
            const isLocked = newAttempts >= MAX_LOGIN_ATTEMPTS;
            await db.query(
                'UPDATE users SET login_attempts = ?, is_locked = ? WHERE user_id = ?',
                [newAttempts, isLocked, user.user_id]
            );

            // eli to eli: removed the buggy destructured query that crashed the server. Reused `isLocked` and `newAttempts` from above instead.
            if (isLocked) {
                // eli: moved io initialization up to fix ReferenceError
                const io = req.app.get('io');
                if (io) io.emit('user-locked', {userId: user.user_id});

                // update userManage of the account lockout
                await db.query('UPDATE users SET is_locked = TRUE WHERE user_id = ?', [user.user_id]);
                await logActivity(db, {
                    user_id: user.user_id,
                    user_email: user.email,
                    user_role: user.role,
                    action: 'ACCOUNT_LOCKED',
                    target_table: 'users',
                    target_id: user.user_id,
                    notes: `Account locked after ${newAttempts} failed login attempts.`,
                    ip_address
                });
                return res.status(429).json({ error: LOCKED_MESSAGE });
            }


            await logActivity(db, {
                user_id: user.user_id,
                user_email: user.email,
                user_role: user.role,
                action: 'FAILED_LOGIN',
                target_table: 'users',
                target_id: user.user_id,
                notes: `Incorrect password (attempt ${newAttempts} of ${MAX_LOGIN_ATTEMPTS}).`,
                ip_address
            });
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Successful login — clear any earlier failed attempts so they
        // don't accumulate across days and eventually lock a real user out.
        if (user.login_attempts > 0) {
            await db.query('UPDATE users SET login_attempts = 0 WHERE user_id = ?', [user.user_id]);
        }

        const token = jwt.sign(
            { user_id: user.user_id, role: user.role, public_id: user.public_id },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        setAuthCookie(res, token);

        await logActivity(db, {
            user_id: user.user_id,
            user_email: user.email,
            user_role: user.role,
            action: 'LOGIN',
            target_table: 'users',
            target_id: user.user_id,
            ip_address
        });

        res.json({
            token,
            user: {
                user_id: user.user_id,
                public_id: user.public_id,
                first_name: user.first_name,
                last_name: user.last_name,
                role: user.role
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/auth/forgot-password
// Always responds with the same generic message whether or not the email
// is registered — this prevents the endpoint being used to check which
// emails have an account (user enumeration).
router.post('/forgot-password', async (req, res) => {
    let { email } = req.body;
    const ip_address = getIp(req);

    if (!email || !EMAIL_PATTERN.test(email = email.trim())) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const genericResponse = {
        message: 'If an account exists for that email, a password reset link has been sent.'
    };

    try {
        const [rows] = await db.query('SELECT user_id, role FROM users WHERE email = ?', [email]);

        if (rows.length === 0) {
            await logActivity(db, {
                user_id: null,
                user_email: email,
                user_role: 'unregistered',
                action: 'PASSWORD_RESET_REQUESTED',
                target_table: 'users',
                notes: 'Reset requested for an email with no matching account.',
                ip_address
            });
            // Same response as the success path — see comment above.
            return res.json(genericResponse);
        }

        const { user_id: userId, role } = rows[0];

        // The raw token goes in the emailed link; only its hash is stored,
        // the same principle as never storing a plain password.
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

        // Invalidate any earlier still-pending reset requests for this user
        // so only the newest link works.
        await db.query('DELETE FROM password_resets WHERE user_id = ?', [userId]);
        await db.query(
            'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
            [userId, tokenHash, expiresAt]
        );

        const resetLink = `${process.env.APP_BASE_URL || 'http://localhost:3000'}/LogInRegister/ChangePass.html?token=${rawToken}`;

        await sendEmail({
            to: email,
            ...passwordReset({ resetLink, minutes: RESET_TOKEN_TTL_MINUTES })
        });

        await logActivity(db, {
            user_id: userId,
            user_email: email,
            user_role: role,
            action: 'PASSWORD_RESET_REQUESTED',
            target_table: 'users',
            target_id: userId,
            ip_address
        });

        res.json(genericResponse);
    } catch (err) {
        console.error('Forgot password error:', err);
        // Still don't leak whether the email exists on failure.
        res.status(500).json({ error: 'Something went wrong. Please try again later.' });
    }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;
    const ip_address = getIp(req);

    if (!token || !password) {
        return res.status(400).json({ error: 'Missing token or new password.' });
    }
    if (password.length < 8 || password.length > 100) {
        return res.status(400).json({ error: 'Password must be between 8 and 100 characters.' });
    }

    try {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        const [rows] = await db.query(
            `SELECT reset_id, user_id FROM password_resets
             WHERE token_hash = ? AND used = FALSE AND expires_at > NOW()`,
            [tokenHash]
        );

        if (rows.length === 0) {
            return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
        }

        const { reset_id, user_id } = rows[0];
        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

        await db.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [password_hash, user_id]);
        // Mark used rather than delete — keeps a record that the token
        // was consumed, and a second submit with the same token still
        // correctly fails the "used = FALSE" check above.
        await db.query('UPDATE password_resets SET used = TRUE WHERE reset_id = ?', [reset_id]);

        const [[{ role } = {}]] = await db.query('SELECT role FROM users WHERE user_id = ?', [user_id]);

        await logActivity(db, {
            user_id,
            user_role: role,
            action: 'PASSWORD_CHANGED',
            target_table: 'users',
            target_id: user_id,
            notes: 'Password changed via emailed reset link.',
            ip_address
        });

        res.json({ message: 'Password reset successful. You can now log in with your new password.' });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ error: 'Something went wrong. Please try again later.' });
    }
});

// GET /api/auth/me
// pageProtection.js calls this on every protected page load to confirm the
// token is still valid and to get the live role (in case an admin changed
// it since the token was issued). authenticateToken already re-checks
// account_status/is_locked against the DB and populates req.user, so this
// route just needs to hand that back.
router.get('/me', authenticateToken, (req, res) => {
    res.json({
        user_id: req.user.user_id,
        public_id: req.user.public_id,
        role: req.user.role
    });
});

// POST /api/auth/logout
// Called by pageProtection.js's window.logout(). Must clear the httpOnly
// cookie server-side — clearing localStorage alone leaves the cookie
// behind, which can still authenticate requests on its own. Deliberately
// NOT behind authenticateToken: logout must still succeed (and clear the
// cookie) even with an expired/invalid token, so the token is decoded
// best-effort here just to attribute the log entry, not to gate access.
router.post('/logout', async (req, res) => {
    const token = extractToken(req);

    if (token) {
        jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
            if (!err && decoded) {
                logActivity(db, {
                    user_id: decoded.user_id,
                    user_role: decoded.role,
                    action: 'LOGOUT',
                    target_table: 'users',
                    target_id: decoded.user_id,
                    ip_address: getIp(req)
                }).catch(() => {});
            }
        });
    }

    clearAuthCookie(res);
    res.json({ message: 'Logged out' });
});

// POST /api/auth/reauth
// Called by passwordGate.js. Re-checks the current password for an
// already-authenticated user before revealing gated content — this is a
// step-up check, not a login, so it doesn't issue a new token or cookie.
router.post('/reauth', authenticateToken, async (req, res) => {
    const { password } = req.body;

    if (!password) {
        return res.status(400).json({ error: 'Password is required.' });
    }

    try {
        const [rows] = await db.query('SELECT password_hash FROM users WHERE user_id = ?', [req.user.user_id]);
        const user = rows[0];

        if (!user) {
            return res.status(401).json({ error: 'Invalid session.' });
        }

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Incorrect password.' });
        }

        res.json({ message: 'Re-authenticated.' });
    } catch (err) {
        console.error('Reauth error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;