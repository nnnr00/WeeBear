const TelegramBot = require('node-telegram-bot-api');
const { kv } = require('@vercel/kv');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const COOLDOWN_SEQUENCE = [5, 10, 30, 40, 50];
const MAX_DAILY_USES = 10;
const VIP_GROUP_LINK = 'https://t.me/+495j5rWmApsxYzg9';

// 数据库操作类
class Database {
  async getUser(userId) {
    const user = await kv.get(`user:${userId}`);
    if (user) return user;
    
    const today = this.getBeijingDateKey();
    return {
      id: userId,
      first_seen_date: today,
      dh_count: 0,
      dh_free_count: 0,
      cooldown_until: null,
      cooldown_level: 0,
      last_date_key: today,
      is_vip: false,
      failed_attempts: 0
    };
  }

  async saveUser(userId, userData) {
    await kv.set(`user:${userId}`, userData);
  }

  async getProducts() {
    return await kv.get('products') || {};
  }

  async saveProducts(products) {
    await kv.set('products', products);
  }

  async addProduct(keyword, items) {
    const products = await this.getProducts();
    products[keyword] = items;
    await this.saveProducts(products);
  }

  async deleteProduct(keyword) {
    const products = await this.getProducts();
    delete products[keyword];
    await this.saveProducts(products);
  }

  async getTickets() {
    return await kv.get('tickets') || [];
  }

  async saveTickets(tickets) {
    await kv.set('tickets', tickets);
  }

  async addTicket(userId, username, orderNumber) {
    const tickets = await this.getTickets();
    const now = this.getBeijingTime();
    
    const existingIndex = tickets.findIndex(t => t.userId === userId);
    
    if (existingIndex !== -1) {
      tickets[existingIndex].lastTime = now;
      tickets[existingIndex].orderNumber = orderNumber;
    } else {
      tickets.unshift({
        userId,
        username,
        orderNumber,
        firstTime: now,
        lastTime: now,
        disabled: false
      });
    }
    
    await this.saveTickets(tickets);
  }

  async deleteTicket(userId) {
    const tickets = await this.getTickets();
    const filtered = tickets.filter(t => t.userId !== userId);
    await this.saveTickets(filtered);
  }

  async getUserState(userId) {
    return await kv.get(`state:${userId}`);
  }

  async setUserState(userId, state) {
    if (state) {
      await kv.set(`state:${userId}`, state, { ex: 3600 });
    } else {
      await kv.del(`state:${userId}`);
    }
  }

  async getPBuffer(userId) {
    return await kv.get(`p_buffer:${userId}`) || null;
  }

  async setPBuffer(userId, data) {
    if (data) {
      await kv.set(`p_buffer:${userId}`, data, { ex: 3600 });
    } else {
      await kv.del(`p_buffer:${userId}`);
    }
  }

  getBeijingTime() {
    const now = new Date();
    const beijingTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    return beijingTime.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  getBeijingDateKey() {
    const now = new Date();
    const beijingTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    return beijingTime.toISOString().split('T')[0];
  }
}

const db = new Database();

// 工具函数
function createInlineKeyboard(buttons) {
  return {
    reply_markup: {
      inline_keyboard: buttons
    }
  };
}

function isAdmin(userId, adminId) {
  return userId.toString() === adminId.toString();
}

function extractOrderNumber(text) {
  if (!text) return null;
  const match = text.match(/20260\d*/);
  return match ? match[0] : null;
}

function formatCooldownTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes > 0) {
    return `${minutes}分${secs}秒`;
  }
  return `${secs}秒`;
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Bot 处理类
class BotHandler {
  constructor(token, adminId) {
    this.token = token;
    this.adminId = adminId;
  }

