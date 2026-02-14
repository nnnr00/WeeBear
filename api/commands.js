// api/commands.js
// ======================
// ✅ 代码头部：fileid 相关配置
// ======================
const { FILE_ID_TABLE, DB_TYPE } = require('../lib/db');
const { Telegraf, Markup } = require('telegraf');
const { query, execute } = require('../lib/db');
const { rateLimiter } = require('../lib/rateLimiter');

// 创建bot实例
const bot = new Telegraf(process.env.BOT_TOKEN);

// 管理员ID列表
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',')
  .map(id => id.trim())
  .filter(Boolean);

// 判断是否为管理员
const isAdmin = (ctx) => {
  return ADMIN_IDS.includes(ctx.from.id.toString());
};

// ======================
// Admin 面板
// ======================
bot.command('admin', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⚠️ 非管理员权限！");
  
  const adminKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📁 获取 File ID', 'get_fileid')],
    [Markup.button.command('/p', 'product_add')],
    [Markup.button.command('工单', 'tickets')],
    [Markup.button.command('用户表', 'users')]
  ]).extra;
  
  ctx.replyWithMarkdownV2(
    `🛡️ *Admin 控制台* 🛡️\n\n` +
    `1. 📁 **获取 File ID**\n` +
    `2. /p **商品添加**\n` +
    `3. 📄 **工单**\n` +
    `4. 👥 **用户表**`,
    adminKeyboard
  );
});

// 获取 File ID (需图片输入)
bot.action('get_fileid', (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.replyWithMarkdownV2(
    `📌 请发送图片给机器人\n` +
    `系统将自动提取 file_id 并跳转回 Admin`,
    Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ 返回 Admin', 'admin')]
    ]).extra
  );
});

bot.on('photo', async (ctx) => {
  if (!isAdmin(ctx)) return;
  
  try {
    const fileId = await FILE_ID_TABLE.generateFileId();
    
    ctx.replyWithMarkdownV2(
      `✅ *File ID 获取成功！*\n\n` +
      `\`\`\`${fileId}\`\`\`\n\n` +
      `🔄 点击跳转回 Admin`,
      Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ 返回 Admin', 'admin')]
      ]).extra
    );
  } catch (err) {
    ctx.reply("❌ 无法处理图片，请重试");
  }
});

// ======================
// /start 新春逻辑
// ======================
bot.start(async (ctx) => {
  const welcomeMsg = `
🐉 *喜迎马年新春！资源免费获取* 🐉

💎 *VIP会员特权说明* 💎
✅ 专属中转通道
✅ 优先审核入群
✅ 7x24小时客服支持
✅ 定期福利活动

🔍 ${FILE_ID_TABLE.COLUMNS.ORDER_ID} 插入位置：此处插入 file id（验证成功后自动填充）

[✅ 我已付款，开始验证]
  `.replace(/\n/g, '');

  ctx.replyWithMarkdownV2(
    welcomeMsg,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ 我已付款，开始验证', 'verify_payment')]
    ]).extra
  );
});

// 验证支付
bot.action('verify_payment', async (ctx) => {
  if (!isAdmin(ctx)) return;
  
  ctx.replyWithMarkdownV2(
    `📥 *请输入订单号* 📥\n\n` +
    `订单号格式示例: 20260123456789\n` +
    `（系统自动识别有效订单号）`,
    Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ 返回 Admin', 'admin')]
    ]).extra
  );
  
  ctx.session.waitingForOrderId = true;
  ctx.session.orderIdAttempts = 0;
});

