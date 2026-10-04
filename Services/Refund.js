// Refund.js — refund helper used right after a patient cancels an appointment.
// Online (PayMongo) payments are refunded automatically; cash / in-person card
// payments stay 'refund_pending' so staff hand the money back and press Refund.
// Uses the same PayMongo rules as the staff route in PaymentRoutes.js:
//   reason must be duplicate | fraudulent | others, amount is in centavos,
//   status becomes 'refunded' only when PayMongo says 'succeeded'.

const { logActivity } = require('../Admin/auditLogRoutes');

const PAYMONGO_BASE = 'https://api.paymongo.com/v1';

function paymongoAuth() {
    return 'Basic ' + Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64');
}

/**
 * Returns { status, message } and never throws — a failed refund must not undo the cancellation.
 * status: 'none' | 'refunded' | 'refund_pending' | 'manual' | 'error'
 */
async function refundAfterCancel(db, appointmentId, { userId, note, ip } = {}) {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            `SELECT payment_id, status, method, amount, paymongo_payment_id, paymongo_refund_id
             FROM payments WHERE appointment_id = ? FOR UPDATE`,
            [appointmentId]
        );
        const p = rows[0];

        // Nothing paid (or already refunded) -> nothing to do.
        if (!p || !['paid', 'refund_pending'].includes(p.status)) {
            await conn.rollback();
            return { status: 'none', message: '' };
        }

        // Cash / in-person card: staff return it manually.
        if (p.method !== 'online') {
            await conn.rollback();
            return { status: 'manual', message: 'Please visit the clinic to receive your refund.' };
        }

        if (!p.paymongo_payment_id) {
            await conn.rollback();
            console.error(`[refund] appointment ${appointmentId}: no paymongo_payment_id`);
            return { status: 'error', message: 'Your refund is pending review by our staff.' };
        }

        // Reuse an existing refund instead of creating a second one.
        let refundRes;
        if (p.paymongo_refund_id) {
            refundRes = await fetch(`${PAYMONGO_BASE}/refunds/${encodeURIComponent(p.paymongo_refund_id)}`, {
                headers: { Authorization: paymongoAuth() }
            });
        } else {
            refundRes = await fetch(`${PAYMONGO_BASE}/refunds`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: paymongoAuth() },
                body: JSON.stringify({
                    data: {
                        attributes: {
                            amount: Math.round(Number(p.amount) * 100),
                            payment_id: p.paymongo_payment_id,
                            reason: 'others',
                            notes: (note ? `Patient cancelled: ${note}` : `Patient cancelled appointment #${appointmentId}`).slice(0, 200)
                        }
                    }
                })
            });
        }

        const data = await refundRes.json().catch(() => ({}));
        if (!refundRes.ok || !data?.data?.id) {
            console.error('[refund] PayMongo error:', JSON.stringify(data));
            await conn.rollback();
            return { status: 'error', message: 'We could not process your refund automatically. Our staff will complete it shortly.' };
        }

        const refundId = data.data.id;
        const refundStatus = data.data.attributes?.status;

        if (refundStatus === 'failed') {
            await conn.query(`UPDATE payments SET paymongo_refund_id = NULL WHERE payment_id = ?`, [p.payment_id]);
            await conn.commit();
            return { status: 'error', message: 'Your refund could not be completed automatically. Our staff will follow up.' };
        }

        const finalStatus = refundStatus === 'succeeded' ? 'refunded' : 'refund_pending';
        await conn.query(
            `UPDATE payments
             SET status = ?, paymongo_refund_id = ?,
                 refunded_at = CASE WHEN ? = 'refunded' THEN NOW() ELSE NULL END
             WHERE payment_id = ?`,
            [finalStatus, refundId, finalStatus, p.payment_id]
        );
        await conn.commit();

        await logActivity(db, {
            user_id: userId || null,
            user_role: 'patient',
            action: finalStatus === 'refunded' ? 'PAYMENT_REFUNDED' : 'PAYMENT_REFUND_REQUESTED',
            target_table: 'payments',
            target_id: Number(appointmentId),
            notes: `Auto-refund ${finalStatus} after patient cancellation (refund ${refundId}).`,
            ip_address: ip || null
        });

        return {
            status: finalStatus,
            message: finalStatus === 'refunded'
                ? 'Your payment has been refunded. E-wallets usually receive it within 24 hours; cards can take up to 30 days.'
                : 'Your refund has been submitted and is being processed.'
        };
    } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        console.error('[refund] unexpected error:', err);
        return { status: 'error', message: 'Your refund is pending review by our staff.' };
    } finally {
        conn.release();
    }
}

