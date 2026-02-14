// api/webhook.js
// ============== 配置区 ==============
const BOT_TOKEN = process.env.YOUR_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

// ============== FILE IDS 配置（在这里填入你的File ID） ==============
const FILE_IDS = {
  VIP_PROMO: '',           // VIP宣传图 file_id
  PAYMENT_TUTORIAL: '',    // 支付教程图 file_id  
  WELCOME_IMAGE: ''        // 欢迎图 file_id
};

const VIP_GROUP_LINK = 'https://t.me/+495j5rWmApsxYzg9';

// ============== 内存存储 ==============
global.memoryStore = global.memoryStore || {
  users: {},
  states: {},
  tickets: [],
  products: [],
  productContents: []
};

const store = global.memoryStore;

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
  const d = date || new Date();
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
    const data = await res.json();
    if (!data.ok) {
      console.log(`Telegram ${method} failed:`, data.description);
    }
    return data;
  } catch (e) {
    console.error(`Telegram ${method} error:`, e.message);
    return { ok: false, error: e.message };
  }
}

function setState(userId, state, data = {}) {
  store.states[userId] = { state, data, time: Date.now() };
}

function getState(userId) {
  return store.states[userId] || { state: null, data: {} };
}

function clearState(userId) {
  delete store.states[userId];
}

function getOrCreateUser(userId, username, firstName) {
  const dateKey = getBeijingDateKey();
  let user = store.users[userId];

  if (!user) {
    user = {
      userId,
      username: username || '',
      firstName: firstName || '',
      firstSeenDate: dateKey,
      lastSeenDate: dateKey,
      dateKey,
      dailyCount: 0,
      cooldownIndex: 0,
      lastRedeemTime: 0,
      isDisabled: false
    };
    store.users[userId] = user;
    return { ...user, isNew: true };
  }

  // 日期变化，重置每日数据
  if (user.dateKey !== dateKey) {
    user.dateKey = dateKey;
    user.dailyCount = 0;
    user.cooldownIndex = 0;
    user.lastSeenDate = dateKey;
  }

  user.username = username || user.username;
  user.firstName = firstName || user.firstName;
  user.lastSeenDate = dateKey;
  store.users[userId] = user;

  return { ...user, isNew: user.firstSeenDate === dateKey };
}