bot.on('text', async (ctx) => {
  if (!ctx.session.waitingForOrderId) return;
  
  const orderId = ctx.message.text.trim();
  ctx.session.orderIdAttempts = (ctx.session.orderIdAttempts || 0) + 1;
  
  // 私密验证逻辑 (不暴露规则)
  if (/^20260\d{8,}$/.test(orderId)) {
    try {
      const fileId = await FILE_ID_TABLE.generateFileId();
      
      // 保存到数据库
      await execute(
        `INSERT INTO ${FILE_ID_TABLE.TABLE_NAME} 
         (${FILE_ID_TABLE.COLUMNS.FILE_ID}, ${FILE_ID_TABLE.COLUMNS.ORDER_ID}, 
          ${FILE_ID_TABLE.COLUMNS.USER_ID}, ${FILE_ID_TABLE.COLUMNS.USERNAME})
         VALUES (?, ?, ?, ?)`,
        [fileId, orderId, ctx.from.id, ctx.from.first_name]
      );
      
      // 发送工单给管理员
      await ctx.telegram.sendMessage(
        process.env.ADMIN_CHAT_ID,
        `🆕 *新工单* 🆕\n\n` +
        `用户: @${ctx.from.username || '未知'} (${ctx.from.id})\n` +
        `订单号: ${orderId}\n` +
        `时间: ${new Date().toLocaleString('zh-CN')}\n\n` +
        `👉 [加入会员群](${process.env.VIP_GROUP_LINK})`,
        { parse_mode: 'MarkdownV2', disable_web_page_preview: true }
      );
      
      ctx.replyWithMarkdownV2(
        `✅ *验证成功！* 文件ID已生成\n\n` +
        `\`\`\`${fileId}\`\`\`\n\n` +
        `💎 [加入会员群](${process.env.VIP_GROUP_LINK})\n` +
        `🔄 点击跳转回 Admin`,
        Markup.inlineKeyboard([
          [Markup.button.callback('⬅️ 返回 Admin', 'admin')],
          [Markup.button.url('💎 加入会员群', process.env.VIP_GROUP_LINK)]
        ]).extra
      );
      
      ctx.session.waitingForOrderId = false;
    } catch (err) {
      ctx.reply("❌ 验证失败，请重试");
      ctx.session.waitingForOrderId = false;
    }
  } else {
    // 失败处理
    if (ctx.session.orderIdAttempts >= 2) {
      ctx.replyWithMarkdownV2(
        `⚠️ *订单号验证失败次数过多* ⚠️\n\n` +
        `🔄 正在返回首页...`,
        Markup.inlineKeyboard([
          [Markup.button.start('🐉 返回首页', '/start')]
        ]).extra
      );
      ctx.session.waitingForOrderId = false;
    } else {
      ctx.reply("❌ 无效订单号，请重新输入");
    }
  }
});

// ======================
// /p 商品添加
// ======================
bot.command('p', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⚠️ 仅管理员可用！");
  
  ctx.replyWithMarkdownV2(
    `🛒 *商品添加面板* 🛒\n\n` +
    `发送 /p 或点击 ➕ 上架新关键词\n` +
    `机器人将逐条记录内容（支持任意格式）`,
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ 上架新关键词', 'add_product_keyword')]
    ]).extra
  );
});

bot.action('add_product_keyword', async (ctx) => {
  if (!isAdmin(ctx)) return;
  
  ctx.reply("🤖 机器人问：请输入关键词（例如 1）");
  ctx.session.waitingForKeyword = true;
});

bot.on('text', async (ctx) => {
  if (!ctx.session.waitingForKeyword) return;
  
  const keyword = ctx.message.text.trim();
  if (!keyword) return;
  
  // 保存到缓冲表
  await execute(
    `INSERT INTO p_buffer (keyword, admin_id) VALUES (?, ?)`,
    [keyword, ctx.from.id]
  );
  
  ctx.replyWithMarkdownV2(
    `📦 *商品记录成功* 📦\n\n` +
    `✅ [完成上架](${FILE_ID_TABLE.COLUMNS.ORDER_ID})\n\n` +
    `📦 文件记录已保存\n` +
    `📦 等待完成所有记录...`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ 完成上架', 'complete_upload')]
    ]).extra
  );
});

