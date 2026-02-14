// lib/index.js
require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./db');
const start = require('./start');
const admin = require('./admin');
const vip = require('./vip');
const dh = require('./dh');
const products = require('./products');

// 初始化机器人
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// 设置会话存储
bot.use(session());

// 注册所有模块
start(bot);
admin(bot);
vip(bot);
dh(bot);
products(bot);

// 错误处理
bot.on('error', (err) => {
  console.error('Bot error:', err);
});

// 启动
const PORT = process.env.PORT || 3000;
bot.launch({
  webHook: {
    port: PORT,
    cert: process.env.SSL_CERT,
    key: process.env.SSL_KEY
  }
});


// 确保关闭连接
process.on('SIGINT', () => {
  bot.stop();
  process.exit();
});
