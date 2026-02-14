require('dotenv').config();
const { Telegraf } = require('telegraf');
const db = require('./db');
const start = require('./start');
const admin = require('./admin');
const vip = require('./vip');
const dh = require('./dh');
const products = require('./products');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Session and modules
bot.use(require('telegraf/session')());
start(bot);
admin(bot);
vip(bot);
dh(bot);
products(bot);

// Error handling
bot.on('error', (err) => {
  console.error('BOT ERROR:', err);
});

// Start bot
const PORT = process.env.PORT || 3000;
bot.launch({
  webHook: {
    port: PORT,
    cert: process.env.SSL_CERT,
    key: process.env.SSL_KEY
  }
}).catch(err => {
  console.error('LAUNCH ERROR:', err);
  process.exit(1);
});

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, () => {
    bot.stop();
    process.exit();
  });
});
