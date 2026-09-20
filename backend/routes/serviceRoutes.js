const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const {
  getAllServices,
  createService,
  updateService,
  deleteService,
} = require('../controllers/serviceController');

// Anyone can view available services before booking.
router.get('/', getAllServices);

// Service mutations are restricted to administrators.
router.post('/', verifyToken, requireRole('admin'), createService);
router.put('/:id', verifyToken, requireRole('admin'), updateService);
router.delete('/:id', verifyToken, requireRole('admin'), deleteService);

module.exports = router;