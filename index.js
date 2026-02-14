require('dotenv').config();
const { Telegraf } = require('telegraf');
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// 初始化所有模块
require('./lib/admin')(bot);
require('./lib/start')(bot);
require('./lib/vip')(bot);
require('./lib/dh')(bot);
require('./lib/products')(bot);

// 设置 Webhook（Vercel 自动处理 HTTPS）
bot.telegram.setWebhook({ url: `${process.env.VERCEL_URL}/webhook` });

module.exports = async (req, res) => {
  bot.handleUpdate(req.body);
  res.status(200).end();
};
