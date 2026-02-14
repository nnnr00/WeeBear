const { Telegraf, session } = require('telegraf');
const { isAdmin } = require('./utils'); // 自定义权限检查

module.exports = (bot) => {
  // Admin 主界面（仅管理员可见）
  bot.action('admin_menu', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const keyboard = {
      inline_keyboard: [
        [
          { text: "📁 获取 File ID", callback_data: "get_file_id" }
        ],
        [
          { text: "🛒 /p 商品添加", callback_data: "open_p_command" }
        ],
        [
          { text: "📋 工单列表", callback_data: "open_tickets" }
        ],
        [
          { text: "👥 用户表", callback_data: "open_users_table" }
        ]
      ]
    };

    await ctx.editMessageText(
      `🛡️ **Admin 控制台**\n\n请选择操作：`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  });

  // 按钮事件处理
  bot.on('callback_query', async (ctx) => {
    const { data } = ctx.callbackQuery;
    
    if (data === 'get_file_id') {
      await ctx.answerCallbackQuery("📸 请发送一张图片给机器人获取 File ID");
      ctx.session.step = 'waiting_for_photo'; // 状态跟踪
    }
    
    else if (data === 'open_p_command') {
      await ctx.answerCallbackQuery();
      ctx.reply("📝 发送 `/p` 开始商品添加", { parse_mode: 'Markdown' });
    }
    
    else if (data === 'open_tickets') {
      await ctx.answerCallbackQuery();
      // 从数据库获取最新 10 条工单（按时间倒序）
      const tickets = await db.query(`
        SELECT user_id, order_number, submitted_at 
        FROM tickets 
        WHERE status = 'active' 
        ORDER BY submitted_at DESC 
        LIMIT 10
      `);
      
      const list = tickets.rows.map(t => 
        `• @${t.username || 'N/A'} (${t.user_id})\n订单号: ${t.order_number}\n时间: ${formatBeijingTime(t.submitted_at)}`
      );
      
      await ctx.replyWithMarkdownV2(
        `📄 **当前工单列表**\n\n${list.join('\n\n') || '无待处理工单'}`,
        { 
          reply_markup: { 
            inline_keyboard: [[{ text: "🗑️ 删除工单", callback_data: "delete_ticket" }]]
          } 
        }
      );
    }
    
    else if (data === 'open_users_table') {
      await ctx.answerCallbackQuery();
      // 获取用户表前 10 条
      const users = await db.query(`SELECT * FROM users LIMIT 10`);
      const table = users.rows.map(u => 
        `@${u.username} (${u.user_id})\n订单号: ${u.order_id || 'N/A'}\n状态: ${u.is_vip ? '✅ VIP' : '⏳ 待验证'}`
      ).join('\n\n');
      
      await ctx.replyWithMarkdownV2(
        `👥 **用户表**\n\n${table || '无用户数据'}`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // 接收图片获取 File ID
  bot.on('photo', async (ctx) => {
    if (ctx.session.step !== 'waiting_for_photo') return;
    
    const fileId = ctx.message.photo[0].file_id; // 取最小分辨率的 file_id
    await ctx.reply(`✅ 获取成功！\nFile ID: \`${fileId}\``, { 
      parse_mode: 'Markdown',
      reply_markup: JSON.stringify({ 
        inline_keyboard: [[{ text: "⬅️ 返回 Admin", callback_data: "admin_menu" }]] 
      })
    });
    ctx.session.step = null; // 重置状态
  });
};
