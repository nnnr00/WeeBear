// lib/db.js
// ======================
// ✅ 代码头部：fileid 相关配置 + 数据库类型检测
// ======================
const { initDB, db } = require('./db'); // 假设这是您的数据库连接

// 检测数据库类型 (MySQL/PostgreSQL)
let DB_TYPE = 'mysql'; // 默认

if (process.env.DB_TYPE) {
  DB_TYPE = process.env.DB_TYPE.toLowerCase();
} else if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('postgres')) {
  DB_TYPE = 'pg';
}

// fileid 表的核心配置 (适配不同数据库)
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
  // 生成合规 file_id 的函数 (自动适配数据库)
  generateFileId: async () => {
    if (DB_TYPE === 'pg') {
      // PostgreSQL 序列生成
      const [result] = await db.query(
        `INSERT INTO file_id_sequence (last_value) 
         VALUES (1) 
         ON CONFLICT (id) DO UPDATE SET last_value = file_id_sequence.last_value + 1
         RETURNING last_value`
      );
      const newId = result.rows[0].last_value;
      return `FID-20260${newId.toString().padStart(6, '0')}`;
    } else {
      // MySQL 兼容
      const [result] = await db.query(
        'UPDATE file_id_sequence SET last_value = LAST_INSERT_ID(last_value + 1) WHERE id = 1'
      );
      const newId = db.escape(result.insertId || LAST_INSERT_ID());
      return `FID-20260${newId.toString().padStart(6, '0')}`;
    }
  }
};

module.exports = {
  initDB,
  FILE_ID_TABLE,
  DB_TYPE, // 导出数据库类型供其他模块使用
  // 其他工具函数...
};
