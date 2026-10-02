// payment and refund logic using PayMongo
// Routes:
//   POST   /api/payments/:appointmentId/create-checkout - Patient starts a PayMongo Hosted Checkout (v2) session
//   POST   /api/payments/:appointmentId/reconcile       - Re-checks PayMongo if the webhook was missed
//   (Online payments are CONFIRMED only by the webhook in PaymongoWebhook.js)
//   PATCH  /api/payments/:appointmentId/mark-paid     - Receptionist marks cash/card payment as paid
//   POST   /api/payments/:appointmentId/refund        - Admin/receptionist issues a refund via PayMongo

const authenticateToken = require('../authMiddleware');
const { logActivity } = require('../Admin/auditLogRoutes');
const { createCheckoutSession, getCheckoutSession } = require('./paymongo');
const { handlePaid } = require('./PaymongoWebhook');

// Must match the real filename in /Customer EXACTLY: Vercel (Linux) is case-sensitive.
const PAYMENT_SUCCESS_PAGE = 'Paymentsuccess.html';
const REFUND_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer', 'others'];

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

    // ── 1. POST /api/payments/:appointmentId/create-checkout ──────────────────
    // Called right after an online booking is created (and by a "Pay now" button
    // while the hold is still active). Creates ONE Hosted Checkout session per
    // appointment, saves its id so the webhook can match it, and returns the URL.
    app.post('/api/payments/:appointmentId/create-checkout', authenticateToken, async (req, res) => {
        if (req.user.role !== 'patient') {
            return res.status(403).json({ message: 'Patients only' });
        }

        const appointmentId = Number(req.params.appointmentId);
        if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
            return res.status(400).json({ message: 'Invalid appointment id' });
        }

        try {
            const [rows] = await db.query(
                `SELECT a.patient_id, a.appointment_status,
                        (a.hold_expires_at IS NOT NULL AND a.hold_expires_at <= NOW()) AS hold_expired,
                        p.amount, p.method, p.status AS payment_status,
                        p.paymongo_session_id, p.checkout_url,
                        s.label AS service_label
                 FROM appointments a
                 JOIN payments p ON p.appointment_id = a.appointment_id
                 JOIN services s ON s.service_id = a.service_id
                 WHERE a.appointment_id = ?`,
                [appointmentId]
            );

            if (rows.length === 0) {
                return res.status(404).json({ message: 'Appointment or payment record not found' });
            }
            const appt = rows[0];

            if (Number(appt.patient_id) !== Number(req.user.user_id)) {
                return res.status(403).json({ message: 'Not authorized' });
            }
            if (appt.method !== 'online') {
                return res.status(400).json({ message: 'This appointment is set for in-person payment. Please pay at the clinic.' });
            }
            if (appt.payment_status !== 'pending') {
                return res.status(409).json({ message: 'This appointment has already been paid or closed.' });
            }
            if (appt.appointment_status !== 'pending' || appt.hold_expired) {
                return res.status(409).json({ message: 'The hold on this time slot has expired. Please book again.' });
            }

            // One session per appointment: reuse it while the hold is active.
            if (appt.paymongo_session_id && appt.checkout_url) {
                return res.json({ checkout_url: appt.checkout_url, reused: true });
            }

            // APP_BASE_URL avoids req.protocol surprises behind Vercel's proxy.
            const baseUrl = (process.env.APP_BASE_URL || `https://${req.get('host')}`).replace(/\/$/, '');

            // A single line item for the full amount, so it always equals payments.amount
            // even when several services were booked together.
            const session = await createCheckoutSession({
                appointmentId,
                items: [{
                    name: `Bungipin Dental Clinic - Appointment #${appointmentId} (${appt.service_label})`,
                    price: appt.amount
                }],
                successUrl: `${baseUrl}/Customer/${PAYMENT_SUCCESS_PAGE}?appointment_id=${appointmentId}`,
                cancelUrl: `${baseUrl}/Customer/History.html`
            });

            // Only the first writer wins, so a double-click can't swap the session id
            // out from under a customer who is already paying.
            const [upd] = await db.query(
                `UPDATE payments SET paymongo_session_id = ?, checkout_url = ?
                 WHERE appointment_id = ? AND paymongo_session_id IS NULL`,
                [session.id, session.checkoutUrl, appointmentId]
            );
            if (upd.affectedRows === 0) {
                const [[saved]] = await db.query(
                    'SELECT checkout_url FROM payments WHERE appointment_id = ?', [appointmentId]
                );
                return res.json({ checkout_url: saved.checkout_url, reused: true });
            }

            await logActivity(db, {
                user_id:      req.user.user_id,
                user_role:    'patient',
                action:       'PAYMENT_CHECKOUT_CREATED',
                target_table: 'payments',
                target_id:    appointmentId,
                notes:        `PayMongo checkout session ${session.id} created for appointment #${appointmentId}.`,
                ip_address:   getIp(req)
            });

            res.json({ checkout_url: session.checkoutUrl });

        } catch (err) {
            console.error('Create checkout error:', err.details || err);
            if (err.details) {
                return res.status(502).json({ message: 'Failed to start the payment. Please try again.' });
            }
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });


    // ── 2. POST /api/payments/:appointmentId/reconcile ─────────────────────────
    // Safety net for a missed/failed webhook. Asks PayMongo directly whether the
    // session was paid and, if so, runs the SAME confirmation code the webhook
    // uses (idempotent, amount-checked, slot re-checked). The browser is never
    // trusted: only PayMongo's own answer counts.
    app.post('/api/payments/:appointmentId/reconcile', authenticateToken, async (req, res) => {
        const appointmentId = Number(req.params.appointmentId);
        if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
            return res.status(400).json({ message: 'Invalid appointment id' });
        }

        try {
            const [rows] = await db.query(
                `SELECT p.status, p.method, p.paymongo_session_id, a.patient_id
                 FROM payments p
                 JOIN appointments a ON a.appointment_id = p.appointment_id
                 WHERE p.appointment_id = ?`,
                [appointmentId]
            );
            if (rows.length === 0) {
                return res.status(404).json({ message: 'Payment record not found' });
            }
            const row = rows[0];

            const isStaff = ['employee', 'admin'].includes(req.user.role);
            if (!isStaff && Number(row.patient_id) !== Number(req.user.user_id)) {
                return res.status(403).json({ message: 'Not authorized' });
            }

            // Nothing to reconcile unless an online payment is still waiting.
            if (row.method !== 'online' || row.status !== 'pending' || !row.paymongo_session_id) {
                return res.json({ status: row.status });
            }

            try {
                const session = await getCheckoutSession(row.paymongo_session_id);
                const payments = session?.attributes?.payments || [];
                // handlePaid falls back to payments[0], so only call it when PayMongo
                // actually reports a paid payment.
                if (payments.some(p => p.attributes?.status === 'paid')) {
                    await handlePaid(db, session);
                }
            } catch (err) {
                console.error('Reconcile failed:', err.details || err);
                return res.status(502).json({ message: 'Could not check with PayMongo right now.' });
            }

            const [[fresh]] = await db.query('SELECT status FROM payments WHERE appointment_id = ?', [appointmentId]);
            res.json({ status: fresh.status });

        } catch (err) {
            console.error('Reconcile error:', err);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    });


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
                                // PayMongo only accepts a fixed set of reason codes; staff's
                                // free-text explanation goes in `notes` instead.
                                reason: REFUND_REASONS.includes(req.body.reason_code) ? req.body.reason_code : 'others',
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