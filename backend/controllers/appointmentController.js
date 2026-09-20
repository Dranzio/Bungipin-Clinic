const pool = require('../config/db');
const QRCode = require('qrcode-svg');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

/**
 * Appointment CRUD controllers. Patients are limited to their own records;
 * employees and admins can manage the appointment queue.
 */

/**
 * List appointments visible to the authenticated user.
 */
async function getAppointments(req, res) {
  try {
    let rows;

    if (req.user.role === 'patient') {
      [rows] = await pool.query(
        `SELECT a.*, s.label AS service_label, s.price
         FROM appointments a
         JOIN services s ON a.service_id = s.service_id
         WHERE a.patient_id = ?
         ORDER BY a.appointment_date DESC, a.time_slot DESC`,
        [req.user.id]
      );
    } else {
      [rows] = await pool.query(
        `SELECT a.*, s.label AS service_label, s.price,
                u.first_name AS patient_first_name, u.last_name AS patient_last_name
         FROM appointments a
         JOIN services s ON a.service_id = s.service_id
         JOIN users u ON a.patient_id = u.user_id
         ORDER BY a.appointment_date DESC, a.time_slot DESC`
      );
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

/**
 * Return one appointment after enforcing patient ownership rules.
 */
async function getAppointmentById(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, s.label AS service_label, s.price
       FROM appointments a
       JOIN services s ON a.service_id = s.service_id
       WHERE a.appointment_id = ?`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    const appointment = rows[0];

    if (req.user.role === 'patient' && appointment.patient_id !== req.user.id) {
      return res.status(403).json({ message: 'You cannot view this appointment' });
    }

    res.json(appointment);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

/**
 * Create a pending appointment for the authenticated patient.
 */
async function createAppointment(req, res) {
  try {
    if (req.user.role !== 'patient') {
      return res.status(403).json({ message: 'Only patients can book appointments' });
    }

    const { service_id, appointment_date, time_slot, patient_note } = req.body;

    if (!service_id || !appointment_date || !time_slot) {
      return res.status(400).json({
        message: 'service_id, appointment_date, and time_slot are required',
      });
    }

    const [result] = await pool.query(
      `INSERT INTO appointments (patient_id, service_id, appointment_date, time_slot, patient_note)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, service_id, appointment_date, time_slot, patient_note || null]
    );

    res.status(201).json({
      appointment_id: result.insertId,
      patient_id: req.user.id,
      service_id,
      appointment_date,
      time_slot,
      appointment_status: 'pending',
    });
  } catch (err) {
    // unique_employee_slot violation, invalid service_id, etc
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

/**
 * Update patient booking details or staff-managed appointment fields.
 * Patients can update only their own pending appointments.
 */
async function updateAppointment(req, res) {
  try {
    const [rows] = await pool.query('SELECT * FROM appointments WHERE appointment_id = ?', [
      req.params.id,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    const appt = rows[0];

    if (req.user.role === 'patient') {
      if (appt.patient_id !== req.user.id) {
        return res.status(403).json({ message: 'You cannot edit this appointment' });
      }
      if (appt.appointment_status !== 'pending') {
        return res.status(400).json({ message: 'Only pending appointments can be edited' });
      }

      const { appointment_date, time_slot, patient_note } = req.body;
      await pool.query(
        `UPDATE appointments
         SET appointment_date = ?, time_slot = ?, patient_note = ?
         WHERE appointment_id = ?`,
        [
          appointment_date ?? appt.appointment_date,
          time_slot ?? appt.time_slot,
          patient_note ?? appt.patient_note,
          req.params.id,
        ]
      );
    } else {
      const { employee_id, appointment_status, dentist_note, queue_status } = req.body;
      await pool.query(
        `UPDATE appointments
         SET employee_id = ?, appointment_status = ?, dentist_note = ?, queue_status = ?
         WHERE appointment_id = ?`,
        [
          employee_id ?? appt.employee_id,
          appointment_status ?? appt.appointment_status,
          dentist_note ?? appt.dentist_note,
          queue_status ?? appt.queue_status,
          req.params.id,
        ]
      );
    }

    res.json({ message: 'Appointment updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

/**
 * Soft-delete an appointment by changing its status to cancelled.
 */
async function cancelAppointment(req, res) {
  try {
    const [rows] = await pool.query('SELECT * FROM appointments WHERE appointment_id = ?', [
      req.params.id,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    const appt = rows[0];

    if (req.user.role === 'patient' && appt.patient_id !== req.user.id) {
      return res.status(403).json({ message: 'You cannot cancel this appointment' });
    }

    if (['completed', 'cancelled'].includes(appt.appointment_status)) {
      return res.status(400).json({ message: 'This appointment cannot be cancelled' });
    }

    await pool.query(
      "UPDATE appointments SET appointment_status = 'cancelled' WHERE appointment_id = ?",
      [req.params.id]
    );

    res.json({ message: 'Appointment cancelled' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

/**
 * Move an appointment to a new date and time while preserving its status.
 */
async function rescheduleAppointment(req, res) {
  try {
    const { appointment_date, time_slot } = req.body;

    if (!appointment_date || !time_slot) {
      return res.status(400).json({
        message: 'appointment_date and time_slot are required',
      });
    }

    const [rows] = await pool.query('SELECT * FROM appointments WHERE appointment_id = ?', [
      req.params.id,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    const appt = rows[0];

    if (req.user.role === 'patient' && appt.patient_id !== req.user.id) {
      return res.status(403).json({ message: 'You cannot reschedule this appointment' });
    }

    if (['completed', 'cancelled'].includes(appt.appointment_status)) {
      return res.status(400).json({ message: 'This appointment cannot be rescheduled' });
    }

    if (req.user.role === 'patient' && !['pending', 'approved'].includes(appt.appointment_status)) {
      return res.status(400).json({ message: 'This appointment cannot be rescheduled' });
    }

    await pool.query(
      `UPDATE appointments
       SET appointment_date = ?, time_slot = ?
       WHERE appointment_id = ?`,
      [appointment_date, time_slot, req.params.id]
    );

    res.json({
      message: 'Appointment rescheduled',
      appointment_id: appt.appointment_id,
      appointment_date,
      time_slot,
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'The selected employee time slot is already booked' });
    }
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

module.exports = {
  getAppointments,
  getAppointmentById,
  createAppointment,
  updateAppointment,
  cancelAppointment,
  rescheduleAppointment,
};

/**
 * Generate a scannable QR code (SVG) identifying one appointment.
 * Used by admin/employee for front-desk check-in/lookup — the QR just
 * encodes IDs, no sensitive data, since it may end up on a printed slip.
 */
async function getAppointmentQRCode(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT a.appointment_id, a.appointment_date, a.time_slot,
              u.public_id AS patient_public_id
       FROM appointments a
       JOIN users u ON a.patient_id = u.user_id
       WHERE a.appointment_id = ?`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    const appt = rows[0];

    // What the scanner reads back. Kept to non-sensitive identifiers only.
    const qrContent = JSON.stringify({
      appointment_id: appt.appointment_id,
      patient_public_id: appt.patient_public_id,
      date: appt.appointment_date,
      time: appt.time_slot,
    });

    const qrcode = new QRCode({
      content: qrContent,
      padding: 4,
      width: 256,
      height: 256,
      color: '#000000',
      background: '#ffffff',
      ecl: 'M',
    });

    res.set('Content-Type', 'image/svg+xml');
    res.send(qrcode.svg());
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

/**
 * Render one appointment as a PDF for download/printing.
 * Builds a small self-contained HTML page, then shells out to the
 * `relaxed` CLI (from relaxedjs) to print it to PDF via headless Chromium.
 * The CLI needs a real file on disk to read and write to, so this uses a
 * temporary directory that gets cleaned up after the response is sent.
 */
async function getAppointmentPDF(req, res) {
  let tmpDir;
  try {
    const [rows] = await pool.query(
      `SELECT a.*, s.label AS service_label, s.price,
              u.first_name AS patient_first_name, u.last_name AS patient_last_name,
              u.public_id AS patient_public_id
       FROM appointments a
       JOIN services s ON a.service_id = s.service_id
       JOIN users u ON a.patient_id = u.user_id
       WHERE a.appointment_id = ?`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    const appt = rows[0];

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; padding: 40px; color: #222; }
    h1 { font-size: 20px; border-bottom: 2px solid #333; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    td { padding: 8px 0; vertical-align: top; }
    td.label { font-weight: bold; width: 180px; color: #555; }
  </style>
</head>
<body>
  <h1>Appointment Summary</h1>
  <table>
    <tr><td class="label">Appointment ID</td><td>${appt.appointment_id}</td></tr>
    <tr><td class="label">Patient</td><td>${appt.patient_first_name} ${appt.patient_last_name} (${appt.patient_public_id})</td></tr>
    <tr><td class="label">Service</td><td>${appt.service_label} (PHP ${appt.price})</td></tr>
    <tr><td class="label">Date</td><td>${appt.appointment_date}</td></tr>
    <tr><td class="label">Time</td><td>${appt.time_slot}</td></tr>
    <tr><td class="label">Status</td><td>${appt.appointment_status}</td></tr>
    <tr><td class="label">Patient Note</td><td>${appt.patient_note || '-'}</td></tr>
    <tr><td class="label">Dentist Note</td><td>${appt.dentist_note || '-'}</td></tr>
  </table>
</body>
</html>`;

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'appt-pdf-'));
    const htmlPath = path.join(tmpDir, 'appointment.html');
    const pdfPath = path.join(tmpDir, 'appointment.pdf');

    await fs.writeFile(htmlPath, html, 'utf8');

    // Call the locally-installed `relaxed` binary directly (rather than
    // `npx`, which looks for node_modules relative to its own cwd — and
    // our cwd here is a scratch tmp directory, not the project root).
    const relaxedBin = path.join(__dirname, '..', 'node_modules', '.bin', 'relaxed');
    await execPromise(`"${relaxedBin}" "${htmlPath}" --build-once`, {
      cwd: tmpDir,
      timeout: 30000,
    });

    const pdfBuffer = await fs.readFile(pdfPath);

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="appointment_${appt.appointment_id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports.getAppointmentQRCode = getAppointmentQRCode;
module.exports.getAppointmentPDF = getAppointmentPDF;