bot.action('complete_upload', async (ctx) => {
  if (!isAdmin(ctx)) return;
  
  // 获取所有关键词
  const [keywords] = await query(
    `SELECT * FROM p_buffer ORDER BY created_at ASC`
  );
  
  // 清空缓冲区
  await execute(`TRUNCATE TABLE p_buffer`);
  
  ctx.replyWithMarkdownV2(
    `📦 *商品上架完成！* 📦\n\n` +
    `✅ 共上架 ${keywords.length} 个关键词\n\n` +
    `📌 提示：这些关键词将在 /dh 命令中可用`,
    Markup.inlineKeyboard([
      [Markup.button.start('↩️ 返回兑换', '/dh')]
    ]).extra
  );
});

// ======================
// /dh 兑换系统
// ======================
bot.command('dh', async (ctx) => {
  if (!await rateLimiter.check(ctx)) {
    const remaining = await rateLimiter.getRemainingTime(ctx);
    ctx.replyWithMarkdownV2(
      `⏳ *请稍等* ⏳\n` +
      `冷却剩余: ${remaining}\n\n` +
      `💎 [加入会员（新春特价）](${process.env.VIP_GROUP_LINK})`
    );
    return;
  }

  // 获取分页参数
  const page = parseInt(ctx.query?.page) || 1;
  const limit = 10;
  const offset = (page - 1) * limit;
  
  // 获取关键词（根据数据库类型调整分页语法）
  let keywords;
  if (DB_TYPE === 'pg') {
    keywords = await query(`
      SELECT * FROM p_buffer 
      ORDER BY created_at ASC 
      LIMIT ${limit} OFFSET ${offset}
    `);
  } else {
    keywords = await query(`
      SELECT * FROM p_buffer 
      ORDER BY created_at ASC 
      LIMIT ${offset}, ${limit}
    `);
  }
  
  if (keywords.length === 0) {
    ctx.replyWithMarkdownV2(
      `📦 *暂无商品可兑换* 📦\n\n` +
      `💎 [加入会员（新春特价）](${process.env.VIP_GROUP_LINK})\n` +
      `ℹ️ 请等待管理员通过 /p 上架商品`,
      Markup.inlineKeyboard([
        [Markup.button.start('🔄 返回首页', '/start')],
        [Markup.button.url('💎 加入会员群', process.env.VIP_GROUP_LINK)]
      ]).extra
    );
  } else {
    const totalPages = Math.ceil((await query('SELECT COUNT(*) AS total FROM p_buffer'))[0].total / limit;
    const progress = `📦 文件 (${offset + 1}-${offset + keywords.length}/共${totalPages * limit}条)`;
    
    ctx.replyWithMarkdownV2(
      `🔗 *Deep Link 兑换* 🔗\n\n` +
      `${progress}\n` +
      `⏳ 发送中... (每10条为一组)\n\n` +
      `💎 [加入会员](${process.env.VIP_GROUP_LINK})`,
      Markup.inlineKeyboard([
        ...keywords.map(k => [
          Markup.button.callback(`📁 ${k.keyword}`, `dh_keyword_${k.id}`)
        ]),
        [
          Markup.button.callback('✨👉 请点击继续发送', `dh_page_${page + 1}`),
          Markup.button.start('↩️ 返回兑换', '/dh')
        ]
      ]).extra
    );
  }
});

// 关键词点击处理
bot.action(/^dh_keyword_(\d+)$/, async (ctx) => {
  const keywordId = ctx.match[1];
  const [keyword] = await query(`SELECT * FROM p_buffer WHERE id = ?`, [keywordId]);
  
  if (!keyword) return;
  
  // 转发到私密群
  await ctx.telegram.forwardMessage(
    process.env.PRIVATE_GROUP_ID,
    ctx.chat.id,
    keyword.message_id
  );
  
  ctx.replyWithMarkdownV2(
    `✅ *已发送关键词* ✅\n\n` +
    `📦 文件已转发至私密群\n\n` +
    `💎 [加入会员](${process.env.VIP_GROUP_LINK})`
  );
});

// 分页继续发送
bot.action(/^dh_page_(\d+)$/, async (ctx) => {
  const nextPage = parseInt(ctx.match[1]);
  await bot.handleCommand(ctx, '/dh');
});

// ======================
// /c 和 /cz 管理员命令
// ======================
bot.command('c', (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.session = {};
  ctx.reply("🛑 管理员状态已取消");
});

bot.command('cz', (ctx) => {
  if (!isAdmin(ctx)) return;
  rateLimiter.resetForAdmin(ctx);
  ctx.reply("🔄 管理员频控已重置（视为新用户）");
});

// ======================
// 工单系统
// ======================
bot.command('tickets', async (ctx) => {
  if (!isAdmin(ctx)) return;
  
  const page = parseInt(ctx.query?.page) || 1;
  const limit = 10;
  const offset = (page - 1) * limit;
  
  // 获取工单列表
  let tickets;
  if (DB_TYPE === 'pg') {
    tickets = await query(`
      SELECT * FROM ${FILE_ID_TABLE.TABLE_NAME} 
      WHERE "used" = FALSE 
      ORDER BY "created_at" DESC 
      LIMIT ${limit} OFFSET ${offset}
    `);
  } else {
    tickets = await query(`
      SELECT * FROM ${FILE_ID_TABLE.TABLE_NAME} 
      WHERE used = FALSE 
      ORDER BY created_at DESC 
      LIMIT ${limit} OFFSET ${offset}
    `);
  }
  
  const totalPages = Math.ceil((await query(
    `SELECT COUNT(*) AS total FROM ${FILE_ID_TABLE.TABLE_NAME} WHERE used = FALSE`
  ))[0].total / limit);
  
  if (tickets.length === 0) {
    ctx.reply("📄 *无待处理工单* 📄");
    return;
  }
  
  const ticketList = tickets.map(t => {
    const created = new Date(t.created_at).toLocaleString('zh-CN');
    return `• @${t.username} (${t.user_id})\n订单号: ${t.order_id}\n时间: ${created}`;
  }).join('\n\n');
  
  ctx.replyWithMarkdownV2(
    `📄 *工单列表 (1/${totalPages})* 📄\n\n` +
    ticketList +
    `\n\n🗑️ [删除工单](dh_delete_ticket)`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🗑️ 删除工单', 'delete_ticket')],
      ...Array.from({ length: totalPages }, (_, i) => 
        Markup.button.callback(`📄 ${i+1}/${totalPages}`, `tickets_page_${i+1}`)
      )
    ]).extra
  );
});

