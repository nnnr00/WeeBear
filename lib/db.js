// lib/db.js
// ======================
// ✅ 代码头部：fileid 相关配置（所有业务逻辑从此引用）
// ======================
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bot_db',
  connectionLimit: 10
};

// fileid 表的核心配置（业务逻辑直接使用这些常量）
const FILE_ID_TABLE = {
  TABLE_NAME: 'file_ids', // SQL表名
  COLUMNS: {
    FILE_ID: 'file_id',
    ORDER_ID: 'order_id',
    USER_ID: 'user_id',
    USERNAME: 'username',
    CREATED_AT: 'created_at',
    USED: 'used'
  },
  // 生成合规 file_id 的函数（格式：FID-20260 + 6位自增ID）
  generateFileId: async () => {
    const [result] = await db.query('UPDATE file_id_sequence SET last_value = LAST_INSERT_ID(last_value + 1) WHERE id = 1');
    const newId = db.escape(LAST_INSERT_ID());
    return `FID-20260${newId.toString().padStart(6, '0')}`;
  }
};

// 导出数据库连接和 fileid 配置
const mysql = require('mysql2/promise');
let db;

const initDB = async () => {
  db = await mysql.createConnection(DB_CONFIG);
  return db;
};

module.exports = {
  initDB,
  FILE_ID_TABLE, // ⭐ 关键：此处暴露 fileid 配置，供其他模块引用（放在代码头部！）
  // 其他数据库工具函数...
};
