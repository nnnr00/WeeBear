// api/commands.js
// ======================
// ✅ 代码头部：引入 fileid 配置（必须放在顶部！）
// ======================
const { FILE_ID_TABLE } = require('../lib/db');
const { Telegraf, Markup } = require('telegraf');
const db = require('../lib/db').initDB();
const { rateLimiter } = require('../lib/rateLimiter');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ======================
// Admin 面板（仅管理员可访问）
// ======================
const isAdmin = (ctx) => {
  const ADMIN_IDS = [123456789]; // 替换为实际管理员ID
  return ADMIN_IDS.includes(ctx.from.id);
};

// 四个按钮的 Handler
bot.command('admin', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⚠️ 非管理员权限！");
  
  const adminKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📁 获取 File ID', 'get_fileid')],
    [Markup.button.command('/p', '商品添加')],
    [Markup.button.command('工单', 'tickets')],
    [Markup.button.command('用户表', 'users')]
  ]).extra;
  
  ctx.replyWithMarkdownV2(
    `🛡️ *Admin 控制台* 🛡️\n\n` +
    `1. 📁 **File ID 按钮**\n` +
    `2. /p **商品添加**\n` +
    `3. 📄 **工单**\n` +
    `4. 👥 **用户表**`,
    adminKeyboard
  );
});

// 按钮 1: 获取 File ID（需用户上传图片）
bot.on('photo', async (ctx) => {
  if (!isAdmin(ctx)) return;
  
  // 从图片提取 file_id（示例：实际需调用OCR或业务系统）
  const fileId = await generateFileIdFromImage(ctx.message.photo[0].file_id);
  ctx.replyWithMarkdownV2(
    `✅ *File ID 获取成功！*\n\n` +
    `\`\`\`${fileId}\`\`\`\n\n` +
    `🔄 点击跳转回 Admin`,
    Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ 返回 Admin', 'admin')]
    ]).extra
  );
});

// 按钮 2: /p 商品添加
bot.command('p', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⚠️ 仅管理员可用！");
  
  ctx.replyWithMarkdownV2(
    `🛒 *商品添加面板* 🛒\n\n` +
    `发送 /p 或点击 ➕ 上架新关键词\n` +
    `机器人将逐条记录内容（支持图片/文本）`,
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ 上架新关键词', 'add_product_keyword')]
    ]).extra
  );
});

// 按钮 3: 工单
bot.command('tickets', (ctx) => {
  if (!isAdmin(ctx)) return;
  
  // 查询待审核工单（按时间倒序）
  const [tickets] = await db.query(
    `SELECT * FROM ${FILE_ID_TABLE.TABLE_NAME} 
     WHERE used = FALSE 
     ORDER BY created_at DESC 
     LIMIT 10`
  );
  
  const ticketList = tickets.map(t => 
    `• @${t.username} (${t.user_id})\n订单号: ${t.order_id}\n时间: ${new Date(t.created_at).toLocaleString('zh-CN')}`
  ).join('\n\n');
  
  ctx.replyWithMarkdownV2(
    `📄 *工单列表 (1/${Math.ceil(tickets.length/10)}) *\n\n` +
    ticketList,
    Markup.inlineKeyboard([
      [Markup.button.callback('🗑️ 删除工单', 'delete_ticket')]
    ]).extra
  );
});

// 按钮 4: 用户表
bot.command('users', (ctx) => {
  if (!isAdmin(ctx)) return;
  
  // 查询用户表（此处简化为示例，实际需连接用户库）
  ctx.replyWithMarkdownV2(
    `👥 *用户表* 👥\n\n` +
    `当前在线用户: 123人\n` +
    `（完整用户数据查询需对接业务系统）`
  );
});