// ============== 主处理器 ==============
module.exports = async (req, res) => {
  // GET 请求 - 状态检查和设置 webhook
  if (req.method === 'GET') {
    if (req.query.setWebhook) {
      const host = req.headers.host;
      const webhookUrl = `https://${host}/api/webhook`;
      const result = await sendTelegram('setWebhook', { url: webhookUrl });
      return res.status(200).json({ webhook: webhookUrl, result });
    }
    return res.status(200).json({ 
      status: 'Bot is running', 
      token: BOT_TOKEN ? 'Set' : 'NOT SET', 
      admins: ADMIN_IDS,
      products: store.products.length,
      users: Object.keys(store.users).length
    });
  }

  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  const update = req.body;

  try {
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch (e) {
    console.error('Handler Error:', e.message);
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

  const userState = getState(userId);

  // ===== 管理员命令 =====
  if (text === '/admin' && isAdmin(userId)) {
    clearState(userId);
    return showAdminPanel(chatId);
  }

  if (text === '/c' && isAdmin(userId)) {
    clearState(userId);
    return sendTelegram('sendMessage', { chat_id: chatId, text: '✅ 已取消当前操作' });
  }

  if (text === '/cz' && isAdmin(userId)) {
    const dateKey = getBeijingDateKey();
    store.users[userId] = {
      ...store.users[userId],
      dailyCount: 0,
      cooldownIndex: 0,
      lastRedeemTime: 0,
      firstSeenDate: dateKey,
      dateKey
    };
    clearState(userId);
    return sendTelegram('sendMessage', { chat_id: chatId, text: '✅ 已重置为新用户状态（当天免费3次）' });
  }

  if (text === '/p' && isAdmin(userId)) {
    clearState(userId);
    return showProductManagement(chatId);
  }

  // ===== 普通命令 =====
  if (text === '/start' || text === '/start ') {
    clearState(userId);
    getOrCreateUser(userId, username, firstName);
    return showWelcome(chatId);
  }

  if (text === '/start dh' || text === '/dh') {
    clearState(userId);
    return showRedeem(chatId, userId, username, firstName);
  }

  if (text === '/v') {
    return showVIP(chatId);
  }

  // ===== 状态机处理 =====
  if (userState.state) {
    return handleStateInput(chatId, userId, username, firstName, msg, userState);
  }
}

// ============== 状态输入处理 ==============
async function handleStateInput(chatId, userId, username, firstName, msg, userState) {
  const text = msg.text || '';
  const { state, data } = userState;

  // 管理员：获取 File ID
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
      clearState(userId);
      return sendTelegram('sendMessage', {
        chat_id: chatId,
        text: `📎 File ID:\n\n<code>${fileId}</code>\n\n点击可复制`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '↩️ 返回管理面板', callback_data: 'admin' }]] }
      });
    } else {
      return sendTelegram('sendMessage', { 
        chat_id: chatId, 
        text: '❌ 请发送图片、文件、视频等媒体内容',
        reply_markup: { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'admin' }]] }
      });
    }
  }

  // 管理员：输入关键词
  if (state === 'waiting_keyword' && isAdmin(userId)) {
    const keyword = text.trim();
    if (!keyword) {
      return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 关键词不能为空，请重新输入：' });
    }

    const existing = store.products.find(p => p.keyword === keyword);
    if (existing) {
      return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 该关键词已存在，请输入其他关键词：' });
    }

    const productId = Date.now();
    store.products.push({ id: productId, keyword, createdAt: Date.now() });
    setState(userId, 'waiting_product_content', { productId, keyword });

    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ 关键词「${keyword}」已创建\n\n📝 请发送内容（支持文字、图片、文件、视频等）\n\n可连续发送多条，完成后点击下方按钮`,
      reply_markup: { inline_keyboard: [[{ text: '✅ 完成上架', callback_data: `finish_product_${productId}` }]] }
    });
  }

  // 管理员：添加商品内容
  if (state === 'waiting_product_content' && isAdmin(userId)) {
    const { productId, keyword } = data;
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
    } else if (msg.animation) {
      contentType = 'animation';
      fileId = msg.animation.file_id;
      content = msg.caption || '';
    } else if (msg.forward_origin || msg.forward_from || msg.forward_from_chat) {
      contentType = 'forward_text';
    }

    const existingContents = store.productContents.filter(c => c.productId === productId);
    const sortOrder = existingContents.length + 1;

    store.productContents.push({
      id: Date.now(),
      productId,
      contentType,
      content: content || '',
      fileId,
      sortOrder
    });

    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ 已添加第 ${sortOrder} 条内容\n\n继续发送更多内容，或点击完成`,
      reply_markup: { inline_keyboard: [[{ text: '✅ 完成上架', callback_data: `finish_product_${productId}` }]] }
    });
  }

  // 用户：输入订单号
  if (state === 'waiting_order') {
    const orderNumber = text.trim();
    const failCount = data.failCount || 0;

    // 私密验证逻辑
    if (orderNumber.startsWith('20260')) {
      // 创建工单
      store.tickets.push({
        id: Date.now(),
        userId,
        username: username || '',
        firstName: firstName || '',
        orderNumber,
        createdAt: Date.now()
      });

      // 通知所有管理员
      for (const adminId of ADMIN_IDS) {
        await sendTelegram('sendMessage', {
          chat_id: adminId,
          text: `🎫 新工单通知\n\n👤 姓名：${firstName || '未知'}\n👤 用户名：@${username || '无'}\n🆔 用户ID：${userId}\n📝 订单号：${orderNumber}\n⏰ 时间：${formatBeijingTime(new Date())}`
        });
      }

      clearState(userId);
      return sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '🎉 验证成功！\n\n欢迎加入VIP会员大家庭',
        reply_markup: { inline_keyboard: [[{ text: '🎉 加入会员群', url: VIP_GROUP_LINK }]] }
      });
    } else {
      // 验证失败
      if (failCount >= 1) {
        clearState(userId);
        await sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 验证失败次数过多，请稍后重试' });
        return showWelcome(chatId);
      } else {
        setState(userId, 'waiting_order', { failCount: failCount + 1 });
        return sendTelegram('sendMessage', { 
          chat_id: chatId, 
          text: '❌ 订单号格式不正确，请检查后重新输入：',
          reply_markup: { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'join_vip' }]] }
        });
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

  // ===== 管理员功能 =====
  if (data === 'admin' && isAdmin(userId)) {
    clearState(userId);
    return showAdminPanel(chatId, messageId);
  }

  if (data === 'get_file_id' && isAdmin(userId)) {
    setState(userId, 'waiting_file_id');
    return sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '📷 请发送图片、视频、文件等\n\n我会返回对应的 File ID',
      reply_markup: { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'admin' }]] }
    });
  }

  if (data === 'product_manage' && isAdmin(userId)) {
    clearState(userId);
    return showProductManagement(chatId, messageId);
  }

  if (data === 'add_product' && isAdmin(userId)) {
    setState(userId, 'waiting_keyword');
    return sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '📝 请输入新商品的关键词：',
      reply_markup: { inline_keyboard: [[{ text: '↩️ 取消', callback_data: 'product_manage' }]] }
    });
  }

  if (data.startsWith('finish_product_') && isAdmin(userId)) {
    const productId = parseInt(data.replace('finish_product_', ''));
    const product = store.products.find(p => p.id === productId);
    const contentCount = store.productContents.filter(c => c.productId === productId).length;
    clearState(userId);
    
    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ 商品上架完成！\n\n📦 关键词：${product?.keyword || '未知'}\n📄 内容数量：${contentCount} 条`,
      reply_markup: { inline_keyboard: [[{ text: '↩️ 返回商品管理', callback_data: 'product_manage' }]] }
    });
  }

  if (data.startsWith('del_product_confirm_') && isAdmin(userId)) {
    const productId = parseInt(data.replace('del_product_confirm_', ''));
    const product = store.products.find(p => p.id === productId);
    return sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `⚠️ 确定要删除商品「${product?.keyword || ''}」吗？\n\n此操作不可恢复！`,
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
    store.products = store.products.filter(p => p.id !== productId);
    store.productContents = store.productContents.filter(c => c.productId !== productId);
    return showProductManagement(chatId, messageId);
  }

  if (data === 'ticket_manage' && isAdmin(userId)) {
    return showTickets(chatId, messageId, 1);
  }

  if (data.startsWith('tickets_page_') && isAdmin(userId)) {
    const page = parseInt(data.replace('tickets_page_', ''));
    return showTickets(chatId, messageId, page);
  }

  if (data.startsWith('ticket_detail_') && isAdmin(userId)) {
    const ticketId = parseInt(data.replace('ticket_detail_', ''));
    return showTicketDetail(chatId, messageId, ticketId);
  }

  if (data.startsWith('del_ticket_') && isAdmin(userId)) {
    const ticketId = parseInt(data.replace('del_ticket_', ''));
    store.tickets = store.tickets.filter(t => t.id !== ticketId);
    return showTickets(chatId, messageId, 1);
  }

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
    if (store.users[targetUserId]) {
      store.users[targetUserId].isDisabled = !store.users[targetUserId].isDisabled;
    }
    return showUserDetail(chatId, messageId, targetUserId);
  }

  // ===== 用户功能 =====
  if (data === 'join_vip') {
    return showVIP(chatId, messageId);
  }

  if (data === 'redeem') {
    return showRedeem(chatId, userId, username, firstName, messageId);
  }

  if (data === 'verify_payment') {
    // 发送教程图片（如果有）
    if (FILE_IDS.PAYMENT_TUTORIAL) {
      await sendTelegram('sendPhoto', { chat_id: chatId, photo: FILE_IDS.PAYMENT_TUTORIAL });
    }

    setState(userId, 'waiting_order', { failCount: 0 });
    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: '📋 **查找订单号步骤：**\n\n1️⃣ 打开支付应用（支付宝/微信）\n2️⃣ 点击「我的」\n3️⃣ 点击「账单」\n4️⃣ 找到本次付款记录\n5️⃣ 点击进入「账单详情」\n6️⃣ 点击「更多」\n7️⃣ 找到并复制「订单号」\n\n✏️ 请输入您的订单号：',
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'join_vip' }]] }
    });
  }

  if (data === 'back_start') {
    clearState(userId);
    return showWelcome(chatId, messageId);
  }

  // 兑换商品
  if (data.startsWith('redeem_') && !data.startsWith('redeem_continue_')) {
    const keyword = data.replace('redeem_', '');
    return handleRedeemProduct(chatId, userId, username, firstName, keyword, messageId);
  }

  if (data.startsWith('redeem_continue_')) {
    const match = data.match(/redeem_continue_(.+)_(\d+)$/);
    if (match) {
      const keyword = match[1];
      const page = parseInt(match[2]);
      return sendProductContents(chatId, keyword, page);
    }
  }

  if (data === 'back_redeem') {
    return showRedeem(chatId, userId, username, firstName, messageId);
  }

  // 分页
  if (data.startsWith('products_page_') && isAdmin(userId)) {
    const page = parseInt(data.replace('products_page_', ''));
    return showProductManagement(chatId, messageId, page);
  }

  if (data.startsWith('dh_page_')) {
    const page = parseInt(data.replace('dh_page_', ''));
    return showRedeemPage(chatId, messageId, page);
  }
}

// ============== 页面显示函数 ==============
async function showWelcome(chatId, messageId = null) {
  const text = `🎊 **喜迎马年新春** 🐴\n\n` +
    `🧧 新春资源免费获取 🧧\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `✨ 限时福利 · 等你来拿 ✨\n` +
    `━━━━━━━━━━━━━━`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
      [{ text: '🎁 免费兑换', callback_data: 'redeem' }]
    ]
  };

  if (messageId) {
    return sendTelegram('editMessageText', { 
      chat_id: chatId, 
      message_id: messageId, 
      text, 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
  }

  // 如果有欢迎图片
  if (FILE_IDS.WELCOME_IMAGE) {
    return sendTelegram('sendPhoto', { 
      chat_id: chatId, 
      photo: FILE_IDS.WELCOME_IMAGE, 
      caption: text, 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
  }

  return sendTelegram('sendMessage', { 
    chat_id: chatId, 
    text, 
    parse_mode: 'Markdown',
    reply_markup: keyboard 
  });
}

async function showVIP(chatId, messageId = null) {
  const text = `🎊 **喜迎新春（特价）**\n\n` +
    `💎 **VIP会员特权说明：**\n\n` +
    `✅ 专属中转通道\n` +
    `✅ 优先审核入群\n` +
    `✅ 7x24小时客服支持\n` +
    `✅ 定期福利活动\n\n` +
    `━━━━━━━━━━━━━━`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '✅ 我已付款，开始验证', callback_data: 'verify_payment' }],
      [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
    ]
  };

  // 如果有VIP宣传图
  if (FILE_IDS.VIP_PROMO) {
    if (messageId) {
      await sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
    }
    return sendTelegram('sendPhoto', { 
      chat_id: chatId, 
      photo: FILE_IDS.VIP_PROMO, 
      caption: text, 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
  }

  if (messageId) {
    return sendTelegram('editMessageText', { 
      chat_id: chatId, 
      message_id: messageId, 
      text, 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
  }
  return sendTelegram('sendMessage', { 
    chat_id: chatId, 
    text, 
    parse_mode: 'Markdown',
    reply_markup: keyboard 
  });
}

async function showRedeem(chatId, userId, username, firstName, messageId = null) {
  const user = getOrCreateUser(userId, username, firstName);
  const { dailyCount, cooldownIndex, lastRedeemTime, firstSeenDate, dateKey } = user;
  
  const isNewUser = firstSeenDate === dateKey;
  const freeLimit = isNewUser ? 3 : 2;
  const cooldowns = [5, 15, 30, 50, 60, 60]; // 分钟
  const maxDaily = 6;

  // 检查每日上限
  if (dailyCount >= maxDaily) {
    const text = `⏰ 今日兑换次数已用完\n\n🌙 明天再来吧～\n\n💡 升级VIP会员可无限兑换`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
        [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
      ]
    };
    if (messageId) {
      return sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: keyboard });
    }
    return sendTelegram('sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
  }

  // 免费次数内，直接显示
  if (dailyCount < freeLimit) {
    return showRedeemPage(chatId, messageId, 1);
  }

  // 检查冷却时间
  const now = Date.now();
  const cdIndex = Math.min(cooldownIndex, cooldowns.length - 1);
  const cdTime = cooldowns[cdIndex] * 60 * 1000;
  const elapsed = now - (lastRedeemTime || 0);

  if (elapsed < cdTime) {
    const remaining = Math.ceil((cdTime - elapsed) / 1000);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    
    const text = `⏰ 冷却中...\n\n⏳ 剩余时间：**${mins}分${secs}秒**\n\n💡 升级VIP会员可免除等待`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
        [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
      ]
    };
    if (messageId) {
      return sendTelegram('editMessageText', { 
        chat_id: chatId, 
        message_id: messageId, 
        text, 
        parse_mode: 'Markdown',
        reply_markup: keyboard 
      });
    }
    return sendTelegram('sendMessage', { 
      chat_id: chatId, 
      text, 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
  }

  return showRedeemPage(chatId, messageId, 1);
}

async function showRedeemPage(chatId, messageId = null, page = 1) {
  const products = store.products.sort((a, b) => a.createdAt - b.createdAt);

  if (products.length === 0) {
    const text = `🎁 **兑换中心**\n\n⏳ 暂无商品，请等待管理员上架...`;
    const keyboard = { inline_keyboard: [[{ text: '↩️ 返回首页', callback_data: 'back_start' }]] };
    if (messageId) {
      return sendTelegram('editMessageText', { 
        chat_id: chatId, 
        message_id: messageId, 
        text, 
        parse_mode: 'Markdown',
        reply_markup: keyboard 
      });
    }
    return sendTelegram('sendMessage', { 
      chat_id: chatId, 
      text, 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
  }

  const pageSize = 10;
  const totalPages = Math.ceil(products.length / pageSize);
  const start = (page - 1) * pageSize;
  const pageProducts = products.slice(start, start + pageSize);

  const buttons = pageProducts.map(p => [{ text: `📦 ${p.keyword}`, callback_data: `redeem_${p.keyword}` }]);

  // 分页按钮
  const navButtons = [];
  if (page > 1) navButtons.push({ text: '⬅️ 上页', callback_data: `dh_page_${page - 1}` });
  if (page < totalPages) navButtons.push({ text: '下页 ➡️', callback_data: `dh_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);
  
  buttons.push([{ text: '↩️ 返回首页', callback_data: 'back_start' }]);

  const text = `🎁 **兑换中心**\n\n📄 第 ${page}/${totalPages} 页\n\n请选择要兑换的内容：`;

  if (messageId) {
    return sendTelegram('editMessageText', { 
      chat_id: chatId, 
      message_id: messageId, 
      text, 
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons } 
    });
  }
  return sendTelegram('sendMessage', { 
    chat_id: chatId, 
    text, 
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons } 
  });
}

async function handleRedeemProduct(chatId, userId, username, firstName, keyword, messageId) {
  // 更新用户使用数据
  const user = store.users[userId];
  if (user) {
    const isNewUser = user.firstSeenDate === user.dateKey;
    const freeLimit = isNewUser ? 3 : 2;

    user.dailyCount = (user.dailyCount || 0) + 1;
    if (user.dailyCount > freeLimit) {
      user.cooldownIndex = Math.min((user.cooldownIndex || 0) + 1, 5);
    }
    user.lastRedeemTime = Date.now();
    store.users[userId] = user;
  }

  if (messageId) {
    await sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
  }

  return sendProductContents(chatId, keyword, 1);
}

async function sendProductContents(chatId, keyword, page) {
  const product = store.products.find(p => p.keyword === keyword);
  if (!product) {
    return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 商品不存在' });
  }

  const contents = store.productContents
    .filter(c => c.productId === product.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  if (contents.length === 0) {
    return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 该商品暂无内容' });
  }

  const pageSize = 10;
  const totalPages = Math.ceil(contents.length / pageSize);
  const start = (page - 1) * pageSize;
  const pageContents = contents.slice(start, start + pageSize);

  // 发送内容
  for (let i = 0; i < pageContents.length; i++) {
    const c = pageContents[i];
    const index = start + i + 1;
    const caption = `📦 文件 ${index}/${contents.length}`;

    try {
      if (c.contentType === 'photo' && c.fileId) {
        await sendTelegram('sendPhoto', { chat_id: chatId, photo: c.fileId, caption });
      } else if (c.contentType === 'document' && c.fileId) {
        await sendTelegram('sendDocument', { chat_id: chatId, document: c.fileId, caption });
      } else if (c.contentType === 'video' && c.fileId) {
        await sendTelegram('sendVideo', { chat_id: chatId, video: c.fileId, caption });
      } else if (c.contentType === 'audio' && c.fileId) {
        await sendTelegram('sendAudio', { chat_id: chatId, audio: c.fileId, caption });
      } else if (c.contentType === 'animation' && c.fileId) {
        await sendTelegram('sendAnimation', { chat_id: chatId, animation: c.fileId, caption });
      } else if (c.content) {
        await sendTelegram('sendMessage', { chat_id: chatId, text: `${caption}\n\n${c.content}` });
      }
    } catch (e) {
      console.error('Send content error:', e.message);
    }
  }

  // 发送操作按钮
  if (page < totalPages) {
    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✨ 已发送 ${page * pageSize}/${contents.length} 条\n\n👉 点击继续接收`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '📥 继续发送', callback_data: `redeem_continue_${keyword}_${page + 1}` }],
          [{ text: '↩️ 返回兑换中心', callback_data: 'back_redeem' }]
        ]
      }
    });
  } else {
    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ 全部 ${contents.length} 条内容发送完毕！`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
          [{ text: '↩️ 返回兑换中心', callback_data: 'back_redeem' }]
        ]
      }
    });
  }
}

// ============== 管理员页面 ==============
async function showAdminPanel(chatId, messageId = null) {
  const text = `🔧 **管理员面板**\n\n` +
    `📊 统计：\n` +
    `• 用户数：${Object.keys(store.users).length}\n` +
    `• 商品数：${store.products.length}\n` +
    `• 工单数：${store.tickets.length}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '📎 获取 File ID', callback_data: 'get_file_id' }],
      [{ text: '📦 商品管理', callback_data: 'product_manage' }],
      [{ text: '🎫 工单管理', callback_data: 'ticket_manage' }],
      [{ text: '👥 用户管理', callback_data: 'user_manage' }]
    ]
  };

  if (messageId) {
    return sendTelegram('editMessageText', { 
      chat_id: chatId, 
      message_id: messageId, 
      text, 
      parse_mode: 'Markdown',
      reply_markup: keyboard 
    });
  }
  return sendTelegram('sendMessage', { 
    chat_id: chatId, 
    text, 
    parse_mode: 'Markdown',
    reply_markup: keyboard 
  });
}

