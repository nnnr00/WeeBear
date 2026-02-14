// api/webhook.js
// ============== 配置区 ==============
const BOT_TOKEN = process.env.YOUR_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));

// ============== FILE IDS 配置 ==============
const FILE_IDS = {
  VIP_PROMO: 'YOUR_VIP_PROMO_FILE_ID_HERE',
  PAYMENT_TUTORIAL: 'YOUR_PAYMENT_TUTORIAL_FILE_ID_HERE',
  WELCOME_IMAGE: 'YOUR_WELCOME_IMAGE_FILE_ID_HERE'
};

const VIP_GROUP_LINK = 'https://t.me/+495j5rWmApsxYzg9';

// ============== 数据库 ==============
const { sql } = require('@vercel/postgres');

async function initDB() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        user_id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        first_name VARCHAR(255),
        first_seen_date VARCHAR(20),
        last_seen_date VARCHAR(20),
        daily_count INT DEFAULT 0,
        cooldown_index INT DEFAULT 0,
        last_redeem_time BIGINT DEFAULT 0,
        date_key VARCHAR(20),
        is_disabled BOOLEAN DEFAULT FALSE
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        username VARCHAR(255),
        first_name VARCHAR(255),
        order_number VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        keyword VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS product_contents (
        id SERIAL PRIMARY KEY,
        product_id INT REFERENCES products(id) ON DELETE CASCADE,
        content_type VARCHAR(50),
        content TEXT,
        file_id VARCHAR(255),
        sort_order INT DEFAULT 0
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS user_states (
        user_id BIGINT PRIMARY KEY,
        state VARCHAR(100),
        data TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
  } catch (e) {
    console.error('DB Init Error:', e);
  }
}

// ============== 工具函数 ==============
function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

function getBeijingTime() {
  const now = new Date();
  const beijingOffset = 8 * 60 * 60 * 1000;
  return new Date(now.getTime() + beijingOffset);
}

function getBeijingDateKey() {
  const bj = getBeijingTime();
  return `${bj.getFullYear()}-${String(bj.getMonth() + 1).padStart(2, '0')}-${String(bj.getDate()).padStart(2, '0')}`;
}

function formatBeijingTime(date) {
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return bj.toISOString().replace('T', ' ').substring(0, 19);
}

async function sendTelegram(method, params) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return res.json();
}

async function setState(userId, state, data = {}) {
  await sql`
    INSERT INTO user_states (user_id, state, data, updated_at)
    VALUES (${userId}, ${state}, ${JSON.stringify(data)}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET state = ${state}, data = ${JSON.stringify(data)}, updated_at = NOW()
  `;
}

async function getState(userId) {
  const result = await sql`SELECT state, data FROM user_states WHERE user_id = ${userId}`;
  if (result.rows.length > 0) {
    return { state: result.rows[0].state, data: JSON.parse(result.rows[0].data || '{}') };
  }
  return { state: null, data: {} };
}

async function clearState(userId) {
  await sql`DELETE FROM user_states WHERE user_id = ${userId}`;
}

async function getOrCreateUser(userId, username, firstName) {
  const dateKey = getBeijingDateKey();
  const result = await sql`SELECT * FROM users WHERE user_id = ${userId}`;
  
  if (result.rows.length === 0) {
    await sql`
      INSERT INTO users (user_id, username, first_name, first_seen_date, last_seen_date, date_key, daily_count, cooldown_index)
      VALUES (${userId}, ${username || ''}, ${firstName || ''}, ${dateKey}, ${dateKey}, ${dateKey}, 0, 0)
    `;
    return { isNew: true, dateKey, dailyCount: 0, cooldownIndex: 0 };
  }
  
  const user = result.rows[0];
  if (user.date_key !== dateKey) {
    await sql`
      UPDATE users SET date_key = ${dateKey}, daily_count = 0, cooldown_index = 0, last_seen_date = ${dateKey}
      WHERE user_id = ${userId}
    `;
    return { isNew: user.first_seen_date === dateKey, dateKey, dailyCount: 0, cooldownIndex: 0 };
  }
  
  await sql`UPDATE users SET last_seen_date = ${dateKey}, username = ${username || ''}, first_name = ${firstName || ''} WHERE user_id = ${userId}`;
  return { 
    isNew: user.first_seen_date === dateKey, 
    dateKey, 
    dailyCount: user.daily_count, 
    cooldownIndex: user.cooldown_index,
    lastRedeemTime: user.last_redeem_time
  };
}

