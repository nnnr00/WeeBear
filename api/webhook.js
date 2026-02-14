// api/webhook.js
// ============== 配置区 ==============
const BOT_TOKEN = process.env.YOUR_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

// ============== FILE IDS 配置 ==============
const FILE_IDS = {
  VIP_PROMO: '',
  PAYMENT_TUTORIAL: '',
  WELCOME_IMAGE: ''
};

const VIP_GROUP_LINK = 'https://t.me/+495j5rWmApsxYzg9';

// ============== Neon 数据库 ==============
const { neon } = require('@neondatabase/serverless');
const sql = neon(DATABASE_URL);

// ============== 初始化数据库 ==============
async function initDB() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        user_id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        first_name VARCHAR(255),
        first_seen_date VARCHAR(20),
        last_seen_date VARCHAR(20),
        date_key VARCHAR(20),
        daily_count INT DEFAULT 0,
        cooldown_index INT DEFAULT 0,
        last_redeem_time BIGINT DEFAULT 0,
        is_disabled BOOLEAN DEFAULT FALSE
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
        product_id INT,
        content_type VARCHAR(50),
        content TEXT,
        file_id VARCHAR(500),
        sort_order INT DEFAULT 0
      )
    `;

    return true;
  } catch (e) {
    console.error('DB Init Error:', e.message);
    return false;
  }
}

// ============== 工具函数 ==============
function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

function getBeijingDateKey() {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return beijingTime.toISOString().split('T')[0];
}

function formatBeijingTime(date) {
  const d = date ? new Date(date) : new Date();
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return bj.toISOString().replace('T', ' ').substring(0, 19);
}

async function sendTelegram(method, params) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return await res.json();
  } catch (e) {
    console.error(`TG Error:`, e.message);
    return { ok: false };
  }
}

async function setState(userId, state, data = {}) {
  try {
    const dataStr = JSON.stringify(data);
    const existing = await sql`SELECT user_id FROM user_states WHERE user_id = ${userId}`;
    if (existing.length > 0) {
      await sql`UPDATE user_states SET state = ${state}, data = ${dataStr}, updated_at = NOW() WHERE user_id = ${userId}`;
    } else {
      await sql`INSERT INTO user_states (user_id, state, data) VALUES (${userId}, ${state}, ${dataStr})`;
    }
  } catch (e) {
    console.error('setState Error:', e.message);
  }
}

async function getState(userId) {
  try {
    const result = await sql`SELECT state, data FROM user_states WHERE user_id = ${userId}`;
    if (result.length > 0) {
      return { state: result[0].state, data: JSON.parse(result[0].data || '{}') };
    }
  } catch (e) {
    console.error('getState Error:', e.message);
  }
  return { state: null, data: {} };
}

async function clearState(userId) {
  try {
    await sql`DELETE FROM user_states WHERE user_id = ${userId}`;
  } catch (e) {
    console.error('clearState Error:', e.message);
  }
}

async function getOrCreateUser(userId, username, firstName) {
  const dateKey = getBeijingDateKey();
  try {
    const result = await sql`SELECT * FROM users WHERE user_id = ${userId}`;

    if (result.length === 0) {
      await sql`INSERT INTO users (user_id, username, first_name, first_seen_date, last_seen_date, date_key, daily_count, cooldown_index, last_redeem_time) VALUES (${userId}, ${username || ''}, ${firstName || ''}, ${dateKey}, ${dateKey}, ${dateKey}, 0, 0, 0)`;
      return { userId, username, firstName, firstSeenDate: dateKey, dateKey, dailyCount: 0, cooldownIndex: 0, lastRedeemTime: 0, isNew: true };
    }

    const user = result[0];

    if (user.date_key !== dateKey) {
      await sql`UPDATE users SET date_key = ${dateKey}, daily_count = 0, cooldown_index = 0, last_seen_date = ${dateKey}, username = ${username || user.username}, first_name = ${firstName || user.first_name} WHERE user_id = ${userId}`;
      return { ...user, dateKey, dailyCount: 0, cooldownIndex: 0, isNew: user.first_seen_date === dateKey };
    }

    await sql`UPDATE users SET last_seen_date = ${dateKey}, username = ${username || user.username}, first_name = ${firstName || user.first_name} WHERE user_id = ${userId}`;

    return {
      userId: user.user_id,
      username: user.username,
      firstName: user.first_name,
      firstSeenDate: user.first_seen_date,
      dateKey: user.date_key,
      dailyCount: user.daily_count || 0,
      cooldownIndex: user.cooldown_index || 0,
      lastRedeemTime: parseInt(user.last_redeem_time) || 0,
      isDisabled: user.is_disabled,
      isNew: user.first_seen_date === dateKey
    };
  } catch (e) {
    console.error('getOrCreateUser Error:', e.message);
    return { userId, dailyCount: 0, cooldownIndex: 0, lastRedeemTime: 0, isNew: true };
  }
}

// ============== 主处理器 ==============
module.exports = async (req, res) => {
  // GET 请求
  if (req.method === 'GET') {
    if (req.query.setWebhook) {
      const webhookUrl = `https://${req.headers.host}/api/webhook`;
      const result = await sendTelegram('setWebhook', { url: webhookUrl });
      return res.status(200).json({ webhook: webhookUrl, result });
    }
    if (req.query.init) {
      const success = await initDB();
      return res.status(200).json({ success, message: success ? 'Database initialized' : 'Init failed' });
    }
    return res.status(200).json({ status: 'OK', token: BOT_TOKEN ? 'Set' : 'Missing', db: DATABASE_URL ? 'Set' : 'Missing', admins: ADMIN_IDS });
  }

  if (req.method !== 'POST') return res.status(200).send('OK');

  // POST 请求处理
  try {
    await initDB();
    const update = req.body;
    
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch (e) {
    console.error('Main Error:', e.message);
  }

  return res.status(200).send('OK');
};

