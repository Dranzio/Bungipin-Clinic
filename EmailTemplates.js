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

// Accepts 'YYYY-MM-DD', a JS Date (what mysql2 returns for DATE columns), or an
// already-formatted string. Returns e.g. "Saturday, October 10, 2026".
function formatDate(value) {
    if (!value) return '';
    const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
        const [y, m, d] = value.slice(0, 10).split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-PH', { ...opts, timeZone: 'UTC' });
    }
    const date = new Date(value);
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

// 1. Customer just submitted a booking (awaiting approval)
function appointmentBooked(a) {
    return compose({
        subject: `We received your appointment request${a.reference ? ` (#${a.reference})` : ''}`,
        preheader: 'Your request is in. We will email you once it is approved.',
        badge: 'pending',
        heading: 'Appointment booked!',
        greeting: `Hi ${a.patientName || 'there'},`,
        paragraphs: ['Thanks for booking with us. Your request has been received and is waiting for the clinic to confirm it.'],
        rows: apptRows(a),
        callout: { text: 'Your slot is not final yet. We will send another email as soon as the clinic approves it.', tone: 'warn' },
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

// 3. Appointment cancelled by the customer, cancelled by staff, or a pending
//    request that staff declined (a.declined = true)
function appointmentCancelled(a) {
    const byCustomer = a.cancelledBy === 'customer';
    const ref = a.reference ? ` (#${a.reference})` : '';

    if (a.declined) {
        return compose({
            subject: `Your appointment request was declined${ref}`,
            preheader: 'The clinic could not accept this request.',
            badge: 'declined',
            heading: 'Your appointment request was declined',
            greeting: `Hi ${a.patientName || 'there'},`,
            paragraphs: ['Sorry, the clinic could not accept your appointment request. You are welcome to pick a different date or time.'],
            rows: apptRows(a),
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
                : 'We are sorry, but your appointment has been cancelled by the clinic.'
        ],
        rows: [...apptRows(a), ['Reason', a.reason]],
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
    staffAccountCreated,
    passwordReset,
    verifyRegistration,
    // exported for reuse/testing
    formatDate,
    formatTime
};