const authenticateToken = require('../authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { put, del } = require('@vercel/blob');

const xrayUploadDir = path.join(__dirname, '..', 'uploads', 'xrays');
const isVercel = process.env.VERCEL === '1' || !!process.env.BLOB_READ_WRITE_TOKEN;

// Use memoryStorage so buffers are available on both local and Vercel serverless environments
const storage = multer.memoryStorage();

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024, files: 10 }, // 10MB per file, 10 files per upload
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed'));
        }
        cb(null, true);
    }
});

function registerPatientRecordsRoutes(app, db) {

    // PATCH /api/appointments/:id/notes — save dentist notes for the
    // currently ongoing session. Only allowed while the appointment is
    // approved AND queue_status is 'ongoing'.
    app.patch('/api/appointments/:id/notes', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { dentist_note } = req.body;
        if (typeof dentist_note !== 'string') {
            return res.status(400).json({ message: 'dentist_note is required' });
        }

        const appointmentId = req.params.id;

        try {
            const [apptRows] = await db.query(
                `SELECT appointment_status, queue_status
                 FROM appointments
                 WHERE appointment_id = ?`,
                [appointmentId]
            );

            if (apptRows.length === 0) {
                return res.status(404).json({ message: 'Appointment not found' });
            }
            if (apptRows[0].appointment_status !== 'approved' || apptRows[0].queue_status !== 'ongoing') {
                return res.status(409).json({ message: 'This appointment does not have an active session' });
            }

            await db.query(
                'UPDATE appointments SET dentist_note = ? WHERE appointment_id = ?',
                [dentist_note, appointmentId]
            );

            res.json({ message: 'Notes saved successfully' });
        } catch (err) {
            console.error('Save dentist notes error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // POST /api/appointments/:id/xrays — upload one or more x-ray images for
    // the currently ongoing session.
    app.post('/api/appointments/:id/xrays',
        authenticateToken,
        async (req, res, next) => {
            if (req.user.role !== 'employee') {
                return res.status(403).json({ message: 'Only employees can upload X-rays' });
            }

            const appointmentId = req.params.id;

            try {
                const [apptRows] = await db.query(
                    `SELECT patient_id, appointment_status, queue_status
                     FROM appointments
                     WHERE appointment_id = ?`,
                    [appointmentId]
                );

                if (apptRows.length === 0) {
                    return res.status(404).json({ message: 'Appointment not found' });
                }
                if (apptRows[0].appointment_status !== 'approved' || apptRows[0].queue_status !== 'ongoing') {
                    return res.status(409).json({ message: 'This appointment does not have an active session' });
                }

                req.xrayPatientId = apptRows[0].patient_id;
                next();
            } catch (err) {
                console.error('X-ray precondition check error:', err);
                res.status(500).json({ message: 'Internal Server Error' });
            }
        },
        upload.array('xrays', 10),
        async (req, res) => {
            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ message: 'No X-ray files were uploaded' });
            }

            const appointmentId = req.params.id;

            try {
                const created = [];
                for (const file of req.files) {
                    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
                    const filename = `${req.xrayPatientId}-${unique}${path.extname(file.originalname)}`;
                    let fileUrl;

                    if (isVercel) {
                        // --- PRODUCTION (Vercel): Upload to Vercel Blob ---
                        const blob = await put(`xrays/${filename}`, file.buffer, {
                            access: 'public',
                            contentType: file.mimetype,
                        });
                        fileUrl = blob.url;
                    } else {
                        // --- LOCAL DEVELOPMENT: Write to local disk ---
                        fs.mkdirSync(xrayUploadDir, { recursive: true });
                        const localPath = path.join(xrayUploadDir, filename);
                        fs.writeFileSync(localPath, file.buffer);
                        fileUrl = `/uploads/xrays/${filename}`;
                    }

                    const [result] = await db.query(
                        `INSERT INTO xrays (patient_id, appointment_id, uploaded_by, file_url)
                         VALUES (?, ?, ?, ?)`,
                        [req.xrayPatientId, appointmentId, req.user.user_id, fileUrl]
                    );
                    created.push({
                        xray_id: result.insertId,
                        appointment_id: Number(appointmentId),
                        file_url: fileUrl
                    });
                }

                res.status(201).json({ message: 'X-rays uploaded successfully', xrays: created });
            } catch (err) {
                console.error('X-ray upload error:', err);
                res.status(500).json({ message: 'Internal Server Error' });
            }
        }
    );

    // DELETE /api/xrays/:xrayId — remove an x-ray uploaded during the
    // current, still-ongoing session.
    app.delete('/api/xrays/:xrayId', authenticateToken, async (req, res) => {
        if (req.user.role !== 'employee') {
            return res.status(403).json({ message: 'Only employees can delete X-rays' });
        }

        const xrayId = req.params.xrayId;

        try {
            const [rows] = await db.query(
                `SELECT x.file_url, a.appointment_status, a.queue_status
                 FROM xrays x
                          JOIN appointments a ON x.appointment_id = a.appointment_id
                 WHERE x.xray_id = ?`,
                [xrayId]
            );

            if (rows.length === 0) {
                return res.status(404).json({ message: 'X-ray not found' });
            }
            if (rows[0].appointment_status !== 'approved' || rows[0].queue_status !== 'ongoing') {
                return res.status(409).json({ message: 'This appointment does not have an active session' });
            }

            await db.query('DELETE FROM xrays WHERE xray_id = ?', [xrayId]);

            // Best-effort file cleanup supporting both Vercel Blob URLs and local files
            const fileUrl = rows[0].file_url;
            if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
                await del(fileUrl).catch(() => {}); // Delete from Vercel Blob
            } else {
                const filePath = path.join(__dirname, '..', fileUrl);
                fs.unlink(filePath, () => {}); // Delete local disk file
            }

            res.json({ message: 'X-ray deleted successfully' });
        } catch (err) {
            console.error('X-ray delete error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // PATCH /api/appointments/:id/complete — complete the currently ongoing
    // appointment and move it to the patient's past visit history.
    app.patch('/api/appointments/:id/complete', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { dentist_note } = req.body;
        const appointmentId = req.params.id;

        try {
            const [apptRows] = await db.query(
                `SELECT appointment_status, queue_status
                 FROM appointments
                 WHERE appointment_id = ?`,
                [appointmentId]
            );

            if (apptRows.length === 0) {
                return res.status(404).json({ message: 'Appointment not found' });
            }

            if (
                apptRows[0].appointment_status !== 'approved' ||
                apptRows[0].queue_status !== 'ongoing'
            ) {
                return res.status(409).json({
                    message: 'This appointment does not have an active session'
                });
            }

            await db.query(
                `UPDATE appointments
                 SET appointment_status = 'completed',
                     queue_status = 'completed',
                     dentist_note = ?
                 WHERE appointment_id = ?`,
                [dentist_note || null, appointmentId]
            );

            res.json({
                message: 'Appointment completed successfully'
            });

        } catch (err) {
            console.error('Complete appointment error:', err);
            res.status(500).json({
                message: 'Internal Server Error'
            });
        }
    });
}

module.exports = registerPatientRecordsRoutes;