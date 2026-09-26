// routing stuff used for forgot + reset password

const express = require('express');
const {user_forgotPass, user_resetPass} = require ('./userController');
const router = express.Router();

// check if these routes are needed first
// router.route('/register').post(user_register);
// router.route('/login').post(user_login);

// forgot + reset routes
router.route(['/forgotPassword', '/forgot-password']).post(user_forgotPass);
router.route(['/resetPassword', '/reset-password']).post(user_resetPass);

module.exports = router;