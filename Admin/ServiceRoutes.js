// MessagesRoutes.js
// Shared inbox + 1:1 chat for patients and employees.
// A patient and employee can only message each other if they share a
// non-cancelled appointment. Admins bypass the restriction.
//
// Attachments: on Vercel they are uploaded to Vercel Blob (the filesystem there
// is read-only). Locally they fall back to the ./uploads folder, same as before.
// messages.file_url stays a JSON array of URLs. It MUST be a TEXT column, since
// Blob URLs are long.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { put, del } = require('@vercel/blob');
const authenticateToken = require('./authMiddleware');

const isVercel = process.env.VERCEL === '1' || !!process.env.BLOB_READ_WRITE_TOKEN;
const uploadDir = path.join(__dirname, 'uploads'); // local development only

// Vercel rejects request bodies over ~4.5 MB, so keep uploads under that.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 10;

// Types that may be uploaded. SVG/HTML are deliberately excluded (script risk).
const ALLOWED_MIME = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain'
]);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_MIME.has(file.mimetype)) {
            return cb(new Error('This file type is not allowed. Use images, PDF, Word, Excel or text files.'));
        }
        cb(null, true);
    }
});

// Runs multer and turns its errors into clean 400 responses (instead of a raw 500).
function handleUpload(req, res, next) {
    upload.array('attachments', MAX_FILES)(req, res, (err) => {
        if (!err) return next();
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? 'A file is too large (max 4 MB per file).'
            : err.code === 'LIMIT_FILE_COUNT'
                ? `You can attach up to ${MAX_FILES} files.`
                : (err.message || 'Upload failed.');
        return res.status(400).json({ error: message });
    });
}

// Saves one uploaded file. Returns its public URL and a remove() for cleanup.
// The random UUID in the name makes the URL unguessable.
async function storeFile(file) {
    const rawExt = path.extname(file.originalname || '').toLowerCase().replace('.', '');
    const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? `.${rawExt}` : '';
    const filename = `${crypto.randomUUID()}${ext}`;

    if (isVercel) {
        const blob = await put(`messages/${filename}`, file.buffer, {
            access: 'public',
            contentType: file.mimetype
        });
        return { url: blob.url, remove: () => del(blob.url) };
    }

    fs.mkdirSync(uploadDir, { recursive: true });
    const fullPath = path.join(uploadDir, filename);
    fs.writeFileSync(fullPath, file.buffer);
    return {
        url: `/uploads/${filename}`,
        remove: async () => { try { fs.unlinkSync(fullPath); } catch (_) { /* ignore */ } }
    };
}

