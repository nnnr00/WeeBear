// api/webhook.js

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║                         🔧 配置区 - 可以在这里修改                              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

// ==================== FILE ID 配置 ====================
const FILE_IDS = {
  VIP_PROMO: 'AgACAgUAAxkBAAJJk2mdXrg0CDLobiwohvOSEQLC333kAAJtEGsbue_wVKyTAAGBMBVkywEAAwIAA3kAAzoE',
  PAYMENT_TUTORIAL: 'AgACAgUAAxkBAAIx4mmRrBW8IE_fkkkkEd1vdwgnDxXIAAJUDmsb2eWQVBZGhHhP0QABIQEAAwIAA3kAAzoE',
  WELCOME_IMAGE: ''
};

// ==================== 链接配置 ====================
const VIP_GROUP_LINK = 'https://t.me/+495j5rWmApsxYzg9';

// ==================== 消息过期时间（分钟）====================
const MESSAGE_EXPIRE_MINUTES = 2;

// ==================== 频率控制配置 ====================
const FREE_TIMES_DAY1 = 3;
const FREE_TIMES_DAY2 = 2;
const FREE_TIMES_DAY3_PLUS = 1;
const MAX_DAILY_TIMES = 6;
const COOLDOWN_MINUTES = [0.05, 0.05, 0.1, 0.1, 1];

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║                              以下代码无需修改                                  ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

const BOT_TOKEN = process.env.YOUR_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

const { neon } = require('@neondatabase/serverless');
let sql;
try {
  sql = neon(DATABASE_URL);
} catch (e) {
  console.error('DB connection error:', e.message);
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(parseInt(userId));
}

function getBeijingTime() {
  const now = new Date();
  return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}

function getBeijingDateKey() {
  const bj = getBeijingTime();
  return bj.toISOString().split('T')[0];
}

function formatBeijingTimeReadable(timestamp) {
  if (!timestamp) return '未知';
  const d = new Date(parseInt(timestamp));
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const year = bj.getUTCFullYear();
  const month = bj.getUTCMonth() + 1;
  const day = bj.getUTCDate();
  const hour = bj.getUTCHours();
  const minute = bj.getUTCMinutes();
  return `${year}年${month}月${day}日 ${hour}时${minute}分`;
}

function calculateDayNumber(firstSeenDate) {
  if (!firstSeenDate) return 1;
  const today = getBeijingDateKey();
  const first = new Date(firstSeenDate + 'T00:00:00Z');
  const current = new Date(today + 'T00:00:00Z');
  const diffTime = current.getTime() - first.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(1, diffDays + 1);
}

function getFreeTimesForDay(dayNumber) {
  if (dayNumber === 1) return FREE_TIMES_DAY1;
  if (dayNumber === 2) return FREE_TIMES_DAY2;
  return FREE_TIMES_DAY3_PLUS;
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
      console.error(`TG [${method}]:`, data.description);
    }
    return data;
  } catch (e) {
    console.error(`TG [${method}] Error:`, e.message);
    return { ok: false, error: e.message };
  }
}

async function recordSentMessage(userId, chatId, messageId) {
  try {
    await sql`INSERT INTO sent_messages (user_id, chat_id, message_id, sent_at) VALUES (${userId}, ${chatId}, ${messageId}, NOW())`;
  } catch (e) {
    console.error('recordSentMessage Error:', e.message);
  }
}

async function recordSentMessages(userId, chatId, messageIds) {
  for (const msgId of messageIds) {
    await recordSentMessage(userId, chatId, msgId);
  }
}

async function deleteExpiredMessages(userId, chatId) {
  try {
    const expireTime = new Date(Date.now() - MESSAGE_EXPIRE_MINUTES * 60 * 1000);
    const messages = await sql`
      SELECT id, message_id FROM sent_messages 
      WHERE user_id = ${userId} AND chat_id = ${chatId} AND sent_at < ${expireTime}
    `;
    if (messages && messages.length > 0) {
      console.log(`Deleting ${messages.length} expired messages for user ${userId}`);
      for (const msg of messages) {
        try {
          await sendTelegram('deleteMessage', { chat_id: chatId, message_id: msg.message_id });
        } catch (e) {}
        try {
          await sql`DELETE FROM sent_messages WHERE id = ${msg.id}`;
        } catch (e) {}
      }
    }
  } catch (e) {
    console.error('deleteExpiredMessages Error:', e.message);
  }
}

async function setState(userId, state, stateData) {
  try {
    const dataStr = JSON.stringify(stateData || {});
    const existing = await sql`SELECT user_id FROM user_states WHERE user_id = ${userId}`;
    if (existing && existing.length > 0) {
      await sql`UPDATE user_states SET state = ${state}, data = ${dataStr}, updated_at = NOW() WHERE user_id = ${userId}`;
    } else {
      await sql`INSERT INTO user_states (user_id, state, data, updated_at) VALUES (${userId}, ${state}, ${dataStr}, NOW())`;
    }
    return true;
  } catch (e) {
    console.error('setState Error:', e.message);
    return false;
  }
}

async function getState(userId) {
  try {
    const result = await sql`SELECT state, data FROM user_states WHERE user_id = ${userId}`;
    if (result && result.length > 0 && result[0].state) {
      let parsedData = {};
      try {
        parsedData = JSON.parse(result[0].data || '{}');
      } catch (e) {
        parsedData = {};
      }
      return { state: result[0].state, data: parsedData };
    }
  } catch (e) {
    console.error('getState Error:', e.message);
  }
  return { state: null, data: {} };
}

async function clearState(userId) {
  try {
    await sql`DELETE FROM user_states WHERE user_id = ${userId}`;
    return true;
  } catch (e) {
    console.error('clearState Error:', e.message);
    return false;
  }
}

