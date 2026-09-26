const mysql = require('mysql2');

const mysqlPool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'dental_appointments',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true
})

const promisePool = mysqlPool.promise();

module.exports = promisePool;   