// ============== 主处理器 ==============
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  await initDB();
  
  const update = req.body;
  
  try {
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch (e) {
    console.error('Handler Error:', e);
  }
  
  res.status(200).send('OK');
};

// ============== 消息处理 ==============
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;
  const firstName = msg.from.first_name;
  const text = msg.text || '';

  // 检查用户状态
  const userState = await getState(userId);
  
  // 管理员命令
  if (text === '/admin' && isAdmin(userId)) {
    return showAdminPanel(chatId);
  }
  
  if (text === '/c' && isAdmin(userId)) {
    await clearState(userId);
    return sendTelegram('sendMessage', { chat_id: chatId, text: '✅ 已取消当前操作' });
  }
  
  if (text === '/cz' && isAdmin(userId)) {
    const dateKey = getBeijingDateKey();
    await sql`
      UPDATE users SET daily_count = 0, cooldown_index = 0, last_redeem_time = 0, first_seen_date = ${dateKey}, date_key = ${dateKey}
      WHERE user_id = ${userId}
    `;
    await clearState(userId);
    return sendTelegram('sendMessage', { chat_id: chatId, text: '✅ 已重置为新用户状态（当天免费3次）' });
  }
  
  if (text === '/p' && isAdmin(userId)) {
    return showProductManagement(chatId);
  }
  
  // 普通命令
  if (text === '/start' || text === '/start ') {
    await getOrCreateUser(userId, username, firstName);
    return showWelcome(chatId);
  }
  
  if (text === '/start dh' || text === '/dh') {
    return showRedeem(chatId, userId, username, firstName);
  }
  
  if (text === '/v') {
    return showVIP(chatId);
  }
  
  // 处理状态机
  if (userState.state) {
    return handleStateInput(chatId, userId, username, firstName, msg, userState);
  }
}

