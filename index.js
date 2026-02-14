// index.js - Vercel 入口文件
require('dotenv').config();
const express = require('express');
const { initDB } = require('./lib/db');
const { bot } = require('./api/commands');

const app = express();
const PORT = process.env.PORT || 3000;

// 添加关键启动日志
console.log(`[SERVER] Starting on port ${PORT}`);
console.log(`[WEBHOOK] Ready at /webhook`);
console.log(`[DEBUG] Environment: NODE_ENV=${process.env.NODE_ENV}`);

// 初始化数据库
initDB()
  .then(() => console.log('[DB] 初始化成功'))
  .catch(err => {
    console.error('[DB] 初始化失败:', err);
    process.exit(1);
  });

// 必须处理 JSON 请求体
app.use(express.json({ limit: '50mb' }));

// Webhook 端点
app.post('/webhook', (req, res) => {
  console.log('[WEBHOOK] Received update request');
  
  bot.handleUpdate(req.body)
    .then(() => {
      console.log('[WEBHOOK] Update handled successfully');
      res.end('ok');
    })
    .catch((err) => {
      console.error('[WEBHOOK] Error:', err);
      res.status(500).end();
    });
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 所有其他路由重定向到 Telegram
app.get('*', (req, res) => {
  console.log(`[ROUTE] Redirecting ${req.url}`);
  res.redirect(process.env.BOT_USERNAME);
});

// 启动服务器
const server = app.listen(PORT, () => {
  console.log(`[SERVER] ✅ 成功启动于 https://your-project.vercel.app (端口: ${PORT})`);
  console.log(`[WEBHOOK] 完整路径: https://your-project.vercel.app/webhook`);
  
  // 添加健康检查
  setInterval(() => {
    console.log('[HEALTH] Server is running');
  }, 30000);
});

// 错误处理
server.on('error', (err) => {
  console.error('[FATAL] 服务器错误:', err);
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用`);
  }
  process.exit(1);
});

// 确保 BotFather Webhook 正确设置
if (process.env.NODE_ENV !== 'production') {
  console.warn('[WARNING] 非生产环境，跳过 BotFather Webhook 设置');
} else {
  const { Telegraf } = require('telegraf');
  const bot = new Telegraf(process.env.BOT_TOKEN);
  
  bot.startPolling()
    .then(() => console.log('[BOT] 长轮询已启动'))
    .catch(err => console.error('[BOT] 轮询失败:', err));
}