// ============== 消息处理 ==============
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || '';
  const firstName = msg.from.first_name || '';
  const text = msg.text || '';

  const userState = await getState(userId);

  // 管理员命令
  if (text === '/admin' && isAdmin(userId)) {
    await clearState(userId);
    return showAdminPanel(chatId);
  }

  if (text === '/c' && isAdmin(userId)) {
    await clearState(userId);
    return sendTelegram('sendMessage', { chat_id: chatId, text: '✅ 已取消当前操作' });
  }

  if (text === '/cz' && isAdmin(userId)) {
    const dateKey = getBeijingDateKey();
    await sql`UPDATE users SET daily_count = 0, cooldown_index = 0, last_redeem_time = 0, first_seen_date = ${dateKey}, date_key = ${dateKey} WHERE user_id = ${userId}`;
    await clearState(userId);
    return sendTelegram('sendMessage', { chat_id: chatId, text: '✅ 已重置为新用户状态' });
  }

  if (text === '/p' && isAdmin(userId)) {
    await clearState(userId);
    return showProductManagement(chatId);
  }

  // 普通命令
  if (text === '/start' || text === '/start ') {
    await clearState(userId);
    await getOrCreateUser(userId, username, firstName);
    return showWelcome(chatId);
  }

  if (text === '/start dh' || text === '/dh') {
    await clearState(userId);
    return showRedeem(chatId, userId, username, firstName);
  }

  if (text === '/v') {
    return showVIP(chatId);
  }

  // 状态机
  if (userState.state) {
    return handleStateInput(chatId, userId, username, firstName, msg, userState);
  }
}