// ============== 状态处理 ==============
async function handleStateInput(chatId, userId, username, firstName, msg, userState) {
  const text = msg.text || '';
  const { state, data } = userState;
  
  // 管理员：获取File ID
  if (state === 'waiting_file_id' && isAdmin(userId)) {
    let fileId = null;
    if (msg.photo) fileId = msg.photo[msg.photo.length - 1].file_id;
    else if (msg.document) fileId = msg.document.file_id;
    else if (msg.video) fileId = msg.video.file_id;
    else if (msg.audio) fileId = msg.audio.file_id;
    else if (msg.voice) fileId = msg.voice.file_id;
    else if (msg.sticker) fileId = msg.sticker.file_id;
    
    if (fileId) {
      await clearState(userId);
      await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: `📎 File ID:\n\`${fileId}\``,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '↩️ 返回管理面板', callback_data: 'admin' }]] }
      });
    } else {
      await sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 请发送图片、文件、视频等媒体内容' });
    }
    return;
  }
  
  // 管理员：输入关键词
  if (state === 'waiting_keyword' && isAdmin(userId)) {
    const keyword = text.trim();
    if (!keyword) {
      return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 关键词不能为空' });
    }
    
    const existing = await sql`SELECT id FROM products WHERE keyword = ${keyword}`;
    if (existing.rows.length > 0) {
      return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 该关键词已存在' });
    }
    
    const result = await sql`INSERT INTO products (keyword) VALUES (${keyword}) RETURNING id`;
    await setState(userId, 'waiting_product_content', { productId: result.rows[0].id, keyword });
    
    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ 关键词「${keyword}」已创建\n\n📝 请发送内容（支持任意格式，逐条记录）\n完成后点击下方按钮`,
      reply_markup: { inline_keyboard: [[{ text: '✅ 完成上架', callback_data: `finish_product_${result.rows[0].id}` }]] }
    });
  }
  
  // 管理员：添加商品内容
  if (state === 'waiting_product_content' && isAdmin(userId)) {
    const { productId } = data;
    let contentType = 'text';
    let content = text;
    let fileId = null;
    
    if (msg.photo) {
      contentType = 'photo';
      fileId = msg.photo[msg.photo.length - 1].file_id;
      content = msg.caption || '';
    } else if (msg.document) {
      contentType = 'document';
      fileId = msg.document.file_id;
      content = msg.caption || '';
    } else if (msg.video) {
      contentType = 'video';
      fileId = msg.video.file_id;
      content = msg.caption || '';
    } else if (msg.audio) {
      contentType = 'audio';
      fileId = msg.audio.file_id;
      content = msg.caption || '';
    } else if (msg.forward_date) {
      contentType = 'forward';
      content = text;
    }
    
    const countResult = await sql`SELECT COUNT(*) as cnt FROM product_contents WHERE product_id = ${productId}`;
    const sortOrder = parseInt(countResult.rows[0].cnt) + 1;
    
    await sql`
      INSERT INTO product_contents (product_id, content_type, content, file_id, sort_order)
      VALUES (${productId}, ${contentType}, ${content || ''}, ${fileId}, ${sortOrder})
    `;
    
    await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ 已添加第 ${sortOrder} 条内容\n\n继续发送或点击完成`,
      reply_markup: { inline_keyboard: [[{ text: '✅ 完成上架', callback_data: `finish_product_${productId}` }]] }
    });
    return;
  }
  
  // 用户：输入订单号
  if (state === 'waiting_order') {
    const orderNumber = text.trim();
    const failCount = data.failCount || 0;
    
    // 私密逻辑：检查是否以20260开头
    if (orderNumber.startsWith('20260')) {
      // 创建工单
      await sql`
        INSERT INTO tickets (user_id, username, first_name, order_number)
        VALUES (${userId}, ${username || ''}, ${firstName || ''}, ${orderNumber})
      `;
      
      // 通知管理员
      for (const adminId of ADMIN_IDS) {
        await sendTelegram('sendMessage', {
          chat_id: adminId,
          text: `🎫 新工单\n\n👤 用户：${firstName || '未知'}\n🆔 ID：${userId}\n📝 订单号：${orderNumber}\n⏰ 时间：${formatBeijingTime(new Date())}`
        });
      }
      
      await clearState(userId);
      return sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '✅ 验证成功！欢迎加入VIP会员',
        reply_markup: { inline_keyboard: [[{ text: '🎉 加入会员群', url: VIP_GROUP_LINK }]] }
      });
    } else {
      if (failCount >= 1) {
        await clearState(userId);
        await sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 订单号验证失败，请重新开始' });
        return showWelcome(chatId);
      } else {
        await setState(userId, 'waiting_order', { failCount: failCount + 1 });
        return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 订单号格式不正确，请重新输入' });
      }
    }
  }
}

