const { Telegraf } = require('telegraf');
const db = require('../db');
const { isAdmin } = require('./utils');

module.exports = (bot) => {
  bot.command('dh', async (ctx) => {
    if (!isAdmin(ctx)) {
      await handleUserDhRequest(ctx);
      return;
    }
    
    // 管理员专用：/dh 命令
    ctx.reply("🛠️ 管理员模式已激活\n\n发送 `/c` 取消操作\n发送 `/cz` 重置自身频控", {
      parse_mode: 'Markdown'
    });
    ctx.session.dhAdminMode = true;
  });

  // 普通用户兑换逻辑
  async function handleUserDhRequest(ctx) {
    const userId = ctx.from.id;
    const now = new Date();
    const beijingNow = formatBeijingTime(now);
    
    // 1. 检查每日重置
    let usage = await db.query(
      `SELECT * FROM dh_usage WHERE user_id = $1 AND reset_date < $2`,
      [userId, beijingNow]
    );
    
    if (!usage.rows[0]) {
      // 新用户或重置后
      await db.query(
        `INSERT INTO dh_usage (user_id, used_count, last_used, cooldown_until, reset_date)
         VALUES ($1, 0, NULL, NULL, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, beijingNow.split(' ')[0]] // reset_date 为今日日期
      );
      usage = await db.query(`SELECT * FROM dh_usage WHERE user_id = $1`, [userId]);
    }

    // 2. 检查冷却状态
    if (usage.rows[0].cooldown_until && new Date(usage.rows[0].cooldown_until) > now) {
      const remaining = Math.floor((new Date(usage.rows[0].cooldown_until) - now) / 60000);
      ctx.reply(
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

    // 3. 消耗次数
    const freeLimit = isNewUser(usage, beijingNow) ? 3 : 2;
    const maxDaily = 6;
    
    if (usage.rows[0].used_count >= maxDaily) {
      ctx.reply("❌ 今日免费次数已用完");
      return;
    }

    // 更新使用计数
    const newCount = usage.rows[0].used_count + 1;
    await db.query(
      `UPDATE dh_usage 
       SET used_count = $1, last_used = $2, cooldown_until = NULL, reset_date = $3
       WHERE user_id = $4`,
      [
        newCount,
        beijingNow,
        beijingNow.split(' ')[0], // 重置日期
        userId
      ]
    );

    // 4. 根据次数返回不同内容（此处简化）
    ctx.reply("🎉 兑换成功！\n点击按钮获取资源：", {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: "⬇️ 下载资源", url: "https://t.me/your_resource_channel" }],
          [{ text: "⏮️ 返回兑换", callback_data: "/dh" }]
        ]
      })
    });
  }

  // 判断是否为新用户（当天首次使用）
  function isNewUser(usage, currentDate) {
    return usage.rows[0].reset_date !== currentDate.split(' ')[0];
  }

  // 管理员命令
  bot.command('c', (ctx) => {
    if (!isAdmin(ctx) || !ctx.session.dhAdminMode) return;
    ctx.session.dhAdminMode = false;
    ctx.reply("🛑 管理员操作已取消");
  });

  bot.command('cz', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await db.query(
      `UPDATE dh_usage 
       SET used_count = 0, cooldown_until = NULL, reset_date = CURRENT_DATE 
       WHERE user_id = $1`,
      [ctx.from.id]
    );
    ctx.reply("🔄 管理员频控已重置（今日视为新用户）");
  });
};