// ============== 状态处理 ==============
async function handleStateInput(chatId, userId, username, firstName, msg, userState) {
  const text = msg.text || '';
  const { state, data } = userState;

  // 获取 File ID
  if (state === 'waiting_file_id' && isAdmin(userId)) {
    let fileId = null;
    if (msg.photo) fileId = msg.photo[msg.photo.length - 1].file_id;
    else if (msg.document) fileId = msg.document.file_id;
    else if (msg.video) fileId = msg.video.file_id;
    else if (msg.audio) fileId = msg.audio.file_id;
    else if (msg.voice) fileId = msg.voice.file_id;
    else if (msg.sticker) fileId = msg.sticker.file_id;
    else if (msg.animation) fileId = msg.animation.file_id;

    if (fileId) {
      await clearState(userId);
      return sendTelegram('sendMessage', {
        chat_id: chatId,
        text: `📎 File ID:\n\n<code>${fileId}</code>`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '↩️ 返回管理面板', callback_data: 'admin' }]] }
      });
    }
    return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 请发送媒体文件' });
  }

  // 输入关键词
  if (state === 'waiting_keyword' && isAdmin(userId)) {
    const keyword = text.trim();
    if (!keyword) return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 关键词不能为空' });

    const existing = await sql`SELECT id FROM products WHERE keyword = ${keyword}`;
    if (existing.length > 0) {
      return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 关键词已存在' });
    }

    const result = await sql`INSERT INTO products (keyword) VALUES (${keyword}) RETURNING id`;
    const productId = result[0].id;
    await setState(userId, 'waiting_product_content', { productId, keyword });

    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ 关键词「${keyword}」已创建\n\n📝 请发送内容`,
      reply_markup: { inline_keyboard: [[{ text: '✅ 完成上架', callback_data: `finish_product_${productId}` }]] }
    });
  }

  // 添加商品内容
  if (state === 'waiting_product_content' && isAdmin(userId)) {
    const { productId } = data;
    let contentType = 'text';
    let content = text;
    let fileId = null;

    if (msg.photo) { contentType = 'photo'; fileId = msg.photo[msg.photo.length - 1].file_id; content = msg.caption || ''; }
    else if (msg.document) { contentType = 'document'; fileId = msg.document.file_id; content = msg.caption || ''; }
    else if (msg.video) { contentType = 'video'; fileId = msg.video.file_id; content = msg.caption || ''; }
    else if (msg.audio) { contentType = 'audio'; fileId = msg.audio.file_id; content = msg.caption || ''; }
    else if (msg.animation) { contentType = 'animation'; fileId = msg.animation.file_id; content = msg.caption || ''; }

    const countResult = await sql`SELECT COUNT(*) as cnt FROM product_contents WHERE product_id = ${productId}`;
    const sortOrder = parseInt(countResult[0].cnt) + 1;

    await sql`INSERT INTO product_contents (product_id, content_type, content, file_id, sort_order) VALUES (${productId}, ${contentType}, ${content || ''}, ${fileId}, ${sortOrder})`;

    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ 已添加第 ${sortOrder} 条内容`,
      reply_markup: { inline_keyboard: [[{ text: '✅ 完成上架', callback_data: `finish_product_${productId}` }]] }
    });
  }

  // 输入订单号
  if (state === 'waiting_order') {
    const orderNumber = text.trim();
    const failCount = data.failCount || 0;

    if (orderNumber.startsWith('20260')) {
      await sql`INSERT INTO tickets (user_id, username, first_name, order_number) VALUES (${userId}, ${username}, ${firstName}, ${orderNumber})`;

      for (const adminId of ADMIN_IDS) {
        await sendTelegram('sendMessage', {
          chat_id: adminId,
          text: `🎫 新工单\n\n👤 ${firstName}\n👤 @${username}\n🆔 ${userId}\n📝 ${orderNumber}\n⏰ ${formatBeijingTime(new Date())}`
        });
      }

      await clearState(userId);
      return sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '🎉 验证成功！',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎉 加入会员群', url: VIP_GROUP_LINK }],
            [{ text: '🎁 免费兑换', callback_data: 'redeem' }]
          ]
        }
      });
    } else {
      if (failCount >= 1) {
        await clearState(userId);
        await sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 验证失败' });
        return showWelcome(chatId);
      }
      await setState(userId, 'waiting_order', { failCount: failCount + 1 });
      return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 订单号格式不正确' });
    }
  }
}

