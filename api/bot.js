const { Telegraf } = require('telegraf');
const { query } = require('../lib/db');
const { 
  getBeijingTime, 
  formatDate,
  paginate,
  generatePaginationKeyboard 
} = require('../lib/utils');
const { checkDhFrequency } = require('../lib/frequencyControl');

// 初始化 Bot (Vercel 适配)
const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { apiRoot: 'https://api.telegram.org' }
});

// ======================
// 中间件：记录用户活动
// ======================
bot.use(async (ctx, next) => {
  const userId = ctx.from.id;
  const today = formatDate(getBeijingTime());
  
  // 更新用户最后活跃时间
  await query(
    `INSERT INTO users (user_id, username, first_name, last_name, first_seen_date, last_seen_date)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (user_id) DO UPDATE 
     SET last_seen_date = $5, 
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name`,
    [
      userId,
      ctx.from.username,
      ctx.from.first_name,
      ctx.from.last_name,
      today
    ]
  );
  
  // 管理员标记
  if (userId.toString() === process.env.ADMIN_ID) {
    ctx.isAdmin = true;
  }
  
  return next();
});

// ======================
// 命令处理器
// ======================

// /start 命令 - 新春活动
bot.start(async (ctx) => {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✨ 加入会员（新春特价）', callback_data: 'join_vip' }],
        [{ text: '🎁 兑换资源', callback_data: 'dh_command' }]
      ]
    }
  };

  await ctx.replyWithHTML(
    `🎉 <b>喜迎马年新春资源免费获取</b> 🎉\n\n` +
    `🔥 <b>VIP会员新春特价开启！</b>\n\n` +
    `💎 <b>VIP会员特权说明：</b>\n` +
    `✅ 专属中转通道\n` +
    `✅ 优先审核入群\n` +
    `✅ 7x24小时客服支持\n` +
    `✅ 定期福利活动\n\n` +
    `👉 点击下方按钮立即加入！`,
    keyboard
  );
});

// /v 命令 - 会员加入流程
bot.action('join_vip', async (ctx) => {
  await ctx.editMessageText(
    `💎 <b>VIP会员新春特价</b>\n\n` +
    `✅ 专属中转通道\n` +
    `✅ 优先审核入群\n` +
    `✅ 7x24小时客服支持\n` +
    `✅ 定期福利活动\n\n` +
    `📎 资源文件已准备就绪\n\n` +
    `✅ 请点击下方按钮完成验证`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ 我已付款，开始验证', callback_data: 'verify_payment' }]
        ]
      }
    }
  );
});

// 验证付款 - 请求订单号
bot.action('verify_payment', async (ctx) => {
  await ctx.editMessageText(
    `🔍 请输入您的订单号（20260开头）\n\n` +
    `💡 订单号可在支付凭证中找到\n` +
    `❗ 注意：仅限20260开头的订单号`,
    { reply_markup: { force_reply: true } }
  );
  
  // 设置管理员状态：等待订单号
  await query(
    `INSERT INTO admin_states (admin_id, state) 
     VALUES ($1, 'waiting_for_order') 
     ON CONFLICT (admin_id) DO UPDATE SET state = 'waiting_for_order'`,
    [ctx.from.id]
  );
});

// 处理订单号输入
bot.on('text', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  
  // 检查是否在等待订单号状态
  const state = await query(
    'SELECT state FROM admin_states WHERE admin_id = $1',
    [ctx.from.id]
  );
  
  if (state.rows[0]?.state === 'waiting_for_order') {
    const orderId = ctx.message.text.trim();
    
    // 验证订单号格式 (20260开头)
    if (!/^20260\d+$/.test(orderId)) {
      await ctx.reply('❌ 订单号必须以20260开头，请重新输入');
      return;
    }
    
    // 检查订单是否存在
    const order = await query(
      'SELECT * FROM orders WHERE order_id = $1',
      [orderId]
    );
    
    if (order.rows.length === 0) {
      // 首次输入错误
      if (!ctx.session.orderAttempts) ctx.session.orderAttempts = 0;
      ctx.session.orderAttempts++;
      
      if (ctx.session.orderAttempts >= 2) {
        await ctx.reply('❌ 两次验证失败，已退回首页');
        await ctx.replyWithHTML(
          `🎉 <b>喜迎马年新春资源免费获取</b> 🎉\n\n` +
          `🔥 <b>VIP会员新春特价开启！</b>`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✨ 加入会员（新春特价）', callback_data: 'join_vip' }],
                [{ text: '🎁 兑换资源', callback_data: 'dh_command' }]
              ]
            }
          }
        );
        await query('DELETE FROM admin_states WHERE admin_id = $1', [ctx.from.id]);
        return;
      }
      
      await ctx.reply(`❌ 订单号无效！请重试 (${2 - ctx.session.orderAttempts} 次机会)`);
      return;
    }
    
    // 验证成功
    await query(
      `UPDATE orders SET status = 'verified', verified_at = NOW() 
       WHERE order_id = $1`,
      [orderId]
    );
    
    // 创建工单通知管理员
    await query(
      `INSERT INTO tickets (user_id, order_id, message) 
       VALUES ($1, $2, '新会员验证成功')`,
      [ctx.from.id, orderId]
    );
    
    // 发送成功消息
    await ctx.replyWithHTML(
      `✅ <b>验证成功！</b>\n\n` +
      `🎁 您已获得 VIP 会员权限\n` +
      `👉 点击加入会员群：`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 加入会员群', url: 'https://t.me/+495j5rWmApsxYzg9' }]
          ]
        }
      }
    );
    
    // 清理状态
    await query('DELETE FROM admin_states WHERE admin_id = $1', [ctx.from.id]);
  }
});

