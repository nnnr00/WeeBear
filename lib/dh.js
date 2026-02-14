// lib/dh.js
const { Telegraf } = require('telegraf');
const db = require('./db');
const { isAdmin, isAdminCommand } = require('./utils');

module.exports = (bot) => {
  // 频控重置检查
  const checkReset = async (ctx) => {
    const userId = ctx.from.id;
    const today = exports.getBeijingDate();
    
    const usage = await db.query(
      `SELECT reset_date FROM dh_usage WHERE user_id = $1`,
      [userId]
    );
    
    if (!usage.rows[0] || usage.rows[0].reset_date !== today) {
      await db.query(`
        INSERT INTO dh_usage (user_id, used_count, reset_date)
        VALUES ($1, 0, $2)
        ON CONFLICT (user_id) DO UPDATE 
        SET used_count = 0, reset_date = $2
      `, [userId, today]);
    }
  };

  // 用户兑换逻辑
  const handleUserDh = async (ctx) => {
    await checkReset(ctx);
    
    const userId = ctx.from.id;
    const usage = await db.query(
      `SELECT * FROM dh_usage WHERE user_id = $1`,
      [userId]
    );
    
    // 检查冷却
    if (usage.rows[0].cooldown_until && new Date(usage.rows[0].cooldown_until) > new Date()) {
      const remaining = Math.floor(
        (new Date(usage.rows[0].cooldown_until) - new Date()) / 60000
      );
      
      await ctx.reply(
        `⏳ 冷却中...\n剩余时间: ${remaining} 分钟`,
        {
          reply_markup: JSON.stringify({
            inline_keyboard: [
              [{ text: "💎 加入会员（跳过等待）", callback_data: "/v" }],
              [{ text: "⏮️ 返回兑换", callback_data: "/dh" }]
            ]
          })
        }
      );
      return;
    }

    // 获取免费次数
    const freeLimit = await exports.isNewUser(userId) ? 3 : 2;
    const maxDaily = 6;
    
    // 检查是否超限
    if (usage.rows[0].used_count >= maxDaily) {
      await ctx.reply("❌ 今日免费次数已用完");
      return;
    }

    // 消耗次数
    const newCount = usage.rows[0].used_count + 1;
    await db.query(
      `UPDATE dh_usage 
       SET used_count = $1, last_used = $2 
       WHERE user_id = $3`,
      [
        newCount,
        new Date().toISOString(),
        userId
      ]
    );

    // 设置冷却（如果超过免费次数）
    if (newCount > freeLimit && newCount <= 12) {
      const cooldownMinutes = [0, 0, 0, 5, 15, 30, 50, 60, 60, 60, 60, 60][newCount];
      const cooldownUntil = new Date(Date.now() + cooldownMinutes * 60000);
      
      await db.query(
        `UPDATE dh_usage 
         SET cooldown_until = $1 
         WHERE user_id = $2`,
        [cooldownUntil.toISOString(), userId]
      );
    }

    // 发送兑换结果
    await ctx.reply("🎉 兑换成功！点击按钮获取资源：", {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: "⬇️ 下载资源", url: "https://t.me/your_resource_channel" }],
          [{ text: "⏮️ 返回兑换", callback_data: "/dh" }]
        ]
      })
    });
  };

  // /dh 命令
  bot.command('dh', async (ctx) => {
    if (isAdminCommand(ctx)) {
      // 管理员模式
      await ctx.reply("🛠️ 管理员模式激活\n\n发送 `/c` 取消操作\n发送 `/cz` 重置自身频控", {
        parse_mode: 'Markdown'
      });
      ctx.session.dhAdminMode = true;
    } else {
      // 普通用户
      await handleUserDh(ctx);
    }
  });

  // 管理员命令
  bot.command('c', (ctx) => {
    if (isAdminCommand(ctx)) {
      ctx.session.dhAdminMode = false;
      ctx.reply("🛑 管理员操作已取消");
    }
  });

  bot.command('cz', async (ctx) => {
    if (isAdminCommand(ctx)) {
      await db.query(`
        UPDATE dh_usage 
        SET used_count = 0, cooldown_until = NULL, reset_date = $1
        WHERE user_id = $2
      `, [exports.getBeijingDate(), ctx.from.id]);
      
      ctx.reply("🔄 管理员频控已重置（今日视为新用户）");
    }
  });

  // 处理按钮点击
  bot.action('dh_button', async (ctx) => {
    if (ctx.match[1] === 'confirm_vip') {
      await ctx.answerCallbackQuery();
      await ctx.replyWithMarkdownV2(
        `✅ 订单验证通过！\n\n点击加入 VIP 群：${process.env.INVITE_LINK}`,
        {
          reply_markup: JSON.stringify({
            inline_keyboard: [[{ text: "💎 加入会员", callback_data: "/v" }]]
          })
        }
      );
    }
  });
};
