const PDFDocument = require('pdfkit');
const pool = require('../config/db');

/**
 * Gather everything about one patient into a single object.
 * Shared by both the JSON endpoint and the PDF endpoint, so the two
 * outputs can never drift out of sync with each other.
 */
async function getPatientRecordData(patientId) {
  const [[patient]] = await pool.query(
    `SELECT u.user_id, u.public_id, u.first_name, u.last_name, u.email, u.phone, u.sex,
            u.account_status, u.created_at,
            pp.birthday, pp.civil_status, pp.secondary_email, pp.address, pp.pregnancy_status
     FROM users u
     JOIN patient_profiles pp ON pp.patient_id = u.user_id
     WHERE u.user_id = ?`,
    [patientId]
  );

  if (!patient) return null;

  const [healthConditions] = await pool.query(
    'SELECT description FROM health_conditions WHERE patient_id = ?',
    [patientId]
  );

  const [allergies] = await pool.query('SELECT allergen FROM allergies WHERE patient_id = ?', [
    patientId,
  ]);

  const [prescriptions] = await pool.query(
    'SELECT medication_name, dosage FROM prescriptions WHERE patient_id = ?',
    [patientId]
  );

  const [appointments] = await pool.query(
    `SELECT a.appointment_id, a.appointment_date, a.time_slot, a.appointment_status,
            s.label AS service_label, s.price,
            CONCAT(e.first_name, ' ', e.last_name) AS dentist_name
     FROM appointments a
     JOIN services s ON s.service_id = a.service_id
     LEFT JOIN users e ON e.user_id = a.employee_id
     WHERE a.patient_id = ?
     ORDER BY a.appointment_date DESC, a.time_slot DESC`,
    [patientId]
  );

  return { patient, healthConditions, allergies, prescriptions, appointments };
}

// A patient may only look at their own record; staff can look at anyone's.
function canAccessRecord(req, patientId) {
  return req.user.role !== 'patient' || req.user.id === Number(patientId);
}

async function getPatientRecord(req, res) {
  try {
    if (!canAccessRecord(req, req.params.id)) {
      return res.status(403).json({ message: 'You cannot view this record' });
    }

    const record = await getPatientRecordData(req.params.id);
    if (!record) {
      return res.status(404).json({ message: 'Patient not found' });
    }

    res.json(record);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

async function getPatientRecordPdf(req, res) {
  try {
    if (!canAccessRecord(req, req.params.id)) {
      return res.status(403).json({ message: 'You cannot view this record' });
    }

    const record = await getPatientRecordData(req.params.id);
    if (!record) {
      return res.status(404).json({ message: 'Patient not found' });
    }

    const { patient, healthConditions, allergies, prescriptions, appointments } = record;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="patient-${patient.public_id}.pdf"`
    );

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res); // stream straight to the HTTP response — no temp file on disk

    doc
      .fontSize(18)
      .text(`Patient Record - ${patient.first_name} ${patient.last_name}`, { align: 'left' })
      .fontSize(10)
      .fillColor('#555')
      .text(`${patient.public_id}  |  Generated ${new Date().toLocaleDateString()}`)
      .fillColor('#000')
      .moveDown();

    doc.fontSize(13).text('Profile', { underline: true }).moveDown(0.3);
    doc
      .fontSize(10)
      .text(`Email: ${patient.email}`)
      .text(`Phone: ${patient.phone || '-'}`)
      .text(`Sex: ${patient.sex || '-'}`)
      .text(`Birthday: ${patient.birthday ? patient.birthday.toISOString().slice(0, 10) : '-'}`)
      .text(`Civil status: ${patient.civil_status || '-'}`)
      .text(`Address: ${patient.address || '-'}`)
      .text(`Account status: ${patient.account_status}`)
      .moveDown();

    doc.fontSize(13).text('Health conditions', { underline: true }).moveDown(0.3);
    doc.fontSize(10);
    if (healthConditions.length === 0) {
      doc.text('None on record.');
    } else {
      healthConditions.forEach((c) => doc.text(`- ${c.description}`));
    }
    doc.moveDown();

    doc.fontSize(13).text('Allergies', { underline: true }).moveDown(0.3);
    doc.fontSize(10);
    if (allergies.length === 0) {
      doc.text('None on record.');
    } else {
      allergies.forEach((a) => doc.text(`- ${a.allergen}`));
    }
    doc.moveDown();

    doc.fontSize(13).text('Prescriptions', { underline: true }).moveDown(0.3);
    doc.fontSize(10);
    if (prescriptions.length === 0) {
      doc.text('None on record.');
    } else {
      prescriptions.forEach((p) => doc.text(`- ${p.medication_name} - ${p.dosage || 'n/a'}`));
    }
    doc.moveDown();

    doc.fontSize(13).text('Appointment history', { underline: true }).moveDown(0.3);
    doc.fontSize(10);
    if (appointments.length === 0) {
      doc.text('No appointments on record.');
    } else {
      appointments.forEach((a) => {
        const date = new Date(a.appointment_date).toISOString().slice(0, 10);
        doc.text(
          `${date} ${a.time_slot}  -  ${a.service_label} (PHP ${a.price})  -  ${a.appointment_status}` +
            (a.dentist_name ? `  -  Dr. ${a.dentist_name}` : '')
        );
      });
    }

    doc.end();
  } catch (err) {
    // headers may already be sent if the stream started - guard against a
    // double response in that edge case
    if (!res.headersSent) {
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
}

module.exports = { getPatientRecordData, getPatientRecord, getPatientRecordPdf };