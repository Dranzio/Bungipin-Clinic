// PaymongoWebhook.js
// POST /api/webhooks/paymongo  — PayMongo calls this when a checkout is paid.
// This is the ONLY place an online payment becomes 'paid'. The browser
// redirect to success_url is just a UX hint and is never trusted.
//
// IMPORTANT: register this BEFORE app.use(express.json()) in your server file,
// because signature checking needs the raw, unparsed body.

const express = require('express');
const { logActivity } = require('../Admin/auditLogRoutes');
const { verifyWebhookSignature, BLOCKING_SQL, getCheckoutSession } = require('./paymongo');
const { sendAppointmentEmail } = require('../AppointmentEmails');

// PaymongoWebhook.js
// POST /api/webhooks/paymongo  — PayMongo calls this when a checkout is paid.
// This is the ONLY place an online payment becomes 'paid'. The browser
// redirect to success_url is just a UX hint and is never trusted.
//
// IMPORTANT: register this BEFORE app.use(express.json()) in your server file,
// because signature checking needs the raw, unparsed body.

const express = require('express');
const { logActivity } = require('../Admin/auditLogRoutes');
const { verifyWebhookSignature, BLOCKING_SQL, getCheckoutSession } = require('./paymongo');
const { sendAppointmentEmail } = require('../AppointmentEmails');

