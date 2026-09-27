const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const authenticateToken = require('../authMiddleware');

const ICON_DIR = path.join(__dirname, '..', 'uploads', 'services');
const MAX_ICON_BYTES = 2 * 1024 * 1024;

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Admins only' });
    }
    next();
}

// The page sends the icon as a base64 data URL (FileReader). services.icon is
// VARCHAR(255), so write the image to /uploads/services and store only the URL.
// Existing URLs (unchanged icon on edit) pass straight through.
function resolveIcon(icon) {
    if (!icon) return null;

    if (!icon.startsWith('data:')) {
        // Unchanged icon on edit — must actually look like a path or URL we
        // generated, not arbitrary text an admin (or a compromised admin
        // session) could smuggle into an <img src> attribute on the client.
        if (!/^(\/uploads\/services\/[\w.-]+|https?:\/\/[^\s"'<>]+)$/.test(icon)) {
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

    fs.mkdirSync(ICON_DIR, { recursive: true });
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const filename = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(ICON_DIR, filename), buffer);
    return `/uploads/services/${filename}`;
}

function toService(row) {
    return { ...row, price: Number(row.price) }; // DECIMAL comes back as a string
}

function validate(body) {
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const price = Number(body.price);
    if (!label || label.length > 100) return { error: 'Service name is required (max 100 characters)' };
    if (!Number.isFinite(price) || price < 0) return { error: 'Price must be a valid non-negative number' };
    return { label, price };
}

function registerServiceRoutes(app, db) {

    // Any logged-in user (patients need this for booking too)
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
            const icon = resolveIcon(req.body.icon);
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
            const icon = resolveIcon(req.body.icon);
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
            // appointments.service_id is ON DELETE RESTRICT
            if (err.code === 'ER_ROW_IS_REFERENCED_2') {
                return res.status(409).json({ message: 'This service has appointments booked against it and cannot be deleted.' });
            }
            console.error('Service delete error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });
}

module.exports = registerServiceRoutes;