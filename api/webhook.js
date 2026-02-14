
// api/webhook.js

// ╔════════════════════════════════════════════════════════════════════════════╗
// ║                           🔧 配置区 - 需要替换                               ║
// ╠════════════════════════════════════════════════════════════════════════════╣
// ║ 以下配置需要在 Vercel 环境变量中设置，或直接在代码中修改                        ║
// ╚════════════════════════════════════════════════════════════════════════════╝

// ==================== FILE ID 配置 ====================
// 在 /admin 中使用「获取 File ID」功能获取，然后填入下方
const FILE_IDS = {
  // VIP宣传图片的 File ID（在 /v 页面显示）
  VIP_PROMO: '',
  
  // 支付教程图片的 File ID（在验证订单时显示）
  PAYMENT_TUTORIAL: '',
  
  // 欢迎图片的 File ID（在 /start 页面显示）
  WELCOME_IMAGE: ''
};

// ==================== VIP 群链接 ====================
// 验证成功后用户点击加入的群链接
const VIP_GROUP_LINK = 'https://t.me/+495j5rWmApsxYzg9';

// ==================== 环境变量（在 Vercel 中设置）====================
// YOUR_BOT_TOKEN: 你的 Telegram Bot Token（从 @BotFather 获取）
// DATABASE_URL: Neon 数据库连接字符串
// ADMIN_IDS: 管理员用户ID，多个用逗号分隔，如：123456789,987654321

// ╔════════════════════════════════════════════════════════════════════════════╗
// ║                           以下代码无需修改                                   ║
// ╚════════════════════════════════════════════════════════════════════════════╝

const BOT_TOKEN = process.env.YOUR_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

// ==================== Neon 数据库连接 ====================
const { neon } = require('@neondatabase/serverless');
const sql = neon(DATABASE_URL);

// ==================== 初始化数据库表 ====================
async function initDB() {
  try {
    // 用户表
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

    // 用户状态表（状态机）
    await sql`
      CREATE TABLE IF NOT EXISTS user_states (
        user_id BIGINT PRIMARY KEY,
        state VARCHAR(100),
        data TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // 工单表
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

    // 商品表
    await sql`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        keyword VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // 商品内容表
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

// ==================== 工具函数 ====================

// 检查是否为管理员
function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

// 获取北京时间日期键（用于每日重置）
function getBeijingDateKey() {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return beijingTime.toISOString().split('T')[0];
}

// 格式化北京时间
function formatBeijingTime(date) {
  const d = date ? new Date(date) : new Date();
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return bj.toISOString().replace('T', ' ').substring(0, 19);
}

// 发送 Telegram API 请求
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
      console.error(`Telegram API Error [${method}]:`, data.description);
    }
    return data;
  } catch (e) {
    console.error(`Telegram API Exception [${method}]:`, e.message);
    return { ok: false, error: e.message };
  }
}

// 设置用户状态
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

// 获取用户状态
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

// 清除用户状态
async function clearState(userId) {
  try {
    await sql`DELETE FROM user_states WHERE user_id = ${userId}`;
  } catch (e) {
    console.error('clearState Error:', e.message);
  }
}

// 获取或创建用户
async function getOrCreateUser(userId, username, firstName) {
  const dateKey = getBeijingDateKey();
  try {
    const result = await sql`SELECT * FROM users WHERE user_id = ${userId}`;

    if (result.length === 0) {
      // 新用户
      await sql`
        INSERT INTO users (user_id, username, first_name, first_seen_date, last_seen_date, date_key, daily_count, cooldown_index, last_redeem_time)
        VALUES (${userId}, ${username || ''}, ${firstName || ''}, ${dateKey}, ${dateKey}, ${dateKey}, 0, 0, 0)
      `;
      return {
        userId,
        username,
        firstName,
        firstSeenDate: dateKey,
        dateKey,
        dailyCount: 0,
        cooldownIndex: 0,
        lastRedeemTime: 0,
        isNew: true,
        isDisabled: false
      };
    }

    const user = result[0];

    // 日期变化，重置每日数据
    if (user.date_key !== dateKey) {
      await sql`
        UPDATE users 
        SET date_key = ${dateKey}, daily_count = 0, cooldown_index = 0, last_seen_date = ${dateKey}, 
            username = ${username || user.username}, first_name = ${firstName || user.first_name} 
        WHERE user_id = ${userId}
      `;
      return {
        userId: user.user_id,
        username: username || user.username,
        firstName: firstName || user.first_name,
        firstSeenDate: user.first_seen_date,
        dateKey: dateKey,
        dailyCount: 0,
        cooldownIndex: 0,
        lastRedeemTime: 0,
        isNew: user.first_seen_date === dateKey,
        isDisabled: user.is_disabled
      };
    }

    // 更新最后访问时间
    await sql`
      UPDATE users 
      SET last_seen_date = ${dateKey}, username = ${username || user.username}, first_name = ${firstName || user.first_name} 
      WHERE user_id = ${userId}
    `;

    return {
      userId: user.user_id,
      username: user.username,
      firstName: user.first_name,
      firstSeenDate: user.first_seen_date,
      dateKey: user.date_key,
      dailyCount: user.daily_count || 0,
      cooldownIndex: user.cooldown_index || 0,
      lastRedeemTime: parseInt(user.last_redeem_time) || 0,
      isNew: user.first_seen_date === dateKey,
      isDisabled: user.is_disabled
    };
  } catch (e) {
    console.error('getOrCreateUser Error:', e.message);
    return {
      userId,
      dailyCount: 0,
      cooldownIndex: 0,
      lastRedeemTime: 0,
      isNew: true,
      isDisabled: false
    };
  }
}

