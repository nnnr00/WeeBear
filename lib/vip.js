const { Telegraf } = require('telegraf');
const db = require('../db'); // 数据库连接

module.exports = (bot) => {
  // Step 1: 用户点击按钮发送 /v
  bot.command('v', (ctx) => {
    ctx.reply("🔍 请输入您的订单号（格式示例：20260123456789）", {
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: "⏮️ 返回首页", callback_data: "/start" }]]
      })
    });
    ctx.session.vStep = 'waiting_order'; // 状态跟踪
  });

  // Step 2: 处理订单号输入
  bot.on('text', async (ctx) => {
    if (ctx.session.vStep !== 'waiting_order') return;
    
    const orderId = ctx.message.text.trim();
    
    // 验证规则：必须以 20260 开头（逻辑私密，不提示用户）
    if (!orderId.startsWith('20260')) {
      handleFailedAttempt(ctx);
      return;
    }

    // 检查是否已存在（防重复）
    const existing = await db.query(
      `SELECT * FROM users WHERE order_id = $1`,
      [orderId]
    );
    
    if (existing.rows[0]) {
      ctx.reply("⚠️ 该订单号已被使用，请检查后重试");
      return;
    }

    // 保存到数据库（不暴露 20260 逻辑）
    await db.query(
      `INSERT INTO users (user_id, username, order_id, created_at) 
       VALUES ($1, $2, $3, NOW() AT TIME ZONE 'Asia/Shanghai')`,
      [ctx.from.id, ctx.from.first_name, orderId]
    );

    // 发送邀请链接
    const inviteMsg = `
✅ 订单验证通过！
点击加入 VIP 群：${process.env.INVITE_LINK}

💡 提示：群内发送 /verify 绑定账号
    `.trim();
    
    ctx.replyWithMarkdownV2(inviteMsg, {
      parse_mode: 'Markdown',
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: "✅ 我已付款，开始验证", callback_data: "confirm_vip" }]]
      })
    });

    // 通知管理员（工单系统）
    notifyAdminOnTicket(ctx, orderId);
  });

  // 失败处理（输入两次无效则返回首页）
  function handleFailedAttempt(ctx) {
    ctx.session.vAttempts = (ctx.session.vAttempts || 0) + 1;
    
    if (ctx.session.vAttempts >= 2) {
      ctx.replyWithMarkdownV2(
        "❌ 输入错误次数过多\n\n⏪ 点击返回首页",
        { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "⏪ 返回", callback_data: "/start" }]] }) }
      );
      ctx.session.vStep = null; // 重置状态
    } else {
      ctx.reply("❌ 订单号格式错误（必须以 20260 开头）");
    }
  }

  // 通知管理员（工单系统）
  async function notifyAdminOnTicket(ctx, orderId) {
    const now = formatBeijingTime(new Date());
    const adminMsg = `
🆕 **新工单**
-----------------
用户名: @${ctx.from.username || 'N/A'} (${ctx.from.id})
订单号: ${orderId}
提交时间: ${now}

[删除工单](${ctx.callbackQuery.data}) // 按钮动态生成
    `.trim();
    
    process.env.ADMIN_IDS.split(',').forEach(adminId => {
      bot.telegram.sendMessage(adminId, adminMsg, { parse_mode: 'Markdown' });
    });
  }
};
