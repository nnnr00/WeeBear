import TelegramBot from 'node-telegram-bot-api';
import db from './database.js';
import {
  createInlineKeyboard,
  isAdmin,
  extractOrderNumber,
  formatCooldownTime,
  chunkArray
} from './utils.js';

const COOLDOWN_SEQUENCE = [5, 10, 30, 40, 50];
const MAX_DAILY_USES = 10;
const VIP_GROUP_LINK = 'https://t.me/+495j5rWmApsxYzg9';

class BotHandler {
  constructor(token, adminId) {
    this.bot = new TelegramBot(token);
    this.adminId = adminId;
  }

  async handleMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    try {
      // 取消命令（仅管理员）
      if (text === '/c' && isAdmin(userId, this.adminId)) {
        await db.setUserState(userId, null);
        await this.bot.sendMessage(chatId, '✅ 已取消当前操作');
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
        await this.bot.sendMessage(chatId, '✅ 已重置您的兑换次数和冷却时间');
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
          default:
            break;
        }
      }
    } catch (error) {
      console.error('Error handling message:', error);
      await this.bot.sendMessage(chatId, '❌ 发生错误，请稍后重试');
    }
  }

  async handleCallbackQuery(query) {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const messageId = query.message.message_id;

    try {
      await this.bot.answerCallbackQuery(query.id);

      // Admin 面板回调
      if (data === 'admin_fileid') {
        await db.setUserState(userId, { action: 'waiting_file_id' });
        await this.bot.sendMessage(chatId, '📎 请发送图片以获取 File ID');
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
        await this.bot.sendMessage(chatId, '👥 用户表功能开发中...');
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
        await this.bot.sendMessage(chatId, '🎉 欢迎加入VIP会员！', keyboard);
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
        await this.bot.sendMessage(chatId, '📝 请输入关键词：');
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
        await this.bot.editMessageText('✅ 商品已删除', {
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
          await this.bot.sendMessage(chatId, '✅ 商品上架成功！');
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
        await this.bot.editMessageText('✅ 工单已删除', {
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
        await this.bot.sendMessage(chatId, `📎 File ID:\n\`${fileId}\``, {
          parse_mode: 'Markdown'
        });
        await db.setUserState(userId, null);
        await this.handleAdmin(msg);
      } else {
        await this.bot.sendMessage(chatId, '❌ 请发送图片');
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
        await this.bot.sendMessage(this.adminId,
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
        
        await this.bot.sendMessage(chatId, '✅ 验证成功！欢迎成为VIP会员！', keyboard);
        await db.setUserState(userId, null);
      } else {
        // 验证失败
        state.attempts = (state.attempts || 0) + 1;
        
        if (state.attempts >= 2) {
          await this.bot.sendMessage(chatId, '❌ 订单号验证失败次数过多，请重新开始');
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
        
        await this.bot.sendMessage(chatId, 
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
        
        await this.bot.sendMessage(chatId, 
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
    const userId = msg.from.id;

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

    await this.bot.sendMessage(chatId, text, keyboard);
  }

  async handleAdmin(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId, this.adminId)) {
      await this.bot.sendMessage(chatId, '❌ 无权限');
      return;
    }

    const keyboard = createInlineKeyboard([
      [{ text: '📎 获取 File ID', callback_data: 'admin_fileid' }],
      [{ text: '📦 商品管理', callback_data: 'admin_products' }],
      [{ text: '🎫 工单管理', callback_data: 'admin_tickets' }],
      [{ text: '👥 用户表', callback_data: 'admin_users' }]
    ]);

    await this.bot.sendMessage(chatId, '⚙️ 管理面板', keyboard);
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

    // 这里插入支付二维码图片
    const paymentFileId = 'YOUR_PAYMENT_QR_FILE_ID'; // 从 /admin -> File ID 获取
    
    const keyboard = createInlineKeyboard([[
      { text: '✅ 我已付款，开始验证', callback_data: 'vip_paid' }
    ]]);

    // 如果有支付图片
    // await this.bot.sendPhoto(chatId, paymentFileId, { caption: text, ...keyboard });
    
    // 没有支付图片时
    await this.bot.sendMessage(chatId, text, keyboard);
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

    await this.bot.sendMessage(chatId, text);
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
      
      await this.bot.sendMessage(chatId, cooldownCheck.message, keyboard);
      return;
    }

    const products = await db.getProducts();
    const keywords = Object.keys(products).sort();

    if (keywords.length === 0) {
      const text = '📦 暂无可兑换商品\n\n请等待管理员上架新商品...';
      const keyboard = createInlineKeyboard([[
        { text: '↩️ 返回首页', callback_data: 'back_to_start' }
      ]]);
      await this.bot.sendMessage(chatId, text, keyboard);
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

    buttons.push([{ text: 