// 编辑消息或发送新消息
async function editOrSend(chatId, messageId, text, buttons, parseMode = null) {
  const keyboard = { inline_keyboard: buttons };
  const params = { chat_id: chatId, text, reply_markup: keyboard };
  if (parseMode) {
    params.parse_mode = parseMode;
  }
  
  if (messageId) {
    params.message_id = messageId;
    const result = await sendTelegram('editMessageText', params);
    if (!result.ok && result.description && result.description.includes('message is not modified')) {
      return result;
    }
    if (!result.ok) {
      delete params.message_id;
      return sendTelegram('sendMessage', params);
    }
    return result;
  }
  return sendTelegram('sendMessage', params);
}

// ==================== 主处理器 ====================
module.exports = async (req, res) => {
  // GET 请求处理
  if (req.method === 'GET') {
    // 设置 Webhook
    if (req.query.setWebhook) {
      const webhookUrl = `https://${req.headers.host}/api/webhook`;
      const result = await sendTelegram('setWebhook', { url: webhookUrl });
      return res.status(200).json({ webhook: webhookUrl, result });
    }
    
    // 初始化数据库
    if (req.query.init) {
      const success = await initDB();
      return res.status(200).json({ success, message: success ? 'Database initialized successfully' : 'Database initialization failed' });
    }
    
    // 状态检查
    return res.status(200).json({
      status: 'Bot is running',
      token: BOT_TOKEN ? 'Configured' : 'Missing',
      database: DATABASE_URL ? 'Configured' : 'Missing',
      admins: ADMIN_IDS
    });
  }

  // 非 POST 请求
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

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
    console.error('Main Handler Error:', e.message);
  }

  return res.status(200).send('OK');
};

// ==================== 消息处理 ====================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || '';
  const firstName = msg.from.first_name || '';
  const text = msg.text || '';

  // 获取用户当前状态
  const userState = await getState(userId);

  // ==================== 管理员命令 ====================
  
  // /admin - 管理面板
  if (text === '/admin' && isAdmin(userId)) {
    await clearState(userId);
    return showAdminPanel(chatId);
  }

  // /c - 取消当前操作
  if (text === '/c' && isAdmin(userId)) {
    await clearState(userId);
    return sendTelegram('sendMessage', { chat_id: chatId, text: '✅ 已取消当前操作' });
  }

  // /cz - 重置为新用户状态（测试用）
  if (text === '/cz' && isAdmin(userId)) {
    const dateKey = getBeijingDateKey();
    await sql`
      UPDATE users 
      SET daily_count = 0, cooldown_index = 0, last_redeem_time = 0, first_seen_date = ${dateKey}, date_key = ${dateKey} 
      WHERE user_id = ${userId}
    `;
    await clearState(userId);
    return sendTelegram('sendMessage', { chat_id: chatId, text: '✅ 已重置为新用户状态（当天免费3次）' });
  }

  // /p - 商品管理
  if (text === '/p' && isAdmin(userId)) {
    await clearState(userId);
    return showProductManagement(chatId);
  }

  // ==================== 普通用户命令 ====================
  
  // /start - 欢迎页面
  if (text === '/start' || text === '/start ') {
    await clearState(userId);
    await getOrCreateUser(userId, username, firstName);
    return showWelcome(chatId);
  }

  // /start dh 或 /dh - 兑换中心（支持深层链接）
  if (text === '/start dh' || text === '/dh') {
    await clearState(userId);
    return showRedeem(chatId, userId, username, firstName);
  }

  // /v - VIP会员页面
  if (text === '/v') {
    return showVIP(chatId);
  }

  // ==================== 状态机处理 ====================
  if (userState.state) {
    return handleStateInput(chatId, userId, username, firstName, msg, userState);
  }
}

