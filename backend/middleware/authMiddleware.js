const jwt = require('jsonwebtoken');

// Authentication middleware shared by protected appointment and service routes.

/**
 * Validate the Bearer token and attach its user claims to req.user.
 */
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // expects "Bearer <token>"

  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired token' });
    }
    req.user = decoded; // { id, email, role }
    next();
  });
}

/**
 * Restrict a route to one or more roles after verifyToken has run.
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission to do this' });
    }
    next();
  };
}

module.exports = { verifyToken, requireRole };
