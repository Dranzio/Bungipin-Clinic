const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const {
  getTransactionReport,
  getMostRequestedServices,
  getTransactionReportPdf,
  getMostRequestedServicesPdf,
} = require('../controllers/reportController');

router.use(verifyToken, requireRole('employee', 'admin'));

router.get('/transactions', getTransactionReport);
router.get('/transactions/pdf', getTransactionReportPdf);
router.get('/most-requested-services', getMostRequestedServices);
router.get('/most-requested-services/pdf', getMostRequestedServicesPdf);

module.exports = router;