// ==================== 状态输入处理 ====================
async function handleStateInput(chatId, userId, username, firstName, msg, userState) {
  const text = msg.text || '';
  const { state, data } = userState;

  // ========== 管理员：获取 File ID ==========
  if (state === 'waiting_file_id' && isAdmin(userId)) {
    let fileId = null;
    
    if (msg.photo) {
      fileId = msg.photo[msg.photo.length - 1].file_id;
    } else if (msg.document) {
      fileId = msg.document.file_id;
    } else if (msg.video) {
      fileId = msg.video.file_id;
    } else if (msg.audio) {
      fileId = msg.audio.file_id;
    } else if (msg.voice) {
      fileId = msg.voice.file_id;
    } else if (msg.sticker) {
      fileId = msg.sticker.file_id;
    } else if (msg.animation) {
      fileId = msg.animation.file_id;
    }

    if (fileId) {
      await clearState(userId);
      return sendTelegram('sendMessage', {
        chat_id: chatId,
        text: `📎 <b>File ID 获取成功</b>\n\n<code>${fileId}</code>\n\n点击上方代码即可复制`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '↩️ 返回管理面板', callback_data: 'admin' }]]
        }
      });
    } else {
      return sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '❌ 无法识别，请发送图片、视频、文件、音频、贴纸或GIF',
        reply_markup: {
          inline_keyboard: [[{ text: '↩️ 返回管理面板', callback_data: 'admin' }]]
        }
      });
    }
  }

  // ========== 管理员：输入关键词 ==========
  if (state === 'waiting_keyword' && isAdmin(userId)) {
    const keyword = text.trim();
    
    if (!keyword) {
      return sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '❌ 关键词不能为空，请重新输入：',
        reply_markup: {
          inline_keyboard: [[{ text: '↩️ 取消', callback_data: 'product_manage' }]]
        }
      });
    }

    // 检查关键词是否已存在
    const existing = await sql`SELECT id FROM products WHERE keyword = ${keyword}`;
    if (existing.length > 0) {
      return sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '❌ 该关键词已存在，请输入其他关键词：',
        reply_markup: {
          inline_keyboard: [[{ text: '↩️ 取消', callback_data: 'product_manage' }]]
        }
      });
    }

    // 创建新商品
    const result = await sql`INSERT INTO products (keyword) VALUES (${keyword}) RETURNING id`;
    const productId = result[0].id;
    await setState(userId, 'waiting_product_content', { productId, keyword });

    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ 关键词「${keyword}」创建成功！\n\n📝 现在请发送内容（支持以下格式）：\n• 文字消息\n• 图片\n• 视频\n• 文件\n• 音频\n• GIF动图\n• 转发的消息\n\n可连续发送多条，完成后点击下方按钮`,
      reply_markup: {
        inline_keyboard: [[{ text: '✅ 完成上架', callback_data: `finish_product_${productId}` }]]
      }
    });
  }

  // ========== 管理员：添加商品内容 ==========
  if (state === 'waiting_product_content' && isAdmin(userId)) {
    const { productId, keyword } = data;
    let contentType = 'text';
    let content = text;
    let fileId = null;

    // 识别不同类型的内容
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
    } else if (msg.voice) {
      contentType = 'voice';
      fileId = msg.voice.file_id;
      content = '';
    } else if (msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_date) {
      // 转发消息，作为文本处理，不显示来源
      contentType = 'text';
      content = text || msg.caption || '[转发内容]';
    }

    // 获取当前内容数量
    const countResult = await sql`SELECT COUNT(*) as cnt FROM product_contents WHERE product_id = ${productId}`;
    const sortOrder = parseInt(countResult[0].cnt) + 1;

    // 插入内容
    await sql`
      INSERT INTO product_contents (product_id, content_type, content, file_id, sort_order) 
      VALUES (${productId}, ${contentType}, ${content || ''}, ${fileId}, ${sortOrder})
    `;

    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ 已添加第 ${sortOrder} 条内容\n\n继续发送更多内容，或点击完成上架`,
      reply_markup: {
        inline_keyboard: [[{ text: '✅ 完成上架', callback_data: `finish_product_${productId}` }]]
      }
    });
  }

  // ========== 用户：输入订单号 ==========
  if (state === 'waiting_order') {
    const orderNumber = text.trim();
    const failCount = data.failCount || 0;

    // 私密验证逻辑：以 20260 开头
    if (orderNumber.startsWith('20260')) {
      // 验证成功，创建工单
      await sql`
        INSERT INTO tickets (user_id, username, first_name, order_number) 
        VALUES (${userId}, ${username}, ${firstName}, ${orderNumber})
      `;

      // 通知所有管理员
      for (const adminId of ADMIN_IDS) {
        await sendTelegram('sendMessage', {
          chat_id: adminId,
          text: `🎫 <b>新工单通知</b>\n\n━━━━━━━━━━━━━━\n👤 姓名：${firstName || '未知'}\n👤 用户名：@${username || '无'}\n🆔 用户ID：<code>${userId}</code>\n📝 订单号：<code>${orderNumber}</code>\n⏰ 时间：${formatBeijingTime(new Date())}\n━━━━━━━━━━━━━━`,
          parse_mode: 'HTML'
        });
      }

      await clearState(userId);
      
      return sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '🎉 验证成功！\n\n欢迎加入VIP会员大家庭！',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎉 加入会员群', url: VIP_GROUP_LINK }],
            [{ text: '🎁 免费兑换', callback_data: 'redeem' }]
          ]
        }
      });
    } else {
      // 验证失败
      if (failCount >= 1) {
        // 第二次失败，返回首页
        await clearState(userId);
        await sendTelegram('sendMessage', {
          chat_id: chatId,
          text: '❌ 订单号验证失败，请确认后重新开始'
        });
        return showWelcome(chatId);
      } else {
        // 第一次失败，允许重试
        await setState(userId, 'waiting_order', { failCount: failCount + 1 });
        return sendTelegram('sendMessage', {
          chat_id: chatId,
          text: '❌ 订单号格式不正确，请检查后重新输入：',
          reply_markup: {
            inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'join_vip' }]]
          }
        });
      }
    }
  }
}