// ============== 回调处理 ==============
async function handleCallback(cbQuery) {
  const chatId = cbQuery.message.chat.id;
  const userId = cbQuery.from.id;
  const username = cbQuery.from.username || '';
  const firstName = cbQuery.from.first_name || '';
  const data = cbQuery.data;
  const messageId = cbQuery.message.message_id;

  await sendTelegram('answerCallbackQuery', { callback_query_id: cbQuery.id });

  // 管理员
  if (data === 'admin' && isAdmin(userId)) {
    await clearState(userId);
    return showAdminPanel(chatId, messageId);
  }

  if (data === 'get_file_id' && isAdmin(userId)) {
    await setState(userId, 'waiting_file_id');
    return editOrSend(chatId, messageId, '📷 请发送媒体文件', [[{ text: '↩️ 返回', callback_data: 'admin' }]]);
  }

  if (data === 'product_manage' && isAdmin(userId)) {
    await clearState(userId);
    return showProductManagement(chatId, messageId);
  }

  if (data === 'add_product' && isAdmin(userId)) {
    await setState(userId, 'waiting_keyword');
    return editOrSend(chatId, messageId, '📝 请输入关键词：', [[{ text: '↩️ 取消', callback_data: 'product_manage' }]]);
  }

  if (data.startsWith('finish_product_') && isAdmin(userId)) {
    await clearState(userId);
    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: '✅ 商品上架完成！',
      reply_markup: { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'product_manage' }]] }
    });
  }

  if (data.startsWith('del_product_confirm_') && isAdmin(userId)) {
    const productId = data.replace('del_product_confirm_', '');
    return editOrSend(chatId, messageId, '⚠️ 确定删除？', [
      [{ text: '✅ 确认', callback_data: `del_product_${productId}` }],
      [{ text: '↩️ 取消', callback_data: 'product_manage' }]
    ]);
  }

  if (data.startsWith('del_product_') && !data.includes('confirm') && isAdmin(userId)) {
    const productId = data.replace('del_product_', '');
    await sql`DELETE FROM product_contents WHERE product_id = ${parseInt(productId)}`;
    await sql`DELETE FROM products WHERE id = ${parseInt(productId)}`;
    return showProductManagement(chatId, messageId);
  }

  // 工单
  if (data === 'ticket_manage' && isAdmin(userId)) {
    return showTickets(chatId, messageId, 1);
  }

  if (data.startsWith('tickets_page_') && isAdmin(userId)) {
    const page = parseInt(data.replace('tickets_page_', ''));
    return showTickets(chatId, messageId, page);
  }

  if (data.startsWith('ticket_detail_') && isAdmin(userId)) {
    const ticketId = data.replace('ticket_detail_', '');
    return showTicketDetail(chatId, messageId, ticketId);
  }

  if (data.startsWith('del_ticket_confirm_') && isAdmin(userId)) {
    const ticketId = data.replace('del_ticket_confirm_', '');
    return editOrSend(chatId, messageId, '⚠️ 确定删除此工单？', [
      [{ text: '✅ 确认', callback_data: `del_ticket_${ticketId}` }],
      [{ text: '↩️ 取消', callback_data: `ticket_detail_${ticketId}` }]
    ]);
  }

  if (data.startsWith('del_ticket_') && !data.includes('confirm') && isAdmin(userId)) {
    const ticketId = data.replace('del_ticket_', '');
    await sql`DELETE FROM tickets WHERE id = ${parseInt(ticketId)}`;
    return showAdminPanel(chatId, messageId);
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
    const targetUserId = data.replace('user_detail_', '');
    return showUserDetail(chatId, messageId, targetUserId);
  }

  if (data.startsWith('toggle_user_') && isAdmin(userId)) {
    const targetUserId = data.replace('toggle_user_', '');
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
    if (FILE_IDS.PAYMENT_TUTORIAL) {
      await sendTelegram('sendPhoto', { chat_id: chatId, photo: FILE_IDS.PAYMENT_TUTORIAL });
    }
    await setState(userId, 'waiting_order', { failCount: 0 });
    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: '📋 查找订单号：\n\n1️⃣ 打开支付应用\n2️⃣ 我的 → 账单\n3️⃣ 找到付款记录\n4️⃣ 账单详情 → 更多\n5️⃣ 复制订单号\n\n请输入：',
      reply_markup: { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'join_vip' }]] }
    });
  }

  if (data === 'back_start') {
    await clearState(userId);
    return showWelcome(chatId, messageId);
  }

  // 兑换
  if (data.startsWith('redeem_kw_')) {
    const keyword = data.replace('redeem_kw_', '');
    return handleRedeemProduct(chatId, userId, username, firstName, keyword, messageId);
  }

  if (data.startsWith('redeem_page_')) {
    const match = data.match(/redeem_page_(.+)_(\d+)$/);
    if (match) {
      return sendProductContents(chatId, userId, match[1], parseInt(match[2]), messageId);
    }
  }

  if (data === 'back_redeem') {
    return showRedeem(chatId, userId, username, firstName, messageId);
  }

  if (data.startsWith('products_page_') && isAdmin(userId)) {
    const page = parseInt(data.replace('products_page_', ''));
    return showProductManagement(chatId, messageId, page);
  }

  if (data.startsWith('dh_page_')) {
    const page = parseInt(data.replace('dh_page_', ''));
    return showRedeemPage(chatId, messageId, page);
  }
}