async function handlePaid(db, session) {
    const match = /^APPT-(\d+)$/.exec(session.attributes?.reference_number || '');
    // eli change: log instead of silently returning, so a skipped payment can be diagnosed
    if (!match) { console.error('[paymongo] handlePaid: no APPT-<id> reference on session', session?.id); return; } // not one of ours
    const appointmentId = Number(match[1]);

    const payments = session.attributes?.payments || [];
    const pay = payments.find(p => p.attributes?.status === 'paid') || payments[0];

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            `SELECT p.payment_id, p.status AS payment_status, p.amount, p.paymongo_session_id,
                    a.patient_id, a.appointment_status, a.employee_id,
                    a.appointment_date, a.time_slot, a.end_time
             FROM payments p
                      JOIN appointments a ON a.appointment_id = p.appointment_id
             WHERE p.appointment_id = ?
                 FOR UPDATE`,
            [appointmentId]
        );
        if (rows.length === 0) { await conn.rollback(); return; }
        const row = rows[0];

        // Must be the exact session we created for this appointment.
        if (row.paymongo_session_id !== session.id) {
            console.error(`[paymongo] session mismatch for appointment ${appointmentId}`);
            await conn.rollback(); return;
        }
        // Duplicate delivery / already handled -> no-op (idempotent).
        // eli change: log the skip (webhook + reconcile can both fire; this is the normal "already done" case)
        if (row.payment_status !== 'pending') { console.log(`[paymongo] appointment ${appointmentId} already '${row.payment_status}', skipping`); await conn.rollback(); return; }

        // Never trust the amount blindly.
        const expected = Math.round(Number(row.amount) * 100);
        const paid = Number(pay?.attributes?.amount);
        if (!Number.isFinite(paid) || paid < expected) {
            console.error(`[paymongo] amount mismatch for appointment ${appointmentId}: paid=${paid} expected=${expected}`);
            await conn.rollback(); return;
        }

        // The hold may have lapsed (customer paid late). Make sure the slot is
        // still free of anyone else's booking before confirming.
        const [clash] = await conn.query(
            `SELECT a.appointment_id FROM appointments a
             WHERE a.employee_id = ? AND a.appointment_date = ?
               AND a.appointment_id <> ? AND ${BLOCKING_SQL}
               AND a.time_slot < ? AND ? < a.end_time
                 FOR UPDATE`,
            [row.employee_id, row.appointment_date, appointmentId, row.end_time, row.time_slot]
        );
        const slotTaken = clash.length > 0;

        // Slot taken -> keep the money record but flag for refund (your existing
        // /refund route already accepts 'refund_pending').
        await conn.query(
            `UPDATE payments
             SET status = ?, paymongo_payment_id = ?, paid_at = NOW(), payment_date = CURDATE()
             WHERE payment_id = ?`,
            [slotTaken ? 'refund_pending' : 'paid', pay?.id || null, row.payment_id]
        );
        await conn.query(
            `UPDATE appointments SET appointment_status = ?, hold_expires_at = NULL
             WHERE appointment_id = ?`,
            [slotTaken ? 'cancelled' : 'pending', appointmentId]
        );

        await conn.commit();

        await logActivity(db, {
            user_id: row.patient_id,
            user_role: 'patient',
            action: slotTaken ? 'PAYMENT_PAID_SLOT_LOST' : 'PAYMENT_CONFIRMED',
            target_table: 'payments',
            target_id: appointmentId,
            notes: `PayMongo webhook: session ${session.id}, payment ${pay?.id}.` +
                (slotTaken ? ' Slot was taken after hold expiry — marked refund_pending.' : ''),
            ip_address: null
        });

        // Online bookings only count as "booked" once they're paid, so this is
        // where the patient's booking-received email goes. (Never throws.)
        // The payment receipt is folded into this booking email (AppointmentEmails.js sees
        // the payment is 'paid'), so the patient gets ONE email instead of two.
        if (!slotTaken) {
            await sendAppointmentEmail(db, appointmentId, 'booked');
        } else {
            // Paid, but the slot was taken: payment is 'refund_pending' and the appointment is
            // cancelled, so this cancelled email automatically carries the refund notice.
            await sendAppointmentEmail(db, appointmentId, 'cancelled', { slotLost: true, cancelledBy: 'clinic' });
        }
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// eli change: self-healing sync. Asks PayMongo about online payments still marked 'pending'
// and confirms the ones PayMongo reports as paid. This makes 'pending' -> 'paid' work even when
// the webhook can't reach this server (localhost, expired ngrok URL, missed delivery).
// It is called whenever the receptionist payments list or a patient's appointment list loads.
// Safe to run repeatedly: handlePaid is idempotent and checks the amount + slot itself.
async function syncPendingOnlinePayments(db, { patientId = null, limit = 10 } = {}) {
    try {
        const params = [];
        let patientSql = '';
        if (patientId) { patientSql = 'AND a.patient_id = ?'; params.push(patientId); }
        params.push(limit);
        const [rows] = await db.query(
            `SELECT p.appointment_id, p.paymongo_session_id
             FROM payments p
             JOIN appointments a ON a.appointment_id = p.appointment_id
             WHERE p.method = 'online' AND p.status = 'pending'
               AND p.paymongo_session_id IS NOT NULL
               AND a.created_at > NOW() - INTERVAL 2 DAY
               ${patientSql}
             ORDER BY p.payment_id DESC
             LIMIT ?`,
            params
        );
        await Promise.allSettled(rows.map(async r => {
            const session = await getCheckoutSession(r.paymongo_session_id);
            const payments = session?.attributes?.payments || [];
            const isPaid = payments.some(p => (p.attributes?.status ?? p.status) === 'paid');
            console.log(`[paymongo sync] appt ${r.appointment_id}: ${isPaid ? 'PAID at PayMongo' : 'not paid yet'}`);
            if (isPaid) await handlePaid(db, session);
        }));
    } catch (err) {
        console.error('[paymongo sync] failed:', err.details || err);
    }
}

function registerPaymongoWebhook(app, db) {
    app.post('/api/webhooks/paymongo', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
        if (!Buffer.isBuffer(req.body)) {
            console.error('[paymongo] body was already parsed — mount this route before express.json()');
            return res.status(500).json({ message: 'Server misconfigured' });
        }

        const raw = req.body.toString('utf8');
        if (!verifyWebhookSignature(raw, req.get('Paymongo-Signature'))) {
            return res.status(401).json({ message: 'Invalid signature' });
        }

        let event;
        try { event = JSON.parse(raw); }
        catch { return res.status(400).json({ message: 'Bad JSON' }); }

        try {
            // [PAYMONGO FIX] PayMongo's docs show TWO event layouts: the newer one puts the type at
            // data.type and the session at data.data; the older one at data.attributes.type /
            // data.attributes.data. Accept either so a webhook version change can't silently break this.
            const ev = event?.data;
            const evType = ev?.attributes?.type || ev?.type;
            const session = ev?.attributes?.data || ev?.data;
            if (evType === 'checkout_session.payment.paid' && session?.id) {
                await handlePaid(db, session);
            }
            // Unknown event types: still 200 so PayMongo doesn't retry them.
            return res.status(200).json({ received: true });
        } catch (err) {
            console.error('[paymongo] webhook processing failed:', err);
            // 500 -> PayMongo retries (our handler is idempotent).
            return res.status(500).json({ message: 'Processing failed' });
        }
    });
}

