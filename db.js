const mysql = require('mysql2');

const mysqlPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME || 'defaultdb',
    port: process.env.DB_PORT || 3306,
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true,
    timezone: '+08:00'
});

mysqlPool.on('connection', (conn) => {
    conn.query("SET time_zone = '+08:00'", (err) => {
        if (err) console.error('Could not set session time zone:', err.message);
    });
});

const promisePool = mysqlPool.promise();

module.exports = promisePool;