async function getOrCreateUser(userId, username, firstName) {
  const dateKey = getBeijingDateKey();
  const nowTimestamp = Date.now();
  try {
    const result = await sql`SELECT * FROM users WHERE user_id = ${userId}`;
    if (!result || result.length === 0) {
      await sql`
        INSERT INTO users (user_id, username, first_name, first_seen_date, first_seen_timestamp, last_seen_date, last_seen_timestamp, date_key, daily_count, cooldown_index, last_redeem_time, total_redeem_count, total_cooldown_count, is_disabled)
        VALUES (${userId}, ${username || ''}, ${firstName || ''}, ${dateKey}, ${nowTimestamp}, ${dateKey}, ${nowTimestamp}, ${dateKey}, 0, 0, 0, 0, 0, false)
      `;
      return {
        userId: userId,
        username: username || '',
        firstName: firstName || '',
        firstSeenDate: dateKey,
        firstSeenTimestamp: nowTimestamp,
        lastSeenDate: dateKey,
        lastSeenTimestamp: nowTimestamp,
        dateKey: dateKey,
        dailyCount: 0,
        cooldownIndex: 0,
        lastRedeemTime: 0,
        totalRedeemCount: 0,
        totalCooldownCount: 0,
        isNewUser: true,
        isDisabled: false
      };
    }
    const user = result[0];
    let dailyCount = user.daily_count || 0;
    let cooldownIndex = user.cooldown_index || 0;
    let lastRedeemTime = parseInt(user.last_redeem_time) || 0;
    if (user.date_key !== dateKey) {
      dailyCount = 0;
      cooldownIndex = 0;
      lastRedeemTime = 0;
      await sql`
        UPDATE users 
        SET date_key = ${dateKey}, daily_count = 0, cooldown_index = 0, last_redeem_time = 0, 
            last_seen_date = ${dateKey}, last_seen_timestamp = ${nowTimestamp},
            username = ${username || user.username || ''}, first_name = ${firstName || user.first_name || ''}
        WHERE user_id = ${userId}
      `;
    } else {
      await sql`
        UPDATE users 
        SET last_seen_date = ${dateKey}, last_seen_timestamp = ${nowTimestamp},
            username = ${username || user.username || ''}, first_name = ${firstName || user.first_name || ''}
        WHERE user_id = ${userId}
      `;
    }
    return {
      userId: user.user_id,
      username: user.username || '',
      firstName: user.first_name || '',
      firstSeenDate: user.first_seen_date,
      firstSeenTimestamp: parseInt(user.first_seen_timestamp) || nowTimestamp,
      lastSeenDate: user.last_seen_date,
      lastSeenTimestamp: parseInt(user.last_seen_timestamp) || nowTimestamp,
      dateKey: dateKey,
      dailyCount: dailyCount,
      cooldownIndex: cooldownIndex,
      lastRedeemTime: lastRedeemTime,
      totalRedeemCount: user.total_redeem_count || 0,
      totalCooldownCount: user.total_cooldown_count || 0,
      isNewUser: false,
      isDisabled: user.is_disabled || false
    };
  } catch (e) {
    console.error('getOrCreateUser Error:', e.message);
    return {
      userId: userId,
      username: username || '',
      firstName: firstName || '',
      firstSeenDate: dateKey,
      firstSeenTimestamp: nowTimestamp,
      dateKey: dateKey,
      dailyCount: 0,
      cooldownIndex: 0,
      lastRedeemTime: 0,
      totalRedeemCount: 0,
      totalCooldownCount: 0,
      isNewUser: true,
      isDisabled: false
    };
  }
}

async function notifyAdminsNewUser(userId, username, firstName) {
  const timeStr = formatBeijingTimeReadable(Date.now());
  for (const adminId of ADMIN_IDS) {
    try {
      await sendTelegram('sendMessage', {
        chat_id: adminId,
        text: `🆕 <b>新用户登录</b>\n\n━━━━━━━━━━━━━━\n👤 <b>姓名</b>：${firstName || '未知'}\n👤 <b>用户名</b>：@${username || '无'}\n🆔 <b>ID</b>：<code>${userId}</code>\n⏰ <b>时间</b>：${timeStr}\n━━━━━━━━━━━━━━`,
        parse_mode: 'HTML'
      });
    } catch (e) {
      console.error('Notify admin new user error:', e.message);
    }
  }
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    if (req.query.setWebhook) {
      const webhookUrl = `https://${req.headers.host}/api/webhook`;
      const result = await sendTelegram('setWebhook', { url: webhookUrl });
      return res.status(200).json({ webhook: webhookUrl, result: result });
    }
    if (req.query.test) {
      try {
        const testResult = await sql`SELECT 1 as test`;
        return res.status(200).json({ db: 'connected', result: testResult });
      } catch (e) {
        return res.status(200).json({ db: 'error', error: e.message });
      }
    }
    return res.status(200).json({
      status: 'Bot is running',
      token: BOT_TOKEN ? 'OK' : 'Missing',
      database: DATABASE_URL ? 'OK' : 'Missing',
      admins: ADMIN_IDS,
      config: {
        FREE_TIMES_DAY1,
        FREE_TIMES_DAY2,
        FREE_TIMES_DAY3_PLUS,
        MAX_DAILY_TIMES,
        COOLDOWN_MINUTES,
        MESSAGE_EXPIRE_MINUTES
      }
    });
  }
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }
  try {
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

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || '';
  const firstName = msg.from.first_name || '';
  const text = msg.text || '';

  await deleteExpiredMessages(userId, chatId);

  const userState = await getState(userId);

  if (userState.state) {
    return await handleStateInput(chatId, userId, username, firstName, msg, userState);
  }

  if (text === '/admin' && isAdmin(userId)) {
    await clearState(userId);
    return await showAdminPanel(chatId, null);
  }

  if (text === '/c' && isAdmin(userId)) {
    await clearState(userId);
    return await sendTelegram('sendMessage', { chat_id: chatId, text: '✅ 已取消当前操作' });
  }

  if (text === '/cz' && isAdmin(userId)) {
    const dateKey = getBeijingDateKey();
    const nowTimestamp = Date.now();
    try {
      await sql`UPDATE users SET daily_count = 0, cooldown_index = 0, last_redeem_time = 0, first_seen_date = ${dateKey}, first_seen_timestamp = ${nowTimestamp}, date_key = ${dateKey} WHERE user_id = ${userId}`;
    } catch (e) {
      console.error('Reset Error:', e.message);
    }
    await clearState(userId);
    return await sendTelegram('sendMessage', { chat_id: chatId, text: '✅ 已重置为新用户状态（第1天）' });
  }

  if (text === '/p' && isAdmin(userId)) {
    await clearState(userId);
    return await showProductManagement(chatId, null, 1);
  }

  // ⚠️ 深层链接必须放在 /start 前面
  if (text === '/start dh' || text === '/dh') {
    await clearState(userId);
    const user = await getOrCreateUser(userId, username, firstName);
    if (user.isNewUser) {
      await notifyAdminsNewUser(userId, username, firstName);
    }
    return await showRedeem(chatId, userId, username, firstName, null);
  }

  if (text === '/start v' || text === '/v') {
    await clearState(userId);
    const user = await getOrCreateUser(userId, username, firstName);
    if (user.isNewUser) {
      await notifyAdminsNewUser(userId, username, firstName);
    }
    return await showVIP(chatId, null);
  }

  // 普通 /start 放最后
  if (text === '/start' || text === '/start ') {
    await clearState(userId);
    const user = await getOrCreateUser(userId, username, firstName);
    if (user.isNewUser) {
      await notifyAdminsNewUser(userId, username, firstName);
    }
    return await showWelcome(chatId, null);
  }
}

