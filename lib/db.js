// lib/db.js
const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

console.log('[DB] 初始化数据库连接...');
console.log('[DB] 环境变量:', {
  DB_TYPE: process.env.DB_TYPE,
  DATABASE_URL: process.env.DATABASE_URL ? '***' : '未设置'
});

let db;

const initDB = async () => {
  try {
    if (process.env.DB_TYPE === 'pg') {
      console.log('[DB] 连接 PostgreSQL...');
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
      });
      db = pool;
      
      // 添加表创建日志
      console.log('[DB] 正在创建表...');
      await createTablesPG();
      console.log('[DB] PostgreSQL 表创建成功');
    } else {
      console.log('[DB] 连接 MySQL...');
      db = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'bot_db',
        connectionLimit: 10
      });
      
      await createTablesMySQL();
      console.log('[DB] MySQL 表创建成功');
    }
    
    return db;
  } catch (err) {
    console.error('[DB] 连接失败:', err.message);
    console.error('[DB] 完整错误:', err);
    throw err;
  }
};

// PostgreSQL 创建表 (完整无缩写)
const createTablesPG = async () => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    
    // 创建 file_ids 表
    await client.query(`
      CREATE TABLE IF NOT EXISTS file_ids (
        id SERIAL PRIMARY KEY,
        file_id VARCHAR(255) NOT NULL UNIQUE,
        order_id VARCHAR(50) NOT NULL,
        user_id VARCHAR(50) NOT NULL,
        username VARCHAR(100) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        used BOOLEAN DEFAULT FALSE,
        UNIQUE (order_id)
      )
    `);
    
    // 创建索引 (正确语法)
    await client.query('CREATE INDEX IF NOT EXISTS idx_user_id ON file_ids (user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_created_at ON file_ids (created_at)');
    
    // 创建 sequence 表
    await client.query(`
      CREATE TABLE IF NOT EXISTS file_id_sequence (
        id INTEGER NOT NULL DEFAULT 1,
        last_value BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (id)
      )
    `);
    
    // 初始化序列
    await client.query(`
      INSERT INTO file_id_sequence (id, last_value) 
      VALUES (1, 0) 
      ON CONFLICT (id) DO UPDATE SET last_value = file_id_sequence.last_value + 1
    `);
    
    // 创建商品缓冲表
    await client.query(`
      CREATE TABLE IF NOT EXISTS p_buffer (
        id SERIAL PRIMARY KEY,
        keyword TEXT NOT NULL,
        admin_id VARCHAR(50) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 创建频控表
    await client.query(`
      CREATE TABLE IF NOT EXISTS dh_usage (
        user_id VARCHAR(50) NOT NULL,
        date_key DATE NOT NULL,
        is_used BOOLEAN DEFAULT TRUE,
        last_used TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        next_reset TIMESTAMPTZ,
        is_new_user BOOLEAN DEFAULT FALSE,
        PRIMARY KEY (user_id, date_key)
      )
    `);
    
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

// ... 其他代码保持不变 ...
