// index.js - Vercel 必须的文件
require('dotenv').config();
const express = require('express');
const { initDB } = require('./lib/db');
const { bot } = require('./api/commands');

const app = express();
const PORT = process.env.PORT || 3000;

// 关键：添加详细日志
console.log(`[Vercel] 启动服务器 (端口: ${PORT})`);
console.log(`[Vercel] Webhook 路径: /webhook`);
console.log(`[Vercel] 环境变量: DB_TYPE=${process.env.DB_TYPE}, BOT_TOKEN=${process.env.BOT_TOKEN ? '***' : '未设置'}`);

// 初始化数据库
initDB()
  .then(() => console.log('[DB] 数据库初始化成功'))
  .catch(err => {
    console.error('[DB] 初始化失败:', err);
    process.exit(1);
  });

// 必须处理 JSON 请求体
app.use(express.json({ limit: '50mb' }));

// 核心 Webhook 路由
app.post('/webhook', (req, res) => {
  console.log('[TELEGRAM] 收到更新请求');
  
  bot.handleUpdate(req.body)
    .then(() => {
      console.log('[TELEGRAM] 更新处理成功');
      res.end('ok');
    })
    .catch(err => {
      console.error('[TELEGRAM] 更新处理失败:', err);
      res.status(500).end();
    });
});

// 所有其他路由重定向到 Telegram
app.get('*', (req, res) => {
  console.log(`[REDIRECT] ${req.url} -> ${process.env.BOT_USERNAME}`);
  res.redirect(`https://t.me/${process.env.BOT_USERNAME}`);
});

// 启动服务器
const server = app.listen(PORT, () => {
  console.log(`[SERVER] 运行中: https://your-project.vercel.app (端口: ${PORT})`);
  console.log(`[WEBHOOK] 完整路径: https://your-project.vercel.app/webhook`);
});

// 错误处理
server.on('error', (err) => {
  console.error('[FATAL] 服务器错误:', err);
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用`);
  }
  process.exit(1);
});