  async sendMessage(chatId, text, options = {}) {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const body = {
      chat_id: chatId,
      text: text,
      ...options
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    return await response.json();
  }

  async sendPhoto(chatId, photo, options = {}) {
    const url = `https://api.telegram.org/bot${this.token}/sendPhoto`;
    const body = {
      chat_id: chatId,
      photo: photo,
      ...options
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    return await response.json();
  }

  async sendDocument(chatId, document, options = {}) {
    const url = `https://api.telegram.org/bot${this.token}/sendDocument`;
    const body = {
      chat_id: chatId,
      document: document,
      ...options
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    return await response.json();
  }

  async sendVideo(chatId, video, options = {}) {
    const url = `https://api.telegram.org/bot${this.token}/sendVideo`;
    const body = {
      chat_id: chatId,
      video: video,
      ...options
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    return await response.json();
  }

  async sendAudio(chatId, audio, options = {}) {
    const url = `https://api.telegram.org/bot${this.token}/sendAudio`;
    const body = {
      chat_id: chatId,
      audio: audio,
      ...options
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    return await response.json();
  }

  async sendVoice(chatId, voice) {
    const url = `https://api.telegram.org/bot${this.token}/sendVoice`;
    const body = {
      chat_id: chatId,
      voice: voice
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    return await response.json();
  }

  async sendSticker(chatId, sticker) {
    const url = `https://api.telegram.org/bot${this.token}/sendSticker`;
    const body = {
      chat_id: chatId,
      sticker: sticker
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    return await response.json();
  }

  async editMessageText(text, options) {
    const url = `https://api.telegram.org/bot${this.token}/editMessageText`;
    const body = {
      text: text,
      ...options
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    return await response.json();
  }

  async answerCallbackQuery(callbackQueryId, options = {}) {
    const url = `https://api.telegram.org/bot${this.token}/answerCallbackQuery`;
    const body = {
      callback_query_id: callbackQueryId,
      ...options
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    return await response.json();
  }

  async handleMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    try {
      // 取消命令（仅管理员）
      if (text === '/c' && isAdmin(userId, this.adminId)) {
        await db.setUserState(userId, null);
        await this.sendMessage(chatId, '✅ 已取消当前操作');
        return;
      }

      // 重置命令（仅管理员）
      if (text === '/cz' && isAdmin(userId, this.adminId)) {
        const user = await db.getUser(userId);
        const today = db.getBeijingDateKey();
        user.first_seen_date = today;
        user.last_date_key = today;
        user.dh_count = 0;
        user.dh_free_count = 0;
        user.cooldown_until = null;
        user.cooldown_level = 0;
        await db.saveUser(userId, user);
        await this.sendMessage(chatId, '✅ 已重置您的兑换次数和冷却时间');
        return;
      }

      // 检查用户状态
      const state = await db.getUserState(userId);

      if (state) {
        await this.handleUserState(msg, state);
        return;
      }

      // 命令处理
      if (text?.startsWith('/')) {
        const command = text.split(' ')[0].split('@')[0];
        
        switch (command) {
          case '/start':
            await this.handleStart(msg);
            break;
          case '/admin':
            await this.handleAdmin(msg);
            break;
          case '/v':
            await this.handleVIP(msg);
            break;
          case '/dh':
            await this.handleExchange(msg);
            break;
          case '/p':
            await this.handleProductManage(msg);
            break;
        }
      }
    } catch (error) {
      console.error('Error handling message:', error);
      await this.sendMessage(chatId, '❌ 发生错误，请稍后重试');
    }
  }

  async handleCallbackQuery(query) {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const messageId = query.message.message_id;

    try {
      await this.answerCallbackQuery(query.id);

      // Admin 面板回调
      if (data === 'admin_fileid') {
        await db.setUserState(userId, { action: 'waiting_file_id' });
        await this.sendMessage(chatId, '📎 请发送图片以获取 File ID');
        return;
      }

      if (data === 'admin_products') {
        await this.handleProductManage({ chat: { id: chatId }, from: { id: userId } });
        return;
      }

      if (data === 'admin_tickets') {
        await this.showTickets(chatId, 1);
        return;
      }

      if (data === 'admin_users') {
        await this.sendMessage(chatId, '👥 用户表功能开发中...');
        return;
      }

      if (data === 'back_to_admin') {
        await this.handleAdmin({ chat: { id: chatId }, from: { id: userId } });
        return;
      }

      // VIP 购买流程
      if (data === 'buy_vip') {
        await this.handleVIP({ chat: { id: chatId }, from: { id: userId } });
        return;
      }

      if (data === 'vip_paid') {
        await this.showPaymentGuide(chatId);
        await db.setUserState(userId, { action: 'waiting_order_number', attempts: 0 });
        return;
      }

      if (data === 'join_vip_group') {
        const keyboard = createInlineKeyboard([[
          { text: '💎 加入会员群', url: VIP_GROUP_LINK }
        ]]);
        await this.sendMessage(chatId, '🎉 欢迎加入VIP会员！', keyboard);
        return;
      }

      // 兑换
      if (data === 'exchange') {
        await this.handleExchange({ chat: { id: chatId }, from: { id: userId } });
        return;
      }

      if (data.startsWith('product_')) {
        const keyword = data.replace('product_', '');
        await this.sendProductContent(chatId, userId, keyword);
        return;
      }

      if (data.startsWith('continue_send_')) {
        const parts = data.split('_');
        const keyword = parts[2];
        const groupIndex = parseInt(parts[3]);
        await this.sendProductContent(chatId, userId, keyword, groupIndex);
        return;
      }

      if (data === 'back_to_exchange') {
        await this.handleExchange({ chat: { id: chatId }, from: { id: userId } });
        return;
      }

      if (data === 'back_to_start') {
        await this.handleStart({ chat: { id: chatId }, from: { id: userId } });
        return;
      }

      // 商品管理
      if (data === 'add_product') {
        await db.setUserState(userId, { action: 'waiting_keyword' });
        await this.sendMessage(chatId, '📝 请输入关键词：');
        return;
      }

      if (data === 'delete_product') {
        await this.showDeleteProducts(chatId, 1);
        return;
      }

      if (data.startsWith('del_product_')) {
        const keyword = data.replace('del_product_', '');
        await this.confirmDeleteProduct(chatId, messageId, keyword);
        return;
      }

      if (data.startsWith('confirm_del_')) {
        const keyword = data.replace('confirm_del_', '');
        await db.deleteProduct(keyword);
        await this.editMessageText('✅ 商品已删除', {
          chat_id: chatId,
          message_id: messageId
        });
        await this.handleProductManage({ chat: { id: chatId }, from: { id: userId } });
        return;
      }

      if (data === 'finish_product') {
        const buffer = await db.getPBuffer(userId);
        if (buffer) {
          await db.addProduct(buffer.keyword, buffer.items);
          await db.setPBuffer(userId, null);
          await db.setUserState(userId, null);
          await this.sendMessage(chatId, '✅ 商品上架成功！');
          await this.handleProductManage({ chat: { id: chatId }, from: { id: userId } });
        }
        return;
      }

      // 工单管理
      if (data.startsWith('ticket_')) {
        const ticketUserId = data.replace('ticket_', '');
        await this.showTicketDetail(chatId, messageId, ticketUserId);
        return;
      }

      if (data.startsWith('delete_ticket_')) {
        const ticketUserId = data.replace('delete_ticket_', '');
        await db.deleteTicket(parseInt(ticketUserId));
        await this.editMessageText('✅ 工单已删除', {
          chat_id: chatId,
          message_id: messageId
        });
        await this.showTickets(chatId, 1);
        return;
      }

      // 分页
      if (data.startsWith('page_')) {
        const parts = data.split('_');
        const type = parts[1];
        const page = parseInt(parts[2]);
        
        if (type === 'tickets') {
          await this.showTickets(chatId, page, messageId);
        } else if (type === 'products') {
          await this.handleProductManage({ chat: { id: chatId }, from: { id: userId } }, page, messageId);
        } else if (type === 'delproducts') {
          await this.showDeleteProducts(chatId, page, messageId);
        } else if (type === 'exchange') {
          await this.handleExchange({ chat: { id: chatId }, from: { id: userId } }, page, messageId);
        }
        return;
      }

    } catch (error) {
      console.error('Error handling callback:', error);
    }
  }

  async handleUserState(msg, state) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name;

    // 获取 File ID
    if (state.action === 'waiting_file_id') {
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await this.sendMessage(chatId, `📎 File ID:\n\`${fileId}\``, {
          parse_mode: 'Markdown'
        });
        await db.setUserState(userId, null);
        await this.handleAdmin(msg);
      } else {
        await this.sendMessage(chatId, '❌ 请发送图片');
      }
      return;
    }

    // 等待订单号
    if (state.action === 'waiting_order_number') {
      const orderNumber = extractOrderNumber(msg.text || '');
      
      if (orderNumber) {
        // 验证成功
        const user = await db.getUser(userId);
        user.is_vip = true;
        await db.saveUser(userId, user);
        
        // 添加工单
        await db.addTicket(userId, username, orderNumber);
        
        // 通知管理员
        await this.sendMessage(this.adminId,
          `🎫 新工单\n` +
          `👤 用户：@${username}\n` +
          `🆔 ID：${userId}\n` +
          `📝 订单号：${orderNumber}\n` +
          `🕐 时间：${db.getBeijingTime()}`
        );
        
        // 发送加入群组按钮
        const keyboard = createInlineKeyboard([[
          { text: '💎 加入会员群', callback_data: 'join_vip_group' }
        ]]);
        
        await this.sendMessage(chatId, '✅ 验证成功！欢迎成为VIP会员！', keyboard);
        await db.setUserState(userId, null);
      } else {
        // 验证失败
        state.attempts = (state.attempts || 0) + 1;
        
        if (state.attempts >= 2) {
          await this.sendMessage(chatId, '❌ 订单号验证失败次数过多，请重新开始');
          await db.setUserState(userId, null);
          await this.handleStart(msg);
        } else {
          await db.setUserState(userId, state);
          await this.showPaymentGuide(chatId);
        }
      }
      return;
    }

    // 等待商品关键词
    if (state.action === 'waiting_keyword') {
      const keyword = msg.text?.trim();
      if (keyword) {
        await db.setPBuffer(userId, { keyword, items: [] });
        await db.setUserState(userId, { action: 'waiting_product_content', keyword });
        
        const keyboard = createInlineKeyboard([[
          { text: '✅ 完成上架', callback_data: 'finish_product' }
        ]]);
        
        await this.sendMessage(chatId, 
          '📦 请发送商品内容（支持文字、图片、文件、转发消息等）\n' +
          '发送完所有内容后点击下方按钮完成',
          keyboard
        );
      }
      return;
    }

    // 等待商品内容
    if (state.action === 'waiting_product_content') {
      const buffer = await db.getPBuffer(userId);
      if (buffer) {
        // 存储消息内容
        const item = {
          type: this.getMessageType(msg),
          content: this.extractMessageContent(msg)
        };
        
        buffer.items.push(item);
        await db.setPBuffer(userId, buffer);
        
        const keyboard = createInlineKeyboard([[
          { text: '✅ 完成上架', callback_data: 'finish_product' }
        ]]);
        
        await this.sendMessage(chatId, 
          `✅ 已记录第 ${buffer.items.length} 条内容`,
          keyboard
        );
      }
      return;
    }
  }

  getMessageType(msg) {
    if (msg.text) return 'text';
    if (msg.photo) return 'photo';
    if (msg.document) return 'document';
    if (msg.video) return 'video';
    if (msg.audio) return 'audio';
    if (msg.voice) return 'voice';
    if (msg.sticker) return 'sticker';
    return 'forward';
  }

  extractMessageContent(msg) {
    if (msg.text) return { text: msg.text };
    if (msg.photo) return { file_id: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption };
    if (msg.document) return { file_id: msg.document.file_id, caption: msg.caption };
    if (msg.video) return { file_id: msg.video.file_id, caption: msg.caption };
    if (msg.audio) return { file_id: msg.audio.file_id, caption: msg.caption };
    if (msg.voice) return { file_id: msg.voice.file_id };
    if (msg.sticker) return { file_id: msg.sticker.file_id };
    return { forward_from: msg.forward_from_chat || msg.forward_from };
  }

  async handleStart(msg) {
    const chatId = msg.chat.id;

    // 检查 deep link
    const startParam = msg.text?.split(' ')[1];
    if (startParam === 'dh') {
      await this.handleExchange(msg);
      return;
    }

    const text = 
      '🎊🐴 喜迎马年新春 🐴🎊\n\n' +
      '🎁 海量资源免费获取\n' +
      '🎉 新春特惠活动进行中\n' +
      '✨ 快来体验我们的服务吧！';

    const keyboard = createInlineKeyboard([
      [{ text: '💎 加入会员（新春特价）', callback_data: 'buy_vip' }],
      [{ text: '🎁 免费兑换', callback_data: 'exchange' }]
    ]);

    await this.sendMessage(chatId, text, keyboard);
  }

  async handleAdmin(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId, this.adminId)) {
      await this.sendMessage(chatId, '❌ 无权限');
      return;
    }

    const keyboard = createInlineKeyboard([
      [{ text: '📎 获取 File ID', callback_data: 'admin_fileid' }],
      [{ text: '📦 商品管理', callback_data: 'admin_products' }],
      [{ text: '🎫 工单管理', callback_data: 'admin_tickets' }],
      [{ text: '👥 用户表', callback_data: 'admin_users' }]
    ]);

    await this.sendMessage(chatId, '⚙️ 管理面板', keyboard);
  }

  async handleVIP(msg) {
    const chatId = msg.chat.id;
    
    const text = 
      '🎊 喜迎新春（特价）\n\n' +
      '💎 VIP会员特权说明：\n' +
      '✅ 专属中转通道\n' +
      '✅ 优先审核入群\n' +
      '✅ 7x24小时客服支持\n' +
      '✅ 定期福利活动\n\n' +
      '💰 新春特价：限时优惠中';

    const keyboard = createInlineKeyboard([[
      { text: '✅ 我已付款，开始验证', callback_data: 'vip_paid' }
    ]]);

    await this.sendMessage(chatId, text, keyboard);
  }

  async showPaymentGuide(chatId) {
    const text = 
      '📱 查找订单号教程：\n\n' +
      '1️⃣ 打开支付应用（支付宝/微信）\n' +
      '2️⃣ 进入【我的】→【账单】\n' +
      '3️⃣ 找到本次支付记录\n' +
      '4️⃣ 点击进入【账单详情】\n' +
      '5️⃣ 点击【更多】查看完整信息\n' +
      '6️⃣ 找到【订单号】并复制\n' +
      '7️⃣ 将订单号发送到此处\n\n' +
      '💡 提示：订单号通常以数字开头';

    await this.sendMessage(chatId, text);
  }

  async handleExchange(msg, page = 1, messageId = null) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // 检查频控
    const cooldownCheck = await this.checkCooldown(userId);
    if (!cooldownCheck.allowed) {
      const keyboard = createInlineKeyboard([
        [{ text: '💎 加入会员（新春特价）', callback_data: 'buy_vip' }],
        [{ text: '↩️ 返回首页', callback_data: 'back_to_start' }]
      ]);
      
      await this.sendMessage(chatId, cooldownCheck.message, keyboard);
      return;
    }

    const products = await db.getProducts();
    const keywords = Object.keys(products).sort();

    if (keywords.length === 0) {
      const text = '📦 暂无可兑换商品\n\n请等待管理员上架新商品...';
      const keyboard = createInlineKeyboard([[
        { text: '↩️ 返回首页', callback_data: 'back_to_start' }
      ]]);
      
      if (messageId) {
        await this.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          ...keyboard
        });
      } else {
        await this.sendMessage(chatId, text, keyboard);
      }
      return;
    }

    // 分页
    const perPage = 10;
    const totalPages = Math.ceil(keywords.length / perPage);
    const startIdx = (page - 1) * perPage;
    const endIdx = startIdx + perPage;
    const pageKeywords = keywords.slice(startIdx, endIdx);

    const buttons = pageKeywords.map(kw => [{
      text: `🎁 ${kw}`,
      callback_data: `product_${kw}`
    }]);

    // 添加分页按钮
    if (totalPages > 1) {
      const navButtons = [];
      if (page > 1) {
        navButtons.push({ text: '⬅️ 上一页', callback_data: `page_exchange_${page - 1}` });
      }
      if (page < totalPages) {
        navButtons.push({ text: '下一页 ➡️', callback_data: `page_exchange_${page + 1}` });
      }
      if (navButtons.length > 0) {
        buttons.push(navButtons);
      }
    }

    buttons.push([{ text: '↩️ 返回首页', callback_data: 'back_to_start' }]);

    const keyboard = createInlineKeyboard(buttons);
    const text = `📄 ${page}/${totalPages}\n\n🎁 请选择要兑换的商品：`;

    if (messageId) {
      await this.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...keyboard
      });
    } else {
      await this.sendMessage(chatId, text, keyboard);
    }
  }

  async sendProductContent(chatId, userId, keyword, groupIndex = 0) {
    const products = await db.getProducts();
    const items = products[keyword];

    if (!items || items.length === 0) {
      await this.sendMessage(chatId, '❌ 商品不存在');
      return;
    }

    // 增加使用次数
    await this.incrementUsage(userId);

    // 分组发送
    const chunks = chunkArray(items, 10);
    const currentChunk = chunks[groupIndex];

    for (let i = 0; i < currentChunk.length; i++) {
      const item = currentChunk[i];
      const fileNumber = groupIndex * 10 + i + 1;
      const totalFiles = items.length;

      try {
        switch (item.type) {
          case 'text':
            await this.sendMessage(chatId, `📦 文件 ${fileNumber}/${totalFiles}\n\n${item.content.text}`);
            break;
          case 'photo':
            await this.sendPhoto(chatId, item.content.file_id, {
              caption: `📦 文件 ${fileNumber}/${totalFiles}${item.content.caption ? '\n\n' + item.content.caption : ''}`
            });
            break;
          case 'document':
            await this.sendDocument(chatId, item.content.file_id, {
              caption: `📦 文件 ${fileNumber}/${totalFiles}${item.content.caption ? '\n\n' + item.content.caption : ''}`
            });
            break;
          case 'video':
            await this.sendVideo(chatId, item.content.file_id, {
              caption: `📦 文件 ${fileNumber}/${totalFiles}${item.content.caption ? '\n\n' + item.content.caption : ''}`
            });
            break;
          case 'audio':
            await this.sendAudio(chatId, item.content.file_id, {
              caption: `📦 文件 ${fileNumber}/${totalFiles}${item.content.caption ? '\n\n' + item.content.caption : ''}`
            });
            break;
          case 'voice':
            await this.sendVoice(chatId, item.content.file_id);
            break;
          case 'sticker':
            await this.sendSticker(chatId, item.content.file_id);
            break;
        }

        // 添加延迟避免触发限流
        if (i < currentChunk.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error('Error sending item:', error);
      }
    }

    // 发送完成或继续按钮
    if (groupIndex < chunks.length - 1) {
      const keyboard = createInlineKeyboard([[
        { text: '✨ 点击继续发送 👉', callback_data: `continue_send_${keyword}_${groupIndex + 1}` }
      ]]);
      await this.sendMessage(chatId, '📦 当前组发送完毕', keyboard);
    } else {
      const keyboard = createInlineKeyboard([
        [{ text: '💎 加入会员（新春特价）', callback_data: 'buy_vip' }],
        [{ text: '↩️ 返回兑换', callback_data: 'back_to_exchange' }]
      ]);
      await this.sendMessage(chatId, '✅ 文件发送完毕', keyboard);
    }
  }

  async checkCooldown(userId) {
    const user = await db.getUser(userId);
    const today = db.getBeijingDateKey();

    // 检查日期是否变化，重置计数
    if (user.last_date_key !== today) {
      user.last_date_key = today;
      user.dh_count = 0;
      user.dh_free_count = 0;
      user.cooldown_until = null;
      user.cooldown_level = 0;
      await db.saveUser(userId, user);
    }

    // VIP 用户无限制
    if (user.is_vip) {
      return { allowed: true };
    }

    // 检查每日上限
    if (user.dh_count >= MAX_DAILY_USES) {
      return {
        allowed: false,
        message: '❌ 今日兑换次数已达上限（10次）\n\n升级VIP享受无限兑换！'
      };
    }

    // 检查冷却时间
    if (user.cooldown_until) {
      const now = Date.now();
      if (now < user.cooldown_until) {
        const remainingSeconds = Math.ceil((user.cooldown_until - now) / 1000);
        return {
          allowed: false,
          message: `⏰ 冷却中，请等待 ${formatCooldownTime(remainingSeconds)}\n\n升级VIP立即解除冷却！`
        };
      }
    }

    // 判断是否为新用户
    const isNewUser = user.first_seen_date === today;
    const freeLimit = isNewUser ? 3 : 2;

    if (user.dh_free_count < freeLimit) {
      return { allowed: true, isFree: true };
    }

    // 需要冷却
    return { allowed: true, needCooldown: true };
  }

  async incrementUsage(userId) {
    const user = await db.getUser(userId);
    const today = db.getBeijingDateKey();

    // 确保日期正确
    if (user.last_date_key !== today) {
      user.last_date_key = today;
      user.dh_count = 0;
      user.dh_free_count = 0;
      user.cooldown_level = 0;
    }

    user.dh_count += 1;

    const isNewUser = user.first_seen_date === today;
    const freeLimit = isNewUser ? 3 : 2;

    if (user.dh_free_count < freeLimit) {
      user.dh_free_count += 1;
    } else {
      // 设置冷却
      const cooldownSeconds = COOLDOWN_SEQUENCE[Math.min(user.cooldown_level, COOLDOWN_SEQUENCE.length - 1)];
      user.cooldown_until = Date.now() + cooldownSeconds * 1000;
      user.cooldown_level += 1;
    }

    await db.saveUser(userId, user);
  }

  async handleProductManage(msg, page = 1, messageId = null) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId, this.adminId)) {
      await this.sendMessage(chatId, '❌ 无权限');
      return;
    }

    const products = await db.getProducts();
    const keywords = Object.keys(products).sort();

    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(keywords.length / perPage));
    const startIdx = (page - 1) * perPage;
    const endIdx = startIdx + perPage;
    const pageKeywords = keywords.slice(startIdx, endIdx);

    const buttons = [];
    
    // 商品列表
    pageKeywords.forEach(kw => {
      buttons.push([{
        text: `📦 ${kw} (${products[kw].length}条)`,
        callback_data: `view_product_${kw}`
      }]);
    });

    // 分页按钮
    if (totalPages > 1) {
      const navButtons = [];
      if (page > 1) {
        navButtons.push({ text: '⬅️ 上一页', callback_data: `page_products_${page - 1}` });
      }
      if (page < totalPages) {
        navButtons.push({ text: '下一页 ➡️', callback_data: `page_products_${page + 1}` });
      }
      if (navButtons.length > 0) {
        buttons.push(navButtons);
      }
    }

    // 操作按钮
    buttons.push([
      { text: '➕ 上架新商品', callback_data: 'add_product' },
      { text: '🗑 删除商品', callback_data: 'delete_product' }
    ]);

    buttons.push([{ text: '↩️ 返回管理面板', callback_data: 'back_to_admin' }]);

    const keyboard = createInlineKeyboard(buttons);
    const text = `📄 ${page}/${totalPages}\n\n📦 商品管理\n当前共 ${keywords.length} 个商品`;

    if (messageId) {
      await this.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...keyboard
      });
    } else {
      await this.sendMessage(chatId, text, keyboard);
    }
  }

  async showDeleteProducts(chatId, page = 1, messageId = null) {
    const products = await db.getProducts();
    const keywords = Object.keys(products).sort();

    if (keywords.length === 0) {
      await this.sendMessage(chatId, '📦 暂无商品');
      return;
    }

    const perPage = 10;
    const totalPages = Math.ceil(keywords.length / perPage);
    const startIdx = (page - 1) * perPage;
    const endIdx = startIdx + perPage;
    const pageKeywords = keywords.slice(startIdx, endIdx);

    const buttons = pageKeywords.map(kw => [{
      text: `🗑 删除 ${kw}`,
      callback_data: `del_product_${kw}`
    }]);

    // 分页按钮
    if (totalPages > 1) {
      const navButtons = [];
      if (page > 1) {
        navButtons.push({ text: '⬅️ 上一页', callback_data: `page_delproducts_${page - 1}` });
      }
      if (page < totalPages) {
        navButtons.push({ text: '下一页 ➡️', callback_data: `page_delproducts_${page + 1}` });
      }
      if (navButtons.length > 0) {
        buttons.push(navButtons);
      }
    }

    buttons.push([{ text: '↩️ 返回', callback_data: 'admin_products' }]);

    const keyboard = createInlineKeyboard(buttons);
    const text = `📄 ${page}/${totalPages}\n\n🗑 选择要删除的商品：`;

    if (messageId) {
      await this.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...keyboard
      });
    } else {
      await this.sendMessage(chatId, text, keyboard);
    }
  }

  async confirmDeleteProduct(chatId, messageId, keyword) {
    const keyboard = createInlineKeyboard([
      [{ text: '⚠️ 确认删除', callback_data: `confirm_del_${keyword}` }],
      [{ text: '❌ 取消', callback_data: 'delete_product' }]
    ]);

    await this.editMessageText(
      `⚠️ 确认删除商品 "${keyword}"？\n\n此操作不可恢复！`,
      {
        chat_id: chatId,
        message_id: messageId,
        ...keyboard
      }
    );
  }

  async showTickets(chatId, page = 1, messageId = null) {
    const tickets = await db.getTickets();

    if (tickets.length === 0) {
      const text = '🎫 暂无工单';
      const keyboard = createInlineKeyboard([[
        { text: '↩️ 返回管理面板', callback_data: 'back_to_admin' }
      ]]);
      
      if (messageId) {
        await this.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          ...keyboard
        });
      } else {
        await this.sendMessage(chatId, text, keyboard);
      }
      return;
    }

    const perPage = 10;
    const totalPages = Math.ceil(tickets.length / perPage);
    const startIdx = (page - 1) * perPage;
    const endIdx = startIdx + perPage;
    const pageTickets = tickets.slice(startIdx, endIdx);

    const buttons = pageTickets.map(ticket => [{
      text: `@${ticket.username} (${ticket.userId})`,
      callback_data: `ticket_${ticket.userId}`
    }]);

    // 分页按钮
    if (totalPages > 1) {
      const navButtons = [];
      if (page > 1) {
        navButtons.push({ text: '⬅️ 上一页', callback_data: `page_tickets_${page - 1}` });
      }
      if (page < totalPages) {
        navButtons.push({ text: '下一页 ➡️', callback_data: `page_tickets_${page + 1}` });
      }
      if (navButtons.length > 0) {
        buttons.push(navButtons);
      }
    }

    buttons.push([{ text: '↩️ 返回管理面板', callback_data: 'back_to_admin' }]);

    const keyboard = createInlineKeyboard(buttons);
    const text = `📄 ${page}/${totalPages}\n\n🎫 工单列表（共 ${tickets.length} 个）`;

    if (messageId) {
      await this.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...keyboard
      });
    } else {
      await this.sendMessage(chatId, text, keyboard);
    }
  }

  async showTicketDetail(chatId, messageId, ticketUserId) {
    const tickets = await db.getTickets();
    const ticket = tickets.find(t => t.userId.toString() === ticketUserId.toString());

    if (!ticket) {
      return;
    }

    const text = 
      `🎫 工单详情\n\n` +
      `👤 用户名：@${ticket.username}\n` +
      `🆔 用户ID：${ticket.userId}\n` +
      `📝 订单号：${ticket.orderNumber}\n` +
      `🕐 首次提交：${ticket.firstTime}\n` +
      `🕐 最近更新：${ticket.lastTime}\n` +
      `${ticket.disabled ? '⚠️ 状态：已停用' : ''}`;

    const keyboard = createInlineKeyboard([
      [{ text: '🗑 删除工单', callback_data: `delete_ticket_${ticketUserId}` }],
      [{ text: '↩️ 返回工单列表', callback_data: 'admin_tickets' }]
    ]);

    await this.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...keyboard
    });
  }

  async processUpdate(update) {
    if (update.message) {
      await this.handleMessage(update.message);
    } else if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }
}

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      const update = req.body;
      const botHandler = new BotHandler(BOT_TOKEN, ADMIN_ID);
      await botHandler.processUpdate(update);
      res.status(200).json({ ok: true });
    } catch (error) {
      console.error('Error processing update:', error);
      res.status(200).json({ ok: true }); // 总是返回 200 给 Telegram
    }
  } else if (req.method === 'GET') {
    // 设置 webhook
    const webhookUrl = `${WEBHOOK_URL}/api/webhook`;
    try {
      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
      const data = await response.json();
      res.status(200).json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};