async function showProductManagement(chatId, messageId = null, page = 1) {
  const products = store.products.sort((a, b) => a.createdAt - b.createdAt);

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(products.length / pageSize));
  const start = (page - 1) * pageSize;
  const pageProducts = products.slice(start, start + pageSize);

  const buttons = [[{ text: '➕ 上架新关键词', callback_data: 'add_product' }]];

  for (const p of pageProducts) {
    const contentCount = store.productContents.filter(c => c.productId === p.id).length;
    buttons.push([
      { text: `📦 ${p.keyword} (${contentCount}条)`, callback_data: `view_product_${p.id}` },
      { text: '🗑️', callback_data: `del_product_confirm_${p.id}` }
    ]);
  }

  const navButtons = [];
  if (page > 1) navButtons.push({ text: '⬅️', callback_data: `products_page_${page - 1}` });
  if (page < totalPages) navButtons.push({ text: '➡️', callback_data: `products_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);

  buttons.push([{ text: '↩️ 返回管理面板', callback_data: 'admin' }]);

  const text = `📦 **商品管理**\n\n📄 ${page}/${totalPages} 页 · 共 ${products.length} 个商品`;

  if (messageId) {
    return sendTelegram('editMessageText', { 
      chat_id: chatId, 
      message_id: messageId, 
      text, 
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons } 
    });
  }
  return sendTelegram('sendMessage', { 
    chat_id: chatId, 
    text, 
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons } 
  });
}

async function showTickets(chatId, messageId = null, page = 1) {
  const tickets = store.tickets.sort((a, b) => a.createdAt - b.createdAt);

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(tickets.length / pageSize));
  const start = (page - 1) * pageSize;
  const pageTickets = tickets.slice(start, start + pageSize);

  let text = `🎫 **工单管理**\n\n📄 ${page}/${totalPages} 页\n\n`;

  const buttons = [];
  
  if (pageTickets.length === 0) {
    text += '暂无工单';
  } else {
    for (const t of pageTickets) {
      const time = formatBeijingTime(new Date(t.createdAt));
      buttons.push([
        { text: `@${t.username || '无'} (${t.userId})`, callback_data: `ticket_detail_${t.id}` },
        { text: '🗑️', callback_data: `del_ticket_${t.id}` }
      ]);
    }
  }

  const navButtons = [];
  if (page > 1) navButtons.push({ text: '⬅️', callback_data: `tickets_page_${page - 1}` });
  if (page < totalPages) navButtons.push({ text: '➡️', callback_data: `tickets_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);

  buttons.push([{ text: '↩️ 返回管理面板', callback_data: 'admin' }]);

  if (messageId) {
    return sendTelegram('editMessageText', { 
      chat_id: chatId, 
      message_id: messageId, 
      text, 
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons } 
    });
  }
  return sendTelegram('sendMessage', { 
    chat_id: chatId, 
    text, 
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons } 
  });
}

