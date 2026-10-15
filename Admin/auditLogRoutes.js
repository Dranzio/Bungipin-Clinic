/**
 * ============================================================================
 * ACTIVITY LOG ROUTES & AUDIT LOGGER HELPER
 * (Pool session time zone is set to +08:00 in db.js, so created_at is already
 * stored and returned in Philippine Standard Time. No CONVERT_TZ needed.)
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
    // Only accounts that exist belong in the audit trail. Events from people with no
    // account (bots guessing emails, unconfirmed sign-ups) are skipped here so that no
    // call site can flood the table by accident.
    if (!user_id || !['admin', 'employee', 'patient'].includes(user_role)) {
        return;
    }
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

/**
 * Throttled logger for people who have NO account (bots guessing emails, sign-ups
 * not yet confirmed). Instead of one row per attempt it keeps at most ONE row per
 * IP address, per action, per hour, and counts the attempts inside that row's notes.
 * These rows are saved with the 'unregistered' role, which the super admin log
 * hides unless "show guest entries" is ticked. Never throws.
 */
const GUEST_WINDOW_MINUTES = 60;

async function logGuestEvent(db, {
    action,
    target_table = 'users',
    user_email = null,
    description = '',
    ip_address = null
}) {
    try {
        const ip = ip_address ? String(ip_address).slice(0, 45) : null;
        const email = user_email ? String(user_email).slice(0, 100) : null;
        const act = String(action).slice(0, 80);

        // Is there already a row for this IP + action inside the current window?
        // (<=> is MySQL's NULL-safe equals, so a missing IP still groups together.)
        const [existing] = await db.query(
            `SELECT log_id, notes
             FROM activity_logs
             WHERE user_role = 'unregistered'
               AND action = ?
               AND ip_address <=> ?
               AND created_at >= (NOW() - INTERVAL ? MINUTE)
             ORDER BY log_id DESC
             LIMIT 1`,
            [act, ip, GUEST_WINDOW_MINUTES]
        );

        if (existing.length > 0) {
            const match = /^(\d+) attempts?/.exec(existing[0].notes || '');
            const count = (match ? parseInt(match[1], 10) : 1) + 1;
            await db.query(
                'UPDATE activity_logs SET notes = ?, user_email = COALESCE(?, user_email) WHERE log_id = ?',
                [buildGuestNotes(count, description, email), email, existing[0].log_id]
            );
            return;
        }

        await db.query(
            `INSERT INTO activity_logs
             (user_id, user_email, user_role, action, target_table, target_id, notes, ip_address)
             VALUES (NULL, ?, 'unregistered', ?, ?, NULL, ?, ?)`,
            [email, act, String(target_table).slice(0, 60), buildGuestNotes(1, description, email), ip]
        );
    } catch (err) {
        console.error('Failed to write guest log:', err);
    }
}

/**
 * Landing-page visits. Never one row per visit: the first visit in a window inserts a
 * single 'unregistered' row, every later visit in that window just bumps its counter.
 * The note reads "N visits in the past H hours". Fire-and-forget; never throws.
 * No schema change: it reuses activity_logs (user_id/ip_address stay NULL).
 */
const VISIT_WINDOW_HOURS = 1;
const LANDING_ACTION = 'LANDING_PAGE_VISIT';

function visitNote(n) {
    const h = VISIT_WINDOW_HOURS;
    return `${n} visit${n === 1 ? '' : 's'} in the past ${h === 1 ? 'hour' : h + ' hours'}`;
}

async function logLandingVisit(db) {
    try {
        // Atomic increment, so simultaneous visits don't overwrite each other's count.
        // The count is read back from the start of the note ("12 visits in ...").
        const [bump] = await db.query(
            `UPDATE activity_logs
             SET notes = CONCAT(CAST(SUBSTRING_INDEX(notes, ' ', 1) AS UNSIGNED) + 1,
                                ' visits in the past ${VISIT_WINDOW_HOURS === 1 ? 'hour' : VISIT_WINDOW_HOURS + ' hours'}')
             WHERE user_role = 'unregistered'
               AND action = ?
               AND created_at >= (NOW() - INTERVAL ? HOUR)
             ORDER BY log_id DESC
             LIMIT 1`,
            [LANDING_ACTION, VISIT_WINDOW_HOURS]
        );
        if (bump.affectedRows > 0) return;

        await db.query(
            `INSERT INTO activity_logs
             (user_id, user_email, user_role, action, target_table, target_id, notes, ip_address)
             VALUES (NULL, NULL, 'unregistered', ?, 'landing_page', NULL, ?, NULL)`,
            [LANDING_ACTION, visitNote(1)]
        );
    } catch (err) {
        console.error('Failed to write landing visit log:', err);
    }
}

function buildGuestNotes(count, description, email) {
    const lastEmail = email ? ` Latest email used: ${email}.` : '';
    return `${count} attempt${count === 1 ? '' : 's'} from this IP in the last hour. ${description}${lastEmail}`.trim();
}

