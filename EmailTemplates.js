// EmailTemplates.js
// One place for every email the app sends. Each builder returns
// { subject, text, html } which can be spread straight into sendEmail():
//
//   const { sendEmail } = require('./Mailer');
//   await sendEmail({ to, ...appointmentBooked({ ... }) });
//
// For notifications that must NEVER break the request that triggered them
// (booking, approving, cancelling...), use notify() instead — it logs and
// swallows email errors:
//
//   notify(customer.email, appointmentApproved({ ... }));
//
// Optional env vars:
//   APP_BASE_URL         e.g. https://yourapp.vercel.app  (links in emails)
//   CLINIC_CONTACT_TEXT  e.g. "the clinic at 0917 123 4567 or clinic@example.com"

const CLINIC_NAME = 'Bungipin Dental Clinic';

// Brand colors taken from the site.
const C = {
    header: '#A2AC89',
    page: '#F3EFE4',
    card: '#FFFFFF',
    soft: '#D3DCBE',
    accent: '#D5C04D',
    ink: '#2A1001'
};

const BADGES = {
    pending:   { label: 'Pending approval', bg: '#FFF4CC', fg: '#7A5B00' },
    approved:  { label: 'Approved',         bg: '#DDEFD3', fg: '#245018' },
    cancelled: { label: 'Cancelled',        bg: '#F8D9D6', fg: '#8A1F17' },
    declined:  { label: 'Declined',         bg: '#F8D9D6', fg: '#8A1F17' },
    changed:   { label: 'Rescheduled',      bg: '#E3E8F7', fg: '#26407A' },
    paid:      { label: 'Paid',             bg: '#DDEFD3', fg: '#245018' },
    refunded:  { label: 'Refunded',         bg: '#E3E8F7', fg: '#26407A' },
    info:      { label: '',                 bg: '#EEE',    fg: '#333' }
};

// ---------- helpers ----------

// Names/services can contain apostrophes, ampersands etc.; never trust them in HTML.
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function baseUrl() {
    return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function clinicContact() {
    return process.env.CLINIC_CONTACT_TEXT || 'the clinic';
}

// Turns a value into a real Date without shifting it.
// db.js uses dateStrings: true and a +08:00 session, so MySQL timestamps arrive
// as plain "YYYY-MM-DD HH:MM:SS" strings that are ALREADY Philippine time.
// new Date() on such a string assumes the server's zone (UTC on Vercel), which
// makes emails show times 8 hours late. Pin those strings to +08:00 instead.
// Real Date objects and strings that already carry a zone pass through as-is.
function parseDbDate(value) {
    if (value instanceof Date) return value;
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
        return new Date(s.replace(' ', 'T') + '+08:00');
    }
    return new Date(s);
}

// Accepts 'YYYY-MM-DD', a JS Date, or an already-formatted string.
// Returns e.g. "Saturday, October 10, 2026".
function formatDate(value) {
    if (!value) return '';
    const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
        const [y, m, d] = value.slice(0, 10).split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-PH', { ...opts, timeZone: 'UTC' });
    }
    const date = parseDbDate(value);
    if (isNaN(date)) return String(value);
    return date.toLocaleDateString('en-PH', { ...opts, timeZone: 'Asia/Manila' });
}

