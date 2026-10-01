// payment and refund logic using PayMongo
// Routes:
//   POST   /api/payments/:appointmentId/create-link  - Patient creates a PayMongo checkout link
//   POST   /api/payments/:appointmentId/verify        - Patient's success page calls this to confirm payment
//   PATCH  /api/payments/:appointmentId/mark-paid     - Receptionist marks cash/card payment as paid
//   POST   /api/payments/:appointmentId/refund        - Admin/receptionist issues a refund via PayMongo

const authenticateToken = require('./authMiddleware');
const { logActivity } = require('./Admin/auditLogRoutes');

// eli to eli: PayMongo uses Base64-encoded secret key as the Authorization header.
// Buffer.from(...).toString('base64') does that encoding.
const PAYMONGO_SECRET = process.env.PAYMONGO_SECRET_KEY;
const PAYMONGO_BASE   = 'https://api.paymongo.com/v1';

// Helper: base64-encode the secret key for Basic Auth
function paymongoAuth() {
    return 'Basic ' + Buffer.from(PAYMONGO_SECRET + ':').toString('base64');
}

// Helper: get the requester's IP for audit logs
function getIp(req) {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.socket?.remoteAddress ||
        null
    );
}

function registerPaymentRoutes(app, db) {

    // ── 1. POST /api/payments/:appointmentId/create-link ───────────────────────
    // Called by the patient on their appointment page.
    // Creates a PayMongo Payment Link and returns the checkout URL.
    // eli to eli: Patient is redirected to the checkout_url on the frontend.
    /**app.post('/api/payments/:appointmentId/create-link', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Patients only' });
        }

        const appointmentId = Number(req.params.appointmentId);

        try {
            // Verify appointment belongs to this patient and is approved
            const [rows] = await db.query(
                `SELECT a.appointment_id, a.appointment_status, a.patient_id,
                        p.amount, p.status AS payment_status, p.method,
                        p.paymongo_link_id, p.checkout_url,
                        u.first_name, u.last_name, u.email
                 FROM appointments a
                 JOIN payments p ON a.appointment_id = p.appointment_id
                 JOIN users u ON a.patient_id = u.user_id
                 WHERE a.appointment_id = ?`,
                [appointmentId]
            );

            if (rows.length === 0) {
                return res.status(404).json({ message: 'Appointment or payment record not found' });
            }

            const appt = rows[0];

            // eli to eli: Only the owner of the appointment can pay
            if (Number(appt.patient_id) !== Number(req.user.user_id)) {
                return res.status(403).json({ message: 'Not authorized' });
            }

            if (appt.payment_status === 'paid') {
                return res.status(409).json({ message: 'This appointment has already been paid.' });
            }

            // eli: Cash/card payments are handled in-person (mark-paid route), not online
            if (appt.method !== 'online') {
                return res.status(400).json({ message: 'This appointment is set for in-person payment. Please pay at the clinic.' });
            }

            // eli: If a checkout link was already created, reuse it instead of making a new one
            if (appt.paymongo_link_id && appt.checkout_url) {
                return res.json({ checkout_url: appt.checkout_url, reused: true });
            }

            // Build the PayMongo Payment Link request
            // eli to eli: amount must be in CENTAVOS (multiply by 100), not pesos
            const amountInCentavos = Math.round(Number(appt.amount) * 100);
            const description = `Bungipin Clinic - Appointment #${appointmentId}`;

            // eli to eli: success_url is where PayMongo redirects the patient AFTER paying.
            // We include the appointmentId so our success page knows which appointment to verify.
            const successUrl = `${req.protocol}://${req.get('host')}/Customer/PaymentSuccess.html?appointment_id=${appointmentId}`;
            const cancelUrl  = `${req.protocol}://${req.get('host')}/Customer/History.html`;

            const paymongoRes = await fetch(`${PAYMONGO_BASE}/links`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': paymongoAuth()
                },
                body: JSON.stringify({
                    data: {
                        attributes: {
                            amount: amountInCentavos,
                            description,
                            currency: 'PHP',
                            // eli to eli: remarks appear on the patient's PayMongo receipt email
                            remarks: `Payment for appointment on ${new Date().toLocaleDateString('en-PH')}`,
                        }
                    }
                })
            });

            const paymongoData = await paymongoRes.json();

            if (!paymongoRes.ok) {
                console.error('PayMongo create-link error:', paymongoData);
                return res.status(502).json({ message: 'Failed to create payment link. Please try again.' });
            }

            const linkId      = paymongoData.data.id;
            const checkoutUrl = paymongoData.data.attributes.checkout_url;

            // Save the link ID and checkout URL to our DB
            await db.query(
                `UPDATE payments SET paymongo_link_id = ?, checkout_url = ? WHERE appointment_id = ?`,
                [linkId, checkoutUrl, appointmentId]
            );

            await logActivity(db, {
                user_id:      req.user.user_id,
                user_role:    'patient',
                action:       'PAYMENT_LINK_CREATED',
                target_table: 'payments',
                target_id:    appointmentId,
                notes:        `PayMongo link created (${linkId}) for appointment #${appointmentId}.`,
                ip_address:   getIp(req)
            });

            res.json({ checkout_url: checkoutUrl });

        } catch (err) {
            console.error('Create payment link error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });
    */


    // ── 2. POST /api/payments/:appointmentId/verify ────────────────────────────
    // Called by PaymentSuccess.html after PayMongo redirects the patient back.
    // Checks PayMongo's API to confirm the payment was actually successful,
    // then marks the DB payment as 'paid'.
    // eli to eli: We verify server-side so patients can't fake a successful payment
    //             by manually visiting the success URL.
    /*app.post('/api/payments/:appointmentId/verify', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Patients only' });
        }

        const appointmentId = Number(req.params.appointmentId);

        try {
            const [rows] = await db.query(
                `SELECT p.payment_id, p.status, p.paymongo_link_id, p.amount, a.patient_id
                 FROM payments p
                 JOIN appointments a ON p.appointment_id = a.appointment_id
                 WHERE p.appointment_id = ?`,
                [appointmentId]
            );

            if (rows.length === 0) {
                return res.status(404).json({ message: 'Payment record not found' });
            }

            const payment = rows[0];

            if (Number(payment.patient_id) !== Number(req.user.user_id)) {
                return res.status(403).json({ message: 'Not authorized' });
            }

            if (payment.status === 'paid') {
                return res.json({ message: 'Already marked as paid.', already_paid: true });
            }

            if (!payment.paymongo_link_id) {
                return res.status(400).json({ message: 'No payment link found for this appointment.' });
            }

            // Check the Payment Link status from PayMongo
            const paymongoRes = await fetch(`${PAYMONGO_BASE}/links/${payment.paymongo_link_id}`, {
                headers: { 'Authorization': paymongoAuth() }
            });

            const paymongoData = await paymongoRes.json();

            if (!paymongoRes.ok) {
                console.error('PayMongo verify error:', paymongoData);
                return res.status(502).json({ message: 'Could not verify payment with PayMongo.' });
            }

            const linkStatus = paymongoData.data.attributes.status;
            // eli to eli: PayMongo link status is 'paid' when the payment was successful
            if (linkStatus !== 'paid') {
                return res.status(402).json({ message: 'Payment has not been completed yet.' });
            }

            // Extract the actual PayMongo payment ID from the link's payments array
            const payments = paymongoData.data.attributes.payments || [];
            const paymongoPaymentId = payments[0]?.id || null;

            // Mark as paid in our DB
            await db.query(
                `UPDATE payments
                 SET status = 'paid',
                     paymongo_payment_id = ?,
                     paid_at = NOW(),
                     payment_date = CURDATE()
                 WHERE appointment_id = ?`,
                [paymongoPaymentId, appointmentId]
            );

            await logActivity(db, {
                user_id:      req.user.user_id,
                user_role:    'patient',
                action:       'PAYMENT_CONFIRMED',
                target_table: 'payments',
                target_id:    appointmentId,
                notes:        `Payment confirmed for appointment #${appointmentId}. PayMongo payment ID: ${paymongoPaymentId}.`,
                ip_address:   getIp(req)
            });

            res.json({ message: 'Payment confirmed successfully!', paid: true });

        } catch (err) {
            console.error('Verify payment error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });
    */


    // ── 3. PATCH /api/payments/:appointmentId/mark-paid ───────────────────────
    // Receptionist marks a cash or in-person card payment as paid.
    // eli: Only receptionist (employee) or admin can call this.
    app.patch('/api/payments/:appointmentId/mark-paid', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Staff only' });
        }

        const appointmentId = Number(req.params.appointmentId);

        try {
            const [rows] = await db.query(
                `SELECT p.status, p.method FROM payments p WHERE p.appointment_id = ?`,
                [appointmentId]
            );

            if (rows.length === 0) {
                return res.status(404).json({ message: 'Payment record not found' });
            }

            const payment = rows[0];

            if (payment.status === 'paid') {
                return res.status(409).json({ message: 'Already marked as paid.' });
            }

            // eli: Prevent marking online payments as paid manually — those go through PayMongo verify
            if (payment.method === 'online') {
                return res.status(400).json({ message: 'Online payments must be verified through PayMongo, not marked manually.' });
            }

            await db.query(
                `UPDATE payments
                 SET status = 'paid',
                     paid_at = NOW(),
                     payment_date = CURDATE()
                 WHERE appointment_id = ?`,
                [appointmentId]
            );

            await logActivity(db, {
                user_id:      req.user.user_id,
                user_role:    req.user.role,
                action:       'PAYMENT_MARKED_PAID',
                target_table: 'payments',
                target_id:    appointmentId,
                notes:        `Cash/card payment for appointment #${appointmentId} marked as paid by staff.`,
                ip_address:   getIp(req)
            });

            res.json({ message: 'Payment marked as paid successfully.' });

        } catch (err) {
            console.error('Mark paid error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });


    // ── 4. POST /api/payments/:appointmentId/refund ───────────────────────────
    // Admin or receptionist issues a refund.
    // For online payments: calls PayMongo Refund API.
    // For cash/card: just marks the DB as refunded (actual cash return is manual).
    // eli to eli: PayMongo refunds go back to the original payment method automatically.
    app.post('/api/payments/:appointmentId/refund', authenticateToken, async (req, res) => {
        if (!['employee', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ message: 'Staff only' });
        }

        const appointmentId = Number(req.params.appointmentId);
        const { reason } = req.body; // optional reason string

        try {
            const [rows] = await db.query(
                `SELECT p.payment_id, p.status, p.method, p.amount,
                        p.paymongo_payment_id
                 FROM payments p
                 WHERE p.appointment_id = ?`,
                [appointmentId]
            );

            if (rows.length === 0) {
                return res.status(404).json({ message: 'Payment record not found' });
            }

            const payment = rows[0];

            // eli: Only paid or refund_pending payments can be refunded
            if (!['paid', 'refund_pending'].includes(payment.status)) {
                return res.status(409).json({
                    message: `Cannot refund a payment with status '${payment.status}'. It must be 'paid' or 'refund_pending'.`
                });
            }

            // Online payments: call PayMongo Refund API
            if (payment.method === 'online') {
                if (!payment.paymongo_payment_id) {
                    return res.status(400).json({ message: 'No PayMongo payment ID found — cannot process online refund.' });
                }

                const amountInCentavos = Math.round(Number(payment.amount) * 100);

                const refundRes = await fetch(`${PAYMONGO_BASE}/refunds`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': paymongoAuth()
                    },
                    body: JSON.stringify({
                        data: {
                            attributes: {
                                amount: amountInCentavos,
                                payment_id: payment.paymongo_payment_id,
                                reason: reason || 'others',
                                // eli to eli: valid PayMongo refund reasons: 'duplicate', 'fraudulent', 'others'
                                notes: reason || 'Appointment cancelled - refund requested by patient'
                            }
                        }
                    })
                });

                const refundData = await refundRes.json();

                if (!refundRes.ok) {
                    console.error('PayMongo refund error:', refundData);
                    return res.status(502).json({ message: 'PayMongo refund failed. Please try again or process manually.' });
                }
            }

            // eli: For cash/card, no API call needed — just update the DB
            await db.query(
                `UPDATE payments SET status = 'refunded' WHERE appointment_id = ?`,
                [appointmentId]
            );

            await logActivity(db, {
                user_id:      req.user.user_id,
                user_role:    req.user.role,
                action:       'PAYMENT_REFUNDED',
                target_table: 'payments',
                target_id:    appointmentId,
                notes:        `Refund processed for appointment #${appointmentId} (method: ${payment.method}).${reason ? ' Reason: ' + reason : ''}`,
                ip_address:   getIp(req)
            });

            res.json({
                message: payment.method === 'online'
                    ? 'Refund submitted to PayMongo. It may take 5–10 business days to reflect.'
                    : 'Payment marked as refunded. Please return the cash to the patient manually.'
            });

        } catch (err) {
            console.error('Refund error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });


    // ── 5. GET /api/payments/:appointmentId ────────────────────────────────────
    // Returns the payment status for an appointment.
    // Usable by the patient (their own appointment) or staff (any appointment).
    app.get('/api/payments/:appointmentId', authenticateToken, async (req, res) => {
        const appointmentId = Number(req.params.appointmentId);

        try {
            const [rows] = await db.query(
                `SELECT p.payment_id, p.amount, p.method, p.status,
                        p.payment_date, p.paid_at, p.checkout_url,
                        a.patient_id
                 FROM payments p
                 JOIN appointments a ON p.appointment_id = a.appointment_id
                 WHERE p.appointment_id = ?`,
                [appointmentId]
            );

            if (rows.length === 0) {
                return res.status(404).json({ message: 'Payment not found' });
            }

            const p = rows[0];

            // eli: Patients can only see their own payment
            if (req.user.role === 'patient' && Number(p.patient_id) !== Number(req.user.user_id)) {
                return res.status(403).json({ message: 'Not authorized' });
            }

            res.json({
                amount:       p.amount,
                method:       p.method,
                status:       p.status,
                payment_date: p.payment_date,
                paid_at:      p.paid_at,
                checkout_url: p.checkout_url
            });

        } catch (err) {
            console.error('Get payment error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });
}

module.exports = registerPaymentRoutes;
