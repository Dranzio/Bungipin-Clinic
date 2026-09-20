const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// Authentication controllers: patient registration and user login.

/**
 * Register a patient account and its profile in one database transaction.
 * Public registration never accepts a role from the request body.
 */
async function register(req, res) {
  const conn = await pool.getConnection();
  try {
    const {
      first_name,
      last_name,
      email,
      phone,
      password,
      sex,
      birthday,
      civil_status,
      address,
    } = req.body;

    if (!first_name || !last_name || !email || !password) {
      conn.release();
      return res.status(400).json({
        message: 'first_name, last_name, email, and password are required',
      });
    }

    const [existing] = await conn.query('SELECT user_id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      conn.release();
      return res.status(409).json({ message: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await conn.beginTransaction();

    // sp_register_user inserts the user row and generates the public_id
    // (e.g. PAT-0001), returning the new user_id via an OUT parameter.
    await conn.query(
      'CALL sp_register_user(?, ?, ?, ?, ?, ?, ?, @new_user_id)',
      [first_name, last_name, email, phone || null, passwordHash, sex || null, 'patient']
    );
    const [[{ new_user_id }]] = await conn.query('SELECT @new_user_id AS new_user_id');

    await conn.query(
      'INSERT INTO patient_profiles (patient_id, birthday, civil_status, address) VALUES (?, ?, ?, ?)',
      [new_user_id, birthday || null, civil_status || null, address || null]
    );

    await conn.commit();

    res.status(201).json({
      user_id: new_user_id,
      first_name,
      last_name,
      email,
      role: 'patient',
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
}

/**
 * Verify credentials and return a JWT containing the user's id and role.
 */
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const user = rows[0];

    if (user.account_status !== 'active') {
      return res.status(403).json({ message: 'This account is suspended' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.user_id, public_id: user.public_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      user: {
        id: user.user_id,
        public_id: user.public_id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

module.exports = { register, login };
