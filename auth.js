const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const router = express.Router();
const db = require('./db');

// forgot + reset password
const Joi = require('@hapi/joi');

const SALT_ROUNDS = 10;

// POST /api/auth/register — patient self-registration only
router.post('/register', async (req, res) => {
    const { first_name, last_name, email, phone, password, sex } = req.body;

    if (!first_name || !last_name || !email || !password || !sex) {
        return res.status(400).json({ error: 'Missing required fields' });
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


// forgot + reset password
const FORGOT_PASSWORD_MODEL = Joi.object({
    email: Joi.string().email().required()
})

const RESET_PASSWORD_MODEL = Joi.object({
    password: Joi.string().min(8).max(100).required(),
    confirmPassword: Joi.string().min(8).max(100).required(),
    otp: Joi.number().required()
})

router.FORGOT_PASSWORD_MODEL = FORGOT_PASSWORD_MODEL;
router.RESET_PASSWORD_MODEL = RESET_PASSWORD_MODEL;

module.exports = router;