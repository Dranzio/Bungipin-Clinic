const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];

    // DENIES DIRECT PAGE ACCESS VIA URL
    const cookies = Object.fromEntries(
        (req.headers.cookie || '').split(';').filter(Boolean).map(cookie => {
            const separator = cookie.indexOf('=');
            return [cookie.slice(0, separator).trim(), decodeURIComponent(cookie.slice(separator + 1).trim())];
        })
    );
    const token = (authHeader && authHeader.split(' ')[1]) || cookies.authToken;

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = decoded;
        next();
    });
}

module.exports = authenticateToken;