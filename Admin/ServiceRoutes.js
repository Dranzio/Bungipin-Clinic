const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { put } = require('@vercel/blob');
const authenticateToken = require('../authMiddleware');

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
        specialization: row.required_specialization || 'General Dentist'
    };
}

function validate(body) {
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const price = Number(body.price);
    const duration = parseInt(body.duration_minutes, 10) || 30;
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

    return { label, price, duration_minutes: duration, required_specialization: spec };
}

function registerServiceRoutes(app, db) {
    // 1. GET /api/services — Includes duration_minutes and required_specialization
    app.get('/api/services', authenticateToken, async (req, res) => {
        try {
            const [rows] = await db.query(
                `SELECT service_id, label, price, duration_minutes, required_specialization, icon, is_available 
                 FROM services 
                 WHERE is_available = TRUE 
                 ORDER BY service_id`
            );
            res.json(rows.map(toService));
        } catch (err) {
            console.error('Service list error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // 2. POST /api/services — Inserts all service attributes
    app.post('/api/services', authenticateToken, requireAdmin, async (req, res) => {
        const v = validate(req.body);
        if (v.error) return res.status(400).json({ message: v.error });

        try {
            const icon = await resolveIcon(req.body.icon);
            const [result] = await db.query(
                `INSERT INTO services (label, price, duration_minutes, required_specialization, icon) 
                 VALUES (?, ?, ?, ?, ?)`,
                [v.label, v.price, v.duration_minutes, v.required_specialization, icon]
            );
            const [[row]] = await db.query('SELECT * FROM services WHERE service_id = ?', [result.insertId]);
            res.status(201).json(toService(row));
        } catch (err) {
            if (err.status) return res.status(err.status).json({ message: err.message });
            console.error('Service create error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // 3. PUT /api/services/:id — Updates all service attributes
    app.put('/api/services/:id', authenticateToken, requireAdmin, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid service id' });

        const v = validate(req.body);
        if (v.error) return res.status(400).json({ message: v.error });

        try {
            const icon = await resolveIcon(req.body.icon);
            const [result] = await db.query(
                `UPDATE services 
                 SET label = ?, price = ?, duration_minutes = ?, required_specialization = ?, icon = ? 
                 WHERE service_id = ?`,
                [v.label, v.price, v.duration_minutes, v.required_specialization, icon, id]
            );
            if (result.affectedRows === 0) return res.status(404).json({ message: 'Service not found' });

            const [[row]] = await db.query('SELECT * FROM services WHERE service_id = ?', [id]);
            res.json(toService(row));
        } catch (err) {
            if (err.status) return res.status(err.status).json({ message: err.message });
            console.error('Service update error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // 4. DELETE /api/services/:id
    app.delete('/api/services/:id', authenticateToken, requireAdmin, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid service id' });

        try {
            const [result] = await db.query('DELETE FROM services WHERE service_id = ?', [id]);
            if (result.affectedRows === 0) return res.status(404).json({ message: 'Service not found' });
            res.json({ message: 'Service deleted' });
        } catch (err) {
            if (err.code === 'ER_ROW_IS_REFERENCED_2') {
                return res.status(409).json({ message: 'This service has appointments booked against it and cannot be deleted.' });
            }
            console.error('Service delete error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });
}

module.exports = registerServiceRoutes;