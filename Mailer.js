const nodemailer = require('nodemailer');

// Single shared transporter configured for Brevo SMTP.
// Required in Vercel Environment Variables:
//   BREVO_USER=your-brevo-registered-email@example.com
//   BREVO_API_KEY=xkeysib-... (Your Brevo API key)
//   EMAIL_FROM=your-verified-domain-or-sender@example.com
const transporter = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    auth: {
        user: process.env.BREVO_USER,
        pass: process.env.BREVO_API_KEY
    }
});

/**
 * Send an email. Usable from any route file in the app.
 *
 * @param {Object} options
 * @param {string} options.to      - recipient address
 * @param {string} options.subject
 * @param {string} options.text    - plain-text body (always provide this)
 * @param {string} [options.html]  - optional HTML body
 */
async function sendEmail({ to, subject, text, html }) {
    if (!process.env.BREVO_USER || !process.env.BREVO_API_KEY) {
        throw new Error('BREVO_USER / BREVO_API_KEY are not configured in the environment');
    }

    return transporter.sendMail({
        from: process.env.EMAIL_FROM || process.env.BREVO_USER,
        to,
        subject,
        text,
        html
    });
}

module.exports = { sendEmail };