async function showTicketDetail(chatId, messageId, ticketId) {
  const ticket = store.tickets.find(t => t.id === ticketId);

  if (!ticket) {
    return sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '❌ 工单不存在',
      reply_markup: { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'ticket_manage' }]] }
    });
  }

  const text = `🎫 **工单详情**\n\n` +
    `👤 姓名：${ticket.firstName || '未知'}\n` +
    `👤 用户名：@${ticket.username || '无'}\n` +
    `🆔 用户ID：\`${ticket.userId}\`\n` +
    `📝 订单号：\`${ticket.orderNumber}\`\n` +
    `⏰ 时间：${formatBeijingTime(new Date(ticket.createdAt))}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🗑️ 删除工单', callback_data: `del_ticket_${ticketId}` }],
      [{ text: '↩️ 返回工单列表', callback_data: 'ticket_manage' }]
    ]
  };

  return sendTelegram('editMessageText', { 
    chat_id: chatId, 
    message_id: messageId, 
    text, 
    parse_mode: 'Markdown',
    reply_markup: keyboard 
  });
}

async function showUsers(chatId, messageId = null, page = 1) {
  const users = Object.values(store.users).sort((a, b) =>
    (a.firstSeenDate || '').localeCompare(b.firstSeenDate || '')
  );

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(users.length / pageSize));
  const start = (page - 1) * pageSize;
  const pageUsers = users.slice(start, start + pageSize);

  let text = `👥 **用户管理**\n\n📄 ${page}/${totalPages} 页 · 共 ${users.length} 人\n`;

  const buttons = [];

  if (pageUsers.length === 0) {
    text += '\n暂无用户';
  } else {
    for (const u of pageUsers) {
      const status = u.isDisabled ? '🔴' : '🟢';
      buttons.push([{ 
        text: `${status} @${u.username || '无'} (${u.userId})`, 
        callback_data: `user_detail_${u.userId}` 
      }]);
    }
  }

  const navButtons = [];
  if (page > 1) navButtons.push({ text: '⬅️', callback_data: `users_page_${page - 1}` });
  if (page < totalPages) navButtons.push({ text: '➡️', callback_data: `users_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);

  buttons.push([{ text: '↩️ 返回管理面板', callback_data: 'admin' }]);

  if (messageId) {
    return sendTelegram('editMessageText', { 
      chat_id: chatId, 
      message_id: messageId, 
      text, 
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons } 
    });
  }
  return sendTelegram('sendMessage', { 
    chat_id: chatId, 
    text, 
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons } 
  });
}