// ============== 回调处理 ==============
async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const username = query.from.username;
  const firstName = query.from.first_name;
  const data = query.data;
  const messageId = query.message.message_id;
  
  await sendTelegram('answerCallbackQuery', { callback_query_id: query.id });
  
  // 管理员面板
  if (data === 'admin' && isAdmin(userId)) {
    return showAdminPanel(chatId, messageId);
  }
  
  // File ID 获取
  if (data === 'get_file_id' && isAdmin(userId)) {
    await setState(userId, 'waiting_file_id');
    return sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '📷 请发送图片或文件，我将返回 File ID',
      reply_markup: { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'admin' }]] }
    });
  }
  
  // 商品管理
  if (data === 'product_manage' && isAdmin(userId)) {
    return showProductManagement(chatId, messageId);
  }
  
  if (data === 'add_product' && isAdmin(userId)) {
    await setState(userId, 'waiting_keyword');
    return sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '📝 请输入关键词：',
      reply_markup: { inline_keyboard: [[{ text: '↩️ 取消', callback_data: 'product_manage' }]] }
    });
  }
  
  if (data.startsWith('finish_product_') && isAdmin(userId)) {
    const productId = parseInt(data.replace('finish_product_', ''));
    await clearState(userId);
    return sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '✅ 商品上架完成！',
      reply_markup: { inline_keyboard: [[{ text: '↩️ 返回商品管理', callback_data: 'product_manage' }]] }
    });
  }
  
  if (data.startsWith('del_product_confirm_') && isAdmin(userId)) {
    const productId = parseInt(data.replace('del_product_confirm_', ''));
    return sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '⚠️ 确定要删除此商品吗？',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ 确认删除', callback_data: `del_product_${productId}` }],
          [{ text: '↩️ 取消', callback_data: 'product_manage' }]
        ]
      }
    });
  }
  
  if (data.startsWith('del_product_') && !data.includes('confirm') && isAdmin(userId)) {
    const productId = parseInt(data.replace('del_product_', ''));
    await sql`DELETE FROM products WHERE id = ${productId}`;
    return showProductManagement(chatId, messageId);
  }
  
  // 工单管理
  if (data === 'ticket_manage' && isAdmin(userId)) {
    return showTickets(chatId, messageId, 1);
  }
  
  if (data.startsWith('tickets_page_') && isAdmin(userId)) {
    const page = parseInt(data.replace('tickets_page_', ''));
    return showTickets(chatId, messageId, page);
  }
  
  if (data.startsWith('del_ticket_') && isAdmin(userId)) {
    const ticketId = parseInt(data.replace('del_ticket_', ''));
    await sql`DELETE FROM tickets WHERE id = ${ticketId}`;
    return showTickets(chatId, messageId, 1);
  }
  
  // 用户管理
  if (data === 'user_manage' && isAdmin(userId)) {
    return showUsers(chatId, messageId, 1);
  }
  
  if (data.startsWith('users_page_') && isAdmin(userId)) {
    const page = parseInt(data.replace('users_page_', ''));
    return showUsers(chatId, messageId, page);
  }
  
  if (data.startsWith('user_detail_') && isAdmin(userId)) {
    const targetUserId = parseInt(data.replace('user_detail_', ''));
    return showUserDetail(chatId, messageId, targetUserId);
  }
  
  if (data.startsWith('toggle_user_') && isAdmin(userId)) {
    const targetUserId = parseInt(data.replace('toggle_user_', ''));
    await sql`UPDATE users SET is_disabled = NOT is_disabled WHERE user_id = ${targetUserId}`;
    return showUserDetail(chatId, messageId, targetUserId);
  }
  
  // 用户功能
  if (data === 'join_vip') {
    return showVIP(chatId, messageId);
  }
  
  if (data === 'redeem') {
    return showRedeem(chatId, userId, username, firstName, messageId);
  }
  
  if (data === 'verify_payment') {
    if (FILE_IDS.PAYMENT_TUTORIAL && FILE_IDS.PAYMENT_TUTORIAL !== 'YOUR_PAYMENT_TUTORIAL_FILE_ID_HERE') {
      await sendTelegram('sendPhoto', { chat_id: chatId, photo: FILE_IDS.PAYMENT_TUTORIAL });
    }
    
    await setState(userId, 'waiting_order', { failCount: 0 });
    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: '📋 查找订单号步骤：\n\n1️⃣ 打开支付应用\n2️⃣ 进入「我的」\n3️⃣ 点击「账单」\n4️⃣ 找到对应交易\n5️⃣ 点击「账单详情」\n6️⃣ 点击「更多」\n7️⃣ 复制「订单号」\n\n请输入您的订单号：',
      reply_markup: { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'join_vip' }]] }
    });
  }
  
  if (data === 'back_start') {
    await clearState(userId);
    return showWelcome(chatId, messageId);
  }
  
  // 兑换商品
  if (data.startsWith('redeem_')) {
    const keyword = data.replace('redeem_', '');
    return handleRedeemProduct(chatId, userId, username, firstName, keyword, messageId);
  }
  
  if (data.startsWith('redeem_continue_')) {
    const parts = data.replace('redeem_continue_', '').split('_');
    const keyword = parts[0];
    const page = parseInt(parts[1]);
    return sendProductContents(chatId, keyword, page);
  }
  
  if (data === 'back_redeem') {
    return showRedeem(chatId, userId, username, firstName, messageId);
  }

  // 商品分页
  if (data.startsWith('products_page_')) {
    const page = parseInt(data.replace('products_page_', ''));
    return showProductManagement(chatId, messageId, page);
  }

  // 兑换分页
  if (data.startsWith('dh_page_')) {
    const page = parseInt(data.replace('dh_page_', ''));
    return showRedeemPage(chatId, messageId, page);
  }
}

