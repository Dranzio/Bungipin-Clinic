// MessagesRoutes.js
// Shared inbox + 1:1 chat for patients and employees.
// A patient and employee can only message each other if they share a
// non-cancelled appointment. Admins bypass the restriction.

const authenticateToken = require('./authmiddleware');

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
                    `SELECT content, sent_at FROM messages
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
                `SELECT message_id, sender_id, receiver_id, content, sent_at, is_read
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
    app.post('/api/messages/send', authenticateToken, async (req, res) => {
        try {
            const { user_id, role } = req.user;
            const { receiver_id, content } = req.body;

            if (!receiver_id || !content || !content.trim()) {
                return res.status(400).json({ error: 'receiver_id and content are required' });
            }

            const allowed = await hasValidRelationship(user_id, role, receiver_id);
            if (!allowed) {
                return res.status(403).json({ error: 'No appointment history with this contact' });
            }

            const [result] = await db.query(
                `INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)`,
                [user_id, receiver_id, content.trim()]
            );

            res.status(201).json({ message_id: result.insertId, sent_at: new Date() });
        } catch (err) {
            console.error('Messages send error:', err);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });
};