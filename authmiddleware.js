const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const isPageRequest = !req.path.startsWith('/api') && req.accepts('html');

    function denyPageAccess(status, error) {
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

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            return denyPageAccess(403, 'Invalid or expired token');
        }
        req.user = decoded;
        next();
    });
}

module.exports = authenticateToken;