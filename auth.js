const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const router = express.Router();
const db = require('./db');

//  DENIED DIRECT PAGE ACCESS VIA URL
const authenticateToken = require('./authmiddleware');

// forgot + reset password
const Joi = require('@hapi/joi');

const SALT_ROUNDS = 10;

// Letters (incl. accented), spaces, hyphens, apostrophes, periods — covers
// real names ("O'Brien", "Anne-Marie", "José") while rejecting anything
// that could carry HTML/script content, since angle brackets, quotes used
// for attribute-breakout, and semicolons are never valid in a name anyway.
const NAME_PATTERN = /^[a-zA-Z\u00C0-\u017F\s'\-.]{1,50}$/;
const PHONE_PATTERN = /^[0-9]{7,15}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = jwt.sign(
            { user_id: user.user_id, role: user.role, public_id: user.public_id },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

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

// GET /api/auth/me - validate the current session token for protected pages
router.get('/me', authenticateToken, (req, res) => {
    res.json(req.user);
});

// forgot + reset password
const FORGOT_PASSWORD_MODEL = Joi.object({
    email: Joi.string().email().required()
})

const RESET_PASSWORD_MODEL = Joi.object({
    password: Joi.string().min(8).max(100).required(),
    confirmPassword: Joi.string().min(8).max(100).required(),
    otp: Joi.number().required()
});


// keep user from accessing page via url
function requireAuth(req, res, next) {
    // check sesh or JWT token
    if(req.session && req.session.user) {
        return next(); // user allowed to page
    }

    // user not allowed; redirect to login
    return res.redirect('/login');
}

router.FORGOT_PASSWORD_MODEL = FORGOT_PASSWORD_MODEL;
router.RESET_PASSWORD_MODEL = RESET_PASSWORD_MODEL;

module.exports = router;