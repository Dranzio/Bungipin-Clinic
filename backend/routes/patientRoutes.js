const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/authMiddleware');
const { getPatientRecord, getPatientRecordPdf } = require('../controllers/patientController');

router.use(verifyToken);

router.get('/:id', getPatientRecord);
router.get('/:id/pdf', getPatientRecordPdf);

module.exports = router;