// ======================
// /start 新春资源逻辑
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
  `.replace(/\n/g, ''); // 移除换行符适配Markdown

  ctx.replyWithMarkdownV2(
    welcomeMsg,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ 我已付款，开始验证', 'verify_payment')]
    ]).extra
  );
});

// /v 验证按钮（点击后触发）
bot.action('verify_payment', async (ctx) => {
  if (!isAdmin(ctx)) return;
  
  ctx.replyWithMarkdownV2(
    `📥 *请输入订单号* 📥\n\n` +
    `订单号格式示例: 20260123456789\n` +
    `（系统自动识别20260开头的有效订单号）`,
    Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ 返回 Admin', 'admin')]
    ]).extra
  );
  
  // 等待用户输入订单号
  ctx.session.waitingForOrderId = true;
});

bot.on('text', async (ctx) => {
  if (ctx.session.waitingForOrderId) {
    const orderId = ctx.message.text.trim();
    
    // 私密逻辑：检查订单号是否以20260开头（不暴露提示）
    if (/^20260\d*$/.test(orderId)) {
      try {
        // 生成 file_id 并存入数据库
        const fileId = await db.FILE_ID_TABLE.generateFileId();
        await db.query(
          `INSERT INTO ${FILE_ID_TABLE.TABLE_NAME} 
           (${FILE_ID_TABLE.COLUMNS.FILE_ID}, ${FILE_ID_TABLE.COLUMNS.ORDER_ID}, ${FILE_ID_TABLE.COLUMNS.USER_ID}, ${FILE_ID_TABLE.COLUMNS.USERNAME})
           VALUES (?, ?, ?, ?)`,
          [fileId, orderId, ctx.from.id, ctx.from.first_name]
        );
        
        // 发送工单给管理员
        const adminContext = await bot.telegram.sendMessage(
          ADMIN_CHAT_ID, 
          `🆕 *新工单* 🆕\n\n` +
          `用户: @${ctx.from.username} (${ctx.from.id})\n` +
          `订单号: ${orderId}\n` +
          `时间: ${new Date().toLocaleString('zh-CN')}\n\n` +
          `👉 [加入会员群](${VIP_GROUP_LINK})`,
          { parse_mode: 'MarkdownV2', disable_web_page_preview: true }
        );
        
        // 更新工单列表（此处简化，实际需写入工单表）
        ctx.replyWithMarkdownV2(
          `✅ *验证成功！* 文件已生成。\n\n` +
          `\`\`\`${fileId}\`\`\`\n\n` +
          `🔄 点击跳转回 Admin`,
          Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ 返回 Admin', 'admin')],
            [Markup.button.url('💎 加入会员群', VIP_GROUP_LINK)]
          ]).extra
        );
        
        ctx.session.waitingForOrderId = false;
      } catch (err) {
        ctx.reply("❌ 验证失败，请重试。");
        ctx.session.waitingForOrderId = false;
      }
    } else {
      // 失败处理：计数2次后返回首页
      ctx.session.orderIdAttempts = (ctx.session.orderIdAttempts || 0) + 1;
      if (ctx.session.orderIdAttempts >= 2) {
        ctx.replyWithMarkdownV2(
          `⚠️ *订单号验证失败次数过多* ⚠️\n\n` +
          `🔄 正在返回首页...`,
          Markup.inlineKeyboard([
            [Markup.button.start('🐉 返回首页', 'start')]
          ]).extra
        );
        ctx.session.orderIdAttempts = 0;
      } else {
        ctx.reply("❌ 无效订单号，请重新输入（以20260开头）");
      }
    }
  }
});

