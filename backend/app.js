// Application setup: middleware and API route registration.
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/authRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const reportRoutes = require('./routes/reportRoutes');
const patientRoutes = require('./routes/patientRoutes');

const app = express();

// Shared middleware used by every API endpoint.
app.use(cors());
app.use(express.json());

// Feature areas are separated into authentication, appointments, and services.
app.use('/api/auth', authRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/patients', patientRoutes);

// Lightweight health check for confirming that the API process is running.
app.get('/', (req, res) => {
  res.json({ message: 'Dental system API is running' });
});

module.exports = app;
