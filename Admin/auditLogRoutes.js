/**
 * ============================================================================
 * ACTIVITY LOG ROUTES & AUDIT LOGGER HELPER
 * (Enforces Philippine Standard Time UTC+8 on Vercel/Cloud MySQL)
 * ============================================================================
 */

const authenticateToken = require('../authMiddleware');

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Admins only' });
    }
    next();
}

/**
 * Universal logging helper. Safely writes to activity_logs table.
 */
async function logActivity(db, {
    user_id = null,
    user_email = null,
    user_role = 'unregistered',
    action,
    target_table = 'system',
    target_id = null,
    notes = null,
    ip_address = null
}) {
    try {
        await db.query(
            `INSERT INTO activity_logs 
             (user_id, user_email, user_role, action, target_table, target_id, notes, ip_address) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                user_id || null,
                user_email ? String(user_email).slice(0, 100) : null,
                ['admin', 'employee', 'patient', 'unregistered'].includes(user_role) ? user_role : 'unregistered',
                String(action).slice(0, 80),
                String(target_table).slice(0, 60),
                target_id || null,
                notes ? String(notes) : null,
                ip_address ? String(ip_address).slice(0, 45) : null
            ]
        );
    } catch (err) {
        console.error('Failed to write activity log:', err);
    }
}

function registerActivityLogRoutes(app, db) {

    // GET /api/activity-logs (Admin only, converted to Philippine Time UTC+8)
    // eli change: audit logs are now SUPER ADMIN ONLY (regular admins are the ones being audited)
    app.get('/api/activity-logs', authenticateToken, requireAdmin, authenticateToken.requireSuperAdmin, async (req, res) => {
        try {
            const {
                role = 'all',
                action = 'all',
                startDate,
                endDate,
                search = ''
            } = req.query;

            const conditions = ['1=1'];
            const params = [];

            // 1. Role Filter
            if (role && role !== 'all') {
                conditions.push('l.user_role = ?');
                params.push(role);
            }

            // 2. Action Filter
            if (action && action !== 'all') {
                conditions.push('l.action = ?');
                params.push(action);
            }

            // 3. Date Range Filter (Evaluated against PH Time UTC+8)
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (startDate && dateRegex.test(startDate)) {
                conditions.push("CONVERT_TZ(l.created_at, '+00:00', '+08:00') >= ?");
                params.push(`${startDate} 00:00:00`);
            }
            if (endDate && dateRegex.test(endDate)) {
                conditions.push("CONVERT_TZ(l.created_at, '+00:00', '+08:00') <= ?");
                params.push(`${endDate} 23:59:59`);
            }

            // 4. Keyword Search
            if (search.trim()) {
                const term = `%${search.trim()}%`;
                conditions.push(`(
                    u.first_name LIKE ? OR 
                    u.last_name LIKE ? OR 
                    l.user_email LIKE ? OR 
                    l.action LIKE ? OR 
                    l.target_table LIKE ? OR 
                    l.notes LIKE ? OR 
                    l.ip_address LIKE ?
                )`);
                params.push(term, term, term, term, term, term, term);
            }

            const whereClause = conditions.join(' AND ');

            // Retrieve records with created_at explicitly converted to PH Time (+08:00)
            const [rows] = await db.query(
                `SELECT 
                    l.log_id,
                    l.user_id,
                    COALESCE(NULLIF(CONCAT_WS(' ', u.first_name, u.last_name), ''), 'Unregistered User') AS user_full_name,
                    COALESCE(u.email, l.user_email, 'N/A') AS email,
                    l.user_role,
                    l.action,
                    l.target_table,
                    l.target_id,
                    l.notes,
                    l.ip_address,
                    CONVERT_TZ(l.created_at, '+00:00', '+08:00') AS created_at
                 FROM activity_logs l
                 LEFT JOIN users u ON l.user_id = u.user_id
                 WHERE ${whereClause}
                 ORDER BY l.created_at DESC`,
                params
            );

            res.json({ data: rows });

        } catch (err) {
            console.error('Activity logs query error:', err);
            res.status(500).json({ message: 'Failed to retrieve activity logs' });
        }
    });
}

module.exports = { registerActivityLogRoutes, logActivity };