// ============== 页面显示函数 ==============
async function showWelcome(chatId, messageId = null) {
  const text = `🎊 喜迎马年新春 🐴\n\n🧧 新春资源免费获取 🧧\n\n✨ 限时福利等你来拿 ✨`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
      [{ text: '🎁 兑换', callback_data: 'redeem' }]
    ]
  };
  
  if (messageId) {
    return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
  }
  
  if (FILE_IDS.WELCOME_IMAGE && FILE_IDS.WELCOME_IMAGE !== 'YOUR_WELCOME_IMAGE_FILE_ID_HERE') {
    return sendTelegram('sendPhoto', { chat_id: chatId, photo: FILE_IDS.WELCOME_IMAGE, caption: text, reply_markup: keyboard });
  }
  return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
}

async function showVIP(chatId, messageId = null) {
  const text = `🎊 喜迎新春（特价）\n\n💎 VIP会员特权说明：\n\n✅ 专属中转通道\n✅ 优先审核入群\n✅ 7x24小时客服支持\n✅ 定期福利活动`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '✅ 我已付款，开始验证', callback_data: 'verify_payment' }],
      [{ text: '↩️ 返回', callback_data: 'back_start' }]
    ]
  };
  
  if (FILE_IDS.VIP_PROMO && FILE_IDS.VIP_PROMO !== 'YOUR_VIP_PROMO_FILE_ID_HERE') {
    if (messageId) {
      await sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
    }
    return sendTelegram('sendPhoto', { chat_id: chatId, photo: FILE_IDS.VIP_PROMO, caption: text, reply_markup: keyboard });
  }
  
  if (messageId) {
    return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
  }
  return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
}

async function showRedeem(chatId, userId, username, firstName, messageId = null) {
  const user = await getOrCreateUser(userId, username, firstName);
  const { isNew, dailyCount, cooldownIndex, lastRedeemTime } = user;
  
  const freeLimit = isNew ? 3 : 2;
  const cooldowns = [5, 15, 30, 50, 60, 60];
  const maxDaily = 6;
  
  // 检查是否超过每日上限
  if (dailyCount >= maxDaily) {
    const text = `⏰ 今日兑换次数已用完\n\n明天再来吧！`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
        [{ text: '↩️ 返回', callback_data: 'back_start' }]
      ]
    };
    if (messageId) {
      return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
    }
    return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
  }
  
  // 检查是否在免费次数内
  if (dailyCount < freeLimit) {
    return showRedeemPage(chatId, messageId, 1);
  }
  
  // 检查冷却
  const now = Date.now();
  const cdIndex = Math.min(cooldownIndex, cooldowns.length - 1);
  const cdTime = cooldowns[cdIndex] * 60 * 1000;
  const elapsed = now - (lastRedeemTime || 0);
  
  if (elapsed < cdTime) {
    const remaining = Math.ceil((cdTime - elapsed) / 1000);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const text = `⏰ 冷却中...\n\n剩余时间：${mins}分${secs}秒\n\n升级VIP免等待！`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
        [{ text: '↩️ 返回', callback_data: 'back_start' }]
      ]
    };
    if (messageId) {
      return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
    }
    return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
  }
  
  return showRedeemPage(chatId, messageId, 1);
}