// ============== 辅助函数 ==============
async function editOrSend(chatId, messageId, text, buttons) {
  const keyboard = { inline_keyboard: buttons };
  if (messageId) {
    return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
  }
  return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
}

// ============== 页面函数 ==============
async function showWelcome(chatId, messageId = null) {
  const text = `🎊 喜迎马年新春 🐴\n\n🧧 新春资源免费获取 🧧\n\n✨ 限时福利等你来拿 ✨`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
      [{ text: '🎁 免费兑换', callback_data: 'redeem' }]
    ]
  };

  if (messageId) {
    return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
  }
  if (FILE_IDS.WELCOME_IMAGE) {
    return sendTelegram('sendPhoto', { chat_id: chatId, photo: FILE_IDS.WELCOME_IMAGE, caption: text, reply_markup: keyboard });
  }
  return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
}

async function showVIP(chatId, messageId = null) {
  const text = `🎊 喜迎新春（特价）\n\n💎 VIP会员特权：\n\n✅ 专属中转通道\n✅ 优先审核入群\n✅ 7x24小时客服\n✅ 定期福利活动`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '✅ 我已付款，开始验证', callback_data: 'verify_payment' }],
      [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
    ]
  };

  if (FILE_IDS.VIP_PROMO) {
    if (messageId) await sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
    return sendTelegram('sendPhoto', { chat_id: chatId, photo: FILE_IDS.VIP_PROMO, caption: text, reply_markup: keyboard });
  }
  if (messageId) {
    return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
  }
  return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
}

