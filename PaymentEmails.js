// PaymentEmails.js
// One call per payment event, same pattern as AppointmentEmails.js:
//   await sendPaymentEmail(db, appointmentId, 'paid');
//   await sendPaymentEmail(db, appointmentId, 'refunded', { refundRef: 'ref_...' });
//
// It reads the patient, service, dentist and payment from the database, builds the
// email from EmailTemplates.js and sends it. It NEVER throws, so a mail problem
// can't turn an already-committed payment/refund into a 500 error. Always `await`
// it before sending the response (Vercel may freeze the function once it responds).

const T = require('./EmailTemplates');

const KINDS = {
    paid: T.paymentReceived,
    refunded: T.paymentRefunded
};

function viewUrl() {
    const path = process.env.CUSTOMER_APPOINTMENTS_PATH;
    if (!path) return undefined;
    return `${(process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')}${path}`;
}

/**
 * @param {object} db mysql2 pool
 * @param {number|string} appointmentId
 * @param {'paid'|'refunded'} kind
 * @param {object} [extra] merged into the template data:
 *   service     text to show instead of the single service label (multi-service bookings)
 *   refundRef   PayMongo refund id (refunded only)
 *   paidAt / refundedAt   override the timestamp shown
 */
async function sendPaymentEmail(db, appointmentId, kind, extra = {}) {
    try {
        const build = KINDS[kind];
        if (!build) throw new Error(`Unknown payment email kind "${kind}"`);

        // Call this AFTER the payment/refund change is committed.
        const [rows] = await db.query(
            `SELECT a.appointment_id, a.appointment_date, a.time_slot,
                    p.amount, p.method,
                    u.email AS patient_email, u.first_name AS patient_first,
                    s.label AS service_label,
                    CASE WHEN d.user_id IS NULL THEN NULL
                         ELSE CONCAT('Dr. ', d.first_name, ' ', d.last_name) END AS dentist_name
             FROM payments p
                      JOIN appointments a ON a.appointment_id = p.appointment_id
                      JOIN users u ON u.user_id = a.patient_id
                      LEFT JOIN services s ON s.service_id = a.service_id
                      LEFT JOIN users d ON d.user_id = a.employee_id
             WHERE p.appointment_id = ?`,
            [appointmentId]
        );

        const r = rows[0];
        if (!r || !r.patient_email) return false;

        // The email goes out right after the event, so "now" is the timestamp. This also
        // avoids DB-vs-server timezone drift from reading paid_at back out of MySQL.
        const now = new Date();
        const data = {
            patientName: r.patient_first,
            reference: `APT-${String(r.appointment_id).padStart(5, '0')}`,
            service: r.service_label,
            dentist: r.dentist_name,
            date: r.appointment_date,
            time: r.time_slot,
            amount: r.amount,
            method: r.method,
            paidAt: now,
            refundedAt: now,
            viewUrl: viewUrl(),
            ...extra
        };

        return await T.notify(r.patient_email, build(data));
    } catch (err) {
        console.error(`sendPaymentEmail(${kind}, #${appointmentId}) failed:`, err.message);
        return false;
    }
}

module.exports = { sendPaymentEmail };