const mysql = require('mysql2');

const mysqlPool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'Sep2024101585*!',
    database: 'dental_appointments',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
})

const promisePool = mysqlPool.promise();

module.exports = promisePool;