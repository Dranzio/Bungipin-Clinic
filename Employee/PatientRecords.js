const authenticateToken = require('../authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { put, del } = require('@vercel/blob');
const { logActivity } = require('../Admin/auditLogRoutes');

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}

const xrayUploadDir = path.join(__dirname, '..', 'uploads', 'xrays');
const isVercel = process.env.VERCEL === '1' || !!process.env.BLOB_READ_WRITE_TOKEN;

const storage = multer.memoryStorage();

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024, files: 10 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed'));
        }
        cb(null, true);
    }
});

function registerPatientRecordsRoutes(app, db, io = null) {

    // Helper: Build structured patient records with robust fallback queries
    async function fetchFullPatientRecords(db, specificPatientId = null) {
        let whereClause = "WHERE u.role = 'patient'";
        const params = [];

        if (specificPatientId) {
            whereClause += " AND u.user_id = ?";
            params.push(specificPatientId);
        }

        const [pRows] = await db.query(`
            SELECT
                u.user_id AS patient_id,
                u.public_id,
                u.first_name,
                u.last_name,
                u.email,
                u.phone,
                u.sex,
                pp.birthday,
                pp.secondary_email,
                pp.address,
                pp.address_street,
                pp.address_barangay,
                pp.address_city,
                pp.address_province,
                pp.pregnancy_status
            FROM users u
                     JOIN patient_profiles pp ON pp.patient_id = u.user_id
            ${whereClause}
            ORDER BY u.user_id ASC
        `, params);

        const fullRecords = [];

        for (const p of pRows) {
            const [conditions] = await db.query('SELECT description FROM health_conditions WHERE patient_id = ?', [p.patient_id]).catch(() => [[]]);
            const [surgeries] = await db.query('SELECT description FROM surgeries WHERE patient_id = ?', [p.patient_id]).catch(() => [[]]);
            const [lifeFactors] = await db.query('SELECT description FROM life_factors WHERE patient_id = ?', [p.patient_id]).catch(() => [[]]);
            const [allergies] = await db.query('SELECT allergen FROM allergies WHERE patient_id = ?', [p.patient_id]).catch(() => [[]]);
            const [prescriptions] = await db.query('SELECT medication_name, dosage FROM prescriptions WHERE patient_id = ?', [p.patient_id]).catch(() => [[]]);
            const [xrays] = await db.query('SELECT xray_id, appointment_id, file_url FROM xrays WHERE patient_id = ?', [p.patient_id]).catch(() => [[]]);
            const [docs] = await db.query('SELECT document_id, file_url, uploaded_at FROM patient_documents WHERE patient_id = ?', [p.patient_id]).catch(() => [[]]);

            const [[lastVisitRow]] = await db.query(`
                SELECT MAX(appointment_date) AS last_visit FROM appointments
                WHERE patient_id = ? AND appointment_status = 'completed'
            `, [p.patient_id]).catch(() => [[{ last_visit: null }]]);

            // Correctly route ongoing queue sessions
            const [[ongoing]] = await db.query(`
                SELECT 
                    a.appointment_id, 
                    a.appointment_date, 
                    a.time_slot,
                    s.label AS service_label, 
                    a.dentist_note, 
                    a.patient_note,
                    a.queue_status
                FROM appointments a
                JOIN services s ON a.service_id = s.service_id
                WHERE a.patient_id = ? 
                  AND a.queue_status = 'ongoing'
                  AND a.appointment_status IN ('approved', 'pending')
                ORDER BY a.appointment_date DESC, a.time_slot DESC LIMIT 1
            `, [p.patient_id]).catch(() => [[null]]);

            const [pastAppts] = await db.query(`
                SELECT 
                    a.appointment_id, 
                    a.appointment_date, 
                    s.label AS service_label, 
                    a.dentist_note, 
                    a.patient_note
                FROM appointments a
                JOIN services s ON a.service_id = s.service_id
                WHERE a.patient_id = ? AND a.appointment_status = 'completed'
                ORDER BY a.appointment_date DESC
            `, [p.patient_id]).catch(() => [[]]);

            fullRecords.push({
                ...p,
                health_conditions: conditions,
                surgeries: surgeries,
                life_factors: lifeFactors,
                allergies: allergies,
                prescriptions: prescriptions,
                xrays: xrays,
                patient_documents: docs,
                last_visit: lastVisitRow ? lastVisitRow.last_visit : null,
                ongoing_appointment: ongoing || null,
                past_appointments: pastAppts
            });
        }

        return fullRecords;
    }

    // GET /api/patients — Retrieve all patient records
    app.get('/api/patients', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        try {
            const patients = await fetchFullPatientRecords(db);
            res.json(patients);
        } catch (err) {
            console.error('Load all patient records error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // GET /api/patients/:id — Retrieve single detailed patient record
    app.get('/api/patients/:id', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const patientId = Number(req.params.id);
        if (!Number.isInteger(patientId)) {
            return res.status(400).json({ message: 'Invalid patient ID' });
        }

        try {
            const records = await fetchFullPatientRecords(db, patientId);
            if (records.length > 0) {
                return res.json(records[0]);
            }
            return res.status(404).json({ message: 'Patient not found' });
        } catch (err) {
            console.error('Fetch patient record error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // PATCH /api/appointments/:id/notes — save dentist notes for the session
    app.patch('/api/appointments/:id/notes', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { dentist_note } = req.body;
        const appointmentId = Number(req.params.id);

        try {
            await db.query(
                'UPDATE appointments SET dentist_note = ? WHERE appointment_id = ?',
                [dentist_note, appointmentId]
            );

            if (io) {
                io.emit('appointment-updated', { appointment_id: appointmentId });
            }

            res.json({ message: 'Dentist notes saved successfully' });
        } catch (err) {
            console.error('Save dentist notes error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // POST /api/appointments/:id/xrays — upload X-ray images
    app.post('/api/appointments/:id/xrays',
        authenticateToken,
        async (req, res, next) => {
            if (!['employee', 'admin'].includes(req.user.role)) {
                return res.status(403).json({ message: 'Only authorized employees can upload X-rays' });
            }

            const appointmentId = Number(req.params.id);

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

            const appointmentId = Number(req.params.id);

            try {
                const created = [];
                for (const file of req.files) {
                    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
                    const filename = `${req.xrayPatientId}-${unique}${path.extname(file.originalname)}`;
                    let fileUrl;

                    if (isVercel) {
                        const blob = await put(`xrays/${filename}`, file.buffer, {
                            access: 'public',
                            contentType: file.mimetype,
                        });
                        fileUrl = blob.url;
                    } else {
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

                await logActivity(db, {
                    user_id: req.user.user_id,
                    user_role: req.user.role,
                    action: 'UPLOAD_XRAY',
                    target_table: 'xrays',
                    target_id: appointmentId,
                    notes: `Uploaded ${created.length} X-ray(s) for appointment #${appointmentId}.`,
                    ip_address: getIp(req)
                });

                res.status(201).json({ message: 'X-rays uploaded successfully', xrays: created });
            } catch (err) {
                console.error('X-ray upload error:', err);
                res.status(500).json({ message: 'Internal Server Error' });
            }
        }
    );

    // DELETE /api/xrays/:xrayId — delete an X-ray
    app.delete('/api/xrays/:xrayId', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Only authorized employees can delete X-rays' });
        }

        const xrayId = Number(req.params.xrayId);

        try {
            const [rows] = await db.query('SELECT file_url FROM xrays WHERE xray_id = ?', [xrayId]);
            if (rows.length === 0) {
                return res.status(404).json({ message: 'X-ray not found' });
            }

            await db.query('DELETE FROM xrays WHERE xray_id = ?', [xrayId]);

            const fileUrl = rows[0].file_url;
            if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
                await del(fileUrl).catch(() => {});
            } else {
                const filePath = path.join(__dirname, '..', fileUrl);
                fs.unlink(filePath, () => {});
            }

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: 'DELETE_XRAY',
                target_table: 'xrays',
                target_id: xrayId,
                notes: `Deleted X-ray #${xrayId}.`,
                ip_address: getIp(req)
            });

            res.json({ message: 'X-ray deleted successfully' });
        } catch (err) {
            console.error('X-ray delete error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // PATCH /api/appointments/:id/complete — complete appointment & sync queue in real-time
    app.patch('/api/appointments/:id/complete', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { dentist_note } = req.body;
        const appointmentId = Number(req.params.id);

        try {
            const [result] = await db.query(
                `UPDATE appointments
                 SET appointment_status = 'completed',
                     queue_status = 'completed',
                     dentist_note = COALESCE(?, dentist_note)
                 WHERE appointment_id = ?`,
                [dentist_note || null, appointmentId]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ message: 'Appointment not found' });
            }

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: req.user.role,
                action: 'COMPLETE_TREATMENT',
                target_table: 'appointments',
                target_id: appointmentId,
                notes: 'Treatment marked complete.',
                ip_address: getIp(req)
            });

            if (io) {
                io.emit('queue_updated');
                io.emit('appointment-updated', { appointment_id: appointmentId, status: 'completed' });
            }

            res.json({ message: 'Appointment completed successfully' });
        } catch (err) {
            console.error('Complete appointment error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });
}

module.exports = registerPatientRecordsRoutes;