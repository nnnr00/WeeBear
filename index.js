// index.js - Vercel 入口文件
require('dotenv').config();
const { initDB } = require('./lib/db');
const { bot } = require('./api/commands');

// 初始化数据库
initDB()
  .then(() => console.log('Database initialized'))
  .catch(err => {
    console.error('Database init failed:', err);
    process.exit(1);
  });

// Vercel 必须导出的处理函数
module.exports = (req, res) => {
  bot.handleUpdate(req.body)
    .then(() => res.end('ok'))
    .catch((err) => {
      console.error('Update handling failed:', err);
      res.status(500).end();
    });
};
