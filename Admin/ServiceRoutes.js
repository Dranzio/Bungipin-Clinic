const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { put } = require('@vercel/blob');
const authenticateToken = require('../authMiddleware');
const { logActivity } = require('./auditLogRoutes');

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}

const ICON_DIR = path.join(__dirname, '..', 'uploads', 'services');
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const isVercel = process.env.VERCEL === '1' || !!process.env.BLOB_READ_WRITE_TOKEN;

const ALLOWED_SPECIALIZATIONS = [
    'General Dentist',
    'Pediatric Dentist',
    'Orthodontist',
    'Endodontist',
    'Oral Surgeon',
    'Periodontist',
    'Prosthodontist',
    'Oral Pathologist',
    'Oral Radiologist'
];

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Admins only' });
    }
    next();
}

async function resolveIcon(icon) {
    if (!icon) return null;
    if (!icon.startsWith('data:')) {
        if (!/^(\/uploads\/services\/[\w.-]+|\.\.\/assets\/[\w.-]+|\/assets\/[\w.-]+|https?:\/\/[^\s"'<>]+)$/.test(icon)) {
            const err = new Error('Invalid icon value');
            err.status = 400;
            throw err;
        }
        return icon;
    }

    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(icon);
    if (!match) {
        const err = new Error('Icon must be a PNG, JPEG, WEBP or GIF image');
        err.status = 400;
        throw err;
    }

    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_ICON_BYTES) {
        const err = new Error('Icon must be 2 MB or smaller');
        err.status = 400;
        throw err;
    }

    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const filename = `${crypto.randomUUID()}.${ext}`;

    if (isVercel) {
        try {
            const blob = await put(`services/${filename}`, buffer, {
                access: 'public',
                contentType: `image/${match[1]}`,
            });
            return blob.url;
        } catch (uploadErr) {
            const err = new Error('Failed to upload icon image to cloud storage');
            err.status = 500;
            throw err;
        }
    } else {
        try {
            fs.mkdirSync(ICON_DIR, { recursive: true });
            fs.writeFileSync(path.join(ICON_DIR, filename), buffer);
            return `/uploads/services/${filename}`;
        } catch (localErr) {
            const err = new Error('Failed to save icon locally');
            err.status = 500;
            throw err;
        }
    }
}

function toService(row) {
    return {
        ...row,
        price: Number(row.price),
        duration_minutes: Number(row.duration_minutes || 30),
        required_specialization: row.required_specialization || 'General Dentist',
        specialization: row.required_specialization || 'General Dentist',
        description: row.description || '',
        is_available: row.is_available === 1 || row.is_available === true
    };
}

function validate(body) {
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const price = Number(body.price);
    const duration = parseInt(body.duration_minutes, 10) || 30;
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const spec = typeof body.specialization === 'string'
        ? body.specialization.trim()
        : (typeof body.required_specialization === 'string' ? body.required_specialization.trim() : 'General Dentist');

    if (!label || label.length < 2 || label.length > 80) {
        return { error: 'Service name is required (2 to 80 characters).' };
    }

    if (/[%$^*<>{}[\]\\;~|_+=]/.test(label)) {
        return { error: 'Service name contains forbidden symbols.' };
    }

    if (/([()\-',/.]){2,}/.test(label)) {
        return { error: 'Service name cannot contain repeated punctuation characters.' };
    }

    const openCount = (label.match(/\(/g) || []).length;
    const closeCount = (label.match(/\)/g) || []).length;
    if (openCount !== closeCount) {
        return { error: 'Parentheses must be properly closed.' };
    }

    const cleanTitleRegex = /^[A-Za-z0-9][A-Za-z0-9\s\-',/().]*[A-Za-z0-9.)]$/;
    if (!cleanTitleRegex.test(label)) {
        return { error: 'Service name must start and end with valid characters.' };
    }

    if (!Number.isFinite(price) || price < 0 || price > 1500000) {
        return { error: 'Price must be a valid number between 0 and 1,500,000 PHP.' };
    }

    if (duration < 5 || duration > 480) {
        return { error: 'Duration must be between 5 and 480 minutes.' };
    }

    if (!ALLOWED_SPECIALIZATIONS.includes(spec)) {
        return { error: 'Invalid dentist specialization selected.' };
    }

    if (description.length > 1000) {
        return { error: 'Service description cannot exceed 1000 characters.' };
    }

    return { label, price, duration_minutes: duration, required_specialization: spec, description };
}

function registerServiceRoutes(app, db) {
    // 0. GET /api/public/services — no login needed. Used by the public homepage.
    //    All enabled services, only the fields the homepage shows.
    app.get('/api/public/services', async (req, res) => {
        try {
            const [rows] = await db.query(
                `SELECT service_id, label, description, price, icon
                 FROM services WHERE is_available = TRUE ORDER BY service_id`
            );
            res.set('Cache-Control', 'no-store');
            res.json(rows.map(r => ({
                service_id: r.service_id,
                label: r.label,
                description: r.description || '',
                price: r.price === null || r.price === undefined ? null : Number(r.price),
                icon: r.icon || null
            })));
        } catch (err) {
            console.error('Public service list error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // 1. GET /api/services — Returns all for admins, active only for patients
    app.get('/api/services', authenticateToken, async (req, res) => {
        try {
            const isAdmin = req.user && req.user.role === 'admin';
            const sql = isAdmin
                ? `SELECT service_id, label, price, duration_minutes, required_specialization, description, icon, is_available 
                   FROM services ORDER BY service_id`
                : `SELECT service_id, label, price, duration_minutes, required_specialization, description, icon, is_available 
                   FROM services WHERE is_available = TRUE ORDER BY service_id`;

            const [rows] = await db.query(sql);
            res.json(rows.map(toService));
        } catch (err) {
            console.error('Service list error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // 2. POST /api/services
    app.post('/api/services', authenticateToken, requireAdmin, async (req, res) => {
        const v = validate(req.body);
        if (v.error) return res.status(400).json({ message: v.error });

        try {
            const icon = await resolveIcon(req.body.icon);
            const [result] = await db.query(
                `INSERT INTO services (label, price, duration_minutes, required_specialization, description, icon, is_available) 
                 VALUES (?, ?, ?, ?, ?, ?, 1)`,
                [v.label, v.price, v.duration_minutes, v.required_specialization, v.description, icon]
            );
            const [[row]] = await db.query('SELECT * FROM services WHERE service_id = ?', [result.insertId]);

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: 'CREATE_SERVICE',
                target_table: 'services',
                target_id: result.insertId,
                notes: `Created service "${v.label}" at ₱${v.price}.`,
                ip_address: getIp(req)
            });

            res.status(201).json(toService(row));
        } catch (err) {
            if (err.status) return res.status(err.status).json({ message: err.message });
            console.error('Service create error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // 3. PUT /api/services/:id
    app.put('/api/services/:id', authenticateToken, requireAdmin, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid service id' });

        const v = validate(req.body);
        if (v.error) return res.status(400).json({ message: v.error });

        try {
            const icon = await resolveIcon(req.body.icon);
            const [result] = await db.query(
                `UPDATE services 
                 SET label = ?, price = ?, duration_minutes = ?, required_specialization = ?, description = ?, icon = ? 
                 WHERE service_id = ?`,
                [v.label, v.price, v.duration_minutes, v.required_specialization, v.description, icon, id]
            );
            if (result.affectedRows === 0) return res.status(404).json({ message: 'Service not found' });

            const [[row]] = await db.query('SELECT * FROM services WHERE service_id = ?', [id]);

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: 'UPDATE_SERVICE',
                target_table: 'services',
                target_id: id,
                notes: `Updated service "${v.label}" to ₱${v.price}.`,
                ip_address: getIp(req)
            });

            res.json(toService(row));
        } catch (err) {
            if (err.status) return res.status(err.status).json({ message: err.message });
            console.error('Service update error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // 4. Toggle Status: PATCH / PUT /api/services/:id/status
    const handleStatusToggle = async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid service id' });

        try {
            const [[existing]] = await db.query('SELECT service_id, label, is_available FROM services WHERE service_id = ?', [id]);
            if (!existing) return res.status(404).json({ message: 'Service not found' });

            const current = existing.is_available === 1 || existing.is_available === true;
            const newStatus = current ? 0 : 1; // Integer 0/1 for MySQL TINYINT

            await db.query('UPDATE services SET is_available = ? WHERE service_id = ?', [newStatus, id]);

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: newStatus === 1 ? 'ENABLE_SERVICE' : 'DISABLE_SERVICE',
                target_table: 'services',
                target_id: id,
                notes: `${newStatus === 1 ? 'Enabled' : 'Disabled'} service "${existing.label}".`,
                ip_address: getIp(req)
            });

            res.json({
                service_id: id,
                is_available: Boolean(newStatus),
                message: `Service "${existing.label}" has been ${newStatus === 1 ? 'enabled' : 'disabled'}.`
            });
        } catch (err) {
            console.error('Service status toggle error:', err);
            res.status(500).json({ message: 'Database error: ' + err.message });
        }
    };

    app.patch('/api/services/:id/status', authenticateToken, requireAdmin, handleStatusToggle);
    app.put('/api/services/:id/status', authenticateToken, requireAdmin, handleStatusToggle);

    // 5. DELETE /api/services/:id
    app.delete('/api/services/:id', authenticateToken, requireAdmin, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid service id' });

        try {
            const [[existing] = []] = await db.query('SELECT label FROM services WHERE service_id = ?', [id]);
            const [result] = await db.query('DELETE FROM services WHERE service_id = ?', [id]);
            if (result.affectedRows === 0) return res.status(404).json({ message: 'Service not found' });

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: 'DELETE_SERVICE',
                target_table: 'services',
                target_id: id,
                notes: existing ? `Deleted service "${existing.label}".` : `Deleted service #${id}.`,
                ip_address: getIp(req)
            });

            res.json({ message: 'Service deleted' });
        } catch (err) {
            if (err.code === 'ER_ROW_IS_REFERENCED_2') {
                return res.status(409).json({ message: 'This service has appointments booked against it and cannot be deleted. You can disable it instead.' });
            }
            console.error('Service delete error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });
}

module.exports = registerServiceRoutes;