// eli change: NEW FILE. Stops a user from "changing" their password to the one they already have.
// No extra table: it reads users.password_hash and uses bcrypt.compare(). (bcrypt hashes cannot be decrypted;
// compare() hashes the typed password with the salt stored inside the saved hash and checks that they match.)
const bcrypt = require('bcrypt');

const REUSE_MESSAGE = "Your new password can't be the same as your current password. Please choose a different one.";

// `conn` can be the pool (db) or a transaction connection: both have .query()
async function isPasswordReused(conn, userId, newPassword) {
    const [rows] = await conn.query('SELECT password_hash FROM users WHERE user_id = ?', [userId]);
    if (!rows[0] || !rows[0].password_hash) return false;
    return bcrypt.compare(String(newPassword), rows[0].password_hash);
}

module.exports = { isPasswordReused, REUSE_MESSAGE };   