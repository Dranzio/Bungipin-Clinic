const jwt = require('jsonwebtoken');
const db = require('./db');

// Clears the httpOnly auth cookie. Attributes must match exactly what
// setAuthCookie in auth.js used to set it, or the browser won't recognize
// it as the same cookie and won't actually remove it.
function clearAuthCookie(res) {
    const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
    res.setHeader(
        'Set-Cookie',
        `authToken=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${isProd ? '; Secure' : ''}`
    );
}

async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const isPageRequest = !req.path.startsWith('/api') && req.accepts('html');

    function denyPageAccess(status, error) {
        clearAuthCookie(res);
        if (isPageRequest) {
            return res.redirect('/denied.html');
        }
        return res.status(status).json({ error });
    }

    // DENIES DIRECT PAGE ACCESS VIA URL
    const cookies = Object.fromEntries(
        (req.headers.cookie || '').split(';').filter(Boolean).map(cookie => {
            const separator = cookie.indexOf('=');
            return [cookie.slice(0, separator).trim(), decodeURIComponent(cookie.slice(separator + 1).trim())];
        })
    );
    const token = (authHeader && authHeader.split(' ')[1]) || cookies.authToken;

    if (!token) {
        return denyPageAccess(401, 'Access token required');
    }

    jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
        if (err) {
            return denyPageAccess(403, 'Invalid or expired token');
        }

        // A valid, unexpired JWT only proves this user WAS in good standing
        // at login time — up to 7 days ago. Re-check the live account state
        // on every request so a suspension, a login lockout, or a deleted
        // account takes effect immediately instead of only once this token
        // naturally expires.
        try {
            const [rows] = await db.query(
                'SELECT role, public_id, account_status, is_locked FROM users WHERE user_id = ?',
                [decoded.user_id]
            );
            const user = rows[0];

            if (!user) {
                return denyPageAccess(401, 'Account no longer exists');
            }
            if (user.account_status === 'suspended') {
                return denyPageAccess(403, 'This account has been suspended. Please contact the clinic.');
            }
            if (user.is_locked) {
                return denyPageAccess(429, 'Please contact an administrator to reset your session.');
            }

            // Use the live role/public_id from the DB rather than the
            // token's original claims, in case an admin changed the
            // user's role after this token was issued.
            req.user = { user_id: decoded.user_id, role: user.role, public_id: user.public_id };
            next();
        } catch (dbErr) {
            console.error('authenticateToken DB check failed:', dbErr);
            return res.status(500).json({ error: 'Internal Server Error' });
        }
    });
}

module.exports = authenticateToken;
module.exports.clearAuthCookie = clearAuthCookie;