const mysql = require('mysql2');

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',        // XAMPP-এ password খালি থাকে
  database: 'mcq_exam',
  waitForConnections: true,
  connectionLimit: 10
});

module.exports = pool.promise();