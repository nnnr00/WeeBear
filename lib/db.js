// lib/db.js
const { Pool } = require('pg');

// 从环境变量获取 DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // 必须为 false 以支持 Neon 的 SSL
  }
});

// 测试连接
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection failed:', err.stack);
  } else {
    console.log('Connected to Neon DB:', res.rows[0]);
  }
});

module.exports = pool;
