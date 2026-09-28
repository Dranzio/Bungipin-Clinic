const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();
const db = require('./db');
const { sendEmail } = require('./Mailer');
const authenticateToken = require('./authMiddleware');
const { clearAuthCookie } = authenticateToken;

const SALT_ROUNDS = 10;
const RESET_TOKEN_TTL_MINUTES = 30;
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7d — must match jwt.sign's expiresIn below

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

// POST /api/auth/register — patient self-registration only
router.post('/register', async (req, res) => {
    let { first_name, last_name, email, phone, password, sex } = req.body;

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

    try {
        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

        // role is hardcoded to 'patient'
        await db.query(
            'CALL sp_register_user(?, ?, ?, ?, ?, ?, ?, @new_id)',
            [first_name, last_name, email, phone, password_hash, sex, 'patient']
        );
        const [[{ '@new_id': newUserId }]] = await db.query('SELECT @new_id AS `@new_id`');

        const [rows] = await db.query(
            'SELECT user_id, public_id, role FROM users WHERE user_id = ?',
            [newUserId]
        );
        const newUser = rows[0];

        const token = jwt.sign(
            { user_id: newUser.user_id, role: newUser.role, public_id: newUser.public_id },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        setAuthCookie(res, token);
        res.status(201).json({ token, user: newUser });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'An account with this email already exists.' });
        }
        console.error('Register error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/auth/login
const MAX_LOGIN_ATTEMPTS = 5;

router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        const user = rows[0];

        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        if (user.account_status === 'suspended') {
            return res.status(403).json({ error: 'This account has been suspended. Please contact the clinic.' });
        }

        // Locked accounts are rejected before the password is even checked
        if (user.is_locked) {
            return res.status(423).json({ error: 'This account is locked after too many failed attempts. Please contact an administrator.' });
        }

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            // Atomic increment; lock when the new count reaches the limit
            await db.query(
                `UPDATE users
                 SET login_attempts = login_attempts + 1,
                     is_locked = (login_attempts + 1 >= ?)
                 WHERE user_id = ?`,
                [MAX_LOGIN_ATTEMPTS, user.user_id]
            );
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Successful login clears the counter
        if (user.login_attempts > 0) {
            await db.query('UPDATE users SET login_attempts = 0 WHERE user_id = ?', [user.user_id]);
        }

        // ...jwt.sign / setAuthCookie / res.json exactly as before
    } catch (err) { /* unchanged */ }
});

// POST /api/auth/forgot-password
// Always responds with the same generic message whether or not the email
// is registered — this prevents the endpoint being used to check which
// emails have an account (user enumeration).
router.post('/forgot-password', async (req, res) => {
    let { email } = req.body;

    if (!email || !EMAIL_PATTERN.test(email = email.trim())) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const genericResponse = {
        message: 'If an account exists for that email, a password reset link has been sent.'
    };

    try {
        const [rows] = await db.query('SELECT user_id FROM users WHERE email = ?', [email]);

        if (rows.length === 0) {
            // Same response as the success path — see comment above.
            return res.json(genericResponse);
        }

        const userId = rows[0].user_id;

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
            subject: 'Reset your password',
            text: `We received a request to reset your password. This link expires in ${RESET_TOKEN_TTL_MINUTES} minutes:\n\n${resetLink}\n\nIf you didn't request this, you can ignore this email.`,
            html: `<p>We received a request to reset your password. This link expires in ${RESET_TOKEN_TTL_MINUTES} minutes:</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, you can ignore this email.</p>`
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
// behind, which can still authenticate requests on its own.
router.post('/logout', (req, res) => {
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