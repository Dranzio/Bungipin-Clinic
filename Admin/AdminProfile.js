const authenticateToken = require('../authmiddleware');

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Admins only' });
    }
    next();
}

function registerAdminProfileRoute(app, db) {

    // GET /api/admin-profile — powers Admin_Sidebar.js's name/email/avatar display
    app.get('/api/admin-profile', authenticateToken, requireAdmin, async (req, res) => {
        try {
            const [rows] = await db.query(
                `SELECT u.user_id, u.public_id, u.first_name, u.last_name, u.email,
                        ap.permission_level
                 FROM users u
                 LEFT JOIN admin_profiles ap ON ap.admin_id = u.user_id
                 WHERE u.user_id = ?`,
                [req.user.user_id]
            );

            if (rows.length === 0) {
                return res.status(404).json({ message: 'Admin profile not found' });
            }

            // No profile_picture/image_url column exists yet — Admin_Sidebar.js
            // already handles that being absent by falling back to the default
            // avatar, so nothing else to add here until that column exists.
            res.json(rows[0]);
        } catch (err) {
            console.error('Admin profile load error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });
}

module.exports = registerAdminProfileRoute;