// eli change: staff-side online refund. Replaces the old route logic that always created a NEW PayMongo
// refund. When a patient cancels, refundAfterCancel above already creates the PayMongo refund, so the staff
// button's second POST was rejected by PayMongo (502) and the row stayed 'refund_pending' forever.
// This version is idempotent: it re-checks the existing refund, and only creates one if none exists.
async function processOnlineRefund(db, appointmentId, { note, reasonCode } = {}) {
    const [rows] = await db.query(
        `SELECT payment_id, status, amount, paymongo_payment_id, paymongo_refund_id
         FROM payments WHERE appointment_id = ?`,
        [appointmentId]
    );
    const p = rows[0];
    if (!p) return { http: 404, message: 'Payment record not found' };
    if (!p.paymongo_payment_id) {
        return { http: 400, message: 'No PayMongo payment ID found — cannot process online refund.' };
    }

    let refund = null;

    // 1) A refund was already created (by the patient's cancel, or an earlier click): look it up.
    if (p.paymongo_refund_id) {
        const r = await fetch(`${PAYMONGO_BASE}/refunds/${encodeURIComponent(p.paymongo_refund_id)}`, {
            headers: { Authorization: paymongoAuth() }
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d?.data?.attributes?.status !== 'failed') refund = d.data;
    }

    // 2) None yet: create it.
    if (!refund) {
        const r = await fetch(`${PAYMONGO_BASE}/refunds`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: paymongoAuth() },
            body: JSON.stringify({
                data: { attributes: {
                    amount: Math.round(Number(p.amount) * 100),
                    payment_id: p.paymongo_payment_id,
                    reason: ['duplicate', 'fraudulent', 'requested_by_customer', 'others'].includes(reasonCode) ? reasonCode : 'others',
                    notes: String(note || 'Appointment cancelled - refund requested').slice(0, 200)
                } }
            })
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d?.data?.id) {
            refund = d.data;
        } else {
            console.error('[refund] PayMongo create failed:', JSON.stringify(d));
            // 3) PayMongo refuses a second refund for the same payment. If one already exists there
            //    (e.g. the id was never saved), find it by payment id and adopt it instead of failing.
            const l = await fetch(`${PAYMONGO_BASE}/refunds?limit=100`, { headers: { Authorization: paymongoAuth() } });
            const ld = await l.json().catch(() => ({}));
            const found = (ld?.data || []).find(x =>
                x?.attributes?.payment_id === p.paymongo_payment_id && x?.attributes?.status !== 'failed');
            if (found) {
                refund = found;
            } else {
                const detail = d?.errors?.[0]?.detail || 'unknown error';
                return { http: 502, message: `PayMongo refund failed: ${detail}` };
            }
        }
    }

    const finalStatus = refund.attributes?.status === 'succeeded' ? 'refunded' : 'refund_pending';
    await db.query(
        `UPDATE payments
         SET status = ?, paymongo_refund_id = ?,
             refunded_at = CASE WHEN ? = 'refunded' THEN COALESCE(refunded_at, NOW()) ELSE NULL END
         WHERE payment_id = ?`,
        [finalStatus, refund.id, finalStatus, p.payment_id]
    );
    return {
        http: 200,
        status: finalStatus,
        message: finalStatus === 'refunded'
            ? 'Refund completed. It is returned to the patient\'s original payment method.'
            : 'Refund submitted to PayMongo and is still processing. It will show as Refunded once PayMongo completes it.'
    };
}

// eli change: moves online 'refund_pending' payments to 'refunded' once PayMongo reports the refund succeeded.
// Called whenever the receptionist payments list or a patient's appointment list loads (no webhook needed).
async function syncPendingRefunds(db, { patientId = null, limit = 10 } = {}) {
    try {
        const params = [];
        let patientSql = '';
        if (patientId) { patientSql = 'AND a.patient_id = ?'; params.push(patientId); }
        params.push(limit);
        const [rows] = await db.query(
            `SELECT p.payment_id, p.paymongo_refund_id
             FROM payments p JOIN appointments a ON a.appointment_id = p.appointment_id
             WHERE p.method = 'online' AND p.status = 'refund_pending' AND p.paymongo_refund_id IS NOT NULL
               ${patientSql}
             ORDER BY p.payment_id DESC LIMIT ?`,
            params
        );
        await Promise.allSettled(rows.map(async r => {
            const res = await fetch(`${PAYMONGO_BASE}/refunds/${encodeURIComponent(r.paymongo_refund_id)}`, {
                headers: { Authorization: paymongoAuth() }
            });
            const d = await res.json().catch(() => ({}));
            const st = d?.data?.attributes?.status;
            console.log(`[refund sync] ${r.paymongo_refund_id}: ${st}`);
            if (res.ok && st === 'succeeded') {
                await db.query(`UPDATE payments SET status = 'refunded', refunded_at = COALESCE(refunded_at, NOW()) WHERE payment_id = ?`, [r.payment_id]);
            }
        }));
    } catch (err) {
        console.error('[refund sync] failed:', err);
    }
}

module.exports = { refundAfterCancel, processOnlineRefund, syncPendingRefunds };