// '14:30:00' -> '2:30 PM'. Anything else is passed through untouched.
function formatTime(value) {
    if (!value) return '';
    const match = /^(\d{1,2}):(\d{2})/.exec(String(value));
    if (!match) return String(value);
    let h = Number(match[1]);
    const suffix = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${match[2]} ${suffix}`;
}

// 1500 -> "PHP 1,500.00". mysql2 returns DECIMAL columns as strings, so coerce first.
function formatMoney(value) {
    const n = Number(value);
    if (!isFinite(n)) return '';
    return n.toLocaleString('en-PH', { style: 'currency', currency: 'PHP' });
}

// Date + time in Manila time, e.g. "October 5, 2026, 2:30 PM".
function formatStamp(value) {
    if (!value) return '';
    const d = parseDbDate(value);
    if (isNaN(d)) return String(value);
    return d.toLocaleString('en-PH', {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila'
    });
}

function methodLabel(method) {
    const m = String(method || '').toLowerCase();
    if (['online', 'paymongo', 'mongo'].includes(m)) return 'Online (PayMongo)';
    if (m === 'cash') return 'Cash (at the clinic)';
    if (m === 'card') return 'Card (at the clinic)';
    return method ? String(method) : '';
}

function when(date, time) {
    return [formatDate(date), formatTime(time)].filter(Boolean).join(' at ');
}

// ---------- shared layout ----------

/**
 * Builds the HTML + plain-text versions of one email from structured parts,
 * so every email shares the same look and a text fallback always exists.
 *
 * @param {string}   o.subject
 * @param {string}   o.heading
 * @param {string}   [o.preheader]   inbox preview line
 * @param {string}   [o.badge]       key of BADGES
 * @param {string}   [o.greeting]
 * @param {string[]} [o.paragraphs]
 * @param {Array<[string,string]>} [o.rows]  label/value summary (like an order receipt)
 * @param {{text:string, tone?:'warn'|'info'}} [o.callout]
 * @param {{label:string, url:string}} [o.button]
 * @param {string[]} [o.footer]
 */
function compose(o) {
    const badge = o.badge ? BADGES[o.badge] : null;
    const rows = (o.rows || []).filter(([, v]) => v !== undefined && v !== null && v !== '');

    // A row may carry a third item, 'mono', to show the value in a monospace
    // font (used for temporary passwords so l/I/O/0 are easy to tell apart).
    const rowsHtml = rows.map(([label, value, style]) => `
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #E6E2D6;color:#6B5B4E;font-size:13px;width:38%;vertical-align:top;">${esc(label)}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #E6E2D6;color:${C.ink};font-size:14px;font-weight:600;vertical-align:top;${style === 'mono' ? "font-family:'Courier New',Courier,monospace;font-size:15px;word-break:break-all;" : ''}">${esc(value)}</td>
        </tr>`).join('');

    const calloutColors = o.callout && o.callout.tone === 'warn'
        ? { bg: '#FFF4CC', border: C.accent }
        : { bg: '#EEF2E3', border: C.header };

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page};font-family:Arial,Helvetica,sans-serif;color:${C.ink};">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(o.preheader || '')}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${C.card};border-radius:16px;overflow:hidden;">
        <tr><td style="background:${C.header};padding:18px 24px;font-size:18px;font-weight:bold;letter-spacing:1px;color:${C.ink};">${esc(CLINIC_NAME.toUpperCase())}</td></tr>
        <tr><td style="padding:28px 24px 8px 24px;">
          ${badge ? `<span style="display:inline-block;background:${badge.bg};color:${badge.fg};font-size:12px;font-weight:bold;padding:4px 10px;border-radius:999px;margin-bottom:12px;">${esc(badge.label)}</span>` : ''}
          <h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;color:${C.ink};">${esc(o.heading)}</h1>
          ${o.greeting ? `<p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;">${esc(o.greeting)}</p>` : ''}
          ${(o.paragraphs || []).map(p => `<p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;">${esc(p)}</p>`).join('')}
        </td></tr>
        ${rows.length ? `<tr><td style="padding:4px 24px 16px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};border-radius:12px;">${rowsHtml}</table>
        </td></tr>` : ''}
        ${o.callout ? `<tr><td style="padding:0 24px 16px 24px;">
          <div style="background:${calloutColors.bg};border-left:4px solid ${calloutColors.border};border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.5;">${esc(o.callout.text)}</div>
        </td></tr>` : ''}
        ${o.button ? `<tr><td align="center" style="padding:4px 24px 24px 24px;">
          <a href="${esc(o.button.url)}" style="display:inline-block;background:${C.accent};color:${C.ink};text-decoration:none;font-weight:bold;font-size:15px;padding:12px 28px;border-radius:999px;">${esc(o.button.label)}</a>
        </td></tr>` : ''}
        <tr><td style="padding:16px 24px 24px 24px;border-top:1px solid #EEE;font-size:12px;line-height:1.5;color:#7A6B5E;">
          ${(o.footer || []).map(f => `<p style="margin:0 0 6px 0;">${esc(f)}</p>`).join('')}
          <p style="margin:0;">This is an automated message from ${esc(CLINIC_NAME)}. Please do not reply to this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

    const text = [
        o.heading,
        '',
        o.greeting,
        ...(o.paragraphs || []),
        ...(rows.length ? ['', ...rows.map(([l, v]) => `${l}: ${v}`)] : []),
        ...(o.callout ? ['', o.callout.text] : []),
        ...(o.button ? ['', `${o.button.label}: ${o.button.url}`] : []),
        '',
        ...(o.footer || []),
        `This is an automated message from ${CLINIC_NAME}.`
    ].filter(line => line !== undefined).join('\n');

    return { subject: o.subject, text, html };
}

function apptRows(a) {
    return [
        ['Reference no.', a.reference],
        ['Service', a.service],
        ['Dentist', a.dentist],
        ['Date', formatDate(a.date)],
        ['Time', formatTime(a.time)]
    ];
}