function registerActivityLogRoutes(app, db) {

    const POSITIONS = ['Dentist', 'Receptionist'];
    const DEFAULT_LIMIT = 8;
    const MAX_LIMIT = 100;

    // GET /api/activity-logs (Super admin only)
    // Audit logs are SUPER ADMIN ONLY (regular admins are the ones being audited)
    // INTERNAL log: registered accounts only. Unregistered/guest rows live in
    // GET /api/external-logs below and can never appear here.
    //
    // Query params (all optional):
    //   role, position, action, startDate, endDate, search  - filters
    //   page, limit       - server-side pagination (limit is capped at 100)
    app.get('/api/activity-logs', authenticateToken, requireAdmin, authenticateToken.requireSuperAdmin, async (req, res) => {
        try {
            const {
                role = 'all',
                position = 'all',
                action = 'all',
                startDate,
                endDate,
                search = ''
            } = req.query;

            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
            const offset = (page - 1) * limit;

            // 0. Registered users only (guest / landing rows are on the external log)
            const conditions = ["l.user_role <> 'unregistered'"];
            const params = [];

            // 1. Role Filter
            if (role && role !== 'all') {
                conditions.push('l.user_role = ?');
                params.push(role);
            }

            // 2. Position Filter (Dentist / Receptionist), read from employee_profiles
            if (position && position !== 'all' && POSITIONS.includes(position)) {
                conditions.push('ep.position = ?');
                params.push(position);
            }

            // 3. Action Filter
            if (action && action !== 'all') {
                conditions.push('l.action = ?');
                params.push(action);
            }

            // 4. Date Range Filter (created_at is already PH time via session time zone)
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (startDate && dateRegex.test(startDate)) {
                conditions.push('l.created_at >= ?');
                params.push(`${startDate} 00:00:00`);
            }
            if (endDate && dateRegex.test(endDate)) {
                conditions.push('l.created_at <= ?');
                params.push(`${endDate} 23:59:59`);
            }

            // 5. Keyword Search
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
            const fromClause = `
                FROM activity_logs l
                     LEFT JOIN users u ON l.user_id = u.user_id
                     LEFT JOIN employee_profiles ep ON ep.employee_id = l.user_id`;

            const [[{ total }]] = await db.query(
                `SELECT COUNT(*) AS total ${fromClause} WHERE ${whereClause}`,
                params
            );

            const [rows] = await db.query(
                `SELECT
                     l.log_id,
                     l.user_id,
                     COALESCE(NULLIF(CONCAT_WS(' ', u.first_name, u.last_name), ''), 'Unregistered User') AS user_full_name,
                     COALESCE(u.email, l.user_email, 'N/A') AS email,
                     l.user_role,
                     ep.position AS position,
                     l.action,
                     l.target_table,
                     l.target_id,
                     l.notes,
                     l.ip_address,
                     l.created_at
                 ${fromClause}
                 WHERE ${whereClause}
                 ORDER BY l.created_at DESC, l.log_id DESC
                 LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );

            res.json({
                data: rows,
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit))
            });

        } catch (err) {
            console.error('Activity logs query error:', err);
            res.status(500).json({ message: 'Failed to retrieve activity logs' });
        }
    });

    // GET /api/external-logs (Super admin only)
    // EXTERNAL log: people without an account - landing page visit counters, failed logins
    // for unknown emails, password resets for unknown emails, unconfirmed sign-ups.
    // Query params (all optional): action, startDate, endDate, search, page, limit
    app.get('/api/external-logs', authenticateToken, requireAdmin, authenticateToken.requireSuperAdmin, async (req, res) => {
        try {
            const { action = 'all', startDate, endDate, search = '' } = req.query;

            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
            const offset = (page - 1) * limit;

            const conditions = ["l.user_role = 'unregistered'"];
            const params = [];

            if (action && action !== 'all') {
                conditions.push('l.action = ?');
                params.push(action);
            }

            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (startDate && dateRegex.test(startDate)) {
                conditions.push('l.created_at >= ?');
                params.push(`${startDate} 00:00:00`);
            }
            if (endDate && dateRegex.test(endDate)) {
                conditions.push('l.created_at <= ?');
                params.push(`${endDate} 23:59:59`);
            }

            if (search.trim()) {
                const term = `%${search.trim()}%`;
                conditions.push(`(
                    l.user_email LIKE ? OR
                    l.action LIKE ? OR
                    l.target_table LIKE ? OR
                    l.notes LIKE ? OR
                    l.ip_address LIKE ?
                )`);
                params.push(term, term, term, term, term);
            }

            const whereClause = conditions.join(' AND ');

            const [[{ total }]] = await db.query(
                `SELECT COUNT(*) AS total FROM activity_logs l WHERE ${whereClause}`,
                params
            );

            const [rows] = await db.query(
                `SELECT
                     l.log_id,
                     l.user_email AS email,
                     l.action,
                     l.target_table,
                     l.notes,
                     l.ip_address,
                     l.created_at
                 FROM activity_logs l
                 WHERE ${whereClause}
                 ORDER BY l.created_at DESC, l.log_id DESC
                 LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );

            res.json({
                data: rows,
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit))
            });

        } catch (err) {
            console.error('External logs query error:', err);
            res.status(500).json({ message: 'Failed to retrieve external logs' });
        }
    });
}

module.exports = { registerActivityLogRoutes, logActivity, logGuestEvent, logLandingVisit };