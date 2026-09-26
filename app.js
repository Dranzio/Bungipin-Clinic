require("dotenv").config();
const express = require("express");
const db = require("./db");
const cors = require("cors");
const authRoutes = require("./auth");
const path = require("path");
const registerPatientProfileRoute = require("./Customer/CustomerProfile");
const registerBookingRoute = require("./Customer/BookingRoutes");
const registerHistoryRoutes = require("./Customer/HistoryRoutes");
const registerEmployeeProfileRoute = require("./Employee/EmployeeProfile");
const registerBookingRequestRoutes = require("./Employee/BookingRequest");
const registerQueueRoutes = require("./Employee/QueueRoutes");
const registerPatientRecordsRoutes = require("./Employee/PatientRecords");
const registerMessagesRoutes = require("./MessagesRoutes");
const authenticateToken = require("./authmiddleware");

// login limiter
const errorHandler = require('./Utils/errorHandler');

const registerServiceRoutes = require("./Admin/ServiceRoutes");

// DENIED DIRECT PAGE ACESS VIA URL
const registerDashboardRoutes = require("./Admin/DashboardRoutes");
const rateLimit = require("express-rate-limit");


// forgot + reset pass
const router = require('./userRoutes');

const app = express();

// login limiter
const loginLimiter = rateLimit({
    windowMs: 30,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
        error: "Too many attempts. Try again in 5 mins."
    }
});
app.use(express.json());
app.use(cors());

// forgot + reset pass
app.use(express.urlencoded({ extended: false }));
app.use('/api/user', router);

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRoutes);
registerPatientProfileRoute(app, db);
registerBookingRoute(app, db);
registerHistoryRoutes(app, db);
registerEmployeeProfileRoute(app, db);
registerBookingRequestRoutes(app, db);
registerQueueRoutes(app, db);
registerPatientRecordsRoutes(app, db);
registerMessagesRoutes(app, db);
registerServiceRoutes(app, db);
registerDashboardRoutes(app, db);

// DENIES DIRECT PAGE VIA URL
function requirePageRole(requiredRole) {
    return (req, res, next) => {
        if (req.user.role !== requiredRole) {
            return res.redirect('/');
        }
        next();
    };
}

// DENIES DIRECT PAGE VIA URL
app.use('/Admin', authenticateToken, requirePageRole('admin'));
app.use('/Employee', authenticateToken, requirePageRole('employee'));
app.use('/Customer', authenticateToken, requirePageRole('patient'));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname)));
app.use(express.static(path.join(__dirname, "images")));
app.use(express.static(path.join(__dirname, "LogInRegister")));
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "LogInRegister", "login.html"));
});

app.get('/api/users', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admins only' });
    }
    try {
        const [rows] = await db.query(
            'SELECT user_id, public_id, first_name, last_name, email, phone, sex, role, account_status, created_at FROM users'
        );
        res.json(rows);
    } catch (err) {
        console.error('Databse Error', err);
        res.status(500).json({error: "Internal Server Error"});
    }
});

// DENIES DIRECT PAGE ACCESS VIA URL
app.get('/api/patients', authenticateToken, async (req, res) => {
    if (!['employee', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Staff access required' });
    }
    try {
        const [rows] = await db.query('CALL sp_get_all_patient_records()', ['patient']);
        const patients = rows[0].map(row => {
            const record = row.patient_record;
            return typeof record === 'string' ? JSON.parse(record) : record;
        });
        res.json(patients);
    } catch (err) {
        console.error('Databse Error', err);
        res.status(500).json({error: "Internal Server Error"});
    }
});

// DENIES DIRECT PAGE ACCESS VIA URL
app.get('/api/patients/:id', authenticateToken, async (req, res) => {
    if (!['employee', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Staff access required' });
    }
    try {
        const [rows] = await db.query('CALL sp_get_patient_record(?)', [req.params.id]);
        if (!rows[0] || rows[0].length === 0) {
            return res.status(404).json({error: "Patient not found"});
        }
        const record = rows[0][0].patient_record;
        res.json(typeof record === 'string' ? JSON.parse(record) : record);
    } catch (err) {
        console.error('Databse Error', err);
        res.status(500).json({error: "Internal Server Error"});
    }
});

// send help
app.use(errorHandler);

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
})