// ======================
// /dh 兑换逻辑（含频控）
// ======================
bot.command('dh', async (ctx) => {
  if (!await rateLimiter.check(ctx)) {
    const remaining = await rateLimiter.getRemainingTime(ctx);
    ctx.replyWithMarkdownV2(
      `⏳ *请稍等* ⏳\n` +
      `冷却剩余: ${remaining}秒\n\n` +
      `💎 [加入会员（新春特价）](${VIP_GROUP_LINK})`
    );
    return;
  }

  // 查询待上架关键词（从 p_buffer 表读取）
  const [keywords] = await db.query(
    `SELECT * FROM p_buffer ORDER BY created_at ASC LIMIT 10`
  );

  if (keywords.length === 0) {
    ctx.replyWithMarkdownV2(
      `📦 *暂无商品可兑换* 📦\n\n` +
      `💎 [加入会员（新春特价）](${VIP_GROUP_LINK})\n` +
      `ℹ️ 请等待管理员通过 /p 上架商品`
    );
  } else {
    // 分页显示关键词（10条/页）
    const page = ctx.query?.page ? parseInt(ctx.query.page) : 1;
    const start = (page - 1) * 10;
    const paginated = keywords.slice(start, start + 10);
    
    ctx.replyWithMarkdownV2(
      `🔗 *Deep Link 兑换* 🔗\n\n` +
      `📦 文件 (${start + 1}-${start + paginated.length}/共${keywords.length}条)\n` +
      `⏳ 发送中... (每10条为一组)`,
      Markup.inlineKeyboard([
        ...paginated.map(k => [
          Markup.button.callback(`📁 ${k.keyword}`, `dh_keyword_${k.id}`)
        ]),
        [
          Markup.button.callback('✨👉 请点击继续发送', `dh_page_${page + 1}`),
          Markup.button.callback('↩️ 返回兑换', 'dh')
        ]
      ]).extra
    );
  }
});

// /dh 分页点击事件
bot.action(/^dh_keyword_(\d+)$/, async (ctx) => {
  const keywordId = ctx.match[1];
  // 处理关键词点击（转发消息等）
  await ctx.telegram.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, ctx.message.message_id);
  ctx.replyWithMarkdownV2(
    `✅ *已发送关键词* ✅\n\n` +
    `📦 文件已转发至私密群\n\n` +
    `💎 [加入会员](${VIP_GROUP_LINK})`
  );
});

// /dh 分页继续发送
bot.action(/^dh_page_(\d+)$/, async (ctx) => {
  const nextPage = parseInt(ctx.match[1]);
  ctx.scene.leave(); // 退出当前场景（简化实现）
  await bot.handleCommand(ctx, '/dh'); // 重新进入 /dh 逻辑
});

// /p 商品添加逻辑
bot.command('p', (ctx) => {
  if (!isAdmin(ctx)) return;
  
  ctx.replyWithMarkdownV2(
    `🛒 *商品添加面板* 🛒\n\n` +
    `发送 /p 或点击 ➕ 上架新关键词\n` +
    `机器人将逐条记录内容（支持任意格式）`,
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ 上架新关键词', 'add_product_keyword')]
    ]).extra
  );
});

// 管理员输入关键词流程
bot.action('add_product_keyword', async (ctx) => {
  if (!isAdmin(ctx)) return;
  
  ctx.reply("🤖 机器人问：请输入关键词（例如 1）");
  ctx.session.waitingForKeyword = true;
});

bot.on('text', async (ctx) => {
  if (ctx.session.waitingForKeyword) {
    const keyword = ctx.message.text.trim();
    // 存入 p_buffer 表（待审核）
    await db.query(
      `INSERT INTO p_buffer (keyword, admin_id, created_at) VALUES (?, ?, NOW())`,
      [keyword, ctx.from.id]
    );
    ctx.reply("✅ 内容已记录！");
    
    // 始终保留完成按钮在底部
    ctx.replyWithMarkdownV2(
      `📦 *商品上架完成！* 📦\n\n` +
      `✅ [完成上架](${FILE_ID_TABLE.COLUMNS.ORDER_ID}) 按钮始终在底部`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ 完成上架', 'complete_product_upload')]
      ]).extra
    );
  }
});

// /c 和 /cz 管理员命令
bot.command('c', (ctx) => {
  if (!isAdmin(ctx)) return;
  ctx.session = {}; // 清空当前状态
  ctx.reply("🛑 管理员状态已取消");
});

bot.command('cz', (ctx) => {
  if (!isAdmin(ctx)) return;
  // 重置频控计数器
  await rateLimiter.resetForAdmin(ctx);
  ctx.reply("🔄 管理员频控已重置（视为新用户）");
});
