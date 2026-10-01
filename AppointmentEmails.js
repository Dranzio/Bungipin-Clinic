// appointmentEmails.js
// One call per route:  await sendAppointmentEmail(db, appointmentId, 'approved');
//
// It looks up the patient, service, dentist and schedule from the database,
// builds the right email from EmailTemplates.js and sends it. It NEVER throws,
// so a mail problem can't turn an already-committed booking/approval into a
// 500 error. Always `await` it before sending the response: on Vercel the
// function can be frozen the moment the response goes out, which would kill
// an email that is still in flight.

const T = require('./EmailTemplates');

const KINDS = {
    booked: T.appointmentBooked,
    approved: T.appointmentApproved,
    cancelled: T.appointmentCancelled,
    rescheduled: T.appointmentRescheduled,
    rescheduleApproved: T.rescheduleRequestApproved
};

// Optional: set CUSTOMER_APPOINTMENTS_PATH (e.g. /Customer/appointments.html)
// in the environment to get a "View my appointments" button in the emails.
function viewUrl() {
    const path = process.env.CUSTOMER_APPOINTMENTS_PATH;
    if (!path) return undefined;
    return `${(process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')}${path}`;
}

/**
 * @param {object} db            mysql2 pool
 * @param {number|string} appointmentId
 * @param {'booked'|'approved'|'cancelled'|'rescheduled'|'rescheduleApproved'} kind
 * @param {object} [extra]       overrides/extras merged into the template data:
 *   service        text to show instead of the appointment's single service (multi-service bookings)
 *   previousDate / previousTime   for the two reschedule emails
 *   reason         shown in cancelled/rescheduled emails
 *   cancelledBy    'customer' | 'clinic'
 *   declined       true when staff declined a still-pending request
 */
async function sendAppointmentEmail(db, appointmentId, kind, extra = {}) {
    try {
        const build = KINDS[kind];
        if (!build) throw new Error(`Unknown appointment email kind "${kind}"`);

        // Read AFTER the change was committed, so dates reflect the new schedule.
        const [rows] = await db.query(
            `SELECT a.appointment_id, a.appointment_date, a.time_slot,
                    p.email AS patient_email, p.first_name AS patient_first, p.last_name AS patient_last,
                    s.label AS service_label,
                    CASE WHEN d.user_id IS NULL THEN NULL
                         ELSE CONCAT('Dr. ', d.first_name, ' ', d.last_name) END AS dentist_name
             FROM appointments a
                      JOIN users p ON a.patient_id = p.user_id
                      LEFT JOIN services s ON a.service_id = s.service_id
                      LEFT JOIN users d ON a.employee_id = d.user_id
             WHERE a.appointment_id = ?`,
            [appointmentId]
        );

        const r = rows[0];
        if (!r || !r.patient_email) return false;

        const data = {
            patientName: r.patient_first,
            reference: `APT-${String(r.appointment_id).padStart(5, '0')}`,
            service: r.service_label,
            dentist: r.dentist_name,
            date: r.appointment_date,
            time: r.time_slot,
            viewUrl: viewUrl(),
            ...extra
        };

        return await T.notify(r.patient_email, build(data));
    } catch (err) {
        console.error(`sendAppointmentEmail(${kind}, #${appointmentId}) failed:`, err.message);
        return false;
    }
}

module.exports = { sendAppointmentEmail };