async function handleStateInput(chatId, userId, username, firstName, msg, userState) {
  const text = msg.text || '';
  const state = userState.state;
  const data = userState.data || {};

  if (state === 'waiting_file_id') {
    if (!isAdmin(userId)) {
      await clearState(userId);
      return;
    }
    let fileId = null;
    let fileType = '';
    if (msg.photo && msg.photo.length > 0) {
      fileId = msg.photo[msg.photo.length - 1].file_id;
      fileType = '图片';
    } else if (msg.document) {
      fileId = msg.document.file_id;
      fileType = '文件';
    } else if (msg.video) {
      fileId = msg.video.file_id;
      fileType = '视频';
    } else if (msg.audio) {
      fileId = msg.audio.file_id;
      fileType = '音频';
    } else if (msg.voice) {
      fileId = msg.voice.file_id;
      fileType = '语音';
    } else if (msg.sticker) {
      fileId = msg.sticker.file_id;
      fileType = '贴纸';
    } else if (msg.animation) {
      fileId = msg.animation.file_id;
      fileType = 'GIF';
    }
    if (fileId) {
      await clearState(userId);
      return await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: `📎 <b>${fileType} File ID</b>\n\n<code>${fileId}</code>\n\n💡 点击上方代码即可复制`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '↩️ 返回管理面板', callback_data: 'admin' }]]
        }
      });
    } else {
      return await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '❌ 无法识别\n\n请发送：图片、视频、文件、音频、贴纸或GIF',
        reply_markup: {
          inline_keyboard: [[{ text: '↩️ 返回管理面板', callback_data: 'admin' }]]
        }
      });
    }
  }

  if (state === 'waiting_keyword') {
    if (!isAdmin(userId)) {
      await clearState(userId);
      return;
    }
    const keyword = text.trim();
    if (!keyword) {
      return await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '❌ 关键词不能为空，请重新输入：',
        reply_markup: {
          inline_keyboard: [[{ text: '↩️ 取消', callback_data: 'product_manage' }]]
        }
      });
    }
    try {
      const existing = await sql`SELECT id FROM products WHERE keyword = ${keyword}`;
      if (existing && existing.length > 0) {
        return await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: '❌ 该关键词已存在，请输入其他：',
          reply_markup: {
            inline_keyboard: [[{ text: '↩️ 取消', callback_data: 'product_manage' }]]
          }
        });
      }
      const insertResult = await sql`INSERT INTO products (keyword) VALUES (${keyword}) RETURNING id`;
      const productId = insertResult[0].id;
      await setState(userId, 'waiting_product_content', { productId: productId, keyword: keyword });
      return await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: `✅ 关键词「${keyword}」创建成功！\n\n📝 请发送内容（图片/视频）\n可连续发送多条`,
        reply_markup: {
          inline_keyboard: [[{ text: '✅ 完成上架', callback_data: 'finish_product_' + productId }]]
        }
      });
    } catch (e) {
      console.error('Create product error:', e.message);
      return await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '❌ 创建失败：' + e.message,
        reply_markup: {
          inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'product_manage' }]]
        }
      });
    }
  }

  if (state === 'waiting_product_content') {
    if (!isAdmin(userId)) {
      await clearState(userId);
      return;
    }
    const productId = data.productId;
    const keyword = data.keyword || '';
    if (!productId) {
      await clearState(userId);
      return await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '❌ 商品信息丢失，请重新上架',
        reply_markup: {
          inline_keyboard: [[{ text: '↩️ 返回商品管理', callback_data: 'product_manage' }]]
        }
      });
    }
    let contentType = null;
    let content = '';
    let fileId = null;
    if (msg.photo && msg.photo.length > 0) {
      contentType = 'photo';
      fileId = msg.photo[msg.photo.length - 1].file_id;
      content = msg.caption || '';
    } else if (msg.video) {
      contentType = 'video';
      fileId = msg.video.file_id;
      content = msg.caption || '';
    } else if (msg.document) {
      contentType = 'document';
      fileId = msg.document.file_id;
      content = msg.caption || '';
    } else if (msg.animation) {
      contentType = 'animation';
      fileId = msg.animation.file_id;
      content = msg.caption || '';
    }
    if (!contentType || !fileId) {
      return await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '❌ 请发送图片或视频',
        reply_markup: {
          inline_keyboard: [[{ text: '✅ 完成上架', callback_data: 'finish_product_' + productId }]]
        }
      });
    }
    try {
      const countResult = await sql`SELECT COUNT(*) as cnt FROM product_contents WHERE product_id = ${productId}`;
      const sortOrder = parseInt(countResult[0].cnt || 0) + 1;
      await sql`
        INSERT INTO product_contents (product_id, content_type, content, file_id, sort_order)
        VALUES (${productId}, ${contentType}, ${content}, ${fileId}, ${sortOrder})
      `;
      return await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: `✅ 已添加第 ${sortOrder} 条内容\n\n继续发送或点击完成`,
        reply_markup: {
          inline_keyboard: [[{ text: '✅ 完成上架', callback_data: 'finish_product_' + productId }]]
        }
      });
    } catch (e) {
      console.error('Add content error:', e.message);
      return await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '❌ 添加失败：' + e.message,
        reply_markup: {
          inline_keyboard: [[{ text: '✅ 完成上架', callback_data: 'finish_product_' + productId }]]
        }
      });
    }
  }

  if (state === 'waiting_order') {
    const orderNumber = text.trim();
    const failCount = data.failCount || 0;
    if (!orderNumber) {
      return await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '❌ 请输入订单号：',
        reply_markup: {
          inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'join_vip' }]]
        }
      });
    }
    if (orderNumber.startsWith('20260')) {
      const nowTimestamp = Date.now();
      const timeStr = formatBeijingTimeReadable(nowTimestamp);
      try {
        await sql`
          INSERT INTO tickets (user_id, username, first_name, order_number, created_timestamp)
          VALUES (${userId}, ${username}, ${firstName}, ${orderNumber}, ${nowTimestamp})
        `;
        console.log(`Ticket created for user ${userId}, order ${orderNumber}`);
      } catch (e) {
        console.error('Create ticket error:', e.message);
      }
      for (const adminId of ADMIN_IDS) {
        try {
          await sendTelegram('sendMessage', {
            chat_id: adminId,
            text: `🎫 <b>新工单</b>\n\n━━━━━━━━━━━━━━\n👤 <b>姓名</b>：${firstName || '未知'}\n👤 <b>用户名</b>：@${username || '无'}\n🆔 <b>ID</b>：<code>${userId}</code>\n📝 <b>订单号</b>：<code>${orderNumber}</code>\n⏰ <b>时间</b>：${timeStr}\n━━━━━━━━━━━━━━`,
            parse_mode: 'HTML'
          });
        } catch (e) {
          console.error('Notify admin error:', e.message);
        }
      }
      await clearState(userId);
      return await sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '🎉 <b>验证成功！</b>\n\n欢迎加入VIP会员！',
        parse_mode: 'HTML',
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
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: '❌ <b>验证失败</b>\n\n请确认订单号后重新开始',
          parse_mode: 'HTML'
        });
        return await showWelcome(chatId, null);
      } else {
        await setState(userId, 'waiting_order', { failCount: failCount + 1 });
        return await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: '❌ <b>订单号格式不正确</b>\n\n请检查后重新输入：',
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'join_vip' }]]
          }
        });
      }
    }
  }
}