async function showRedeemPage(chatId, messageId = null, page = 1) {
  const products = await sql`SELECT * FROM products ORDER BY created_at ASC`;
  
  if (products.rows.length === 0) {
    const text = `🎁 兑换中心\n\n⏳ 请等待管理员上架商品...`;
    const keyboard = { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'back_start' }]] };
    if (messageId) {
      return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
    }
    return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
  }
  
  const pageSize = 10;
  const totalPages = Math.ceil(products.rows.length / pageSize);
  const start = (page - 1) * pageSize;
  const pageProducts = products.rows.slice(start, start + pageSize);
  
  const buttons = pageProducts.map(p => [{ text: p.keyword, callback_data: `redeem_${p.keyword}` }]);
  
  const navButtons = [];
  if (page > 1) navButtons.push({ text: '⬅️', callback_data: `dh_page_${page - 1}` });
  if (page < totalPages) navButtons.push({ text: '➡️', callback_data: `dh_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);
  buttons.push([{ text: '↩️ 返回', callback_data: 'back_start' }]);
  
  const text = `🎁 兑换中心\n\n📄 ${page}/${totalPages}\n\n请选择：`;
  
  if (messageId) {
    return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: buttons } });
  }
  return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: buttons } });
}

async function handleRedeemProduct(chatId, userId, username, firstName, keyword, messageId) {
  const user = await getOrCreateUser(userId, username, firstName);
  const isNew = user.isNew;
  const freeLimit = isNew ? 3 : 2;
  
  // 更新使用次数
  await sql`
    UPDATE users SET 
      daily_count = daily_count + 1,
      cooldown_index = CASE WHEN daily_count >= ${freeLimit - 1} THEN cooldown_index + 1 ELSE cooldown_index END,
      last_redeem_time = ${Date.now()}
    WHERE user_id = ${userId}
  `;
  
  if (messageId) {
    await sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
  }
  
  return sendProductContents(chatId, keyword, 1);
}

async function sendProductContents(chatId, keyword, page) {
  const product = await sql`SELECT id FROM products WHERE keyword = ${keyword}`;
  if (product.rows.length === 0) {
    return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 商品不存在' });
  }
  
  const productId = product.rows[0].id;
  const contents = await sql`SELECT * FROM product_contents WHERE product_id = ${productId} ORDER BY sort_order ASC`;
  
  if (contents.rows.length === 0) {
    return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 暂无内容' });
  }
  
  const pageSize = 10;
  const totalPages = Math.ceil(contents.rows.length / pageSize);
  const start = (page - 1) * pageSize;
  const pageContents = contents.rows.slice(start, start + pageSize);
  
  for (let i = 0; i < pageContents.length; i++) {
    const c = pageContents[i];
    const index = start + i + 1;
    const caption = `📦 文件 ${index}/${contents.rows.length}`;
    
    if (c.content_type === 'photo' && c.file_id) {
      await sendTelegram('sendPhoto', { chat_id: chatId, photo: c.file_id, caption });
    } else if (c.content_type === 'document' && c.file_id) {
      await sendTelegram('sendDocument', { chat_id: chatId, document: c.file_id, caption });
    } else if (c.content_type === 'video' && c.file_id) {
      await sendTelegram('sendVideo', { chat_id: chatId, video: c.file_id, caption });
    } else if (c.content_type === 'audio' && c.file_id) {
      await sendTelegram('sendAudio', { chat_id: chatId, audio: c.file_id, caption });
    } else if (c.content) {
      await sendTelegram('sendMessage', { chat_id: chatId, text: `${caption}\n\n${c.content}` });
    }
  }
  
  if (page < totalPages) {
    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✨👉 请点击继续发送`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '📥 继续发送', callback_data: `redeem_continue_${keyword}_${page + 1}` }],
          [{ text: '↩️ 返回兑换', callback_data: 'back_redeem' }]
        ]
      }
    });
  } else {
    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ 文件发送完毕`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
          [{ text: '↩️ 返回兑换', callback_data: 'back_redeem' }]
        ]
      }
    });
  }
}

async function showAdminPanel(chatId, messageId = null) {
  const text = `🔧 管理员面板`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '📎 获取 File ID', callback_data: 'get_file_id' }],
      [{ text: '📦 商品管理', callback_data: 'product_manage' }],
      [{ text: '🎫 工单管理', callback_data: 'ticket_manage' }],
      [{ text: '👥 用户管理', callback_data: 'user_manage' }]
    ]
  };
  
  if (messageId) {
    return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
  }
  return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
}

async function showProductManagement(chatId, messageId = null, page = 1) {
  const products = await sql`SELECT * FROM products ORDER BY created_at ASC`;
  
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(products.rows.length / pageSize));
  const start = (page - 1) * pageSize;
  const pageProducts = products.rows.slice(start, start + pageSize);
  
  const buttons = [[{ text: '➕ 上架新关键词', callback_data: 'add_product' }]];
  
  for (const p of pageProducts) {
    buttons.push([
      { text: p.keyword, callback_data: `view_product_${p.id}` },
      { text: '🗑️ 删除', callback_data: `del_product_confirm_${p.id}` }
    ]);
  }
  
  const navButtons = [];
  if (page > 1) navButtons.push({ text: '⬅️', callback_data: `products_page_${page - 1}` });
  if (page < totalPages) navButtons.push({ text: '➡️', callback_data: `products_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);
  
  buttons.push([{ text: '↩️ 返回', callback_data: 'admin' }]);
  
  const text = `📦 商品管理\n\n📄 ${page}/${totalPages}`;
  
  if (messageId) {
    return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: buttons } });
  }
  return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: buttons } });
}

