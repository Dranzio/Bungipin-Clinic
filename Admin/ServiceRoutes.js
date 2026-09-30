const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { put } = require('@vercel/blob');
const authenticateToken = require('../authMiddleware');

const ICON_DIR = path.join(__dirname, '..', 'uploads', 'services');
const MAX_ICON_BYTES = 2 * 1024 * 1024;

const isVercel = process.env.VERCEL === '1' || !!process.env.BLOB_READ_WRITE_TOKEN;

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Admins only' });
    }
    next();
}

async function resolveIcon(icon) {
    if (!icon) return null;

    if (!icon.startsWith('data:')) {
        if (!/^(\/uploads\/services\/[\w.-]+|\.\.\/assets\/[\w.-]+|https?:\/\/[^\s"'<>]+)$/.test(icon)) {
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
            console.error('Blob upload error:', uploadErr);
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
            console.error('Local file write error:', localErr);
            const err = new Error('Failed to save icon locally');
            err.status = 500;
            throw err;
        }
    }
}

function toService(row) {
    return { ...row, price: Number(row.price) };
}

// Validates title and price while allowing valid parentheses (e.g. "Root Canal (Molar)")//
function validate(body) {
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const price = Number(body.price);

    if (!label || label.length < 2 || label.length > 80) {
        return { error: 'Service name is required (2 to 80 characters).' };
    }

    // 1. Strictly forbid dangerous symbols (% $ ^ * < > etc.)
    if (/[%$^*<>{}[\]\\;~|_+=]/.test(label)) {
        return { error: 'Service name contains forbidden symbols (e.g. %, $, *, <, >).' };
    }

    // 2. Forbid repeated punctuation: (((((, ))))), -----, .....
    if (/([()\-',/.]){2,}/.test(label)) {
        return { error: 'Service name cannot contain repeated punctuation characters.' };
    }

    // 3. Parentheses balance check: allows ( ) when properly matched
    const openCount = (label.match(/\(/g) || []).length;
    const closeCount = (label.match(/\)/g) || []).length;
    if (openCount !== closeCount) {
        return { error: 'Parentheses must be properly closed (e.g. "Root Canal (Molar)").' };
    }

    // 4. Valid title structure
    const cleanTitleRegex = /^[A-Za-z0-9][A-Za-z0-9\s\-',/().]*[A-Za-z0-9.)]$/;
    if (!cleanTitleRegex.test(label)) {
        return { error: 'Service name must start and end with valid letters, numbers, or closing parenthesis.' };
    }

    if (!Number.isFinite(price) || price < 0 || price > 1500000) {
        return { error: 'Price must be a valid number between 0 and 1,000,000 PHP.' };
    }

    return { label, price };
}

function registerServiceRoutes(app, db) {
    app.get('/api/services', authenticateToken, async (req, res) => {
        try {
            const [rows] = await db.query(
                'SELECT service_id, label, price, icon, is_available FROM services ORDER BY service_id'
            );
            res.json(rows.map(toService));
        } catch (err) {
            console.error('Service list error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    app.post('/api/services', authenticateToken, requireAdmin, async (req, res) => {
        const v = validate(req.body);
        if (v.error) return res.status(400).json({ message: v.error });

        try {
            const icon = await resolveIcon(req.body.icon);
            const [result] = await db.query(
                'INSERT INTO services (label, price, icon) VALUES (?, ?, ?)',
                [v.label, v.price, icon]
            );
            const [[row]] = await db.query('SELECT * FROM services WHERE service_id = ?', [result.insertId]);
            res.status(201).json(toService(row));
        } catch (err) {
            if (err.status) return res.status(err.status).json({ message: err.message });
            console.error('Service create error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    app.put('/api/services/:id', authenticateToken, requireAdmin, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid service id' });

        const v = validate(req.body);
        if (v.error) return res.status(400).json({ message: v.error });

        try {
            const icon = await resolveIcon(req.body.icon);
            const [result] = await db.query(
                'UPDATE services SET label = ?, price = ?, icon = ? WHERE service_id = ?',
                [v.label, v.price, icon, id]
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