async function showRedeem(chatId, userId, username, firstName, messageId = null) {
  const user = await getOrCreateUser(userId, username, firstName);
  const { dailyCount, cooldownIndex, lastRedeemTime, isNew } = user;

  const freeLimit = isNew ? 3 : 2;
  const cooldowns = [5, 15, 30, 50, 60, 60];
  const maxDaily = 6;

  if (dailyCount >= maxDaily) {
    return editOrSend(chatId, messageId, '⏰ 今日次数已用完\n\n明天再来～', [
      [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
      [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
    ]);
  }

  if (dailyCount < freeLimit) {
    return showRedeemPage(chatId, messageId, 1);
  }

  const now = Date.now();
  const cdIndex = Math.min(cooldownIndex, cooldowns.length - 1);
  const cdTime = cooldowns[cdIndex] * 60 * 1000;
  const elapsed = now - (lastRedeemTime || 0);

  if (elapsed < cdTime) {
    const remaining = Math.ceil((cdTime - elapsed) / 1000);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    return editOrSend(chatId, messageId, `⏰ 冷却中...\n\n剩余：${mins}分${secs}秒`, [
      [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
      [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
    ]);
  }

  return showRedeemPage(chatId, messageId, 1);
}

async function showRedeemPage(chatId, messageId = null, page = 1) {
  const products = await sql`SELECT * FROM products ORDER BY created_at ASC`;

  if (products.length === 0) {
    return editOrSend(chatId, messageId, '🎁 兑换中心\n\n⏳ 暂无商品...', [
      [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
      [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
    ]);
  }

  const pageSize = 10;
  const totalPages = Math.ceil(products.length / pageSize);
  const start = (page - 1) * pageSize;
  const pageProducts = products.slice(start, start + pageSize);

  const buttons = pageProducts.map(p => [{ text: `📦 ${p.keyword}`, callback_data: `redeem_kw_${p.keyword}` }]);
  buttons.push([{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }]);

  const navButtons = [];
  if (page > 1) navButtons.push({ text: '⬅️', callback_data: `dh_page_${page - 1}` });
  if (page < totalPages) navButtons.push({ text: '➡️', callback_data: `dh_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);

  buttons.push([{ text: '↩️ 返回首页', callback_data: 'back_start' }]);

  return editOrSend(chatId, messageId, `🎁 兑换中心\n\n📄 ${page}/${totalPages}`, buttons);
}

async function handleRedeemProduct(chatId, userId, username, firstName, keyword, messageId) {
  const user = await getOrCreateUser(userId, username, firstName);
  const freeLimit = user.isNew ? 3 : 2;

  await sql`UPDATE users SET daily_count = daily_count + 1, cooldown_index = CASE WHEN daily_count >= ${freeLimit} THEN LEAST(cooldown_index + 1, 5) ELSE cooldown_index END, last_redeem_time = ${Date.now()} WHERE user_id = ${userId}`;

  return sendProductContents(chatId, userId, keyword, 1, messageId);
}

async function sendProductContents(chatId, userId, keyword, page, messageId = null) {
  const productResult = await sql`SELECT id FROM products WHERE keyword = ${keyword}`;
  if (productResult.length === 0) {
    return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 商品不存在' });
  }
  const productId = productResult[0].id;

  const contents = await sql`SELECT * FROM product_contents WHERE product_id = ${productId} ORDER BY sort_order ASC`;

  if (contents.length === 0) {
    return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 暂无内容' });
  }

  const pageSize = 10;
  const totalPages = Math.ceil(contents.length / pageSize);
  const start = (page - 1) * pageSize;
  const pageContents = contents.slice(start, start + pageSize);

  if (messageId) {
    await sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
  }

  // 合并文本内容
  let textParts = [];
  let mediaItems = [];

  for (let i = 0; i < pageContents.length; i++) {
    const c = pageContents[i];
    const idx = start + i + 1;

    if (c.file_id) {
      mediaItems.push({ type: c.content_type, fileId: c.file_id, caption: c.content, idx });
    } else if (c.content) {
      textParts.push(`[${idx}] ${c.content}`);
    }
  }

  // 发送合并的文本
  if (textParts.length > 0) {
    const combinedText = `📦 ${keyword} (${page}/${totalPages})\n\n${textParts.join('\n\n')}`;
    await sendTelegram('sendMessage', { chat_id: chatId, text: combinedText });
  }

  // 发送媒体
  for (const m of mediaItems) {
    const cap = `[${m.idx}/${contents.length}] ${m.caption || ''}`;
    if (m.type === 'photo') await sendTelegram('sendPhoto', { chat_id: chatId, photo: m.fileId, caption: cap });
    else if (m.type === 'document') await sendTelegram('sendDocument', { chat_id: chatId, document: m.fileId, caption: cap });
    else if (m.type === 'video') await sendTelegram('sendVideo', { chat_id: chatId, video: m.fileId, caption: cap });
    else if (m.type === 'audio') await sendTelegram('sendAudio', { chat_id: chatId, audio: m.fileId, caption: cap });
    else if (m.type === 'animation') await sendTelegram('sendAnimation', { chat_id: chatId, animation: m.fileId, caption: cap });
  }

  // 操作按钮
  const buttons = [];
  if (page < totalPages) {
    buttons.push([{ text: `📥 继续发送 (${page + 1}/${totalPages})`, callback_data: `redeem_page_${keyword}_${page + 1}` }]);
  }
  buttons.push([{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }]);
  buttons.push([{ text: '↩️ 返回兑换中心', callback_data: 'back_redeem' }]);

  const statusText = page < totalPages ? `✨ ${page}/${totalPages} 组已发送` : `✅ 全部 ${contents.length} 条发送完毕！`;

  return sendTelegram('sendMessage', { chat_id: chatId, text: statusText, reply_markup: { inline_keyboard: buttons } });
}

// ============== 管理员页面 ==============
async function showAdminPanel(chatId, messageId = null) {
  let userCount = 0, productCount = 0, ticketCount = 0;
  try {
    const u = await sql`SELECT COUNT(*) as cnt FROM users`;
    const p = await sql`SELECT COUNT(*) as cnt FROM products`;
    const t = await sql`SELECT COUNT(*) as cnt FROM tickets`;
    userCount = u[0].cnt;
    productCount = p[0].cnt;
    ticketCount = t[0].cnt;
  } catch (e) {}

  const text = `🔧 管理员面板\n\n📊 用户:${userCount} 商品:${productCount} 工单:${ticketCount}`;
  const buttons = [
    [{ text: '📎 获取 File ID', callback_data: 'get_file_id' }],
    [{ text: '📦 商品管理', callback_data: 'product_manage' }],
    [{ text: '🎫 工单管理', callback_data: 'ticket_manage' }],
    [{ text: '👥 用户管理', callback_data: 'user_manage' }]
  ];

  return editOrSend(chatId, messageId, text, buttons);
}

async function showProductManagement(chatId, messageId = null, page = 1) {
  const products = await sql`SELECT * FROM products ORDER BY created_at ASC`;

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(products.length / pageSize));
  const start = (page - 1) * pageSize;
  const pageProducts = products.slice(start, start + pageSize);

  const buttons = [[{ text: '➕ 上架新关键词', callback_data: 'add_product' }]];

  for (const p of pageProducts) {
    const cnt = await sql`SELECT COUNT(*) as c FROM product_contents WHERE product_id = ${p.id}`;
    buttons.push([
      { text: `📦 ${p.keyword} (${cnt[0].c}条)`, callback_data: `view_product_${p.id}` },
      { text: '🗑️', callback_data: `del_product_confirm_${p.id}` }
    ]);
  }

  const navButtons = [];
  if (page > 1) navButtons.push({ text: '⬅️', callback_data: `products_page_${page - 1}` });
  if (page < totalPages) navButtons.push({ text: '➡️', callback_data: `products_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);

  buttons.push([{ text: '↩️ 返回', callback_data: 'admin' }]);

  return editOrSend(chatId, messageId, `📦 商品管理\n\n📄 ${page}/${totalPages}`, buttons);
}

async function showTickets(chatId, messageId = null, page = 1) {
  const tickets = await sql`SELECT * FROM tickets ORDER BY created_at ASC`;

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(tickets.length / pageSize));
  const start = (page - 1) * pageSize;
  const pageTickets = tickets.slice(start, start + pageSize);

  const buttons = [];

  for (const t of pageTickets) {
    buttons.push([{ text: `👤 ${t.first_name || '未知'} (${t.user_id})`, callback_data: `ticket_detail_${t.id}` }]);
  }

  const navButtons = [];
  if (page > 1) navButtons.push({ text: '⬅️', callback_data: `tickets_page_${page - 1}` });
  if (page < totalPages) navButtons.push({ text: '➡️', callback_data: `tickets_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);

  buttons.push([{ text: '↩️ 返回', callback_data: 'admin' }]);

  const text = tickets.length === 0 ? '🎫 工单管理\n\n暂无工单' : `🎫 工单管理\n\n📄 ${page}/${totalPages}`;

  return editOrSend(chatId, messageId, text, buttons);
}

async function showTicketDetail(chatId, messageId, ticketId) {
  const result = await sql`SELECT * FROM tickets WHERE id = ${parseInt(ticketId)}`;

  if (result.length === 0) {
    return editOrSend(chatId, messageId, '❌ 工单不存在', [[{ text: '↩️ 返回', callback_data: 'ticket_manage' }]]);
  }

  const t = result[0];
  const text = `🎫 工单详情\n\n━━━━━━━━━━━━━━\n👤 姓名：${t.first_name || '未知'}\n👤 用户名：@${t.username || '无'}\n🆔 用户ID：${t.user_id}\n📝 订单号：${t.order_number}\n⏰ 时间：${formatBeijingTime(t.created_at)}\n━━━━━━━━━━━━━━`;

  const buttons = [
    [{ text: '🗑️ 删除此工单', callback_data: `del_ticket_confirm_${ticketId}` }],
    [{ text: '↩️ 返回工单列表', callback_data: 'ticket_manage' }]
  ];

  return editOrSend(chatId, messageId, text, buttons);
}

async function showUsers(chatId, messageId = null, page = 1) {
  const users = await sql`SELECT * FROM users ORDER BY first_seen_date ASC`;

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(users.length / pageSize));
  const start = (page - 1) * pageSize;
  const pageUsers = users.slice(start, start + pageSize);

  const buttons = [];

  for (const u of pageUsers) {
    const status = u.is_disabled ? '🔴' : '🟢';
    buttons.push([{ text: `${status} ${u.first_name || '未知'} (${u.user_id})`, callback_data: `user_detail_${u.user_id}` }]);
  }

  const navButtons = [];
  if (page > 1) navButtons.push({ text: '⬅️', callback_data: `users_page_${page - 1}` });
  if (page < totalPages) navButtons.push({ text: '➡️', callback_data: `users_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);

  buttons.push([{ text: '↩️ 返回', callback_data: 'admin' }]);

  const text = users.length === 0 ? '👥 用户管理\n\n暂无用户' : `👥 用户管理\n\n📄 ${page}/${totalPages} · 共${users.length}人`;

  return editOrSend(chatId, messageId, text, buttons);
}

async function showUserDetail(chatId, messageId, targetUserId) {
  const result = await sql`SELECT * FROM users WHERE user_id = ${targetUserId}`;

  if (result.length === 0) {
    return editOrSend(chatId, messageId, '❌ 用户不存在', [[{ text: '↩️ 返回', callback_data: 'user_manage' }]]);
  }

  const u = result[0];
  const status = u.is_disabled ? '🔴 已停用' : '🟢 正常';
  const isNew = u.first_seen_date === u.date_key;

  const text = `👤 用户详情\n\n━━━━━━━━━━━━━━\n👤 姓名：${u.first_name || '未知'}\n👤 用户名：@${u.username || '无'}\n🆔 用户ID：${u.user_id}\n📅 首次访问：${u.first_seen_date || '未知'}\n📅 最近访问：${u.last_seen_date || '未知'}\n📊 今日兑换：${u.daily_count || 0} 次\n⏱️ 冷却等级：${u.cooldown_index || 0}\n🆕 新用户：${isNew ? '是' : '否'}\n⚡ 状态：${status}\n━━━━━━━━━━━━━━`;

  const toggleText = u.is_disabled ? '✅ 启用用户' : '🔴 停用用户';

  const buttons = [
    [{ text: toggleText, callback_data: `toggle_user_${targetUserId}` }],
    [{ text: '↩️ 返回用户列表', callback_data: 'user_manage' }]
  ];

  return editOrSend(chatId, messageId, text, buttons);
}
