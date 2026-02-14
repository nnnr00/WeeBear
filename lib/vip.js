const { Telegraf } = require('telegraf');
const db = require('./db');
const { isAdmin, isNewUser } = require('./utils');
const { getBeijingTime } = require('./timezone');

module.exports = (bot) => {
  bot.command('v', (ctx) => {
    ctx.reply("🔍 请输入您的订单号（格式示例：20260123456789）", {
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: "⏮️ 返回首页", callback_data: "/start" }]]
      })
    });
    ctx.session.vStep = 'waiting_order';
  });

  bot.on('text', async (ctx) => {
    if (ctx.session.vStep !== 'waiting_order') return;
    
    const orderId = ctx.message.text.trim();
    
    // PRIVATE LOGIC: Never reveal 20260 pattern
    if (!orderId.startsWith('20260')) {
      handleFailedAttempt(ctx);
      return;
    }

    const { rows } = await db.query(
      `SELECT * FROM users WHERE order_id = $1`,
      [orderId]
    );

    if (rows[0]) {
      await ctx.reply("⚠️ 该订单号已被使用");
      return;
    }

    await db.query(`
      INSERT INTO users (user_id, username, order_id, created_at, last_seen)
      VALUES ($1, $2, $3, 
        (NOW() AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'),
        (NOW() AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')
      )
      ON CONFLICT (user_id) DO UPDATE
      SET order_id = EXCLUDED.order_id,
          username = EXCLUDED.username,
          created_at = EXCLUDED.created_at,
          last_seen = EXCLUDED.last_seen
    `, [
      ctx.from.id,
      ctx.from.first_name,
      orderId
    ]);

    await ctx.replyWithMarkdownV2(
      `✅ 订单验证通过！\n\n点击加入 VIP 群：${process.env.INVITE_LINK}`,
      {
        reply_markup: JSON.stringify({
          inline_keyboard: [[{ text: "✅ 我已付款，开始验证", callback_data: "confirm_vip" }]]
        })
      }
    );

    notifyAdminOnTicket(ctx, orderId);
  });

  function handleFailedAttempt(ctx) {
    ctx.session.vAttempts = (ctx.session.vAttempts || 0) + 1;
    
    if (ctx.session.vAttempts >= 2) {
      ctx.replyWithMarkdownV2(
        "❌ 输入错误次数过多\n\n⏪ 点击返回首页",
        { 
          reply_markup: JSON.stringify({
            inline_keyboard: [[{ text: "⏪ 返回", callback_data: "/start" }]]
          })
        }
      );
      ctx.session.vStep = null;
    } else {
      ctx.reply("❌ 订单号格式错误（必须以 20260 开头）");
    }
  }

  async function notifyAdminOnTicket(ctx, orderId) {
    const now = getBeijingTime();
    const adminMsg = `
🆕 **新工单**
-----------------
用户名: @${ctx.from.username || 'N/A'} (${ctx.from.id})
订单号: ${orderId}
提交时间: ${now}

[删除工单](${ctx.from.id}_ticket)
    `.trim();

    process.env.ADMIN_IDS.split(',').forEach(id => {
      bot.telegram.sendMessage(id, adminMsg, { parse_mode: 'Markdown' });
    });
  }
};
