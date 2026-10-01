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
const authenticateToken = require("./authMiddleware");
const registerDoctorScheduleRoutes = require('./Employee/doctorScheduleRoutes');

// show IO in routes
const http = require('http');
const { Server } = require('socket.io');

// login limiter
const errorHandler = require('./Utils/errorHandler');
const rateLimit = require("express-rate-limit");
const registerServiceRoutes = require("./Admin/ServiceRoutes");
const registerUserManagementRoutes = require("./Admin/UserManage");
const registerAdminProfileRoute = require("./Admin/AdminProfile");

// DENIED DIRECT PAGE ACESS VIA URL
const registerDashboardRoutes = require("./Admin/DashboardRoutes");

const app = express();
app.set('trust proxy', 1);

// show IO in routes
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(cors());

// forgot + reset pass
app.use(express.urlencoded({ extended: false }));

// rate limiter for login requests
const loginLimit = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
    message: { error: "Too many login attempts for this address, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { forwardedHeader: false }   // silences ERR_ERL_FORWARDED_HEADER on Vercel
});

// make IO accessible in route files
app.set('io', io);

io.on('connection', (socket) => {
    console.log('Connected to real-time updates');
});

server.listen(3000, () => {
    console.log('Server running on port 3000');
});

// apply rate limiting to login route
app.use('/api/auth/login', loginLimit);


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
registerUserManagementRoutes(app, db);
registerAdminProfileRoute(app, db);
registerDashboardRoutes(app, db);
registerDoctorScheduleRoutes(app, db);

// DENIES DIRECT PAGE VIA URL
function requirePageRole(requiredRole) {
    return (req, res, next) => {
        if (req.user.role !== requiredRole) {
            return res.redirect('/denied.html');
        }
        next();
    };
}

// DENIES DIRECT PAGE VIA URL
app.use('/uploads', authenticateToken, express.static(path.join(__dirname, 'uploads')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/assets', express.static(path.join(__dirname, 'images')));
app.get('/output.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'output.css'));
});
app.get('/pageProtection.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'pageProtection.js'));
});

// added route for passwordGate.js (kept returning 404 not found and loading a document type)
app.get('/passwordGate.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'passwordGate.js'));
});

app.use('/LogInRegister', express.static(path.join(__dirname, 'LogInRegister')));
app.use('/WelcomePage', express.static(path.join(__dirname, 'WelcomePage')));

app.use('/Admin', authenticateToken, requirePageRole('admin'), express.static(path.join(__dirname, 'Admin')));
app.use('/Employee', authenticateToken, requirePageRole('employee'), express.static(path.join(__dirname, 'Employee')));
app.use('/Customer', authenticateToken, requirePageRole('patient'), express.static(path.join(__dirname, 'Customer')));
app.use('/Taskbar', authenticateToken, express.static(path.join(__dirname, 'Taskbar')));
app.get('/denied.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'denied.html'));
});
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "WelcomePage", "home.html"));
});
app.get('/home.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'WelcomePage', 'home.html'));
});
app.get('/aboutus.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'WelcomePage', 'aboutus.html'));
});
app.get('/contact.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'WelcomePage', 'contact.html'));
});


// MOVED THIS TO USERMANAGE.JS
/**
 app.get('/api/users', authenticateToken, async (req, res) => {
 if (req.user.role !== 'admin') {
 return res.status(403).json({ error: 'Admins only' });
 }
 try {
 const [rows] = await db.query(
 'SELECT user_id, public_id, first_name, last_name, email, phone, sex, role, account_status, created_at, is_locked, login_attempts FROM users'
 );
 res.json(rows);
 } catch (err) {
 console.error('Databse Error', err);
 res.status(500).json({error: "Internal Server Error"});
 }
 });
 */


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

// send help : global error handling middleware
app.use(errorHandler);


// pls check (from eli): di nagloload yung server so i removed this then it loaded na
// if (!process.env.VERCEL) {
//     server.listen(3000, () => console.log('Server running on port 3000'));
// }

module.exports = app;