// ==================== 回调处理 ====================
async function handleCallback(cbQuery) {
  const chatId = cbQuery.message.chat.id;
  const userId = cbQuery.from.id;
  const username = cbQuery.from.username || '';
  const firstName = cbQuery.from.first_name || '';
  const data = cbQuery.data;
  const messageId = cbQuery.message.message_id;

  // 响应回调
  await sendTelegram('answerCallbackQuery', { callback_query_id: cbQuery.id });

  // ==================== 管理员功能 ====================

  // 管理面板
  if (data === 'admin' && isAdmin(userId)) {
    await clearState(userId);
    return showAdminPanel(chatId, messageId);
  }

  // 获取 File ID
  if (data === 'get_file_id' && isAdmin(userId)) {
    await setState(userId, 'waiting_file_id');
    return editOrSend(chatId, messageId, '📷 请发送图片、视频、文件、音频、贴纸或GIF\n\n我会返回对应的 File ID', [
      [{ text: '↩️ 返回管理面板', callback_data: 'admin' }]
    ]);
  }

  // 商品管理
  if (data === 'product_manage' && isAdmin(userId)) {
    await clearState(userId);
    return showProductManagement(chatId, messageId);
  }

  // 添加商品
  if (data === 'add_product' && isAdmin(userId)) {
    await setState(userId, 'waiting_keyword');
    return editOrSend(chatId, messageId, '📝 请输入新商品的关键词：', [
      [{ text: '↩️ 取消', callback_data: 'product_manage' }]
    ]);
  }

  // 完成上架
  if (data.startsWith('finish_product_') && isAdmin(userId)) {
    const productId = parseInt(data.replace('finish_product_', ''));
    await clearState(userId);
    
    // 获取商品信息
    const product = await sql`SELECT keyword FROM products WHERE id = ${productId}`;
    const contentCount = await sql`SELECT COUNT(*) as cnt FROM product_contents WHERE product_id = ${productId}`;
    
    const keyword = product.length > 0 ? product[0].keyword : '未知';
    const count = contentCount.length > 0 ? contentCount[0].cnt : 0;

    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ 商品上架完成！\n\n📦 关键词：${keyword}\n📄 内容数量：${count} 条`,
      reply_markup: {
        inline_keyboard: [[{ text: '↩️ 返回商品管理', callback_data: 'product_manage' }]]
      }
    });
  }

  // 删除商品确认
  if (data.startsWith('del_product_confirm_') && isAdmin(userId)) {
    const productId = data.replace('del_product_confirm_', '');
    const product = await sql`SELECT keyword FROM products WHERE id = ${parseInt(productId)}`;
    const keyword = product.length > 0 ? product[0].keyword : '未知';
    
    return editOrSend(chatId, messageId, `⚠️ 确定要删除商品「${keyword}」吗？\n\n此操作将同时删除所有关联内容，且不可恢复！`, [
      [{ text: '✅ 确认删除', callback_data: `del_product_${productId}` }],
      [{ text: '↩️ 取消', callback_data: 'product_manage' }]
    ]);
  }

  // 执行删除商品
  if (data.startsWith('del_product_') && !data.includes('confirm') && isAdmin(userId)) {
    const productId = parseInt(data.replace('del_product_', ''));
    await sql`DELETE FROM product_contents WHERE product_id = ${productId}`;
    await sql`DELETE FROM products WHERE id = ${productId}`;
    return showProductManagement(chatId, messageId);
  }

  // 工单管理
  if (data === 'ticket_manage' && isAdmin(userId)) {
    return showTickets(chatId, messageId, 1);
  }

  // 工单分页
  if (data.startsWith('tickets_page_') && isAdmin(userId)) {
    const page = parseInt(data.replace('tickets_page_', ''));
    return showTickets(chatId, messageId, page);
  }

  // 工单详情
  if (data.startsWith('ticket_detail_') && isAdmin(userId)) {
    const ticketId = data.replace('ticket_detail_', '');
    return showTicketDetail(chatId, messageId, ticketId);
  }

  // 删除工单确认
  if (data.startsWith('del_ticket_confirm_') && isAdmin(userId)) {
    const ticketId = data.replace('del_ticket_confirm_', '');
    return editOrSend(chatId, messageId, '⚠️ 确定要删除此工单吗？\n\n此操作不可恢复！', [
      [{ text: '✅ 确认删除', callback_data: `del_ticket_${ticketId}` }],
      [{ text: '↩️ 取消', callback_data: `ticket_detail_${ticketId}` }]
    ]);
  }

  // 执行删除工单
  if (data.startsWith('del_ticket_') && !data.includes('confirm') && isAdmin(userId)) {
    const ticketId = parseInt(data.replace('del_ticket_', ''));
    await sql`DELETE FROM tickets WHERE id = ${ticketId}`;
    return showAdminPanel(chatId, messageId);
  }

  // 用户管理
  if (data === 'user_manage' && isAdmin(userId)) {
    return showUsers(chatId, messageId, 1);
  }

  // 用户分页
  if (data.startsWith('users_page_') && isAdmin(userId)) {
    const page = parseInt(data.replace('users_page_', ''));
    return showUsers(chatId, messageId, page);
  }

  // 用户详情
  if (data.startsWith('user_detail_') && isAdmin(userId)) {
    const targetUserId = data.replace('user_detail_', '');
    return showUserDetail(chatId, messageId, targetUserId);
  }

  // 切换用户状态
  if (data.startsWith('toggle_user_') && isAdmin(userId)) {
    const targetUserId = data.replace('toggle_user_', '');
    await sql`UPDATE users SET is_disabled = NOT is_disabled WHERE user_id = ${targetUserId}`;
    return showUserDetail(chatId, messageId, targetUserId);
  }

  // 商品管理分页
  if (data.startsWith('products_page_') && isAdmin(userId)) {
    const page = parseInt(data.replace('products_page_', ''));
    return showProductManagement(chatId, messageId, page);
  }

  // ==================== 用户功能 ====================

  // 加入会员
  if (data === 'join_vip') {
    return showVIP(chatId, messageId);
  }

  // 兑换中心
  if (data === 'redeem') {
    return showRedeem(chatId, userId, username, firstName, messageId);
  }

  // 验证付款
  if (data === 'verify_payment') {
    // 发送支付教程图片（如果有配置）
    if (FILE_IDS.PAYMENT_TUTORIAL) {
      await sendTelegram('sendPhoto', {
        chat_id: chatId,
        photo: FILE_IDS.PAYMENT_TUTORIAL,
        protect_content: true
      });
    }

    await setState(userId, 'waiting_order', { failCount: 0 });
    
    return sendTelegram('sendMessage', {
      chat_id: chatId,
      text: '📋 <b>查找订单号步骤：</b>\n\n1️⃣ 打开支付应用（支付宝/微信）\n2️⃣ 点击「我的」\n3️⃣ 点击「账单」\n4️⃣ 找到本次付款记录\n5️⃣ 点击进入「账单详情」\n6️⃣ 点击「更多」\n7️⃣ 找到并复制「订单号」\n\n━━━━━━━━━━━━━━\n\n✏️ 请输入您的订单号：',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '↩️ 返回', callback_data: 'join_vip' }]]
      }
    });
  }

  // 返回首页
  if (data === 'back_start') {
    await clearState(userId);
    return showWelcome(chatId, messageId);
  }

  // 兑换商品
  if (data.startsWith('redeem_kw_')) {
    const keyword = data.replace('redeem_kw_', '');
    return handleRedeemProduct(chatId, userId, username, firstName, keyword, messageId);
  }

  // 兑换内容分页
  if (data.startsWith('redeem_page_')) {
    const match = data.match(/redeem_page_(.+)_(\d+)$/);
    if (match) {
      const keyword = match[1];
      const page = parseInt(match[2]);
      return sendProductContents(chatId, userId, keyword, page, messageId);
    }
  }

  // 返回兑换中心
  if (data === 'back_redeem') {
    return showRedeem(chatId, userId, username, firstName, messageId);
  }

  // 兑换中心分页
  if (data.startsWith('dh_page_')) {
    const page = parseInt(data.replace('dh_page_', ''));
    return showRedeemPage(chatId, messageId, page);
  }
}

// ==================== 页面显示函数 ====================

// 欢迎页面
async function showWelcome(chatId, messageId = null) {
  const text = `🎊 <b>喜迎马年新春</b> 🐴\n\n🧧 新春资源免费获取 🧧\n\n━━━━━━━━━━━━━━\n✨ 限时福利 · 等你来拿 ✨\n━━━━━━━━━━━━━━`;

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
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  // 如果有欢迎图片
  if (FILE_IDS.WELCOME_IMAGE) {
    return sendTelegram('sendPhoto', {
      chat_id: chatId,
      photo: FILE_IDS.WELCOME_IMAGE,
      caption: text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      protect_content: true
    });
  }

  return sendTelegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

// VIP会员页面
async function showVIP(chatId, messageId = null) {
  const text = `🎊 <b>喜迎新春（特价）</b>\n\n💎 <b>VIP会员特权说明：</b>\n\n✅ 专属中转通道\n✅ 优先审核入群\n✅ 7x24小时客服支持\n✅ 定期福利活动\n\n━━━━━━━━━━━━━━`;

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
      parse_mode: 'HTML',
      reply_markup: keyboard,
      protect_content: true
    });
  }

  if (messageId) {
    return sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  return sendTelegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

// 兑换中心
async function showRedeem(chatId, userId, username, firstName, messageId = null) {
  const user = await getOrCreateUser(userId, username, firstName);
  const { dailyCount, cooldownIndex, lastRedeemTime, isNew } = user;

  // 频率控制参数
  const freeLimit = isNew ? 3 : 2;  // 新用户3次，老用户2次
  const cooldowns = [5, 15, 30, 50, 60, 60];  // 冷却时间（分钟）
  const maxDaily = 6;  // 每日最多6次

  // 检查每日上限
  if (dailyCount >= maxDaily) {
    return editOrSend(chatId, messageId, '⏰ 今日兑换次数已用完\n\n🌙 明天再来吧～\n\n💡 升级VIP会员可无限兑换', [
      [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
      [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
    ]);
  }

  // 免费次数内
  if (dailyCount < freeLimit) {
    return showRedeemPage(chatId, messageId, 1);
  }

  // 检查冷却时间
  const now = Date.now();
  const cdIndex = Math.min(cooldownIndex, cooldowns.length - 1);
  const cdTime = cooldowns[cdIndex] * 60 * 1000;  // 转换为毫秒
  const elapsed = now - (lastRedeemTime || 0);

  if (elapsed < cdTime) {
    const remaining = Math.ceil((cdTime - elapsed) / 1000);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    
    return editOrSend(chatId, messageId, `⏰ 冷却中...\n\n⏳ 剩余时间：${mins}分${secs}秒\n\n💡 升级VIP会员可免除等待`, [
      [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
      [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
    ]);
  }

  return showRedeemPage(chatId, messageId, 1);
}

// 兑换中心分页
async function showRedeemPage(chatId, messageId = null, page = 1) {
  const products = await sql`SELECT * FROM products ORDER BY created_at ASC`;

  if (products.length === 0) {
    return editOrSend(chatId, messageId, '🎁 <b>兑换中心</b>\n\n⏳ 暂无商品，请等待管理员上架...', [
      [{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }],
      [{ text: '↩️ 返回首页', callback_data: 'back_start' }]
    ], 'HTML');
  }

  const pageSize = 10;
  const totalPages = Math.ceil(products.length / pageSize);
  const start = (page - 1) * pageSize;
  const pageProducts = products.slice(start, start + pageSize);

  // 商品按钮
  const buttons = pageProducts.map(p => [{ text: `📦 ${p.keyword}`, callback_data: `redeem_kw_${p.keyword}` }]);

  // 始终显示加入会员按钮
  buttons.push([{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }]);

  // 分页按钮
  const navButtons = [];
  if (page > 1) {
    navButtons.push({ text: '⬅️ 上一页', callback_data: `dh_page_${page - 1}` });
  }
  if (page < totalPages) {
    navButtons.push({ text: '下一页 ➡️', callback_data: `dh_page_${page + 1}` });
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }

  buttons.push([{ text: '↩️ 返回首页', callback_data: 'back_start' }]);

  const text = `🎁 <b>兑换中心</b>\n\n📄 第 ${page}/${totalPages} 页\n\n请选择要兑换的内容：`;

  return editOrSend(chatId, messageId, text, buttons, 'HTML');
}

// 处理兑换商品
async function handleRedeemProduct(chatId, userId, username, firstName, keyword, messageId) {
  const user = await getOrCreateUser(userId, username, firstName);
  const freeLimit = user.isNew ? 3 : 2;

  // 更新用户兑换数据
  await sql`
    UPDATE users 
    SET daily_count = daily_count + 1, 
        cooldown_index = CASE WHEN daily_count >= ${freeLimit} THEN LEAST(cooldown_index + 1, 5) ELSE cooldown_index END,
        last_redeem_time = ${Date.now()} 
    WHERE user_id = ${userId}
  `;

  return sendProductContents(chatId, userId, keyword, 1, messageId);
}

// 发送商品内容
async function sendProductContents(chatId, userId, keyword, page, messageId = null) {
  // 获取商品
  const productResult = await sql`SELECT id FROM products WHERE keyword = ${keyword}`;
  if (productResult.length === 0) {
    return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 商品不存在' });
  }
  const productId = productResult[0].id;

  // 获取内容
  const contents = await sql`SELECT * FROM product_contents WHERE product_id = ${productId} ORDER BY sort_order ASC`;

  if (contents.length === 0) {
    return sendTelegram('sendMessage', { chat_id: chatId, text: '❌ 该商品暂无内容' });
  }

  const pageSize = 10;
  const totalPages = Math.ceil(contents.length / pageSize);
  const start = (page - 1) * pageSize;
  const pageContents = contents.slice(start, start + pageSize);

  // 删除之前的消息
  if (messageId) {
    await sendTelegram('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
  }

  // 分类处理内容
  let textParts = [];
  let mediaItems = [];

  for (let i = 0; i < pageContents.length; i++) {
    const c = pageContents[i];
    const idx = start + i + 1;

    if (c.file_id) {
      mediaItems.push({
        type: c.content_type,
        fileId: c.file_id,
        caption: c.content,
        idx
      });
    } else if (c.content) {
      textParts.push(`📄 [${idx}] ${c.content}`);
    }
  }

  // 发送合并的文本内容（禁止保存）
  if (textParts.length > 0) {
    const combinedText = `📦 <b>${keyword}</b> (${page}/${totalPages})\n\n${textParts.join('\n\n')}`;
    await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: combinedText,
      parse_mode: 'HTML',
      protect_content: true  // 禁止保存/转发
    });
  }

  // 发送媒体文件（禁止保存）
  for (const m of mediaItems) {
    const caption = `📦 [${m.idx}/${contents.length}] ${m.caption || ''}`;
    const baseParams = {
      chat_id: chatId,
      caption,
      protect_content: true  // 禁止保存/转发
    };

    if (m.type === 'photo') {
      await sendTelegram('sendPhoto', { ...baseParams, photo: m.fileId });
    } else if (m.type === 'document') {
      await sendTelegram('sendDocument', { ...baseParams, document: m.fileId });
    } else if (m.type === 'video') {
      await sendTelegram('sendVideo', { ...baseParams, video: m.fileId });
    } else if (m.type === 'audio') {
      await sendTelegram('sendAudio', { ...baseParams, audio: m.fileId });
    } else if (m.type === 'animation') {
      await sendTelegram('sendAnimation', { ...baseParams, animation: m.fileId });
    } else if (m.type === 'voice') {
      await sendTelegram('sendVoice', { ...baseParams, voice: m.fileId });
    }
  }

  // 操作按钮
  const buttons = [];

  // 继续发送按钮
  if (page < totalPages) {
    buttons.push([{ text: `📥 继续发送 (${page + 1}/${totalPages})`, callback_data: `redeem_page_${keyword}_${page + 1}` }]);
  }

  // 始终显示加入会员按钮
  buttons.push([{ text: '💎 加入会员（新春特价）', callback_data: 'join_vip' }]);

  // 返回按钮
  buttons.push([{ text: '↩️ 返回兑换中心', callback_data: 'back_redeem' }]);

  // 状态提示
  const statusText = page < totalPages
    ? `✨ 第 ${page}/${totalPages} 组已发送`
    : `✅ 全部 ${contents.length} 条内容发送完毕！`;

  return sendTelegram('sendMessage', {
    chat_id: chatId,
    text: statusText,
    reply_markup: { inline_keyboard: buttons }
  });
}

// ==================== 管理员页面函数 ====================

// 管理面板
async function showAdminPanel(chatId, messageId = null) {
  let userCount = 0, productCount = 0, ticketCount = 0;
  
  try {
    const u = await sql`SELECT COUNT(*) as cnt FROM users`;
    const p = await sql`SELECT COUNT(*) as cnt FROM products`;
    const t = await sql`SELECT COUNT(*) as cnt FROM tickets`;
    userCount = u[0].cnt;
    productCount = p[0].cnt;
    ticketCount = t[0].cnt;
  } catch (e) {
    console.error('Stats Error:', e.message);
  }

  const text = `🔧 <b>管理员面板</b>\n\n📊 <b>数据统计：</b>\n• 👥 用户数：${userCount}\n• 📦 商品数：${productCount}\n• 🎫 工单数：${ticketCount}`;

  const buttons = [
    [{ text: '📎 获取 File ID', callback_data: 'get_file_id' }],
    [{ text: '📦 商品管理', callback_data: 'product_manage' }],
    [{ text: '🎫 工单管理', callback_data: 'ticket_manage' }],
    [{ text: '👥 用户管理', callback_data: 'user_manage' }]
  ];

  return editOrSend(chatId, messageId, text, buttons, 'HTML');
}

// 商品管理
async function showProductManagement(chatId, messageId = null, page = 1) {
  const products = await sql`SELECT * FROM products ORDER BY created_at ASC`;

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(products.length / pageSize));
  const start = (page - 1) * pageSize;
  const pageProducts = products.slice(start, start + pageSize);

  const buttons = [[{ text: '➕ 上架新关键词', callback_data: 'add_product' }]];

  // 商品列表
  for (const p of pageProducts) {
    const cnt = await sql`SELECT COUNT(*) as c FROM product_contents WHERE product_id = ${p.id}`;
    const contentCount = cnt[0].c;
    buttons.push([
      { text: `📦 ${p.keyword} (${contentCount}条)`, callback_data: `view_product_${p.id}` },
      { text: '🗑️ 删除', callback_data: `del_product_confirm_${p.id}` }
    ]);
  }

  // 分页按钮
  const navButtons = [];
  if (page > 1) {
    navButtons.push({ text: '⬅️', callback_data: `products_page_${page - 1}` });
  }
  if (page < totalPages) {
    navButtons.push({ text: '➡️', callback_data: `products_page_${page + 1}` });
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }

  buttons.push([{ text: '↩️ 返回管理面板', callback_data: 'admin' }]);

  const text = `📦 <b>商品管理</b>\n\n📄 第 ${page}/${totalPages} 页 · 共 ${products.length} 个商品`;

  return editOrSend(chatId, messageId, text, buttons, 'HTML');
}

// 工单列表
async function showTickets(chatId, messageId = null, page = 1) {
  const tickets = await sql`SELECT * FROM tickets ORDER BY created_at ASC`;

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(tickets.length / pageSize));
  const start = (page - 1) * pageSize;
  const pageTickets = tickets.slice(start, start + pageSize);

  const buttons = [];

  // 工单列表
  for (const t of pageTickets) {
    buttons.push([{
      text: `👤 ${t.first_name || '未知'} (${t.user_id})`,
      callback_data: `ticket_detail_${t.id}`
    }]);
  }

  // 分页按钮
  const navButtons = [];
  if (page > 1) {
    navButtons.push({ text: '⬅️', callback_data: `tickets_page_${page - 1}` });
  }
  if (page < totalPages) {
    navButtons.push({ text: '➡️', callback_data: `tickets_page_${page + 1}` });
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }

  buttons.push([{ text: '↩️ 返回管理面板', callback_data: 'admin' }]);

  const text = tickets.length === 0
    ? '🎫 <b>工单管理</b>\n\n暂无工单'
    : `🎫 <b>工单管理</b>\n\n📄 第 ${page}/${totalPages} 页 · 共 ${tickets.length} 个工单`;

  return editOrSend(chatId, messageId, text, buttons, 'HTML');
}

// 工单详情
async function showTicketDetail(chatId, messageId, ticketId) {
  const result = await sql`SELECT * FROM tickets WHERE id = ${parseInt(ticketId)}`;

  if (result.length === 0) {
    return editOrSend(chatId, messageId, '❌ 工单不存在', [
      [{ text: '↩️ 返回工单列表', callback_data: 'ticket_manage' }]
    ]);
  }

  const t = result[0];
  
  const text = `🎫 <b>工单详情</b>\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `👤 <b>姓名</b>：${t.first_name || '未知'}\n` +
    `👤 <b>用户名</b>：@${t.username || '无'}\n` +
    `🆔 <b>用户ID</b>：<code>${t.user_id}</code>\n` +
    `📝 <b>订单号</b>：<code>${t.order_number}</code>\n` +
    `⏰ <b>提交时间</b>：${formatBeijingTime(t.created_at)}\n` +
    `━━━━━━━━━━━━━━`;

  const buttons = [
    [{ text: '🗑️ 删除此工单', callback_data: `del_ticket_confirm_${ticketId}` }],
    [{ text: '↩️ 返回工单列表', callback_data: 'ticket_manage' }]
  ];

  return editOrSend(chatId, messageId, text, buttons, 'HTML');
}

// 用户列表
async function showUsers(chatId, messageId = null, page = 1) {
  const users = await sql`SELECT * FROM users ORDER BY first_seen_date ASC`;

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(users.length / pageSize));
  const start = (page - 1) * pageSize;
  const pageUsers = users.slice(start, start + pageSize);

  const buttons = [];

  // 用户列表
  for (const u of pageUsers) {
    const status = u.is_disabled ? '🔴' : '🟢';
    buttons.push([{
      text: `${status} ${u.first_name || '未知'} (${u.user_id})`,
      callback_data: `user_detail_${u.user_id}`
    }]);
  }

  // 分页按钮
  const navButtons = [];
  if (page > 1) {
    navButtons.push({ text: '⬅️', callback_data: `users_page_${page - 1}` });
  }
  if (page < totalPages) {
    navButtons.push({ text: '➡️', callback_data: `users_page_${page + 1}` });
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }

  buttons.push([{ text: '↩️ 返回管理面板', callback_data: 'admin' }]);

  const text = users.length === 0
    ? '👥 <b>用户管理</b>\n\n暂无用户'
    : `👥 <b>用户管理</b>\n\n📄 第 ${page}/${totalPages} 页 · 共 ${users.length} 人`;

  return editOrSend(chatId, messageId, text, buttons, 'HTML');
}