// /dh 命令 - 资源兑换
bot.command('dh', async (ctx) => {
  const result = await checkDhFrequency(ctx.from.id);
  
  if (!result.allowed) {
    await ctx.replyWithHTML(result.message, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💎 加入会员（新春特价）', url: 'https://t.me/+495j5rWmApsxYzg9' }],
          [{ text: '↩️ 返回兑换', callback_data: 'dh_command' }]
        ]
      }
    });
    return;
  }
  
  // 获取活跃商品
  const products = await query(
    'SELECT * FROM products WHERE is_active = true ORDER BY created_at ASC'
  );
  
  if (products.rows.length === 0) {
    await ctx.reply('⏳ 请等待管理员上架资源');
    return;
  }
  
  // 分页显示商品
  const page = parseInt(ctx.match?.[1] || '1');
  const { items, totalPages } = paginate(products.rows, page, 10);
  
  const keyboard = items.map(p => [
    { text: `📦 ${p.keyword}`, callback_data: `product_${p.id}` }
  ]);
  
  if (totalPages > 1) {
    keyboard.push(
      generatePaginationKeyboard(page, totalPages, 'dh').reply_markup.inline_keyboard[0]
    );
  }
  
  await ctx.reply(`📄 第 ${page}/${totalPages} 页\n请选择要兑换的资源：`, {
    reply_markup: { inline_keyboard: keyboard }
  });
});

// 商品详情处理
bot.action(/^product_(\d+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const product = await query('SELECT * FROM products WHERE id = $1', [productId]);
  
  if (!product.rows[0]) {
    await ctx.answerCbQuery('资源不存在');
    return;
  }
  
  // 分割内容为多组 (每10条一组)
  const contents = product.rows[0].content.split('\n');
  const totalPages = Math.ceil(contents.length / 10);
  
  const sendContentGroup = async (page = 1) => {
    const start = (page - 1) * 10;
    const group = contents.slice(start, start + 10);
    
    let message = `📦 资源: ${product.rows[0].keyword}\n`;
    message += `📄 ${page}/${totalPages}\n\n`;
    
    group.forEach((item, i) => {
      message += `${start + i + 1}. ${item}\n`;
    });
    
    if (page < totalPages) {
      await ctx.editMessageText(message, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✨👉 请点击继续发送', callback_data: `continue_${productId}_${page + 1}` }]
          ]
        }
      });
    } else {
      await ctx.editMessageText(message + 
        `\n✅ 文件发送完毕（全部组已完成）\n` +
        `💎 加入会员（新春特价）\n` +
        `↩️ 返回兑换`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💎 加入会员', url: 'https://t.me/+495j5rWmApsxYzg9' }],
            [{ text: '↩️ 返回兑换', callback_data: 'dh_command' }]
          ]
        }
      });
    }
  };
  
  // 首次发送第一组
  await sendContentGroup(1);
  
  // 处理继续发送
  bot.action(/^continue_(\d+)_(\d+)$/, async (ctx) => {
    await sendContentGroup(parseInt(ctx.match[2]));
    await ctx.answerCbQuery();
  });
});

// ======================
// 管理员专属功能
// ======================

