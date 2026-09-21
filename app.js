require("dotenv").config();
const express = require("express");
const db = require("./db");
const cors = require("cors");
const authRoutes = require("./auth");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());

app.use('/api/auth', authRoutes);

app.use(express.static(path.join(__dirname)));
app.use(express.static(path.join(__dirname, "images")));
app.use(express.static(path.join(__dirname, "LogInRegister")));
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "LogInRegister", "login.html"));
});

// API to get data from db. check by doing https://localhost:3000/api/{x}
app.get('/api/users', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM users');
        res.json(rows);
    } catch (err) {
        console.error('Databse Error', err);
        res.status(500).json({error: "Internal Server Error"});
    }
});

app.get('/api/patients', async (req, res) => {
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

app.get('/api/patients/:id', async (req, res) => {
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



const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
})