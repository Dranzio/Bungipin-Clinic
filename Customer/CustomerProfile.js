const bcrypt = require('bcrypt');
const authenticateToken = require('../authmiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const SALT_ROUNDS = 10;

const uploadDir = path.join(__dirname, '..', 'uploads', 'medical-pdfs');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        cb(null, `${req.user.user_id}-${Date.now()}${path.extname(file.originalname)}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {//
        if (file.mimetype !== 'application/pdf') {
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

        const fileUrl = `/uploads/medical-pdfs/${req.file.filename}`;

        try {
            await db.query(
                'INSERT INTO patient_documents (patient_id, file_url) VALUES (?, ?)',
                [req.user.user_id, fileUrl]
            );
            res.status(201).json({ message: 'PDF uploaded successfully', file_url: fileUrl });
        } catch (err) {
            console.error('Medical PDF upload error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });

    app.patch('/api/patient-profile', authenticateToken, async (req, res) => {
    if (req.user.role !== 'patient') {
        return res.status(403).json({ message: 'Only patients can update this profile' });
    }

    const patient_id = req.user.user_id;
    const {
        birthday, 
        secondary_email, 
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

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Update Users Table (password)
        if (new_password) {
            const password_hash = await bcrypt.hash(new_password, SALT_ROUNDS);
            // Update the users table where the password actually lives
            await connection.query(
                `UPDATE users SET password_hash = ? WHERE user_id = ?`,
                [password_hash, patient_id]
            );
        }

        // 2. Single Unified Update for Patient Profiles
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
                secondary_email || null, 
                address || null, 
                address_street || null, 
                address_barangay || null, 
                address_city || null, 
                address_province || null, 
                pregnancy_status || null, 
                patient_id
            ]
        );

        // 3. Health Conditions
        await connection.query('DELETE FROM health_conditions WHERE patient_id = ?', [patient_id]);
        if (Array.isArray(health_conditions) && health_conditions.length > 0) {
            const values = health_conditions.map(description => [patient_id, description]);
            await connection.query('INSERT INTO health_conditions (patient_id, description) VALUES ?', [values]);
        }

        // 4. Surgeries (Safely handled if table exists)
        try {
            await connection.query('DELETE FROM surgeries WHERE patient_id = ?', [patient_id]);
            if (Array.isArray(surgeries) && surgeries.length > 0) {
                const values = surgeries.map(description => [patient_id, description]);
                await connection.query('INSERT INTO surgeries (patient_id, description) VALUES ?', [values]);
            }
        } catch (err) {
            // Ignore if surgeries table hasn't been created in DB yet
        }

        // 5. Life Factors (Safely handled if table exists)
        try {
            await connection.query('DELETE FROM life_factors WHERE patient_id = ?', [patient_id]);
            if (Array.isArray(life_factors) && life_factors.length > 0) {
                const values = life_factors.map(description => [patient_id, description]);
                await connection.query('INSERT INTO life_factors (patient_id, description) VALUES ?', [values]);
            }
        } catch (err) {
            // Ignore if life_factors table hasn't been created in DB yet
        }

        // 6. Prescriptions
        await connection.query('DELETE FROM prescriptions WHERE patient_id = ?', [patient_id]);
        if (Array.isArray(prescriptions) && prescriptions.length > 0) {
            const values = prescriptions.map(p => [patient_id, p.medication_name, p.dosage || null]);
            await connection.query('INSERT INTO prescriptions (patient_id, medication_name, dosage) VALUES ?', [values]);
        }

        // 7. Allergies
        await connection.query('DELETE FROM allergies WHERE patient_id = ?', [patient_id]);
        if (Array.isArray(allergies) && allergies.length > 0) {
            const values = allergies.map(allergen => [patient_id, allergen]);
            await connection.query('INSERT INTO allergies (patient_id, allergen) VALUES ?', [values]);
        }

        await connection.commit();

        const io = req.app.get('io');
        if(io) {
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