// lib/db.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 测试连接（仅开发环境）
if (process.env.NODE_ENV !== 'production') {
  pool.query('SELECT NOW()', (err, res) => {
    if (err) console.error('DB CONNECTION FAILED:', err);
    else console.log('DB CONNECTED:', res.rows[0]);
  });
}

module.exports = pool;