function viewButton(a) {
    return a.viewUrl ? { label: 'View my appointments', url: a.viewUrl } : undefined;
}

// ---------- customer: appointments ----------
// appointment object shape used by all of these:
//   { patientName, reference, service, dentist, date, time, viewUrl?,
//     previousDate?, previousTime?, reason? }

// 1. Customer just submitted a booking (awaiting approval).
//    When a.payment is present (an online booking that was already paid through
//    PayMongo) the payment receipt is folded into this same email instead of
//    sending a second one. a.payment = { amount, method, paidAt }
function appointmentBooked(a) {
    const p = a.payment;
    const ref = a.reference ? ` (#${a.reference})` : '';
    return compose({
        subject: p ? `We received your appointment request and payment${ref}` : `We received your appointment request${ref}`,
        preheader: p
            ? `Payment of ${formatMoney(p.amount)} received. We will email you once the appointment is approved.`
            : 'Your request is in. We will email you once it is approved.',
        badge: 'pending',
        heading: p ? 'Appointment booked and paid!' : 'Appointment booked!',
        greeting: `Hi ${a.patientName || 'there'},`,
        paragraphs: [
            p
                ? 'Thanks for booking with us. Your payment went through and your request is waiting for the clinic to confirm it.'
                : 'Thanks for booking with us. Your request has been received and is waiting for the clinic to confirm it.'
        ],
        rows: [
            ...apptRows(a),
            ...(p ? [
                ['Amount paid', formatMoney(p.amount)],
                ['Payment method', methodLabel(p.method)],
                ['Paid on', formatStamp(p.paidAt)]
            ] : [])
        ],
        callout: {
            text: p
                ? 'Your slot is not final yet. We will send another email as soon as the clinic approves it. Please keep this email as your payment receipt.'
                : 'Your slot is not final yet. We will send another email as soon as the clinic approves it.',
            tone: 'warn'
        },
        button: viewButton(a)
    });
}

