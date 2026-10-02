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

module.exports = { refundAfterCancel };