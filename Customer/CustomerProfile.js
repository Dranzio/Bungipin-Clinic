const bcrypt = require('bcrypt');
const authenticateToken = require('../authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { put, del } = require('@vercel/blob');
const { logActivity } = require('../Admin/auditLogRoutes');
const { isPasswordReused, REUSE_MESSAGE } = require('../Utils/passwordHistory');

function getIp(req) {
    return req.ip || req.headers['x-forwarded-for'];
}

const SALT_ROUNDS = 10;
const uploadDir = path.join(__dirname, '..', 'uploads', 'medical-pdfs');
const isVercel = process.env.VERCEL === '1' || !!process.env.BLOB_READ_WRITE_TOKEN;

// ⏱️ 5-Minute Password Cooldown Tracker (5 mins = 300,000 ms)
const PASSWORD_COOLDOWN_MS = 5 * 60 * 1000;
const patientPasswordCooldowns = new Map();

const storage = multer.memoryStorage();

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== 'application/pdf' && !file.originalname.toLowerCase().endsWith('.pdf')) {
            return cb(new Error('Only PDF files are allowed'));
        }
        cb(null, true);
    }
});

function registerPatientProfileRoute(app, db) {

    // GET /api/patient-profile
    app.get('/api/patient-profile', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Only patients can access this profile' });
        }

        try {
            const [rows] = await db.query('CALL sp_get_patient_record(?)', [req.user.user_id]);
            if (!rows[0] || rows[0].length === 0) {
                return res.status(404).json({ message: 'Profile not found' });
            }
            const record = rows[0][0].patient_record;
            res.json(typeof record === 'string' ? JSON.parse(record) : record);
        } catch (err) {
            console.error('Profile load error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // POST /api/patient-profile/medical-pdf
    app.post('/api/patient-profile/medical-pdf', authenticateToken, upload.single('medical_pdf'), async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Only patients can upload medical documents' });
        }
        if (!req.file) {
            return res.status(400).json({ message: 'No PDF file was uploaded' });
        }

        const unique = `${req.user.user_id}-${Date.now()}`;
        const filename = `${unique}${path.extname(req.file.originalname)}`;
        let fileUrl;

        try {
            if (isVercel) {
                const blob = await put(`medical-pdfs/${filename}`, req.file.buffer, {
                    access: 'public',
                    contentType: req.file.mimetype || 'application/pdf',
                });
                fileUrl = blob.url;
            } else {
                fs.mkdirSync(uploadDir, { recursive: true });
                const localPath = path.join(uploadDir, filename);
                fs.writeFileSync(localPath, req.file.buffer);
                fileUrl = `/uploads/medical-pdfs/${filename}`;
            }

            const [result] = await db.query(
                'INSERT INTO patient_documents (patient_id, file_url) VALUES (?, ?)',
                [req.user.user_id, fileUrl]
            );
            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: 'patient',
                action: 'UPLOAD_PDF',
                target_table: 'patient_documents',
                target_id: result.insertId,
                notes: `Uploaded medical document "${req.file.originalname}".`,
                ip_address: getIp(req)
            });

            res.status(201).json({
                message: 'PDF uploaded successfully',
                file_url: fileUrl,
                document_id: result.insertId
            });
        } catch (err) {
            console.error('Medical PDF upload error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    // DELETE /api/patient-profile/medical-pdf/:documentId
    app.delete('/api/patient-profile/medical-pdf/:documentId', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Unauthorized' });
        }
        const documentId = req.params.documentId;

        try {
            await db.query(
                'DELETE FROM patient_documents WHERE document_id = ? AND patient_id = ?',
                [documentId, req.user.user_id]
            );

            await logActivity(db, {
                user_id: req.user.user_id,
                user_role: 'patient',
                action: 'DELETE_PDF',
                target_table: 'patient_documents',
                target_id: documentId,
                notes: `Deleted medical document #${documentId}.`,
                ip_address: getIp(req)
            });

            res.json({ message: 'Document deleted successfully' });
        } catch (err) {
            console.error('Document delete error:', err);
            res.status(500).json({ message: 'Failed to delete document' });
        }
    });

    // PATCH /api/patient-profile
    app.patch('/api/patient-profile', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Only patients can update this profile' });
        }

        const patient_id = req.user.user_id;
        const {
            birthday,
            secondary_email,
            phone,
            address,
            address_street,
            address_barangay,
            address_city,
            address_province,
            pregnancy_status,
            health_conditions,
            surgeries,
            life_factors,
            prescriptions,
            allergies,
            new_password
        } = req.body;

        if (new_password) {
            const pw = String(new_password);
            if (pw.length < 8) {
                return res.status(400).json({ message: 'New password must be at least 8 characters long.' });
            }
            if (pw.length > 64) {
                return res.status(400).json({ message: 'New password must not exceed 64 characters.' });
            }
        }

        if (birthday) {
            const bDate = new Date(birthday);
            if (isNaN(bDate.getTime()) || bDate > new Date() || bDate.getFullYear() < 1900) {
                return res.status(400).json({ message: 'Invalid birthday value.' });
            }
        }

        if (phone && !/^09\d{9}$/.test(String(phone).trim())) {
            return res.status(400).json({ message: 'Phone number must be an 11-digit Philippine mobile number starting with 09.' });
        }

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            // 1. Password Update with 5-Minute Cooldown & Reuse Check
            if (new_password) {
                const lastChanged = patientPasswordCooldowns.get(patient_id);
                if (lastChanged && (Date.now() - lastChanged < PASSWORD_COOLDOWN_MS)) {
                    const remainingMins = Math.ceil((PASSWORD_COOLDOWN_MS - (Date.now() - lastChanged)) / 60000);
                    await connection.rollback();
                    return res.status(429).json({
                        message: `You recently changed your password. For security, please wait ${remainingMins} minute(s) before changing it again.`
                    });
                }

                if (await isPasswordReused(connection, patient_id, new_password)) {
                    await connection.rollback();
                    return res.status(400).json({ message: REUSE_MESSAGE });
                }

                const password_hash = await bcrypt.hash(new_password, SALT_ROUNDS);
                await connection.query(
                    `UPDATE users SET password_hash = ? WHERE user_id = ?`,
                    [password_hash, patient_id]
                );

                patientPasswordCooldowns.set(patient_id, Date.now());
            }

            // 2. Profile Details Update
            await connection.query(
                `UPDATE patient_profiles
                 SET birthday = ?,
                     secondary_email = ?,
                     address = ?,
                     address_street = ?,
                     address_barangay = ?,
                     address_city = ?,
                     address_province = ?,
                     pregnancy_status = ?
                 WHERE patient_id = ?`,
                [
                    birthday || null,
                    secondary_email ? String(secondary_email).trim() : null,
                    address || null,
                    address_street ? String(address_street).trim() : null,
                    address_barangay ? String(address_barangay).trim() : null,
                    address_city ? String(address_city).trim() : null,
                    address_province ? String(address_province).trim() : null,
                    pregnancy_status || null,
                    patient_id
                ]
            );

            // Update phone number in users table
            if (phone) {
                try {
                    await connection.query(
                        `UPDATE users SET phone = ? WHERE user_id = ?`,
                        [String(phone).trim(), patient_id]
                    );
                } catch (e) { /* Ignore */ }
            }

            // 3. Health Conditions
            await connection.query('DELETE FROM health_conditions WHERE patient_id = ?', [patient_id]);
            if (Array.isArray(health_conditions) && health_conditions.length > 0) {
                const values = health_conditions.filter(Boolean).map(desc => [patient_id, String(desc).trim()]);
                if (values.length > 0) {
                    await connection.query('INSERT INTO health_conditions (patient_id, description) VALUES ?', [values]);
                }
            }

            // 4. Surgeries
            try {
                await connection.query('DELETE FROM surgeries WHERE patient_id = ?', [patient_id]);
                if (Array.isArray(surgeries) && surgeries.length > 0) {
                    const values = surgeries.filter(Boolean).map(desc => [patient_id, String(desc).trim()]);
                    if (values.length > 0) {
                        await connection.query('INSERT INTO surgeries (patient_id, description) VALUES ?', [values]);
                    }
                }
            } catch (err) { /* Surgeries table optional */ }

            // 5. Lifestyle Factors
            try {
                await connection.query('DELETE FROM life_factors WHERE patient_id = ?', [patient_id]);
                if (Array.isArray(life_factors) && life_factors.length > 0) {
                    const values = life_factors.filter(Boolean).map(desc => [patient_id, String(desc).trim()]);
                    if (values.length > 0) {
                        await connection.query('INSERT INTO life_factors (patient_id, description) VALUES ?', [values]);
                    }
                }
            } catch (err) { /* Life factors table optional */ }

            // 6. Prescriptions
            await connection.query('DELETE FROM prescriptions WHERE patient_id = ?', [patient_id]);
            if (Array.isArray(prescriptions) && prescriptions.length > 0) {
                const values = prescriptions
                    .filter(p => p && p.medication_name && String(p.medication_name).trim())
                    .map(p => [patient_id, String(p.medication_name).trim(), p.dosage ? String(p.dosage).trim() : null]);
                if (values.length > 0) {
                    await connection.query('INSERT INTO prescriptions (patient_id, medication_name, dosage) VALUES ?', [values]);
                }
            }

            // 7. Allergies
            await connection.query('DELETE FROM allergies WHERE patient_id = ?', [patient_id]);
            if (Array.isArray(allergies) && allergies.length > 0) {
                const values = allergies.filter(Boolean).map(al => [patient_id, String(al).trim()]);
                if (values.length > 0) {
                    await connection.query('INSERT INTO allergies (patient_id, allergen) VALUES ?', [values]);
                }
            }

            await connection.commit();

            await logActivity(db, {
                user_id: patient_id,
                user_role: 'patient',
                action: 'UPDATE_PROFILE',
                target_table: 'patient_profiles',
                target_id: patient_id,
                ip_address: getIp(req)
            });

            const io = req.app.get('io');
            if (io) {
                io.to(`user_${patient_id}`).emit('profile_status_changed', {
                    patient_id: patient_id,
                    isComplete: Boolean(birthday),
                    birthday: birthday
                });
            }
            res.json({ message: 'Profile updated successfully' });

        } catch (err) {
            await connection.rollback();
            console.error('Profile update error:', err);
            res.status(500).json({ message: err.message || 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });
}

module.exports = registerPatientProfileRoute;