// 管理员入口 (/admin 命令)
bot.command('admin', async (ctx) => {
  if (!ctx.isAdmin) {
    await ctx.reply('⚠️ 仅限管理员访问');
    return;
  }
  
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🆔 获取 file id', callback_data: 'admin_get_fileid' }],
        [{ text: '➕ 商品添加 (/p)', callback_data: 'admin_add_product' }],
        [{ text: '📋 工单系统', callback_data: 'admin_tickets' }],
        [{ text: '👥 用户表', callback_data: 'admin_users' }]
      ]
    }
  };
  
  await ctx.reply('👑 管理员控制台', keyboard);
});

// 获取 file id 功能
bot.action('admin_get_fileid', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  await ctx.editMessageText('📎 请发送图片以获取 file id');
  await query(
    `INSERT INTO admin_states (admin_id, state) 
     VALUES ($1, 'waiting_for_image') 
     ON CONFLICT (admin_id) DO UPDATE SET state = 'waiting_for_image'`,
    [ctx.from.id]
  );
});

// 处理图片获取 file id
bot.on('photo', async (ctx) => {
  const state = await query(
    'SELECT state FROM admin_states WHERE admin_id = $1',
    [ctx.from.id]
  );
  
  if (state.rows[0]?.state === 'waiting_for_image') {
    const fileId = ctx.message.photo.pop().file_id;
    await ctx.reply(`✅ 获取成功!\nFile ID: \`${fileId}\``, { parse_mode: 'Markdown' });
    
    // 这里可将 fileId 存储到数据库 (根据您的需求扩展)
    await query('UPDATE products SET file_id = $1 WHERE ...', [fileId]); 
    
    await query('DELETE FROM admin_states WHERE admin_id = $1', [ctx.from.id]);
    await ctx.reply('✅ 已保存，返回管理员菜单', {
      reply_markup: {
        inline_keyboard: [[{ text: '↩️ 返回管理员菜单', callback_data: 'admin_menu' }]]
      }
    });
  }
});

// 商品添加流程 (/p 命令)
bot.action('admin_add_product', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  await ctx.editMessageText('➕ 上架新关键词\n\n请输入关键词 (例如: 1)');
  await query(
    `INSERT INTO admin_states (admin_id, state, data) 
     VALUES ($1, 'waiting_for_keyword', '{"step": 1}') 
     ON CONFLICT (admin_id) DO UPDATE 
     SET state = 'waiting_for_keyword', data = '{"step": 1}'`,
    [ctx.from.id]
  );
});

// 处理关键词输入
bot.on('text', async (ctx) => {
  const state = await query(
    'SELECT state, data FROM admin_states WHERE admin_id = $1',
    [ctx.from.id]
  );
  
  if (!state.rows[0]) return;
  
  const currentState = state.rows[0].state;
  const data = JSON.parse(state.rows[0].data || '{}');
  
  // 商品添加流程
  if (currentState === 'waiting_for_keyword' && data.step === 1) {
    await query(
      `UPDATE admin_states 
       SET data = $1 
       WHERE admin_id = $2`,
      [JSON.stringify({ ...data, keyword: ctx.message.text, step: 2 }), ctx.from.id]
    );
    
    await ctx.reply('✅ 关键词已记录\n\n请输入内容 (支持任意格式，逐条记录)\n\n' +
                   '💡 发送多条内容会自动累积，完成后点击「✅ 完成上架」');
  } 
  else if (currentState === 'waiting_for_keyword' && data.step === 2) {
    // 累积内容到 buffer
    const newBuffer = [...(data.buffer || []), ctx.message.text];
    await query(
      `UPDATE admin_states 
       SET data = $1 
       WHERE admin_id = $2`,
      [JSON.stringify({ ...data, buffer: newBuffer }), ctx.from.id]
    );
    
    await ctx.reply(`📝 已记录第 ${newBuffer.length} 条内容\n\n继续发送下一条或点击下方按钮完成`);
  }
});

// 完成商品上架
bot.action('complete_product', async (ctx) => {
  const state = await query(
    'SELECT data FROM admin_states WHERE admin_id = $1',
    [ctx.from.id]
  );
  
  if (!state.rows[0]) return;
  
  const data = JSON.parse(state.rows[0].data);
  if (data.step !== 2) return;
  
  // 保存到数据库
  await query(
    `INSERT INTO products (keyword, content) 
     VALUES ($1, $2)`,
    [data.keyword, data.buffer.join('\n')]
  );
  
  await ctx.editMessageText(
    `✅ 商品 "${data.keyword}" 已成功上架!\n\n` +
    `📝 内容预览:\n${data.buffer.slice(0, 3).join('\n')}...`,
    { reply_markup: { inline_keyboard: [[{ text: '↩️ 返回管理员菜单', callback_data: 'admin_menu' }]] } }
  );
  
  await query('DELETE FROM admin_states WHERE admin_id = $1', [ctx.from.id]);
});

