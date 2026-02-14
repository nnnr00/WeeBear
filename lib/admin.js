const { Telegraf } = require('telegraf');
const { getBeijingTime } = require('./timezone');
const db = require('./db');
const { isAdmin } = require('./utils');

module.exports = (bot) => {
  // Admin menu
  bot.action('admin_menu', async (ctx) => {
    if (!isAdmin(ctx)) return;
    
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🛡️ **Admin 控制台**\n\n请选择操作：`,
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: "📁 获取 File ID", callback_data: "get_file_id" }],
            [{ text: "🛒 /p 商品添加", callback_data: "open_p_command" }],
            [{ text: "📋 工单列表", callback_data: "open_tickets" }],
            [{ text: "👥 用户表", callback_data: "open_users_table" }]
          ]
        }
      }
    );
  });

  // File ID handler
  bot.action('get_file_id', async (ctx) => {
    if (!isAdmin(ctx)) return;
    
    await ctx.answerCallbackQuery("📸 请发送一张图片获取 File ID");
    ctx.session.step = 'waiting_for_photo';
  });

  bot.on('photo', async (ctx) => {
    if (ctx.session.step !== 'waiting_for_photo') return;
    
    const fileId = ctx.message.photo[0].file_id;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `✅ 获取成功！\n\nFile ID: \`${fileId}\``,
      {
        reply_markup: JSON.stringify({
          inline_keyboard: [[{ text: "⬅️ 返回 Admin", callback_data: "admin_menu" }]]
        })
      }
    );
    ctx.session.step = null;
  });

  // Products management
  bot.action('open_p_command', async (ctx) => {
    if (!isAdmin(ctx)) return;
    
    await ctx.answerCallbackQuery();
    await ctx.reply("🔑 请输入商品关键词（例如：1）", {
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: "⏮️ 返回", callback_data: "/start" }]]
      })
    });
    ctx.session.pStep = 'waiting_keyword';
  });

  bot.on('text', async (ctx) => {
    if (ctx.session.pStep === 'waiting_keyword') {
      ctx.session.productKeyword = ctx.message.text.trim();
      ctx.session.pContents = [];
      
      await ctx.reply("📝 请逐条输入商品内容\n发送 '✅ 完成上架'", {
        parse_mode: 'Markdown'
      });
      ctx.session.pStep = 'waiting_content';
    }
  });

  bot.on('text', async (ctx) => {
    if (ctx.session.pStep === 'waiting_content' && ctx.message.text === '✅ 完成上架') {
      await saveProduct(ctx);
      ctx.session = null;
      return;
    }
    
    if (ctx.session.pStep === 'waiting_content') {
      ctx.session.pContents.push({ type: 'text', value: ctx.message.text });
      await ctx.reply("➕ 继续添加内容 或 发送 '✅ 完成上架'");
    }
  });

  bot.on('photo', async (ctx) => {
    if (ctx.session.pStep !== 'waiting_content' || !ctx.session.productKeyword) return;
    
    const fileId = ctx.message.photo[0].file_id;
    ctx.session.pContents.push({ type: 'photo', value: fileId });
    await ctx.reply("🖼️ 图片已添加！继续添加 或 发送 '✅ 完成上架'");
  });

  async function saveProduct(ctx) {
    await db.query(`
      INSERT INTO products (keyword, contents, is_active)
      VALUES ($1, $2, true)
      ON CONFLICT (keyword) DO UPDATE 
      SET contents = $2, is_active = true
    `, [
      ctx.session.productKeyword,
      JSON.stringify(ctx.session.pContents)
    ]);
    
    await ctx.reply("✅ 商品上架成功！", {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: "🛒 查看商品", callback_data: "view_products" }],
          [{ text: "⏮️ 返回", callback_data: "/start" }]
        ]
      })
    });
  }

  // View products
  bot.action('view_products', async (ctx) => {
    if (!isAdmin(ctx)) return;
    
    const { rows } = await db.query(`
      SELECT keyword, is_active FROM products ORDER BY keyword
    `);
    
    const list = rows.map(p => 
      `• ${p.keyword} (${p.is_active ? '✅ 上架' : '❌ 下架'})`
    ).join('\n\n');
    
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `📦 **商品列表**\n\n${list || '无商品'}`,
      { 
        parse_mode: 'Markdown',
        reply_markup: JSON.stringify({
          inline_keyboard: [[{ text: "➕ 上架新商品", callback_data: "open_p_command" }]]
        })
      }
    );
  });

  // Delete product
  bot.action(/delete_product_(.+)/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    
    const keyword = ctx.match[1];
    await db.query(
      `UPDATE products SET is_active = false WHERE keyword = $1`,
      [keyword]
    );
    
    await ctx.answerCallbackQuery("🗑️ 已停用关键词");
    await ctx.editMessageText("✅ 已停用关键词");
  });

  // Tickets management
  bot.action('open_tickets', async (ctx) => {
    if (!isAdmin(ctx)) return;
    
    const { rows } = await db.query(`
      SELECT id, user_id, order_number, submitted_at 
      FROM tickets 
      WHERE status = 'active'
      ORDER BY submitted_at DESC 
      LIMIT 10
    `);
    
    const list = rows.map(t => 
      `• @${t.user_id} (${t.order_number})\n时间: ${getBeijingTime(t.submitted_at)}`
    ).join('\n\n');
    
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `📄 **工单列表**\n\n${list || '无待处理工单'}`,
      { 
        reply_markup: JSON.stringify({
          inline_keyboard: [[{ text: "🗑️ 删除工单", callback_data: "delete_ticket" }]]
        })
      }
    );
  });

  // Delete ticket
  bot.action('delete_ticket', async (ctx) => {
    if (!isAdmin(ctx)) return;
    
    const [userId, ticketId] = ctx.match[1].split('_');
    await db.query(
      `UPDATE tickets SET status = 'deleted' WHERE id = $1`,
      [ticketId]
    );
    
    await ctx.answerCallbackQuery("🗑️ 工单已删除");
    await ctx.editMessageText("✅ 工单已删除");
  });

  // Users table
  bot.action('open_users_table', async (ctx) => {
    if (!isAdmin(ctx)) return;
    
    const { rows } = await db.query(`
      SELECT user_id, username, order_id, is_vip 
      FROM users 
      LIMIT 10
    `);
    
    const table = rows.map(u => 
      `@${u.username || 'N/A'} (${u.user_id})\n订单号: ${u.order_id || 'N/A'}\n状态: ${u.is_vip ? '✅ VIP' : '⏳ 待验证'}\n`
    ).join('\n\n');
    
    await ctx.answerCallbackQuery();
    await ctx.replyWithMarkdownV2(
      `👥 **用户表**\n\n${table}`,
      { parse_mode: 'Markdown' }
    );
  });
};
