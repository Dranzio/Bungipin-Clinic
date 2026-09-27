const nodemailer = require('nodemailer');

// Single shared transporter. Credentials come from the environment —
// never hardcode an address or app password in source.
// Required in .env:
//   EMAIL_SERVICE=Gmail          (or another nodemailer-supported service)
//   EMAIL_USER=you@example.com
//   EMAIL_PASS=your-app-password (a Gmail "App Password", not your login password)
//   EMAIL_FROM=you@example.com   (optional; defaults to EMAIL_USER)
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'Gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

/**
 * Send an email. Usable from any route file in the app —
 * password resets, booking confirmations, notifications, etc.
 *
 * @param {Object} options
 * @param {string} options.to      - recipient address
 * @param {string} options.subject
 * @param {string} options.text    - plain-text body (always provide this)
 * @param {string} [options.html]  - optional HTML body
 */
async function sendEmail({ to, subject, text, html }) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        throw new Error('EMAIL_USER / EMAIL_PASS are not configured in the environment');
    }

    return transporter.sendMail({
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to,
        subject,
        text,
        html
    });
}

module.exports = { sendEmail };