async function showTickets(chatId, messageId = null, page = 1) {
  const tickets = await sql`SELECT * FROM tickets ORDER BY created_at ASC`;
  
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(tickets.rows.length / pageSize));
  const start = (page - 1) * pageSize;
  const pageTickets = tickets.rows.slice(start, start + pageSize);
  
  let text = `🎫 工单管理\n\n📄 ${page}/${totalPages}\n\n`;
  
  const buttons = [];
  for (const t of pageTickets) {
    text += `@${t.username || '无'}（${t.user_id}）- ${t.order_number}\n`;
    buttons.push([
      { text: `@${t.username || '无'}（${t.user_id}）`, callback_data: `ticket_${t.id}` },
      { text: '🗑️', callback_data: `del_ticket_${t.id}` }
    ]);
  }
  
  if (pageTickets.length === 0) {
    text += '暂无工单';
  }
  
  const navButtons = [];
  if (page > 1) navButtons.push({ text: '⬅️', callback_data: `tickets_page_${page - 1}` });
  if (page < totalPages) navButtons.push({ text: '➡️', callback_data: `tickets_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);
  
  buttons.push([{ text: '↩️ 返回', callback_data: 'admin' }]);
  
  if (messageId) {
    return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: buttons } });
  }
  return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: buttons } });
}

async function showUsers(chatId, messageId = null, page = 1) {
  const users = await sql`SELECT * FROM users ORDER BY first_seen_date ASC`;
  
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(users.rows.length / pageSize));
  const start = (page - 1) * pageSize;
  const pageUsers = users.rows.slice(start, start + pageSize);
  
  let text = `👥 用户管理\n\n📄 ${page}/${totalPages}\n`;
  
  const buttons = [];
  for (const u of pageUsers) {
    const status = u.is_disabled ? '🔴' : '🟢';
    buttons.push([{ text: `${status} @${u.username || '无'}（${u.user_id}）`, callback_data: `user_detail_${u.user_id}` }]);
  }
  
  const navButtons = [];
  if (page > 1) navButtons.push({ text: '⬅️', callback_data: `users_page_${page - 1}` });
  if (page < totalPages) navButtons.push({ text: '➡️', callback_data: `users_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);
  
  buttons.push([{ text: '↩️ 返回', callback_data: 'admin' }]);
  
  if (messageId) {
    return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: buttons } });
  }
  return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: buttons } });
}

async function showUserDetail(chatId, messageId, targetUserId) {
  const result = await sql`SELECT * FROM users WHERE user_id = ${targetUserId}`;
  
  if (result.rows.length === 0) {
    return sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '❌ 用户不存在',
      reply_markup: { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'user_manage' }]] }
    });
  }
  
  const u = result.rows[0];
  const status = u.is_disabled ? '🔴 已停用' : '🟢 正常';
  
  const text = `👤 用户详情\n\n` +
    `姓名：${u.first_name || '未知'}\n` +
    `用户名：@${u.username || '无'}\n` +
    `ID：${u.user_id}\n` +
    `首次：${u.first_seen_date}\n` +
    `最近：${u.last_seen_date}\n` +
    `状态：${status}`;
  
  const toggleText = u.is_disabled ? '✅ 启用' : '🔴 停用';
  
  const keyboard = {
    inline_keyboard: [
      [{ text: toggleText, callback_data: `toggle_user_${targetUserId}` }],
      [{ text: '↩️ 返回', callback_data: 'user_manage' }]
    ]
  };
  
  return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
}
