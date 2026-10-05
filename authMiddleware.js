const jwt = require('jsonwebtoken');
const db = require('./db');

// Active session: a session ends after this long with no activity. Keep it a
// little LONGER than the browser-side warning in InactivityTimer.js (13 min + 15 s).
const IDLE_SECONDS = 15 * 60;
// Only write last_active_at when it is at least this stale, to avoid a DB write per request.
const TOUCH_AFTER_SECONDS = 60;

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

// Pulls the token out of either the Authorization header or the authToken
// cookie. Exported so routes that need best-effort access to the current
// user (e.g. /logout, which must succeed even with a stale/invalid token)
// can reuse this without duplicating the cookie-parsing logic.
function extractToken(req) {
    const authHeader = req.headers['authorization'];
    const cookies = Object.fromEntries(
        (req.headers.cookie || '').split(';').filter(Boolean).map(cookie => {
            const separator = cookie.indexOf('=');
            return [cookie.slice(0, separator).trim(), decodeURIComponent(cookie.slice(separator + 1).trim())];
        })
    );
    return (authHeader && authHeader.split(' ')[1]) || cookies.authToken;
}

async function authenticateToken(req, res, next) {
    const isPageRequest = !req.path.startsWith('/api') && req.accepts('html');

    function denyPageAccess(status, error) {
        clearAuthCookie(res);
        if (isPageRequest) {
            return res.redirect('/denied.html');
        }
        return res.status(status).json({ error });
    }

    const token = extractToken(req);

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
                // eli change: also load the admin's permission_level (live from the DB, never from the token)
                `SELECT u.role, u.public_id, u.account_status, u.is_locked, ap.permission_level,
                        u.current_session_id,
                        (u.session_expires_at < NOW()) AS session_expired,
                        TIMESTAMPDIFF(SECOND, u.last_active_at, NOW()) AS idle_seconds
                 FROM users u
                 LEFT JOIN admin_profiles ap ON ap.admin_id = u.user_id
                 WHERE u.user_id = ?`,
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

            // Active session check. The token must carry the user's CURRENT session id
            // (a newer login, a logout, a password reset or a suspension changes/clears it),
            // and the session must be neither past its absolute expiry nor idle too long.
            // Tokens issued before this feature existed have no sid and must log in again.
            if (!decoded.sid
                || user.current_session_id !== decoded.sid
                || user.session_expired
                || user.idle_seconds === null
                || user.idle_seconds > IDLE_SECONDS) {
                return denyPageAccess(401, 'Your session has ended. Please log in again.');
            }

            // Awaited on purpose: on Vercel the function can be frozen right after the
            // response goes out, which would silently drop a fire-and-forget write.
            if (user.idle_seconds >= TOUCH_AFTER_SECONDS) {
                await db.query('UPDATE users SET last_active_at = NOW() WHERE user_id = ?', [decoded.user_id]);
            }

            // Use the live role/public_id from the DB rather than the
            // token's original claims, in case an admin changed the
            // user's role after this token was issued.
            // eli change: permission_level added ('super_admin' for the owner account, otherwise 'Admin' / null)
            req.user = { user_id: decoded.user_id, role: user.role, public_id: user.public_id, permission_level: user.permission_level };
            next();
        } catch (dbErr) {
            console.error('authenticateToken DB check failed:', dbErr);
            return res.status(500).json({ error: 'Internal Server Error' });
        }
    });
}

module.exports = authenticateToken;
module.exports.clearAuthCookie = clearAuthCookie;
module.exports.extractToken = extractToken;

// eli change: shared helpers for the super admin tier. A super admin is an admin whose
// admin_profiles.permission_level is 'super_admin'. Use AFTER authenticateToken.
function isSuperAdmin(user) {
    return !!user && user.role === 'admin' && user.permission_level === 'super_admin';
}
function requireSuperAdmin(req, res, next) {
    if (!isSuperAdmin(req.user)) {
        return res.status(403).json({ message: 'Super admin only' });
    }
    next();
}
module.exports.isSuperAdmin = isSuperAdmin;
module.exports.requireSuperAdmin = requireSuperAdmin;