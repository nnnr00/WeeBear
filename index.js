// index.js
require('dotenv').config();
const express = require('express');
const { initDB } = require('./lib/db');
const { bot } = require('./api/commands');

const app = express();

// 解析Telegram webhook请求
app.use(express.json({ limit: '50mb' }));

// 初始化数据库
initDB()
  .then(() => console.log('[DB] 初始化成功'))
  .catch(err => {
    console.error('[DB] 初始化失败:', err);
    process.exit(1);
  });

// Webhook端点
app.post('/webhook', (req, res) => {
  bot.handleUpdate(req.body)
    .then(() => res.end('ok'))
    .catch(err => {
      console.error('[WEBHOOK] 处理失败:', err);
      res.status(500).end();
    });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] 运行在端口 ${PORT}`);
  console.log(`[WEBHOOK] 已就绪: /webhook`);
});

// 调试路由
app.get('/start', (req, res) => {
  res.redirect(process.env.BOT_USERNAME);
});

app.get('/p', (req, res) => {
  res.send('使用 /p 命令在 Telegram 中');
});

app.get('/dh', (req, res) => {
  res.send('使用 /dh 命令在 Telegram 中');
});

app.get('/admin', (req, res) => {
  res.send('使用 /admin 命令在 Telegram 中');
});

app.get('/c', (req, res) => {
  res.send('使用 /c 命令在 Telegram 中');
});

app.get('/cz', (req, res) => {
  res.send('使用 /cz 命令在 Telegram 中');
});