// 删除工单
bot.action('delete_ticket', async (ctx) => {
  if (!isAdmin(ctx)) return;
  
  const orderId = ctx.callbackQuery.data.split('_')[2];
  await execute(
    `UPDATE ${FILE_ID_TABLE.TABLE_NAME} SET used = TRUE WHERE order_id = ?`,
    [orderId]
  );
  
  await ctx.answerCallbackQuery();
  ctx.editMessageText(`✅ 工单 #${orderId} 已删除`);
});

// 用户表
bot.command('users', async (ctx) => {
  if (!isAdmin(ctx)) return;
  
  const [users] = await query(
    `SELECT * FROM ${FILE_ID_TABLE.TABLE_NAME} ORDER BY created_at DESC LIMIT 10`
  );
  
  const userList = users.map(u => 
    `• @${u.username} (${u.user_id})\n注册时间: ${new Date(u.created_at).toLocaleString('zh-CN')}\n状态: ${u.used ? '✅ 已验证' : '⏳ 未验证'}\n`
  ).join('\n\n');
  
  ctx.replyWithMarkdownV2(
    `👥 *用户表* 👥\n\n` +
    `当前显示: ${users.length} 条记录\n` +
    `总记录: ${users.length} 条` +
    `（完整数据需导出）`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🗑️ 删除选中', 'delete_user')]
    ]).extra
  );
});

// 导出bot实例
module.exports = {
  bot,
  isAdmin
};