async function handleCallback(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const username = callbackQuery.from.username || '';
  const firstName = callbackQuery.from.first_name || '';
  const cbData = callbackQuery.data;
  const messageId = callbackQuery.message.message_id;

  await sendTelegram('answerCallbackQuery', { callback_query_id: callbackQuery.id });
  await deleteExpiredMessages(userId, chatId);

  if (cbData === 'admin') {
    if (!isAdmin(userId)) return;
    await clearState(userId);
    return await showAdminPanel(chatId, messageId);
  }

  if (cbData === 'get_file_id') {
    if (!isAdmin(userId)) return;
    await setState(userId, 'waiting_file_id', {});
    return await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '📷 请发送需要获取 File ID 的内容：\n\n支持：图片、视频、文件、音频、贴纸、GIF',
      reply_markup: {
        inline_keyboard: [[{ text: '↩️ 返回管理面板', callback_data: 'admin' }]]
      }
    });
  }

  if (cbData === 'product_manage') {
    if (!isAdmin(userId)) return;
    await clearState(userId);
    return await showProductManagement(chatId, messageId, 1);
  }

  if (cbData.startsWith('products_page_')) {
    if (!isAdmin(userId)) return;
    const page = parseInt(cbData.replace('products_page_', '')) || 1;
    return await showProductManagement(chatId, messageId, page);
  }

  if (cbData === 'add_product') {
    if (!isAdmin(userId)) return;
    await setState(userId, 'waiting_keyword', {});
    return await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '📝 请输入新商品的关键词：',
      reply_markup: {
        inline_keyboard: [[{ text: '↩️ 取消', callback_data: 'product_manage' }]]
      }
    });
  }

  if (cbData.startsWith('finish_product_')) {
    if (!isAdmin(userId)) return;
    const productId = parseInt(cbData.replace('finish_product_', ''));
    await clearState(userId);
    let keyword = '未知';
    let contentCount = 0;
    try {
      const pResult = await sql`SELECT keyword FROM products WHERE id = ${productId}`;
      if (pResult && pResult.length > 0) keyword = pResult[0].keyword;
      const cResult = await sql`SELECT COUNT(*) as cnt FROM product_contents WHERE product_id = ${productId}`;
      if (cResult && cResult.length > 0) contentCount = cResult[0].cnt || 0;
    } catch (e) {
      console.error('Get product info error:', e.message);
    }
    return await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ <b>商品上架完成！</b>\n\n📦 关键词：${keyword}\n📄 内容：${contentCount} 条`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '↩️ 返回商品管理', callback_data: 'product_manage' }]]
      }
    });
  }

  if (cbData.startsWith('del_product_confirm_')) {
    if (!isAdmin(userId)) return;
    const productId = cbData.replace('del_product_confirm_', '');
    let keyword = '未知';
    try {
      const pResult = await sql`SELECT keyword FROM products WHERE id = ${parseInt(productId)}`;
      if (pResult && pResult.length > 0) keyword = pResult[0].keyword;
    } catch (e) {
      console.error('Get product error:', e.message);
    }
    return await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `⚠️ 确定删除商品「${keyword}」？\n\n此操作不可恢复！`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ 确认删除', callback_data: 'del_product_' + productId }],
          [{ text: '↩️ 取消', callback_data: 'product_manage' }]
        ]
      }
    });
  }

  if (cbData.startsWith('del_product_') && !cbData.includes('confirm')) {
    if (!isAdmin(userId)) return;
    const productId = parseInt(cbData.replace('del_product_', ''));
    try {
      await sql`DELETE FROM product_contents WHERE product_id = ${productId}`;
      await sql`DELETE FROM products WHERE id = ${productId}`;
    } catch (e) {
      console.error('Delete product error:', e.message);
    }
    return await showProductManagement(chatId, messageId, 1);
  }

  if (cbData === 'ticket_manage') {
    if (!isAdmin(userId)) return;
    return await showTickets(chatId, messageId, 1);
  }

  if (cbData.startsWith('tickets_page_')) {
    if (!isAdmin(userId)) return;
    const page = parseInt(cbData.replace('tickets_page_', '')) || 1;
    return await showTickets(chatId, messageId, page);
  }

  if (cbData.startsWith('ticket_detail_')) {
    if (!isAdmin(userId)) return;
    const ticketId = cbData.replace('ticket_detail_', '');
    return await showTicketDetail(chatId, messageId, ticketId);
  }

  if (cbData.startsWith('del_ticket_confirm_')) {
    if (!isAdmin(userId)) return;
    const ticketId = cbData.replace('del_ticket_confirm_', '');
    return await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '⚠️ 确定删除此工单？\n\n此操作不可恢复！',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ 确认删除', callback_data: 'del_ticket_' + ticketId }],
          [{ text: '↩️ 取消', callback_data: 'ticket_detail_' + ticketId }]
        ]
      }
    });
  }

  if (cbData.startsWith('del_ticket_') && !cbData.includes('confirm')) {
    if (!isAdmin(userId)) return;
    const ticketId = parseInt(cbData.replace('del_ticket_', ''));
    try {
      await sql`DELETE FROM tickets WHERE id = ${ticketId}`;
    } catch (e) {
      console.error('Delete ticket error:', e.message);
    }
    return await showAdminPanel(chatId, messageId);
  }

  if (cbData === 'user_manage') {
    if (!isAdmin(userId)) return;
    return await showUsers(chatId, messageId, 1);
  }

  if (cbData.startsWith('users_page_')) {
    if (!isAdmin(userId)) return;
    const page = parseInt(cbData.replace('users_page_', '')) || 1;
    return await showUsers(chatId, messageId, page);
  }

  if (cbData.startsWith('user_detail_')) {
    if (!isAdmin(userId)) return;
    const targetUserId = cbData.replace('user_detail_', '');
    return await showUserDetail(chatId, messageId, targetUserId);
  }

  if (cbData.startsWith('toggle_user_')) {
    if (!isAdmin(userId)) return;
    const targetUserId = cbData.replace('toggle_user_', '');
    try {
      await sql`UPDATE users SET is_disabled = NOT is_disabled WHERE user_id = ${targetUserId}`;
    } catch (e) {
      console.error('Toggle user error:', e.message);
    }
    return await showUserDetail(chatId, messageId, targetUserId);
  }

  if (cbData === 'join_vip') {
    return await showVIP(chatId, messageId);
  }

  if (cbData === 'verify_payment') {
    if (FILE_IDS.PAYMENT_TUTORIAL) {
      await sendTelegram('sendPhoto', {
        chat_id: chatId,
        photo: FILE_IDS.PAYMENT_TUTORIAL,
        protect_content: true
      });
    }
    await setState(userId, 'waiting_order', { failCount: 0 });
    return await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: '📋 <b>查找订单号步骤：</b>\n\n1️⃣ 打开支付应用（支付宝/微信）\n2️⃣ 点击「我的」\n3️⃣ 点击「账单」\n4️⃣ 找到本次付款记录\n5️⃣ 点击「账单详情」\n6️⃣ 点击「更多」\n7️⃣ 复制「订单号」\n\n━━━━━━━━━━━━━━\n\n✏️ 请输入您的订单号：',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'join_vip' }]]
      }
    });
  }

  if (cbData === 'redeem') {
    return await showRedeem(chatId, userId, username, firstName, messageId);
  }

  if (cbData === 'back_start') {
    await clearState(userId);
    return await showWelcome(chatId, messageId);
  }

  if (cbData.startsWith('dh_page_')) {
    const page = parseInt(cbData.replace('dh_page_', '')) || 1;
    return await showRedeemPage(chatId, messageId, page);
  }

  if (cbData.startsWith('redeem_kw_')) {
    const keyword = cbData.replace('redeem_kw_', '');
    return await handleRedeemProduct(chatId, userId, username, firstName, keyword, messageId);
  }

  if (cbData.startsWith('redeem_page_')) {
    const match = cbData.match(/redeem_page_(.+)_(\d+)$/);
    if (match) {
      const keyword = match[1];
      const page = parseInt(match[2]) || 1;
      return await sendProductContents(chatId, userId, keyword, page, messageId);
    }
  }

  if (cbData === 'back_redeem') {
    return await showRedeem(chatId, userId, username, firstName, messageId);
  }
}

async function showWelcome(chatId, messageId) {
  const text = '🎊 <b>喜迎马年新春</b> 🐴\n\n🧧 新春资源免费获取 🧧\n\n━━━━━━━━━━━━━━\n✨ 限时福利 · 等你来拿 ✨\n━━━━━━━━━━━━━━';
  const keyboard = {
    inline_keyboard: [
      [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
      [{ text: '🎁 免费兑换', callback_data: 'redeem' }]
    ]
  };
  if (messageId) {
    return await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }
  if (FILE_IDS.WELCOME_IMAGE) {
    return await sendTelegram('sendPhoto', {
      chat_id: chatId,
      photo: FILE_IDS.WELCOME_IMAGE,
      caption: text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      protect_content: true
    });
  }
  return await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

async function showVIP(chatId, messageId) {
  const text = '🎊 <b>喜迎新春（特价）</b>\n\n💎 <b>VIP会员特权：</b>\n\n✅ 专属中转通道\n✅ 优先审核入群\n✅ 7x24小时客服\n✅ 定期福利活动\n\n━━━━━━━━━━━━━━';
  const keyboard = {
    inline_keyboard: [
      [{ text: '✅ 我已付款，开始验证', callback_data: 'verify_payment' }],
      [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
    ]
  };
  if (FILE_IDS.VIP_PROMO) {
    if (messageId) {
      try {
        await sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
      } catch (e) {}
    }
    return await sendTelegram('sendPhoto', {
      chat_id: chatId,
      photo: FILE_IDS.VIP_PROMO,
      caption: text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      protect_content: true
    });
  }
  if (messageId) {
    return await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }
  return await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

async function showRedeem(chatId, userId, username, firstName, messageId) {
  const user = await getOrCreateUser(userId, username, firstName);
  const dailyCount = user.dailyCount || 0;
  const cooldownIndex = user.cooldownIndex || 0;
  const lastRedeemTime = user.lastRedeemTime || 0;
  const dayNumber = calculateDayNumber(user.firstSeenDate);
  const freeLimit = getFreeTimesForDay(dayNumber);

  console.log(`showRedeem: userId=${userId}, dayNumber=${dayNumber}, freeLimit=${freeLimit}, dailyCount=${dailyCount}, cooldownIndex=${cooldownIndex}, lastRedeemTime=${lastRedeemTime}`);

  if (dailyCount >= MAX_DAILY_TIMES) {
    const text = '⏰ <b>今日次数已用完</b>\n\n🌙 明天再来～\n\n💡 VIP会员无限制';
    const keyboard = {
      inline_keyboard: [
        [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
        [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
      ]
    };
    if (messageId) {
      return await sendTelegram('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    }
    return await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  if (dailyCount < freeLimit) {
    return await showRedeemPage(chatId, messageId, 1);
  }

  const now = Date.now();
  const cdIndex = Math.min(cooldownIndex, COOLDOWN_MINUTES.length - 1);
  const cdTimeMs = COOLDOWN_MINUTES[cdIndex] * 60 * 1000;
  const elapsed = now - lastRedeemTime;

  console.log(`Cooldown check: cdIndex=${cdIndex}, cdTimeMs=${cdTimeMs}, elapsed=${elapsed}, needWait=${elapsed < cdTimeMs}`);

  if (lastRedeemTime > 0 && elapsed < cdTimeMs) {
    const remaining = Math.ceil((cdTimeMs - elapsed) / 1000);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const text = `⏰ <b>冷却中...</b>\n\n⏳ 剩余时间：${mins}分${secs}秒\n\n💡 VIP会员无需等待`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
        [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
      ]
    };
    if (messageId) {
      return await sendTelegram('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    }
    return await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  return await showRedeemPage(chatId, messageId, 1);
}

async function showRedeemPage(chatId, messageId, page) {
  let products = [];
  try {
    products = await sql`SELECT * FROM products ORDER BY created_at ASC`;
  } catch (e) {
    console.error('Get products error:', e.message);
  }

  if (!products || products.length === 0) {
    const text = '🎁 <b>兑换中心</b>\n\n⏳ 暂无商品...';
    const keyboard = {
      inline_keyboard: [
        [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
        [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
      ]
    };
    if (messageId) {
      return await sendTelegram('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    }
    return await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  const pageSize = 10;
  const totalPages = Math.ceil(products.length / pageSize);
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageProducts = products.slice(start, start + pageSize);

  const buttons = [];
  for (const p of pageProducts) {
    buttons.push([{ text: '📦 ' + p.keyword, callback_data: 'redeem_kw_' + p.keyword }]);
  }

  buttons.push([{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }]);

  const navButtons = [];
  if (currentPage > 1) {
    navButtons.push({ text: '⬅️', callback_data: 'dh_page_' + (currentPage - 1) });
  }
  if (currentPage < totalPages) {
    navButtons.push({ text: '➡️', callback_data: 'dh_page_' + (currentPage + 1) });
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }

  buttons.push([{ text: '↩️ 返回首页', callback_data: 'back_start' }]);

  const text = `🎁 <b>兑换中心</b>\n\n📄 ${currentPage}/${totalPages} 页`;

  if (messageId) {
    return await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  }
  return await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function handleRedeemProduct(chatId, userId, username, firstName, keyword, messageId) {
  const user = await getOrCreateUser(userId, username, firstName);
  const dayNumber = calculateDayNumber(user.firstSeenDate);
  const freeLimit = getFreeTimesForDay(dayNumber);
  const dailyCount = user.dailyCount || 0;
  const cooldownIndex = user.cooldownIndex || 0;
  const totalRedeemCount = user.totalRedeemCount || 0;
  const totalCooldownCount = user.totalCooldownCount || 0;

  const nowTimestamp = Date.now();
  let newCooldownIndex = cooldownIndex;
  let newTotalCooldownCount = totalCooldownCount;

  if (dailyCount >= freeLimit) {
    newCooldownIndex = Math.min(cooldownIndex + 1, COOLDOWN_MINUTES.length - 1);
    newTotalCooldownCount = totalCooldownCount + 1;
  }

  try {
    await sql`
      UPDATE users 
      SET daily_count = ${dailyCount + 1}, 
          cooldown_index = ${newCooldownIndex}, 
          last_redeem_time = ${nowTimestamp},
          total_redeem_count = ${totalRedeemCount + 1},
          total_cooldown_count = ${newTotalCooldownCount}
      WHERE user_id = ${userId}
    `;
    console.log(`Updated user ${userId}: dailyCount=${dailyCount + 1}, cooldownIndex=${newCooldownIndex}, lastRedeemTime=${nowTimestamp}`);
  } catch (e) {
    console.error('Update redeem error:', e.message);
  }

  return await sendProductContents(chatId, userId, keyword, 1, messageId);
}

async function sendProductContents(chatId, userId, keyword, page, messageId) {
  let productId = null;
  try {
    const pResult = await sql`SELECT id FROM products WHERE keyword = ${keyword}`;
    if (!pResult || pResult.length === 0) {
      return await sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 商品不存在' });
    }
    productId = pResult[0].id;
  } catch (e) {
    console.error('Get product error:', e.message);
    return await sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 获取失败' });
  }

  let contents = [];
  try {
    contents = await sql`SELECT * FROM product_contents WHERE product_id = ${productId} ORDER BY sort_order ASC`;
  } catch (e) {
    console.error('Get contents error:', e.message);
  }

  if (!contents || contents.length === 0) {
    return await sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 暂无内容' });
  }

  const pageSize = 10;
  const totalPages = Math.ceil(contents.length / pageSize);
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageContents = contents.slice(start, start + pageSize);

  if (messageId) {
    try {
      await sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageId });
    } catch (e) {}
  }

  const mediaGroup = [];
  for (let i = 0; i < pageContents.length; i++) {
    const c = pageContents[i];
    const idx = start + i + 1;
    if (c.content_type === 'photo' && c.file_id) {
      mediaGroup.push({
        type: 'photo',
        media: c.file_id,
        caption: i === 0 ? `📦 <b>${keyword}</b> - ${currentPage}/${totalPages} 组\n\n[${idx}/${contents.length}]` : `[${idx}/${contents.length}]`,
        parse_mode: i === 0 ? 'HTML' : undefined
      });
    } else if (c.content_type === 'video' && c.file_id) {
      mediaGroup.push({
        type: 'video',
        media: c.file_id,
        caption: i === 0 ? `📦 <b>${keyword}</b> - ${currentPage}/${totalPages} 组\n\n[${idx}/${contents.length}]` : `[${idx}/${contents.length}]`,
        parse_mode: i === 0 ? 'HTML' : undefined
      });
    }
  }

  let sentMessageIds = [];

  if (mediaGroup.length > 0) {
    try {
      const result = await sendTelegram('sendMediaGroup', {
        chat_id: chatId,
        media: mediaGroup,
        protect_content: true
      });
      if (result.ok && result.result) {
        for (const msg of result.result) {
          sentMessageIds.push(msg.message_id);
        }
      }
    } catch (e) {
      console.error('Send media group error:', e.message);
    }
  }

  if (sentMessageIds.length > 0) {
    await recordSentMessages(userId, chatId, sentMessageIds);
  }

  const buttons = [];
  if (currentPage < totalPages) {
    buttons.push([{ text: `📥 继续发送 (${currentPage + 1}/${totalPages})`, callback_data: `redeem_page_${keyword}_${currentPage + 1}` }]);
  }
  buttons.push([{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }]);
  buttons.push([{ text: '↩️ 返回兑换中心', callback_data: 'back_redeem' }]);

  const statusText = currentPage < totalPages
    ? `✨ 第 ${currentPage}/${totalPages} 组已发送`
    : `✅ 全部 ${contents.length} 条发送完毕！`;

  const statusResult = await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: statusText,
    reply_markup: { inline_keyboard: buttons }
  });

  if (statusResult.ok && statusResult.result) {
    await recordSentMessage(userId, chatId, statusResult.result.message_id);
  }

  return statusResult;
}

async function showAdminPanel(chatId, messageId) {
  let userCount = 0;
  let productCount = 0;
  let ticketCount = 0;
  try {
    const r = await sql`SELECT COUNT(*) as cnt FROM users`;
    userCount = r[0].cnt || 0;
  } catch (e) {}
  try {
    const r = await sql`SELECT COUNT(*) as cnt FROM products`;
    productCount = r[0].cnt || 0;
  } catch (e) {}
  try {
    const r = await sql`SELECT COUNT(*) as cnt FROM tickets`;
    ticketCount = r[0].cnt || 0;
  } catch (e) {}

  const text = `🔧 <b>管理员面板</b>\n\n📊 用户：${userCount}\n📦 商品：${productCount}\n🎫 工单：${ticketCount}`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '📎 获取 File ID', callback_data: 'get_file_id' }],
      [{ text: '📦 商品管理', callback_data: 'product_manage' }],
      [{ text: '🎫 工单管理', callback_data: 'ticket_manage' }],
      [{ text: '👥 用户管理', callback_data: 'user_manage' }]
    ]
  };

  if (messageId) {
    return await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }
  return await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

async function showProductManagement(chatId, messageId, page) {
  let products = [];
  try {
    products = await sql`SELECT * FROM products ORDER BY created_at ASC`;
  } catch (e) {}

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil((products?.length || 0) / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageProducts = (products || []).slice(start, start + pageSize);

  const buttons = [[{ text: '➕ 上架新关键词', callback_data: 'add_product' }]];

  for (const p of pageProducts) {
    let cnt = 0;
    try {
      const r = await sql`SELECT COUNT(*) as c FROM product_contents WHERE product_id = ${p.id}`;
      cnt = r[0].c || 0;
    } catch (e) {}
    buttons.push([
      { text: `📦 ${p.keyword} (${cnt}条)`, callback_data: 'view_' + p.id },
      { text: '🗑️', callback_data: 'del_product_confirm_' + p.id }
    ]);
  }

  const navButtons = [];
  if (currentPage > 1) {
    navButtons.push({ text: '⬅️', callback_data: 'products_page_' + (currentPage - 1) });
  }
  if (currentPage < totalPages) {
    navButtons.push({ text: '➡️', callback_data: 'products_page_' + (currentPage + 1) });
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }

  buttons.push([{ text: '↩️ 返回', callback_data: 'admin' }]);

  const text = `📦 <b>商品管理</b>\n\n📄 ${currentPage}/${totalPages} 页 · 共 ${products?.length || 0} 个`;

  if (messageId) {
    return await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  }
  return await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showTickets(chatId, messageId, page) {
  let tickets = [];
  try {
    tickets = await sql`SELECT * FROM tickets ORDER BY created_at DESC`;
  } catch (e) {}

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil((tickets?.length || 0) / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageTickets = (tickets || []).slice(start, start + pageSize);

  const buttons = [];
  for (const t of pageTickets) {
    const timeStr = t.created_timestamp ? formatBeijingTimeReadable(t.created_timestamp) : '未知';
    buttons.push([{ text: `👤 ${t.first_name || '未知'} - ${timeStr}`, callback_data: 'ticket_detail_' + t.id }]);
  }

  const navButtons = [];
  if (currentPage > 1) {
    navButtons.push({ text: '⬅️', callback_data: 'tickets_page_' + (currentPage - 1) });
  }
  if (currentPage < totalPages) {
    navButtons.push({ text: '➡️', callback_data: 'tickets_page_' + (currentPage + 1) });
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }

  buttons.push([{ text: '↩️ 返回', callback_data: 'admin' }]);

  const text = (tickets?.length || 0) === 0
    ? '🎫 <b>工单管理</b>\n\n暂无工单'
    : `🎫 <b>工单管理</b>\n\n📄 ${currentPage}/${totalPages} 页 · 共 ${tickets.length} 个`;

  if (messageId) {
    return await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  }
  return await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showTicketDetail(chatId, messageId, ticketId) {
  let ticket = null;
  try {
    const r = await sql`SELECT * FROM tickets WHERE id = ${parseInt(ticketId)}`;
    if (r && r.length > 0) {
      ticket = r[0];
    }
  } catch (e) {}

  if (!ticket) {
    return await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '❌ 工单不存在',
      reply_markup: {
        inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'ticket_manage' }]]
      }
    });
  }

  const timeStr = ticket.created_timestamp
    ? formatBeijingTimeReadable(parseInt(ticket.created_timestamp))
    : '未知';

  const text = `🎫 <b>工单详情</b>\n\n━━━━━━━━━━━━━━\n👤 <b>姓名</b>：${ticket.first_name || '未知'}\n👤 <b>用户名</b>：@${ticket.username || '无'}\n🆔 <b>用户ID</b>：<code>${ticket.user_id}</code>\n📝 <b>订单号</b>：<code>${ticket.order_number}</code>\n⏰ <b>提交时间</b>：${timeStr}\n━━━━━━━━━━━━━━`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🗑️ 删除此工单', callback_data: 'del_ticket_confirm_' + ticketId }],
      [{ text: '↩️ 返回工单列表', callback_data: 'ticket_manage' }]
    ]
  };

  return await sendTelegram('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

async function showUsers(chatId, messageId, page) {
  let users = [];
  try {
    users = await sql`SELECT * FROM users ORDER BY first_seen_timestamp DESC`;
  } catch (e) {}

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil((users?.length || 0) / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageUsers = (users || []).slice(start, start + pageSize);

  const buttons = [];
  for (const u of pageUsers) {
    const status = u.is_disabled ? '🔴' : '🟢';
    const dayNumber = calculateDayNumber(u.first_seen_date);
    buttons.push([{ text: `${status} ${u.first_name || '未知'} (第${dayNumber}天)`, callback_data: 'user_detail_' + u.user_id }]);
  }

  const navButtons = [];
  if (currentPage > 1) {
    navButtons.push({ text: '⬅️', callback_data: 'users_page_' + (currentPage - 1) });
  }
  if (currentPage < totalPages) {
    navButtons.push({ text: '➡️', callback_data: 'users_page_' + (currentPage + 1) });
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }

  buttons.push([{ text: '↩️ 返回', callback_data: 'admin' }]);

  const text = (users?.length || 0) === 0
    ? '👥 <b>用户管理</b>\n\n暂无用户'
    : `👥 <b>用户管理</b>\n\n📄 ${currentPage}/${totalPages} 页 · 共 ${users.length} 人`;

  if (messageId) {
    return await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  }
  return await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showUserDetail(chatId, messageId, targetUserId) {
  let user = null;
  try {
    const r = await sql`SELECT * FROM users WHERE user_id = ${targetUserId}`;
    if (r && r.length > 0) {
      user = r[0];
    }
  } catch (e) {
    console.error('Get user error:', e.message);
  }

  if (!user) {
    return await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: '❌ 用户不存在',
      reply_markup: {
        inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'user_manage' }]]
      }
    });
  }

  const status = user.is_disabled ? '🔴 已停用' : '🟢 正常';
  const dayNumber = calculateDayNumber(user.first_seen_date);
  const freeLimit = getFreeTimesForDay(dayNumber);

  const firstSeenTimeStr = user.first_seen_timestamp
    ? formatBeijingTimeReadable(parseInt(user.first_seen_timestamp))
    : (user.first_seen_date || '未知');

  const lastSeenTimeStr = user.last_seen_timestamp
    ? formatBeijingTimeReadable(parseInt(user.last_seen_timestamp))
    : (user.last_seen_date || '未知');

  const totalRedeemCount = user.total_redeem_count || 0;
  const dailyCount = user.daily_count || 0;
  const cooldownIndex = user.cooldown_index || 0;
  const totalCooldownCount = user.total_cooldown_count || 0;

  const text = `👤 <b>用户详情</b>\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `👤 <b>姓名</b>：${user.first_name || '未知'}\n` +
    `👤 <b>用户名</b>：@${user.username || '无'}\n` +
    `🆔 <b>ID</b>：<code>${user.user_id}</code>\n` +
    `📅 <b>首次登录</b>：${firstSeenTimeStr}\n` +
    `📅 <b>最近访问</b>：${lastSeenTimeStr}\n` +
    `📊 <b>总兑换</b>：${totalRedeemCount} 次\n` +
    `🆓 <b>今日兑换</b>：${dailyCount}/${MAX_DAILY_TIMES} 次（免费${freeLimit}次）\n` +
    `⏱️ <b>今日冷却</b>：${cooldownIndex} 次\n` +
    `⏱️ <b>总冷却</b>：${totalCooldownCount} 次\n` +
    `📆 <b>用户天数</b>：第 ${dayNumber} 天\n` +
    `⚡ <b>状态</b>：${status}\n` +
    `━━━━━━━━━━━━━━`;

  const toggleText = user.is_disabled ? '✅ 启用用户' : '🔴 停用用户';

  const keyboard = {
    inline_keyboard: [
      [{ text: toggleText, callback_data: 'toggle_user_' + targetUserId }],
      [{ text: '↩️ 返回用户列表', callback_data: 'user_manage' }]
    ]
  };

  return await sendTelegram('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}
