const bcrypt = require('bcrypt');
const authenticateToken = require('../authMiddleware');

const SALT_ROUNDS = 10;

function registerPatientProfileRoute(app, db) {

    // GET /api/patient-profile — loads the logged-in patient's own full record
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

    app.patch('/api/patient-profile', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Only patients can update this profile' });
        }

        const patientId = req.user.user_id;
        const {
            birthday, civil_status, secondary_email, address, phone,
            pregnancy_status, health_conditions, prescriptions, allergies,
            new_password
        } = req.body;

        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            if (new_password) {
                const password_hash = await bcrypt.hash(new_password, SALT_ROUNDS);
                await connection.query(
                    'UPDATE users SET phone = ?, password_hash = ? WHERE user_id = ?',
                    [phone, password_hash, patientId]
                );
            } else {
                await connection.query(
                    'UPDATE users SET phone = ? WHERE user_id = ?',
                    [phone, patientId]
                );
            }

            await connection.query(
                `UPDATE patient_profiles
                 SET birthday = ?, civil_status = ?, secondary_email = ?, address = ?, pregnancy_status = ?
                 WHERE patient_id = ?`,
                [birthday || null, civil_status, secondary_email, address, pregnancy_status || null, patientId]
            );

            // health_conditions and allergies arrive as arrays of plain
            // strings (["Asthma"], not [{description: "Asthma"}]) — matches
            // how customerProfile.html actually builds them client-side.
            await connection.query('DELETE FROM health_conditions WHERE patient_id = ?', [patientId]);
            if (Array.isArray(health_conditions) && health_conditions.length > 0) {
                const values = health_conditions.map(description => [patientId, description]);
                await connection.query('INSERT INTO health_conditions (patient_id, description) VALUES ?', [values]);
            }

            await connection.query('DELETE FROM prescriptions WHERE patient_id = ?', [patientId]);
            if (Array.isArray(prescriptions) && prescriptions.length > 0) {
                const values = prescriptions.map(p => [patientId, p.medication_name, p.dosage || null]);
                await connection.query('INSERT INTO prescriptions (patient_id, medication_name, dosage) VALUES ?', [values]);
            }

            await connection.query('DELETE FROM allergies WHERE patient_id = ?', [patientId]);
            if (Array.isArray(allergies) && allergies.length > 0) {
                const values = allergies.map(allergen => [patientId, allergen]);
                await connection.query('INSERT INTO allergies (patient_id, allergen) VALUES ?', [values]);
            }

            await connection.commit();
            res.json({ message: 'Profile updated successfully' });

        } catch (err) {
            await connection.rollback();
            console.error('Profile update error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        } finally {
            connection.release();
        }
    });
}

module.exports = registerPatientProfileRoute;