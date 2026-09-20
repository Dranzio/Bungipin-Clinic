const pool = require('../config/db');

/**
 * Service CRUD controllers. Services are publicly readable and admin-managed.
 */

/**
 * List services currently available for booking.
 */
async function getAllServices(req, res) {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM services WHERE is_available = TRUE ORDER BY label'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

/**
 * Create a service. Access is restricted to administrators by the route.
 */
async function createService(req, res) {
  try {
    const { label, price, icon, is_available } = req.body;

    if (!label || price === undefined) {
      return res.status(400).json({ message: 'label and price are required' });
    }

    const [result] = await pool.query(
      'INSERT INTO services (label, price, icon, is_available) VALUES (?, ?, ?, ?)',
      [label, price, icon || null, is_available ?? true]
    );

    res.status(201).json({ service_id: result.insertId, label, price, icon, is_available });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

/**
 * Update the supplied service fields while preserving omitted values.
 */
async function updateService(req, res) {
  try {
    const [existing] = await pool.query('SELECT * FROM services WHERE service_id = ?', [
      req.params.id,
    ]);
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Service not found' });
    }

    const current = existing[0];
    const { label, price, icon, is_available } = req.body;

    await pool.query(
      'UPDATE services SET label = ?, price = ?, icon = ?, is_available = ? WHERE service_id = ?',
      [
        label ?? current.label,
        price ?? current.price,
        icon ?? current.icon,
        is_available ?? current.is_available,
        req.params.id,
      ]
    );

    res.json({ message: 'Service updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

/**
 * Soft-delete a service by marking it unavailable.
 * Existing appointments can continue to reference the service.
 */
async function deleteService(req, res) {
  try {
    const [existing] = await pool.query('SELECT service_id FROM services WHERE service_id = ?', [
      req.params.id,
    ]);
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Service not found' });
    }

    await pool.query('UPDATE services SET is_available = FALSE WHERE service_id = ?', [
      req.params.id,
    ]);

    res.json({ message: 'Service marked unavailable' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

module.exports = { getAllServices, createService, updateService, deleteService };