// 工单系统
bot.action('admin_tickets', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const tickets = await query(
    `SELECT t.*, u.username 
     FROM tickets t
     JOIN users u ON t.user_id = u.user_id
     WHERE t.status = 'open'
     ORDER BY t.created_at ASC
     LIMIT 10`
  );
  
  const keyboard = tickets.rows.map(t => [
    { text: `@${t.username} (${t.order_id})`, callback_data: `ticket_${t.ticket_id}` }
  ]);
  
  if (tickets.rows.length === 0) {
    await ctx.editMessageText('📭 当前无待处理工单');
  } else {
    await ctx.editMessageText('📋 待处理工单:', {
      reply_markup: { inline_keyboard: keyboard }
    });
  }
});

// 工单详情 & 删除
bot.action(/^ticket_(\d+)$/, async (ctx) => {
  const ticketId = ctx.match[1];
  const ticket = await query(
    `SELECT t.*, u.username, u.user_id 
     FROM tickets t
     JOIN users u ON t.user_id = u.user_id
     WHERE t.ticket_id = $1`,
    [ticketId]
  );
  
  if (!ticket.rows[0]) return;
  
  const t = ticket.rows[0];
  const beijingTime = getBeijingTime();
  
  await ctx.editMessageText(
    `👤 用户: @${t.username} (ID: ${t.user_id})\n` +
    `📝 订单号: ${t.order_id}\n` +
    `🕒 提交时间: ${formatDate(new Date(t.created_at))} ${beijingTime.getHours()}:${beijingTime.getMinutes()}\n\n` +
    `💬 内容: ${t.message}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗑️ 删除工单', callback_data: `delete_ticket_${ticketId}` }]
        ]
      }
    }
  );
});

// 删除工单确认
bot.action(/^delete_ticket_(\d+)$/, async (ctx) => {
  const ticketId = ctx.match[1];
  const ticket = await query('SELECT * FROM tickets WHERE ticket_id = $1', [ticketId]);
  
  if (!ticket.rows[0]) return;
  
  await ctx.editMessageText(
    `⚠️ 确认删除工单?\n\n` +
    `👤 用户: @${ticket.rows[0].username} (ID: ${ticket.rows[0].user_id})\n` +
    `📝 订单号: ${ticket.rows[0].order_id}\n` +
    `🕒 时间: ${formatDate(new Date(ticket.rows[0].created_at))} ${getBeijingTime().getHours()}:${getBeijingTime().getMinutes()}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ 确认删除', callback_data: `confirm_delete_${ticketId}` }],
          [{ text: '❌ 取消', callback_data: 'admin_tickets' }]
        ]
      }
    }
  );
});

// 执行删除
bot.action(/^confirm_delete_(\d+)$/, async (ctx) => {
  await query('DELETE FROM tickets WHERE ticket_id = $1', [ctx.match[1]]);
  await ctx.editMessageText('✅ 工单已删除');
  setTimeout(() => ctx.editMessageText('📋 工单列表', {
    reply_markup: { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'admin_tickets' }]] }
  }), 1000);
});

// ======================
// 管理员工具命令
// ======================

// /c - 取消当前操作
bot.command('c', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  await query('DELETE FROM admin_states WHERE admin_id = $1', [ctx.from.id]);
  await ctx.reply('✅ 已取消当前操作');
});

// /cz - 重置管理员状态
bot.command('cz', async (ctx) => {
  if (!ctx.isAdmin) return;
  
  const today = formatDate(getBeijingTime());
  await query(
    `UPDATE dh_usage 
     SET success_count = 0, total_attempts = 0, cooling_until = NULL, failure_count = 0 
     WHERE user_id = $1 AND date_key = $2`,
    [ctx.from.id, today]
  );
  
  await ctx.reply('✅ 已重置管理员状态\n💡 现在您有 3 次免费兑换机会 (新用户状态)');
});

// ======================
// Vercel 部署适配
// ======================
module.exports = async (req, res) => {
  await bot.handleUpdate(req.body);
  res.status(200).end();
};

// Webhook 设置 (Vercel 部署时使用)
if (process.env.NODE_ENV === 'production') {
  bot.launch({
    webhook: {
      domain: process.env.VERCEL_URL,
      port: process.env.PORT
    }
  });
}