// 2. Clinic approved the appointment
function appointmentApproved(a) {
    return compose({
        subject: `Your appointment is confirmed${a.reference ? ` (#${a.reference})` : ''}`,
        preheader: `See you on ${formatDate(a.date)}.`,
        badge: 'approved',
        heading: 'Your appointment is approved',
        greeting: `Hi ${a.patientName || 'there'},`,
        paragraphs: ['Good news! The clinic has approved your appointment. Here are the details:'],
        rows: apptRows(a),
        callout: { text: 'Please arrive a few minutes early. If you can no longer make it, cancel or reschedule from your account so someone else can take the slot.' },
        button: viewButton(a)
    });
}

// 3. Appointment cancelled by the customer, cancelled by staff, a pending
//    request that staff declined (a.declined = true), or a paid booking whose slot
//    was taken before the payment came in (a.slotLost = true).
//    If the appointment was already paid, a.refund = { amount, method } folds the
//    "refund requested" notice into this email (AppointmentEmails.js sets it
//    automatically when the payment is 'refund_pending').
function refundNotice(a) {
    if (!a.refund) return { paragraphs: [], rows: [] };
    const amount = formatMoney(a.refund.amount);
    return {
        paragraphs: [`Because you had already paid, a refund of ${amount} has been requested. The clinic will review and process it, and we will email you again once it has been sent.`],
        rows: [
            ['Refund requested', amount],
            ['Refund status', 'Waiting for the clinic to process it']
        ]
    };
}

function appointmentCancelled(a) {
    const byCustomer = a.cancelledBy === 'customer';
    const ref = a.reference ? ` (#${a.reference})` : '';
    const refund = refundNotice(a);

    if (a.slotLost) {
        return compose({
            subject: `We couldn't keep your appointment slot${ref}`,
            preheader: 'Your payment was received, but the time slot is no longer available.',
            badge: 'cancelled',
            heading: "We couldn't keep your slot",
            greeting: `Hi ${a.patientName || 'there'},`,
            paragraphs: [
                'Your payment went through, but the hold on your time slot had expired and another booking took it before your payment was completed. We are very sorry, your appointment has been cancelled.',
                ...refund.paragraphs
            ],
            rows: [...apptRows(a), ...refund.rows],
            callout: { text: `Questions? Please contact ${clinicContact()}. You are welcome to book a new appointment any time.` },
            button: viewButton(a)
        });
    }

    if (a.declined) {
        return compose({
            subject: `Your appointment request was declined${ref}`,
            preheader: 'The clinic could not accept this request.',
            badge: 'declined',
            heading: 'Your appointment request was declined',
            greeting: `Hi ${a.patientName || 'there'},`,
            paragraphs: [
                'Sorry, the clinic could not accept your appointment request. You are welcome to pick a different date or time.',
                ...refund.paragraphs
            ],
            rows: [...apptRows(a), ...refund.rows],
            callout: { text: `Questions? Please contact ${clinicContact()}.` },
            button: viewButton(a)
        });
    }

    return compose({
        subject: `Your appointment was cancelled${ref}`,
        preheader: byCustomer ? 'This confirms your cancellation.' : 'The clinic had to cancel your appointment.',
        badge: 'cancelled',
        heading: 'Your appointment was cancelled',
        greeting: `Hi ${a.patientName || 'there'},`,
        paragraphs: [
            byCustomer
                ? 'This confirms that your appointment has been cancelled.'
                : 'We are sorry, but your appointment has been cancelled by the clinic.',
            ...refund.paragraphs
        ],
        rows: [...apptRows(a), ['Reason', a.reason], ...refund.rows],
        callout: { text: `Questions? Please contact ${clinicContact()}. You are welcome to book a new appointment any time.` },
        button: viewButton(a)
    });
}

// 4. A staff member changed the schedule for the customer
function appointmentRescheduled(a) {
    return compose({
        subject: `Your appointment was rescheduled${a.reference ? ` (#${a.reference})` : ''}`,
        preheader: `New schedule: ${when(a.date, a.time)}`,
        badge: 'changed',
        heading: 'Your appointment was rescheduled',
        greeting: `Hi ${a.patientName || 'there'},`,
        paragraphs: ['The clinic has moved your appointment to a new schedule.'],
        rows: [
            ['Reference no.', a.reference],
            ['Service', a.service],
            ['Dentist', a.dentist],
            ['Previous schedule', when(a.previousDate, a.previousTime)],
            ['New schedule', when(a.date, a.time)],
            ['Reason', a.reason]
        ],
        callout: { text: `If this new schedule does not work for you or you have any issues, please contact ${clinicContact()}.`, tone: 'warn' },
        button: viewButton(a)
    });
}

// 5. The customer asked to reschedule and the clinic approved it
function rescheduleRequestApproved(a) {
    return compose({
        subject: `Your reschedule request was approved${a.reference ? ` (#${a.reference})` : ''}`,
        preheader: `New schedule: ${when(a.date, a.time)}`,
        badge: 'approved',
        heading: 'Reschedule request approved',
        greeting: `Hi ${a.patientName || 'there'},`,
        paragraphs: ['The clinic approved your request to reschedule. Your appointment is now set for:'],
        rows: [
            ['Reference no.', a.reference],
            ['Service', a.service],
            ['Dentist', a.dentist],
            ['Previous schedule', when(a.previousDate, a.previousTime)],
            ['New schedule', when(a.date, a.time)]
        ],
        button: viewButton(a)
    });
}

// ---------- customer: payments ----------
// payment object shape used by both of these:
//   { patientName, reference, service, dentist, date, time, amount, method,
//     paidAt?, refundedAt?, refundRef?, viewUrl? }

// 6. A payment for the appointment was received (PayMongo checkout or cash/card at the clinic)
function paymentReceived(a) {
    return compose({
        subject: `Payment received${a.reference ? ` (#${a.reference})` : ''}`,
        preheader: `We received your payment of ${formatMoney(a.amount)}.`,
        badge: 'paid',
        heading: 'Payment received',
        greeting: `Hi ${a.patientName || 'there'},`,
        paragraphs: ['Thank you! We have received your payment for the appointment below.'],
        rows: [
            ['Reference no.', a.reference],
            ['Service', a.service],
            ['Amount paid', formatMoney(a.amount)],
            ['Payment method', methodLabel(a.method)],
            ['Paid on', formatStamp(a.paidAt)],
            ['Dentist', a.dentist],
            ['Appointment', when(a.date, a.time)]
        ],
        callout: { text: 'Please keep this email as your payment receipt.' },
        button: viewButton(a)
    });
}

// 7. The clinic refunded the payment (the appointment is cancelled as part of the refund)
function paymentRefunded(a) {
    const online = ['online', 'paymongo', 'mongo'].includes(String(a.method || '').toLowerCase());
    return compose({
        subject: `Your refund has been processed${a.reference ? ` (#${a.reference})` : ''}`,
        preheader: `${formatMoney(a.amount)} is being returned to you.`,
        badge: 'refunded',
        heading: 'Refund processed',
        greeting: `Hi ${a.patientName || 'there'},`,
        paragraphs: [
            a.afterCancellation
                ? 'The clinic has processed the refund for your cancelled appointment.'
                : 'The clinic has refunded your payment, and the appointment below has been cancelled.',
            online
                ? 'The money is being returned to the payment method you used at checkout. Depending on your bank or e-wallet, it can take several business days to appear.'
                : 'Your in-clinic payment has been marked as refunded.'
        ],
        rows: [
            ['Reference no.', a.reference],
            ['Service', a.service],
            ['Refund amount', formatMoney(a.amount)],
            ['Original payment', methodLabel(a.method)],
            ['Refund reference', a.refundRef],
            ['Refunded on', formatStamp(a.refundedAt)],
            ['Appointment', when(a.date, a.time)]
        ],
        callout: {
            text: online
                ? `If the refund has not appeared after 10 business days, please contact ${clinicContact()}.`
                : `If you have not received your money back, please contact ${clinicContact()}.`
        },
        button: viewButton(a)
    });
}

// ---------- staff accounts ----------

// 6. Admin created an Employee/Admin account with a temporary password
//    (variant 'resent' = an admin re-sent the credentials, e.g. after a reset)
function staffAccountCreated({ firstName, role, email, tempPassword, loginUrl, variant }) {
    const roleLabel = role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Staff';
    const resent = variant === 'resent';
    return compose({
        subject: resent
            ? `Your ${CLINIC_NAME} login details`
            : `Your ${CLINIC_NAME} ${roleLabel.toLowerCase()} account is ready`,
        preheader: 'Your login details are inside. Change the temporary password after you sign in.',
        badge: 'info',
        heading: resent ? 'Your login details' : 'Your account has been created',
        greeting: `Hi ${firstName || 'there'},`,
        paragraphs: [
            resent
                ? 'An administrator sent you the temporary login details for your account. Use them to log in.'
                : `An administrator created ${/^[aeiou]/i.test(roleLabel) ? 'an' : 'a'} ${roleLabel.toLowerCase()} account for you. Use the details below to log in.`
        ],
        rows: [
            ['Email (username)', email],
            ['Temporary password', tempPassword, 'mono'],
            ['Role', roleLabel]
        ],
        callout: {
            text: 'Please change this temporary password after you log in for the first time, and do not share it with anyone. You can also use "Forgot your password?" on the login page to choose your own.',
            tone: 'warn'
        },
        button: { label: 'Log in', url: loginUrl || `${baseUrl()}/LogInRegister/login.html` }
    });
}

// ---------- auth flows ----------

// 7. Forgot password
function passwordReset({ resetLink, minutes }) {
    return compose({
        subject: 'Reset your password',
        preheader: `This link expires in ${minutes} minutes.`,
        heading: 'Reset your password',
        paragraphs: [
            'We received a request to reset the password for your account.',
            `Use the button below to choose a new one. The link expires in ${minutes} minutes and can only be used once.`
        ],
        button: { label: 'Reset password', url: resetLink },
        footer: ["If you didn't request this, you can safely ignore this email. Your password will not change."]
    });
}

// Registration confirmation (replaces the inline email in auth.js)
function verifyRegistration({ firstName, link, hours }) {
    return compose({
        subject: `Confirm your ${CLINIC_NAME} account`,
        preheader: 'One more step to finish creating your account.',
        heading: 'Confirm your email',
        greeting: `Hi ${firstName || 'there'},`,
        paragraphs: [
            'Thanks for signing up! Confirm your email address to finish creating your account.',
            `This link expires in ${hours} hours.`
        ],
        button: { label: 'Confirm my email', url: link },
        footer: ["If you didn't sign up, ignore this email and no account will be created."]
    });
}

// ---------- safe sending ----------

/**
 * Fire-and-forget wrapper for notifications. Never throws, so a mail outage
 * can't make "approve appointment" (etc.) return an error after the database
 * change already succeeded. Returns true/false if you want to log the outcome.
 */
async function notify(to, template) {
    if (!to) return false;
    try {
        const { sendEmail } = require('./Mailer');
        await sendEmail({ to, ...template });
        return true;
    } catch (err) {
        console.error(`Email "${template.subject}" to ${to} failed:`, err.message);
        return false;
    }
}

module.exports = {
    notify,
    appointmentBooked,
    appointmentApproved,
    appointmentCancelled,
    appointmentRescheduled,
    rescheduleRequestApproved,
    paymentReceived,
    paymentRefunded,
    staffAccountCreated,
    passwordReset,
    verifyRegistration,
    // exported for reuse/testing
    formatDate,
    formatTime
};