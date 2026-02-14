// lib/db.js
const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

// 数据库类型检测
const DB_TYPE = process.env.DB_TYPE || 'pg';
console.log(`[DB] 检测到数据库类型: ${DB_TYPE}`);

let db;

// 初始化数据库连接
const initDB = async () => {
  try {
    if (DB_TYPE === 'pg') {
      // PostgreSQL 配置
      db = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
      });
      
      // 创建所有表
      await createTablesPG();
    } else {
      // MySQL 配置
      db = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'bot_db',
        connectTimeout: 10000
      });
      
      // 创建所有表
      await createTablesMySQL();
    }
    
    console.log(`[DB] 成功连接到 ${DB_TYPE}`);
    return db;
  } catch (err) {
    console.error('[DB] 连接失败:', err);
    throw err;
  }
};

// PostgreSQL 建表脚本 (完整无缩写)
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
    
    // 创建索引 (PostgreSQL 语法)
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
    console.log('[DB] PostgreSQL 表创建成功');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

// MySQL 建表脚本 (完整无缩写)
const createTablesMySQL = async () => {
  try {
    await db.query('START TRANSACTION');
    
    // 创建 file_ids 表
    await db.query(`
      CREATE TABLE IF NOT EXISTS file_ids (
        id INT AUTO_INCREMENT PRIMARY KEY,
        file_id VARCHAR(255) NOT NULL UNIQUE,
        order_id VARCHAR(50) NOT NULL,
        user_id VARCHAR(50) NOT NULL,
        username VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        used BOOLEAN DEFAULT FALSE,
        UNIQUE (order_id),
        INDEX idx_user_id (user_id),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    // 创建 sequence 表
    await db.query(`
      CREATE TABLE IF NOT EXISTS file_id_sequence (
        id INT NOT NULL DEFAULT 1,
        last_value BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);
    
    // 初始化序列
    await db.query(`
      INSERT INTO file_id_sequence (last_value) 
      VALUES (0) 
      ON DUPLICATE KEY UPDATE last_value = last_value + 1
    `);
    
    // 创建商品缓冲表
    await db.query(`
      CREATE TABLE IF NOT EXISTS p_buffer (
        id INT AUTO_INCREMENT PRIMARY KEY,
        keyword TEXT NOT NULL,
        admin_id VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    
    // 创建频控表
    await db.query(`
      CREATE TABLE IF NOT EXISTS dh_usage (
        user_id VARCHAR(50) NOT NULL,
        date_key DATE NOT NULL,
        is_used BOOLEAN DEFAULT TRUE,
        last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        next_reset TIMESTAMP,
        is_new_user BOOLEAN DEFAULT FALSE,
        PRIMARY KEY (user_id, date_key),
        INDEX idx_last_used (last_used)
      ) ENGINE=InnoDB
    `);
    
    await db.query('COMMIT');
    console.log('[DB] MySQL 表创建成功');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
};

// fileid 配置
const FILE_ID_TABLE = {
  TABLE_NAME: 'file_ids',
  COLUMNS: {
    FILE_ID: 'file_id',
    ORDER_ID: 'order_id',
    USER_ID: 'user_id',
    USERNAME: 'username',
    CREATED_AT: 'created_at',
    USED: 'used'
  },
  async generateFileId() {
    if (DB_TYPE === 'pg') {
      const [result] = await db.query(`
        INSERT INTO file_id_sequence (id, last_value) 
        VALUES (1, 1) 
        ON CONFLICT (id) DO UPDATE SET last_value = file_id_sequence.last_value + 1
        RETURNING last_value
      `);
      
      const newId = result.rows[0].last_value;
      return `FID-20260${newId.toString().padStart(6, '0')}`;
    } else {
      const [result] = await db.query(
        'UPDATE file_id_sequence SET last_value = LAST_INSERT_ID(last_value + 1) WHERE id = 1'
      );
      
      const newId = result.insertId || 1;
      return `FID-20260${newId.toString().padStart(6, '0')}`;
    }
  }
};

// 通用查询
const query = async (sql, params = []) => {
  try {
    if (DB_TYPE === 'pg') {
      let paramIndex = 1;
      const pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
      const [rows] = await db.query(pgSql, params);
      return rows;
    } else {
      const [rows] = await db.query(sql, params);
      return rows;
    }
  } catch (err) {
    console.error('[QUERY ERROR]', sql, params, err);
    throw err;
  }
};

// 执行SQL
const execute = async (sql, params = []) => {
  try {
    if (DB_TYPE === 'pg') {
      let paramIndex = 1;
      const pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
      await db.query(pgSql, params);
    } else {
      await db.query(sql, params);
    }
  } catch (err) {
    console.error('[EXEC ERROR]', sql, params, err);
    throw err;
  }
};

module.exports = {
  initDB,
  FILE_ID_TABLE,
  DB_TYPE,
  query,
  execute
};
