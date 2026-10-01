const pool = require('../config/db');

/**
 * Fetch all payments with appointment and patient info
 */
async function getPayments(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT a.appointment_id, a.appointment_date, a.time_slot, a.appointment_status,
              u.first_name AS patient_first_name, u.last_name AS patient_last_name,
              s.label AS service_label, s.price,
              p.payment_id, p.amount, p.payment_date, p.method, COALESCE(p.status, 'pending') AS payment_status
       FROM appointments a
       JOIN services s ON a.service_id = s.service_id
       JOIN users u ON a.patient_id = u.user_id
       LEFT JOIN payments p ON a.appointment_id = p.appointment_id
       ORDER BY a.appointment_date DESC, a.time_slot DESC`
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

/**
 * Accept a payment for an appointment
 */
async function acceptPayment(req, res) {
  try {
    const appointmentId = req.params.id;
    const { amount, method } = req.body; // method e.g. 'cash', 'card', 'online'

    if (!amount || !method) {
      return res.status(400).json({ message: 'Amount and method are required' });
    }

    // Check if appointment exists
    const [appts] = await pool.query('SELECT * FROM appointments WHERE appointment_id = ?', [appointmentId]);
    if (appts.length === 0) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    // Check if payment already exists
    const [payments] = await pool.query('SELECT * FROM payments WHERE appointment_id = ?', [appointmentId]);
    
    if (payments.length > 0) {
      // Update existing payment
      await pool.query(
        `UPDATE payments SET amount = ?, payment_date = CURDATE(), method = ?, status = 'paid' WHERE appointment_id = ?`,
        [amount, method, appointmentId]
      );
    } else {
      // Insert new payment
      await pool.query(
        `INSERT INTO payments (appointment_id, amount, payment_date, method, status)
         VALUES (?, ?, CURDATE(), ?, 'paid')`,
        [appointmentId, amount, method]
      );
    }

    res.json({ message: 'Payment accepted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

/**
 * Refund a payment for an appointment
 */
async function refundPayment(req, res) {
  try {
    const appointmentId = req.params.id;

    // Check if payment exists
    const [payments] = await pool.query('SELECT * FROM payments WHERE appointment_id = ?', [appointmentId]);
    
    if (payments.length === 0) {
      return res.status(404).json({ message: 'Payment record not found for this appointment' });
    }

    if (payments[0].status === 'refunded') {
      return res.status(400).json({ message: 'Payment is already refunded' });
    }

    // Update payment status to refunded
    await pool.query(
      `UPDATE payments SET status = 'refunded' WHERE appointment_id = ?`,
      [appointmentId]
    );

    res.json({ message: 'Payment refunded successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

module.exports = {
  getPayments,
  acceptPayment,
  refundPayment
};
