const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const {
  getAppointments,
  getAppointmentById,
  createAppointment,
  updateAppointment,
  cancelAppointment,
  rescheduleAppointment,
  getAppointmentQRCode,
  getAppointmentPDF,
} = require('../controllers/appointmentController');

// All appointment operations require a valid login token.
router.use(verifyToken);

router.get('/', getAppointments);
router.get('/:id', getAppointmentById);
router.post('/', createAppointment);
router.put('/:id', updateAppointment);
router.patch('/:id/reschedule', rescheduleAppointment);
router.delete('/:id', cancelAppointment);

// Front-desk tools — admin/employee only, patients don't need these.
router.get('/:id/qrcode', requireRole('admin', 'employee'), getAppointmentQRCode);
router.get('/:id/pdf', requireRole('admin', 'employee'), getAppointmentPDF);

module.exports = router;