// 用户详情
async function showUserDetail(chatId, messageId, targetUserId) {
  const result = await sql`SELECT * FROM users WHERE user_id = ${targetUserId}`;

  if (result.length === 0) {
    return editOrSend(chatId, messageId, '❌ 用户不存在', [
      [{ text: '↩️ 返回用户列表', callback_data: 'user_manage' }]
    ]);
  }

  const u = result[0];
  const status = u.is_disabled ? '🔴 已停用' : '🟢 正常';
  const isNew = u.first_seen_date === u.date_key;

  const text = `👤 <b>用户详情</b>\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `👤 <b>姓名</b>：${u.first_name || '未知'}\n` +
    `👤 <b>用户名</b>：@${u.username || '无'}\n` +
    `🆔 <b>用户ID</b>：<code>${u.user_id}</code>\n` +
    `📅 <b>首次访问</b>：${u.first_seen_date || '未知'}\n` +
    `📅 <b>最近访问</b>：${u.last_seen_date || '未知'}\n` +
    `📊 <b>今日兑换</b>：${u.daily_count || 0} 次\n` +
    `⏱️ <b>冷却等级</b>：${u.cooldown_index || 0}\n` +
    `🆕 <b>新用户</b>：${isNew ? '是' : '否'}\n` +
    `⚡ <b>状态</b>：${status}\n` +
    `━━━━━━━━━━━━━━`;

  const toggleText = u.is_disabled ? '✅ 启用用户' : '🔴 停用用户';

  const buttons = [
    [{ text: toggleText, callback_data: `toggle_user_${targetUserId}` }],
    [{ text: '↩️ 返回用户列表', callback_data: 'user_manage' }]
  ];

  return editOrSend(chatId, messageId, text, buttons, 'HTML');
}