module.exports = registerPaymongoWebhook;
// Also used by the reconcile route in PaymentRoutes.js.
module.exports.handlePaid = handlePaid;
// eli change: exported so the payments list and the patient's appointment list can self-heal
module.exports.syncPendingOnlinePayments = syncPendingOnlinePayments;

// eli change: self-healing sync. Asks PayMongo about online payments still marked 'pending'
// and confirms the ones PayMongo reports as paid. This makes 'pending' -> 'paid' work even when
// the webhook can't reach this server (localhost, expired ngrok URL, missed delivery).
// It is called whenever the receptionist payments list or a patient's appointment list loads.
// Safe to run repeatedly: handlePaid is idempotent and checks the amount + slot itself.
async function syncPendingOnlinePayments(db, { patientId = null, limit = 10 } = {}) {
    try {
        const params = [];
        let patientSql = '';
        if (patientId) { patientSql = 'AND a.patient_id = ?'; params.push(patientId); }
        params.push(limit);
        const [rows] = await db.query(
            `SELECT p.appointment_id, p.paymongo_session_id
             FROM payments p
             JOIN appointments a ON a.appointment_id = p.appointment_id
             WHERE p.method = 'online' AND p.status = 'pending'
               AND p.paymongo_session_id IS NOT NULL
               AND a.created_at > NOW() - INTERVAL 2 DAY
               ${patientSql}
             ORDER BY p.payment_id DESC
             LIMIT ?`,
            params
        );
        await Promise.allSettled(rows.map(async r => {
            const session = await getCheckoutSession(r.paymongo_session_id);
            const payments = session?.attributes?.payments || [];
            const isPaid = payments.some(p => (p.attributes?.status ?? p.status) === 'paid');
            console.log(`[paymongo sync] appt ${r.appointment_id}: ${isPaid ? 'PAID at PayMongo' : 'not paid yet'}`);
            if (isPaid) await handlePaid(db, session);
        }));
    } catch (err) {
        console.error('[paymongo sync] failed:', err.details || err);
    }
}

function registerPaymongoWebhook(app, db) {
    app.post('/api/webhooks/paymongo', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
        if (!Buffer.isBuffer(req.body)) {
            console.error('[paymongo] body was already parsed — mount this route before express.json()');
            return res.status(500).json({ message: 'Server misconfigured' });
        }

        const raw = req.body.toString('utf8');
        if (!verifyWebhookSignature(raw, req.get('Paymongo-Signature'))) {
            return res.status(401).json({ message: 'Invalid signature' });
        }

        let event;
        try { event = JSON.parse(raw); }
        catch { return res.status(400).json({ message: 'Bad JSON' }); }

        try {
            // [PAYMONGO FIX] PayMongo's docs show TWO event layouts: the newer one puts the type at
            // data.type and the session at data.data; the older one at data.attributes.type /
            // data.attributes.data. Accept either so a webhook version change can't silently break this.
            const ev = event?.data;
            const evType = ev?.attributes?.type || ev?.type;
            const session = ev?.attributes?.data || ev?.data;
            if (evType === 'checkout_session.payment.paid' && session?.id) {
                await handlePaid(db, session);
            }
            // Unknown event types: still 200 so PayMongo doesn't retry them.
            return res.status(200).json({ received: true });
        } catch (err) {
            console.error('[paymongo] webhook processing failed:', err);
            // 500 -> PayMongo retries (our handler is idempotent).
            return res.status(500).json({ message: 'Processing failed' });
        }
    });
}

module.exports = registerPaymongoWebhook;
// Also used by the reconcile route in PaymentRoutes.js.
module.exports.handlePaid = handlePaid;
// eli change: exported so the payments list and the patient's appointment list can self-heal
module.exports.syncPendingOnlinePayments = syncPendingOnlinePayments;