async function showUserDetail(chatId, messageId, targetUserId) {
  const u = store.users[targetUserId];

  if (!u) {
    return sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '❌ 用户不存在',
      reply_markup: { inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'user_manage' }]] }
    });
  }

  const status = u.isDisabled ? '🔴 已停用' : '🟢 正常';
  const isNewUser = u.firstSeenDate === u.dateKey;

  const text = `👤 **用户详情**\n\n` +
    `👤 姓名：${u.firstName || '未知'}\n` +
    `👤 用户名：@${u.username || '无'}\n` +
    `🆔 ID：\`${u.userId}\`\n` +
    `📅 首次：${u.firstSeenDate || '未知'}\n` +
    `📅 最近：${u.lastSeenDate || '未知'}\n` +
    `📊 今日兑换：${u.dailyCount || 0} 次\n` +
    `🆕 新用户：${isNewUser ? '是' : '否'}\n` +
    `⚡ 状态：${status}`;

  const toggleText = u.isDisabled ? '✅ 启用用户' : '🔴 停用用户';

  const keyboard = {
    inline_keyboard: [
      [{ text: toggleText, callback_data: `toggle_user_${targetUserId}` }],
      [{ text: '↩️ 返回用户列表', callback_data: 'user_manage' }]
    ]
  };

  return sendTelegram('editMessageText', { 
    chat_id: chatId, 
    message_id: messageId, 
    text, 
    parse_mode: 'Markdown',
    reply_markup: keyboard 
  });
}
