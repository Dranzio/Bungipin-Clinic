// paymongo.js — shared PayMongo helpers (Hosted Checkout v2 + webhook verification)
const crypto = require('crypto');

const BASE = 'https://api.paymongo.com';
const HOLD_MINUTES = 15;

// Which appointments currently occupy a slot. Use with the table alias "a".
// A 'pending' row only blocks while its hold hasn't expired, so an
// abandoned checkout frees the slot automatically (no cron required).
const BLOCKING_SQL = `(a.appointment_status = 'approved'
    OR (a.appointment_status = 'pending'
        AND (a.hold_expires_at IS NULL OR a.hold_expires_at > NOW())))`;

function authHeader() {
    // Secret key is the Basic-auth username; the trailing colon = empty password.
    return 'Basic ' + Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64');
}

/**
 * Create a Checkout Session (v2) and return { id, checkoutUrl }.
 * items: [{ name, price }]  (price in pesos; converted to centavos here)
 */
async function createCheckoutSession({ appointmentId, items, successUrl, cancelUrl }) {
    const res = await fetch(`${BASE}/v2/checkout_sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
        body: JSON.stringify({
            data: {
                attributes: {
                    line_items: items.map(i => ({
                        name: String(i.name).slice(0, 255),
                        amount: Math.round(Number(i.price) * 100),
                        currency: 'PHP',
                        quantity: 1
                    })),
                    // Must be enabled on your PayMongo account or the request is rejected.
                    payment_method_types: ['card', 'gcash', 'paymaya', 'qrph'],
                    success_url: successUrl,
                    cancel_url: cancelUrl,
                    reference_number: `APPT-${appointmentId}`,
                    send_email_receipt: true,
                    metadata: { appointment_id: String(appointmentId) }
                }
            }
        })
    });

    const json = await res.json();
    if (!res.ok) {
        const err = new Error('PayMongo checkout session creation failed');
        err.details = json;
        throw err;
    }
    return { id: json.data.id, checkoutUrl: json.data.attributes.checkout_url };
}

/**
 * Fetch a Checkout Session by id (used to double-check a payment when the
 * webhook was missed). Uses PayMongo's documented "Retrieve a Checkout" call.
 * Returns the session resource ({ id, attributes }).
 */
async function getCheckoutSession(sessionId) {
    const res = await fetch(`${BASE}/v1/checkout_sessions/${encodeURIComponent(sessionId)}`, {
        headers: { Authorization: authHeader() }
    });
    const json = await res.json();
    if (!res.ok) {
        const err = new Error('PayMongo checkout session lookup failed');
        err.details = json;
        throw err;
    }
    return json.data;
}

/**
 * Verify the Paymongo-Signature header against the RAW request body.
 * Format used here: "t=<timestamp>,te=<test sig>,li=<live sig>", where each
 * sig = HMAC-SHA256(webhookSecret, `${t}.${rawBody}`) as hex.
 * Matches PayMongo's "Securing a webhook" docs: use `te` for test-mode events
 * and `li` for live-mode events.
 */
function verifyWebhookSignature(rawBody, header) {
    const secret = process.env.PAYMONGO_WEBHOOK_SECRET;
    if (!header || !secret) return false;

    const parts = {};
    for (const piece of header.split(',')) {
        const idx = piece.indexOf('=');
        if (idx > 0) parts[piece.slice(0, idx).trim()] = piece.slice(idx + 1).trim();
    }
    if (!parts.t) return false;

    const expected = crypto.createHmac('sha256', secret)
        .update(`${parts.t}.${rawBody}`)
        .digest('hex');

    return [parts.te, parts.li].filter(Boolean).some(sig =>
        sig.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    );
}

module.exports = { BLOCKING_SQL, HOLD_MINUTES, createCheckoutSession, getCheckoutSession, verifyWebhookSignature };