module.exports = function registerMessagesRoutes(app, db) {

    // Returns the list of user_ids the current user is allowed to talk to.
    async function getContactIds(userId, role) {
        let query;
        if (role === 'employee') {
            query = `SELECT DISTINCT patient_id AS contact_id FROM appointments
                     WHERE employee_id = ? AND appointment_status != 'cancelled'`;
        } else if (role === 'patient') {
            query = `SELECT DISTINCT employee_id AS contact_id FROM appointments
                     WHERE patient_id = ? AND appointment_status != 'cancelled'`;
        } else {
            // Admins aren't restricted by appointment history.
            return null;
        }
        const [rows] = await db.query(query, [userId]);
        return rows.map(r => r.contact_id);
    }

    // Checks whether userId is allowed to message contactId.
    async function hasValidRelationship(userId, role, contactId) {
        if (role === 'admin') return true;

        const contactIds = await getContactIds(userId, role);
        return contactIds !== null && contactIds.includes(Number(contactId));
    }

    // GET /api/messages/threads
    // Returns one row per eligible contact, with their latest message (if any)
    // and whether the current user has unread messages from them.
    app.get('/api/messages/threads', authenticateToken, async (req, res) => {
        try {
            const { user_id, role } = req.user;
            const contactIds = await getContactIds(user_id, role);

            if (!contactIds || contactIds.length === 0) {
                return res.json([]);
            }

            const threads = await Promise.all(contactIds.map(async (contactId) => {
                const [contactRows] = await db.query(
                    'SELECT user_id, first_name, last_name FROM users WHERE user_id = ?',
                    [contactId]
                );
                const contact = contactRows[0];
                if (!contact) return null;

                const [lastMsgRows] = await db.query(
                    `SELECT content, sender_id, file_url, sent_at FROM messages
                    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
                    ORDER BY sent_at DESC LIMIT 1`,
                    [user_id, contactId, contactId, user_id]
                );
                const lastMsg = lastMsgRows[0];

                const [unreadRows] = await db.query(
                    `SELECT COUNT(*) AS unread_count FROM messages
                     WHERE sender_id = ? AND receiver_id = ? AND is_read = FALSE`,
                    [contactId, user_id]
                );

                return {
                    user_id: contact.user_id,
                    contact_id: contact.user_id,
                    first_name: contact.first_name,
                    last_name: contact.last_name,
                    content: lastMsg ? lastMsg.content : null,
                    sender_id: lastMsg ? lastMsg.sender_id : null,
                    file_url: lastMsg ? lastMsg.file_url : null,
                    sent_at: lastMsg ? lastMsg.sent_at : null,
                    has_unread: unreadRows[0].unread_count > 0
                };
            }));

            const validThreads = threads
                .filter(Boolean)
                .sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0));

            res.json(validThreads);
        } catch (err) {
            console.error('Messages threads error:', err);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // GET /api/messages/:contactId
    // Returns the full conversation and marks incoming messages as read.
    app.get('/api/messages/:contactId', authenticateToken, async (req, res) => {
        try {
            const { user_id, role } = req.user;
            const contactId = parseInt(req.params.contactId, 10);

            if (Number.isNaN(contactId)) {
                return res.status(400).json({ error: 'Invalid contact id' });
            }

            const allowed = await hasValidRelationship(user_id, role, contactId);
            if (!allowed) {
                return res.status(403).json({ error: 'No appointment history with this contact' });
            }

            const [messages] = await db.query(
                `SELECT message_id, sender_id, receiver_id, content, file_url, sent_at, is_read
                 FROM messages
                 WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
                 ORDER BY sent_at ASC`,
                [user_id, contactId, contactId, user_id]
            );

            await db.query(
                `UPDATE messages SET is_read = TRUE
                 WHERE sender_id = ? AND receiver_id = ? AND is_read = FALSE`,
                [contactId, user_id]
            );

            res.json(messages);
        } catch (err) {
            console.error('Messages fetch error:', err);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // POST /api/messages/send
    app.post('/api/messages/send', authenticateToken, handleUpload, async (req, res) => {
        const stored = []; // files already saved, so they can be removed if something fails
        try {
            const { user_id, role } = req.user;
            const { receiver_id, content } = req.body;

            // Content or files must be present
            const hasFiles = req.files && req.files.length > 0;
            const hasContent = content && content.trim();

            if (!receiver_id || (!hasContent && !hasFiles)) {
                return res.status(400).json({ error: 'receiver_id and either content or files are required' });
            }

            const allowed = await hasValidRelationship(user_id, role, receiver_id);
            if (!allowed) {
                return res.status(403).json({ error: 'No appointment history with this contact' });
            }

            // Upload files first, then save their URLs as a JSON array on the message
            let fileUrls = null;
            if (hasFiles) {
                for (const f of req.files) {
                    stored.push(await storeFile(f));
                }
                fileUrls = JSON.stringify(stored.map(s => s.url));
            }

            const [result] = await db.query(
                `INSERT INTO messages (sender_id, receiver_id, content, file_url) VALUES (?, ?, ?, ?)`,
                [user_id, receiver_id, hasContent ? content.trim() : null, fileUrls]
            );

            res.status(201).json({ message_id: result.insertId, sent_at: new Date() });
        } catch (err) {
            // Best-effort cleanup of any files uploaded before the failure
            await Promise.all(stored.map(s => Promise.resolve(s.remove()).catch(() => {})));
            console.error('Messages send error:', err);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });
};