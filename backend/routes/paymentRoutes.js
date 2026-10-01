const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const {
  getPayments,
  acceptPayment,
  refundPayment
} = require('../controllers/paymentController');

// All payment operations require a valid login token.
router.use(verifyToken);

// Payments are mainly for front-desk (employee) and admin.
router.get('/', requireRole('admin', 'employee'), getPayments);
router.post('/:id/pay', requireRole('admin', 'employee'), acceptPayment);
router.post('/:id/refund', requireRole('admin', 'employee'), refundPayment);

module.exports = router;
