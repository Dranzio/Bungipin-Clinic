const connection = require('./db');
const { isEmpty } = require('./Utils/object_isEmpty');
const AppError = require('./Utils/error');
const bcrypt = require('bcryptjs');
const { FORGOT_PASSWORD_MODEL, RESET_PASSWORD_MODEL } = require('./auth');
const nodemailer = require('nodemailer');

exports.user_forgotPass = (req, res, next) => {
    if (isEmpty(req.body)) return next(new AppError('form data not found', 400));

    try {
        const { error } = FORGOT_PASSWORD_MODEL.validate(req.body);
        if (error) return next(new AppError(error.details[0].message, 400));

        // FIX 1: Change [[req.body.email]] to [req.body.email]
        connection.query("SELECT * FROM users WHERE email = ?", [req.body.email], async (err, data1) => {
            if (err) return next(new AppError(err, 500));

            if (!data1 || data1.length === 0) {
                return next(new AppError("User does not exist", 400));
            }

            const otp = Math.floor(1000 + Math.random() * 9000);
            const otpExpire = new Date(Date.now() + 30); // 3 minutes expiration

            connection.query("UPDATE users SET otp = ?, otpExpire = ? WHERE email = ?", [otp, otpExpire, req.body.email], (err) => {
                if (err) return next(new AppError(err, 500));

                const transporter = nodemailer.createTransport({
                    service: 'Gmail',
                    auth: {
                        user: 'liyahxbest@gmail.com',
                        pass: 'YOUR_16_DIGIT_APP_PASSWORD' // FIX 2: Replace with Gmail App Password
                    },
                });

                const mailOptions = {
                    from: 'liyahxbest@gmail.com',
                    to: req.body.email,
                    subject: 'Password reset OTP',
                    text: `Your OTP (will expire in 3 minutes) : ${otp}`,
                };

                transporter.sendMail(mailOptions, (error) => {
                    if (error) {
                        return next(new AppError(error.message || error, 500));
                    }
                    return res.json({ message: "OTP sent to your email" });
                });
            });
        });
    } catch (err) {
        return next(new AppError(err.message, 500));
    }
};

exports.user_resetPass = (req, res, next) => {

    const body = req.body;
    const password = body.password;
    const confirmPassword = body.confirmPassword;

    if (isEmpty(body)) return next(new AppError('form data not found', 400));

    try {

        const { error } = RESET_PASSWORD_MODEL.validate(body);

        if (error) return next(new AppError(error.details[0].message, 400));

        if (password.localeCompare(confirmPassword) != 0) return next(new AppError("Passwords do not match.", 400));

        connection.query("SELECT * FROM user WHERE otp = ? AND otpExpire > NOW()", [[body.otp]], async (err, data, fields) => {
            if (err) return next(new AppError(err, 500));

            if (data.length == 0) return next(new AppError('Invalid or expired OTP', 400));

            const solt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, solt);

            connection.query("UPDATE users SET password = ?, otp = null, otpExpire = null WHERE otp = ?", [hashedPassword, body.otp], async (err, data, fields) => {
                if (err) return next(new AppError(err, 500));

                res.json({
                    data: 'Password reset successful'
                })

            })

        })

    }
    catch (err) {
        return next(new AppError(err, 500));
    }

}