// ╔══════════════════════════════════════════════════════════════╗
// ║           FILE_ID 配置区 — 在此处替换你的 file_id            ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  部署前把下面两个值改成你通过 fileid 功能获取到的真实 file_id  ║
// ╚══════════════════════════════════════════════════════════════╝
const VIP_IMAGE_FILE_ID = process.env.VIP_IMAGE_FILE_ID || "YOUR_VIP_IMAGE_FILE_ID_HERE";
const ORDER_TUTORIAL_FILE_ID = process.env.ORDER_TUTORIAL_FILE_ID || "YOUR_ORDER_TUTORIAL_FILE_ID_HERE";

// ═══════════════════════════════════════════════════════════
//  环境变量
// ═══════════════════════════════════════════════════════════
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const DATABASE_URL = process.env.DATABASE_URL;
const VIP_GROUP_LINK = "https://t.me/+495j5rWmApsxYzg9";

// ═══════════════════════════════════════════════════════════
//  Neon 数据库
// ═══════════════════════════════════════════════════════════
const { neon } = require("@neondatabase/serverless");
const sql = neon(DATABASE_URL);

// ═══════════════════════════════════════════════════════════
//  Telegram API 调用
// ═══════════════════════════════════════════════════════════
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function sendMessage(chatId, text, opts = {}) {
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...opts });
}

async function sendPhoto(chatId, photo, caption, opts = {}) {
  return tg("sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML", ...opts });
}

async function editMessageText(chatId, messageId, text, opts = {}) {
  return tg("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...opts });
}

async function editMessageMedia(chatId, messageId, media, opts = {}) {
  return tg("editMessageMedia", { chat_id: chatId, message_id: messageId, media, ...opts });
}

async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  return tg("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: showAlert });
}

async function deleteMessage(chatId, messageId) {
  return tg("deleteMessage", { chat_id: chatId, message_id: messageId });
}

async function sendDocument(chatId, document, caption, opts = {}) {
  return tg("sendDocument", { chat_id: chatId, document, caption, parse_mode: "HTML", ...opts });
}

async function sendVideo(chatId, video, caption, opts = {}) {
  return tg("sendVideo", { chat_id: chatId, video, caption, parse_mode: "HTML", ...opts });
}

async function sendAnimation(chatId, animation, caption, opts = {}) {
  return tg("sendAnimation", { chat_id: chatId, animation, caption, parse_mode: "HTML", ...opts });
}

async function sendSticker(chatId, sticker) {
  return tg("sendSticker", { chat_id: chatId, sticker });
}

async function sendVoice(chatId, voice, caption, opts = {}) {
  return tg("sendVoice", { chat_id: chatId, voice, caption, parse_mode: "HTML", ...opts });
}

async function sendAudio(chatId, audio, caption, opts = {}) {
  return tg("sendAudio", { chat_id: chatId, audio, caption, parse_mode: "HTML", ...opts });
}

async function copyMessage(chatId, fromChatId, messageId, opts = {}) {
  return tg("copyMessage", { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId, ...opts });
}

async function forwardMessage(chatId, fromChatId, messageId) {
  return tg("forwardMessage", { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId });
}

// ═══════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════
function isAdmin(userId) {
  return userId === ADMIN_ID;
}

function getBeijingDateKey() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return beijing.toISOString().slice(0, 10);
}

function getBeijingTimeStr() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return beijing.toISOString().replace("T", " ").slice(0, 19);
}

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ═══════════════════════════════════════════════════════════
//  用户状态管理
// ═══════════════════════════════════════════════════════════
async function getState(userId) {
  const rows = await sql`SELECT state, state_data FROM user_states WHERE user_id = ${userId}`;
  if (rows.length === 0) return { state: null, data: {} };
  return { state: rows[0].state, data: rows[0].state_data || {} };
}

async function setState(userId, state, data = {}) {
  await sql`
    INSERT INTO user_states (user_id, state, state_data, updated_at)
    VALUES (${userId}, ${state}, ${JSON.stringify(data)}::jsonb, NOW())
    ON CONFLICT (user_id) DO UPDATE SET state = ${state}, state_data = ${JSON.stringify(data)}::jsonb, updated_at = NOW()
  `;
}

async function clearState(userId) {
  await sql`DELETE FROM user_states WHERE user_id = ${userId}`;
}

// ═══════════════════════════════════════════════════════════
//  用户记录
// ═══════════════════════════════════════════════════════════
async function ensureUser(from) {
  const dateKey = getBeijingDateKey();
  const rows = await sql`SELECT * FROM users WHERE user_id = ${from.id}`;
  if (rows.length === 0) {
    await sql`
      INSERT INTO users (user_id, username, first_name, last_name, first_seen_date, first_seen_ts, last_seen_ts, dh_date_key, dh_used_count, dh_cooldown_index)
      VALUES (${from.id}, ${from.username || null}, ${from.first_name || null}, ${from.last_name || null}, ${dateKey}, NOW(), NOW(), ${dateKey}, 0, 0)
    `;
    return { ...from, first_seen_date: dateKey, dh_date_key: dateKey, dh_used_count: 0, dh_cooldown_index: 0, is_new: true };
  } else {
    await sql`UPDATE users SET username = ${from.username || null}, first_name = ${from.first_name || null}, last_name = ${from.last_name || null}, last_seen_ts = NOW() WHERE user_id = ${from.id}`;
    return { ...rows[0], is_new: rows[0].first_seen_date === dateKey };
  }
}

// ═══════════════════════════════════════════════════════════
//  频控逻辑
// ═══════════════════════════════════════════════════════════
const COOLDOWNS = [5, 15, 30, 50, 60, 60]; // 分钟

async function checkRateLimit(userId) {
  const dateKey = getBeijingDateKey();
  const rows = await sql`SELECT * FROM users WHERE user_id = ${userId}`;
  if (rows.length === 0) return { allowed: false, msg: "用户不存在" };
  let u = rows[0];

  // 日切重置
  if (u.dh_date_key !== dateKey) {
    await sql`UPDATE users SET dh_date_key = ${dateKey}, dh_used_count = 0, dh_cooldown_index = 0, dh_last_use_ts = NULL WHERE user_id = ${userId}`;
    u.dh_date_key = dateKey;
    u.dh_used_count = 0;
    u.dh_cooldown_index = 0;
    u.dh_last_use_ts = null;
  }

  const isNew = u.first_seen_date === dateKey;
  const freeLimit = isNew ? 3 : 2;
  const dailyMax = 6;

  if (u.dh_used_count >= dailyMax) {
    return { allowed: false, msg: "🚫 今日次数已用完（最多6次），明天再来吧！", showVip: true };
  }

  if (u.dh_used_count < freeLimit) {
    return { allowed: true, remaining: freeLimit - u.dh_used_count - 1 };
  }

  // 进入冷却
  const cooldownIdx = Math.min(u.dh_cooldown_index, COOLDOWNS.length - 1);
  const cooldownMin = COOLDOWNS[cooldownIdx];

  if (u.dh_last_use_ts) {
    const lastUse = new Date(u.dh_last_use_ts).getTime();
    const now = Date.now();
    const elapsed = (now - lastUse) / 1000 / 60;
    if (elapsed < cooldownMin) {
      const remainSec = Math.ceil((cooldownMin - elapsed) * 60);
      const mm = Math.floor(remainSec / 60);
      const ss = remainSec % 60;
      return {
        allowed: false,
        msg: `⏳ 冷却中，剩余 ${mm}分${ss}秒\n\n请稍后再试～`,
        showVip: true,
      };
    }
  }

  return { allowed: true, cooldownIdx };
}

async function recordUse(userId) {
  const rows = await sql`SELECT * FROM users WHERE user_id = ${userId}`;
  const u = rows[0];
  const dateKey = getBeijingDateKey();
  const isNew = u.first_seen_date === dateKey;
  const freeLimit = isNew ? 3 : 2;
  const newCount = u.dh_used_count + 1;
  let newCooldownIdx = u.dh_cooldown_index;
  if (newCount > freeLimit) {
    newCooldownIdx = Math.min(u.dh_cooldown_index + 1, COOLDOWNS.length - 1);
  }
  await sql`UPDATE users SET dh_used_count = ${newCount}, dh_cooldown_index = ${newCooldownIdx}, dh_last_use_ts = NOW() WHERE user_id = ${userId}`;
}

// ═══════════════════════════════════════════════════════════
//  /start 页面
// ═══════════════════════════════════════════════════════════
async function handleStart(chatId, from, msgParam) {
  await clearState(from.id);
  await ensureUser(from);

  if (msgParam === "dh") {
    return handleDhCommand(chatId, from);
  }

  const text = `🎊🐴 <b>喜迎马年新春 · 资源免费获取</b> 🐴🎊

🧧 新春快乐！万事如意！
🎁 限时活动进行中，精彩福利等你领取～

✨ 请选择下方功能开始体验 👇`;

  await sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🧧 加入会员（新春特价）", callback_data: "vip_intro" }],
        [{ text: "🎁 兑换", callback_data: "dh_enter" }],
      ],
    },
  });
}

// ═══════════════════════════════════════════════════════════
//  VIP 会员 (/v)
// ═══════════════════════════════════════════════════════════
async function handleVipIntro(chatId, from, callbackQueryId) {
  if (callbackQueryId) await answerCallbackQuery(callbackQueryId);

  const caption = `🐴🧧 <b>喜迎新春 · 会员特价</b> 🧧🐴

💎 <b>VIP会员特权说明：</b>

✅ 专属中转通道
✅ 优先审核入群
✅ 7×24小时客服支持
✅ 定期福利活动

🎊 新春限时特惠，立即加入！`;

  await sendPhoto(chatId, VIP_IMAGE_FILE_ID, caption, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ 我已付款，开始验证", callback_data: "verify_pay" }],
        [{ text: "↩️ 返回首页", callback_data: "back_start" }],
      ],
    },
  });
}

async function handleVerifyPay(chatId, from, callbackQueryId) {
  if (callbackQueryId) await answerCallbackQuery(callbackQueryId);
  await setState(from.id, "awaiting_order", { attempts: 0 });

  const caption = `📋 <b>订单验证指引</b>

请按以下步骤查找您的订单号：

1️⃣ 打开支付应用
2️⃣ 进入 <b>「我的」</b> 页面
3️⃣ 点击 <b>「账单」</b>
4️⃣ 找到对应的支付记录
5️⃣ 点击进入 <b>「账单详情」</b>
6️⃣ 点击 <b>「更多」</b>
7️⃣ 复制完整的 <b>订单号</b>

📝 请将完整订单号发送给我进行验证 👇`;

  await sendPhoto(chatId, ORDER_TUTORIAL_FILE_ID, caption, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "↩️ 返回", callback_data: "vip_intro" }],
      ],
    },
  });
}

async function handleOrderInput(chatId, from, text) {
  const { state, data } = await getState(from.id);
  if (state !== "awaiting_order") return false;

  const orderText = text.trim();

  // 私密逻辑：以 20260 开头
  if (/^20260\d+$/.test(orderText)) {
    // 验证成功
    await clearState(from.id);

    // 创建工单
    await sql`
      INSERT INTO tickets (user_id, username, first_name, order_number, created_at)
      VALUES (${from.id}, ${from.username || null}, ${from.first_name || null}, ${orderText}, NOW())
    `;

    // 通知管理员
    const adminMsg = `🎫 <b>新工单通知</b>

👤 用户：${escapeHtml(from.first_name || "")} ${from.username ? "@" + from.username : ""}
🆔 ID：<code>${from.id}</code>
📝 订单号：<code>${orderText}</code>
🕐 时间：${getBeijingTimeStr()}（北京时间）`;

    await sendMessage(ADMIN_ID, adminMsg);

    // 发送成功消息给用户
    await sendMessage(chatId, `✅ <b>验证成功！</b>\n\n🎉 恭喜您，订单验证通过！\n请点击下方按钮加入会员群 👇`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎊 加入会员群", url: VIP_GROUP_LINK }],
          [{ text: "↩️ 返回首页", callback_data: "back_start" }],
        ],
      },
    });
    return true;
  }

  // 识别失败
  const attempts = (data.attempts || 0) + 1;
  if (attempts >= 2) {
    await clearState(from.id);
    await sendMessage(chatId, `❌ 多次验证未通过，已返回首页\n\n请确认支付后重新操作`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "↩️ 返回首页", callback_data: "back_start" }],
        ],
      },
    });
    return true;
  }

  await setState(from.id, "awaiting_order", { attempts });
  await sendMessage(chatId, `❌ <b>订单号格式不正确</b>\n\n请仔细核对后重新输入完整订单号 👇`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "↩️ 返回", callback_data: "vip_intro" }],
      ],
    },
  });
  return true;
}

// ═══════════════════════════════════════════════════════════
//  /dh 兑换系统
// ═══════════════════════════════════════════════════════════
async function handleDhCommand(chatId, from, callbackQueryId) {
  if (callbackQueryId) await answerCallbackQuery(callbackQueryId);
  await clearState(from.id);

  // 获取所有商品关键词
  const products = await sql`SELECT id, keyword FROM products ORDER BY created_at ASC`;

  if (products.length === 0) {
    await sendMessage(chatId, `🎁 <b>兑换中心</b>\n\n⏳ 暂无可兑换商品\n请等待管理员上架，敬请期待～ ✨`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "↩️ 返回首页", callback_data: "back_start" }],
        ],
      },
    });
    return;
  }

  // 分页显示
  await showDhPage(chatId, from, 0);
}

async function showDhPage(chatId, from, page, editMsgId) {
  const products = await sql`SELECT id, keyword FROM products ORDER BY created_at ASC`;
  const pageSize = 10;
  const totalPages = Math.ceil(products.length / pageSize);
  const currentPage = Math.min(page, totalPages - 1);
  const start = currentPage * pageSize;
  const pageProducts = products.slice(start, start + pageSize);

  const buttons = pageProducts.map((p) => [{ text: `📦 ${p.keyword}`, callback_data: `dh_item_${p.id}` }]);

  // 分页导航
  const nav = [];
  if (currentPage > 0) nav.push({ text: "⬅️ 上一页", callback_data: `dh_page_${currentPage - 1}` });
  if (currentPage < totalPages - 1) nav.push({ text: "➡️ 下一页", callback_data: `dh_page_${currentPage + 1}` });
  if (nav.length > 0) buttons.push(nav);
  buttons.push([{ text: "↩️ 返回首页", callback_data: "back_start" }]);

  const text = `🎁 <b>兑换中心</b>\n\n📄 第 ${currentPage + 1}/${totalPages} 页\n\n请选择要兑换的内容 👇`;

  if (editMsgId) {
    await editMessageText(chatId, editMsgId, text, { reply_markup: { inline_keyboard: buttons } });
  } else {
    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: buttons } });
  }
}

async function handleDhItem(chatId, from, productId, callbackQueryId) {
  await answerCallbackQuery(callbackQueryId);

  // 频控检查
  const check = await checkRateLimit(from.id);
  if (!check.allowed) {
    const btns = [];
    if (check.showVip) {
      btns.push([{ text: "💎 加入会员（新春特价）", callback_data: "vip_intro" }]);
    }
    btns.push([{ text: "↩️ 返回兑换", callback_data: "dh_enter" }]);
    await sendMessage(chatId, check.msg, { reply_markup: { inline_keyboard: btns } });
    return;
  }

  // 获取商品内容
  const items = await sql`SELECT * FROM product_items WHERE product_id = ${productId} ORDER BY sort_order ASC, id ASC`;
  if (items.length === 0) {
    await sendMessage(chatId, `📦 该商品暂无内容`, {
      reply_markup: { inline_keyboard: [[{ text: "↩️ 返回兑换", callback_data: "dh_enter" }]] },
    });
    return;
  }

  // 记录使用
  await recordUse(from.id);

  // 分组发送，每10条一组
  const groupSize = 10;
  const totalGroups = Math.ceil(items.length / groupSize);

  // 存储发送状态
  await setState(from.id, "dh_sending", { productId, currentGroup: 0, totalGroups, totalItems: items.length });

  await sendDhGroup(chatId, from.id, items, 0, groupSize, totalGroups);
}

async function sendDhGroup(chatId, userId, items, groupIndex, groupSize, totalGroups) {
  const start = groupIndex * groupSize;
  const end = Math.min(start + groupSize, items.length);
  const groupItems = items.slice(start, end);

  for (let i = 0; i < groupItems.length; i++) {
    const item = groupItems[i];
    const progress = `📦 文件 ${start + i + 1}/${items.length}`;
    await sendProductItem(chatId, item, progress);
  }

  if (groupIndex + 1 < totalGroups) {
    // 还有更多组
    await setState(userId, "dh_sending", { items: items.map(i => i.id), currentGroup: groupIndex + 1, totalGroups, totalItems: items.length, productId: items[0].product_id });
    await sendMessage(chatId, `✨👉 已发送 ${end}/${items.length} 条\n\n请点击继续发送`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "▶️ 继续发送", callback_data: `dh_continue_${items[0].product_id}_${groupIndex + 1}` }],
          [{ text: "↩️ 返回兑换", callback_data: "dh_enter" }],
        ],
      },
    });
  } else {
    await clearState(userId);
    await sendMessage(chatId, `✅ <b>文件发送完毕</b>（共 ${items.length} 条）\n\n感谢使用！`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💎 加入会员（新春特价）", callback_data: "vip_intro" }],
          [{ text: "↩️ 返回兑换", callback_data: "dh_enter" }],
        ],
      },
    });
  }
}

async function sendProductItem(chatId, item, progress) {
  try {
    switch (item.msg_type) {
      case "text":
        await sendMessage(chatId, `${progress}\n\n${item.content}`);
        break;
      case "photo":
        await sendPhoto(chatId, item.file_id, `${progress}\n${item.caption || ""}`);
        break;
      case "document":
        await sendDocument(chatId, item.file_id, `${progress}\n${item.caption || ""}`);
        break;
      case "video":
        await sendVideo(chatId, item.file_id, `${progress}\n${item.caption || ""}`);
        break;
      case "animation":
        await sendAnimation(chatId, item.file_id, `${progress}\n${item.caption || ""}`);
        break;
      case "sticker":
        await sendSticker(chatId, item.file_id);
        break;
      case "voice":
        await sendVoice(chatId, item.file_id, `${progress}`);
        break;
      case "audio":
        await sendAudio(chatId, item.file_id, `${progress}\n${item.caption || ""}`);
        break;
      case "forward":
        // 转发存储为 text 类型但标记为 forward
        await sendMessage(chatId, `${progress}\n\n${item.content || ""}`);
        break;
      default:
        if (item.file_id) {
          await sendDocument(chatId, item.file_id, `${progress}\n${item.caption || ""}`);
        } else {
          await sendMessage(chatId, `${progress}\n\n${item.content || "[未知格式]"}`);
        }
    }
  } catch (e) {
    await sendMessage(chatId, `${progress}\n\n⚠️ 发送失败`);
  }
}

// ═══════════════════════════════════════════════════════════
//  /admin 管理面板
// ═══════════════════════════════════════════════════════════
async function handleAdmin(chatId, from) {
  if (!isAdmin(from.id)) return;
  await clearState(from.id);

  await sendMessage(chatId, `🔧 <b>管理员面板</b>\n\n请选择操作 👇`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📷 获取 File ID", callback_data: "admin_fileid" }],
        [{ text: "📦 商品添加 /p", callback_data: "admin_products" }],
        [{ text: "🎫 工单管理", callback_data: "admin_tickets_0" }],
        [{ text: "👥 用户表", callback_data: "admin_users_0" }],
      ],
    },
  });
}

// ═══════════════════════════════════════════════════════════
//  File ID 获取
// ═══════════════════════════════════════════════════════════
async function handleFileIdStart(chatId, from, callbackQueryId) {
  if (!isAdmin(from.id)) return;
  if (callbackQueryId) await answerCallbackQuery(callbackQueryId);
  await setState(from.id, "awaiting_fileid");
  await sendMessage(chatId, `📷 <b>获取 File ID</b>\n\n请发送图片、文件、视频或贴纸，我将返回其 file_id`, {
    reply_markup: {
      inline_keyboard: [[{ text: "↩️ 返回管理面板", callback_data: "admin_back" }]],
    },
  });
}

async function handleFileIdInput(chatId, from, message) {
  let fileId = null;
  let fileType = "unknown";

  if (message.photo) {
    fileId = message.photo[message.photo.length - 1].file_id;
    fileType = "photo";
  } else if (message.document) {
    fileId = message.document.file_id;
    fileType = "document";
  } else if (message.video) {
    fileId = message.video.file_id;
    fileType = "video";
  } else if (message.animation) {
    fileId = message.animation.file_id;
    fileType = "animation";
  } else if (message.sticker) {
    fileId = message.sticker.file_id;
    fileType = "sticker";
  } else if (message.voice) {
    fileId = message.voice.file_id;
    fileType = "voice";
  } else if (message.audio) {
    fileId = message.audio.file_id;
    fileType = "audio";
  } else if (message.video_note) {
    fileId = message.video_note.file_id;
    fileType = "video_note";
  }

  if (fileId) {
    await sendMessage(chatId, `✅ <b>File ID 获取成功</b>\n\n📁 类型：${fileType}\n\n<code>${fileId}</code>`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📷 继续获取", callback_data: "admin_fileid" }],
          [{ text: "↩️ 返回管理面板", callback_data: "admin_back" }],
        ],
      },
    });
    await clearState(from.id);
    return true;
  }

  await sendMessage(chatId, `❌ 无法识别此消息类型，请发送图片/文件/视频/贴纸`);
  return true;
}

// ═══════════════════════════════════════════════════════════
//  /p 商品管理
// ═══════════════════════════════════════════════════════════
async function handleProducts(chatId, from, callbackQueryId, page = 0) {
  if (!isAdmin(from.id)) return;
  if (callbackQueryId) await answerCallbackQuery(callbackQueryId);
  await clearState(from.id);

  const products = await sql`SELECT id, keyword, created_at FROM products ORDER BY created_at ASC`;
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(products.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const start = currentPage * pageSize;
  const pageProducts = products.slice(start, start + pageSize);

  const buttons = pageProducts.map((p) => [
    { text: `📦 ${p.keyword}`, callback_data: `p_view_${p.id}` },
    { text: `🗑 删除`, callback_data: `p_del_${p.id}` },
  ]);

  // 分页导航
  const nav = [];
  if (currentPage > 0) nav.push({ text: "⬅️ 上一页", callback_data: `p_page_${currentPage - 1}` });
  if (currentPage < totalPages - 1) nav.push({ text: "➡️ 下一页", callback_data: `p_page_${currentPage + 1}` });
  if (nav.length > 0) buttons.push(nav);

  buttons.push([{ text: "➕ 上架新关键词", callback_data: "p_add_keyword" }]);
  buttons.push([{ text: "↩️ 返回管理面板", callback_data: "admin_back" }]);

  const text = `📦 <b>商品管理</b>\n\n📄 第 ${currentPage + 1}/${totalPages} 页\n共 ${products.length} 个关键词`;

  await sendMessage(chatId, text, { reply_markup: { inline_keyboard: buttons } });
}

async function handleAddKeyword(chatId, from, callbackQueryId) {
  if (!isAdmin(from.id)) return;
  if (callbackQueryId) await answerCallbackQuery(callbackQueryId);
  await setState(from.id, "p_awaiting_keyword");
  await sendMessage(chatId, `📝 <b>上架新关键词</b>\n\n请输入关键词：`, {
    reply_markup: {
      inline_keyboard: [[{ text: "↩️ 取消", callback_data: "admin_products" }]],
    },
  });
}

async function handleKeywordInput(chatId, from, text) {
  const keyword = text.trim();
  // 检查是否已存在
  const existing = await sql`SELECT id FROM products WHERE keyword = ${keyword}`;
  if (existing.length > 0) {
    await sendMessage(chatId, `❌ 关键词 <b>${escapeHtml(keyword)}</b> 已存在`);
    return;
  }

  const result = await sql`INSERT INTO products (keyword) VALUES (${keyword}) RETURNING id`;
  const productId = result[0].id;
  await setState(from.id, "p_awaiting_content", { productId, keyword, sortOrder: 0 });

  await sendMessage(chatId, `✅ 关键词 <b>${escapeHtml(keyword)}</b> 已创建\n\n📝 请发送内容（支持任意格式，逐条记录）\n发送完毕后点击下方按钮完成上架`, {
    reply_markup: {
      inline_keyboard: [[{ text: "✅ 完成上架", callback_data: `p_finish_${productId}` }]],
    },
  });
}

async function handleContentInput(chatId, from, message) {
  const { data } = await getState(from.id);
  const productId = data.productId;
  let sortOrder = data.sortOrder || 0;

  let msgType = "text";
  let content = null;
  let fileId = null;
  let caption = null;

  if (message.forward_from || message.forward_from_chat || message.forward_sender_name) {
    // 转发消息 - 提取内容但不显示来源
    if (message.text) {
      msgType = "text";
      content = message.text;
    } else if (message.photo) {
      msgType = "photo";
      fileId = message.photo[message.photo.length - 1].file_id;
      caption = message.caption || "";
    } else if (message.document) {
      msgType = "document";
      fileId = message.document.file_id;
      caption = message.caption || "";
    } else if (message.video) {
      msgType = "video";
      fileId = message.video.file_id;
      caption = message.caption || "";
    } else if (message.animation) {
      msgType = "animation";
      fileId = message.animation.file_id;
      caption = message.caption || "";
    } else if (message.sticker) {
      msgType = "sticker";
      fileId = message.sticker.file_id;
    } else if (message.voice) {
      msgType = "voice";
      fileId = message.voice.file_id;
    } else if (message.audio) {
      msgType = "audio";
      fileId = message.audio.file_id;
      caption = message.caption || "";
    } else {
      msgType = "text";
      content = message.text || "[转发内容]";
    }
  } else if (message.text) {
    msgType = "text";
    content = message.text;
  } else if (message.photo) {
    msgType = "photo";
    fileId = message.photo[message.photo.length - 1].file_id;
    caption = message.caption || "";
  } else if (message.document) {
    msgType = "document";
    fileId = message.document.file_id;
    caption = message.caption || "";
  } else if (message.video) {
    msgType = "video";
    fileId = message.video.file_id;
    caption = message.caption || "";
  } else if (message.animation) {
    msgType = "animation";
    fileId = message.animation.file_id;
    caption = message.caption || "";
  } else if (message.sticker) {
    msgType = "sticker";
    fileId = message.sticker.file_id;
  } else if (message.voice) {
    msgType = "voice";
    fileId = message.voice.file_id;
  } else if (message.audio) {
    msgType = "audio";
    fileId = message.audio.file_id;
    caption = message.caption || "";
  }

  sortOrder++;
  await sql`
    INSERT INTO product_items (product_id, msg_type, content, file_id, caption, sort_order)
    VALUES (${productId}, ${msgType}, ${content}, ${fileId}, ${caption}, ${sortOrder})
  `;
  await setState(from.id, "p_awaiting_content", { ...data, sortOrder });

  await sendMessage(chatId, `✅ 已添加第 ${sortOrder} 条内容\n\n继续发送更多内容，或点击完成上架`, {
    reply_markup: {
      inline_keyboard: [[{ text: "✅ 完成上架", callback_data: `p_finish_${productId}` }]],
    },
  });
}

async function handleFinishProduct(chatId, from, productId, callbackQueryId) {
  if (!isAdmin(from.id)) return;
  await answerCallbackQuery(callbackQueryId, "✅ 上架完成！");
  await clearState(from.id);

  const items = await sql`SELECT COUNT(*) as cnt FROM product_items WHERE product_id = ${productId}`;
  const product = await sql`SELECT keyword FROM products WHERE id = ${productId}`;

  await sendMessage(chatId, `✅ <b>上架完成</b>\n\n📦 关键词：${escapeHtml(product[0]?.keyword || "")}\n📝 共 ${items[0].cnt} 条内容`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📦 商品管理", callback_data: "admin_products" }],
        [{ text: "↩️ 返回管理面板", callback_data: "admin_back" }],
      ],
    },
  });
}

async function handleDeleteProduct(chatId, from, productId, callbackQueryId) {
  if (!isAdmin(from.id)) return;
  await answerCallbackQuery(callbackQueryId);
  const product = await sql`SELECT keyword FROM products WHERE id = ${productId}`;
  if (product.length === 0) return;

  await sendMessage(chatId, `⚠️ 确认删除关键词 <b>${escapeHtml(product[0].keyword)}</b> 及其所有内容？\n\n此操作不可恢复！`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "⚠️ 确认删除", callback_data: `p_del_confirm_${productId}` }],
        [{ text: "↩️ 取消", callback_data: "admin_products" }],
      ],
    },
  });
}

async function handleDeleteProductConfirm(chatId, from, productId, callbackQueryId) {
  if (!isAdmin(from.id)) return;
  await answerCallbackQuery(callbackQueryId, "✅ 已删除");
  await sql`DELETE FROM product_items WHERE product_id = ${productId}`;
  await sql`DELETE FROM products WHERE id = ${productId}`;
  await handleProducts(chatId, from, null, 0);
}

async function handleViewProduct(chatId, from, productId, callbackQueryId) {
  if (!isAdmin(from.id)) return;
  await answerCallbackQuery(callbackQueryId);
  const product = await sql`SELECT keyword FROM products WHERE id = ${productId}`;
  const items = await sql`SELECT * FROM product_items WHERE product_id = ${productId} ORDER BY sort_order ASC, id ASC`;

  if (product.length === 0) return;

  let text = `📦 <b>关键词：${escapeHtml(product[0].keyword)}</b>\n\n共 ${items.length} 条内容：\n\n`;
  items.forEach((item, i) => {
    text += `${i + 1}. [${item.msg_type}] ${item.content ? escapeHtml(item.content.substring(0, 30)) : item.file_id ? "📎文件" : ""}\n`;
  });

  await sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🗑 删除此关键词", callback_data: `p_del_${productId}` }],
        [{ text: "↩️ 返回商品列表", callback_data: "admin_products" }],
      ],
    },
  });
}

// ═══════════════════════════════════════════════════════════
//  工单管理
// ═══════════════════════════════════════════════════════════
async function handleTickets(chatId, from, callbackQueryId, page = 0) {
  if (!isAdmin(from.id)) return;
  if (callbackQueryId) await answerCallbackQuery(callbackQueryId);

  const tickets = await sql`SELECT * FROM tickets WHERE is_deleted = false ORDER BY created_at ASC`;
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(tickets.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const start = currentPage * pageSize;
  const pageTickets = tickets.slice(start, start + pageSize);

  const buttons = pageTickets.map((t) => [
    { text: `🎫 ${t.first_name || ""}${t.username ? " @" + t.username : ""} (${t.user_id})`, callback_data: `ticket_view_${t.id}` },
  ]);

  const nav = [];
  if (currentPage > 0) nav.push({ text: "⬅️ 上一页", callback_data: `tickets_page_${currentPage - 1}` });
  if (currentPage < totalPages - 1) nav.push({ text: "➡️ 下一页", callback_data: `tickets_page_${currentPage + 1}` });
  if (nav.length > 0) buttons.push(nav);
  buttons.push([{ text: "↩️ 返回管理面板", callback_data: "admin_back" }]);

  const text = `🎫 <b>工单管理</b>\n\n📄 第 ${currentPage + 1}/${totalPages} 页\n共 ${tickets.length} 条工单`;

  await sendMessage(chatId, text, { reply_markup: { inline_keyboard: buttons } });
}

async function handleTicketView(chatId, from, ticketId, callbackQueryId) {
  if (!isAdmin(from.id)) return;
  await answerCallbackQuery(callbackQueryId);

  const tickets = await sql`SELECT * FROM tickets WHERE id = ${ticketId}`;
  if (tickets.length === 0) return;
  const t = tickets[0];

  const createdAt = new Date(t.created_at);
  const bjTime = new Date(createdAt.getTime() + 8 * 60 * 60 * 1000);
  const timeStr = bjTime.toISOString().replace("T", " ").slice(0, 19);

  const text = `🎫 <b>工单详情</b>

👤 用户名字：${escapeHtml(t.first_name || "无")}
📛 用户名：${t.username ? "@" + t.username : "无"}
🆔 用户ID：<code>${t.user_id}</code>
📝 订单号：<code>${t.order_number}</code>
🕐 时间：${timeStr}（北京时间）`;

  await sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🗑 删除此工单", callback_data: `ticket_del_${ticketId}` }],
        [{ text: "↩️ 返回工单列表", callback_data: "admin_tickets_0" }],
      ],
    },
  });
}

async function handleTicketDelete(chatId, from, ticketId, callbackQueryId) {
  if (!isAdmin(from.id)) return;
  await answerCallbackQuery(callbackQueryId, "✅ 已删除");
  await sql`UPDATE tickets SET is_deleted = true WHERE id = ${ticketId}`;
  await handleTickets(chatId, from, null, 0);
}

// ═══════════════════════════════════════════════════════════
//  用户表
// ═══════════════════════════════════════════════════════════
async function handleUsers(chatId, from, callbackQueryId, page = 0) {
  if (!isAdmin(from.id)) return;
  if (callbackQueryId) await answerCallbackQuery(callbackQueryId);

  const users = await sql`SELECT * FROM users ORDER BY first_seen_ts ASC`;
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(users.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const start = currentPage * pageSize;
  const pageUsers = users.slice(start, start + pageSize);

  const buttons = pageUsers.map((u) => [
    { text: `${u.username ? "@" + u.username : u.first_name || "用户"} (${u.user_id})`, callback_data: `user_view_${u.user_id}` },
  ]);

  const nav = [];
  if (currentPage > 0) nav.push({ text: "⬅️ 上一页", callback_data: `users_page_${currentPage - 1}` });
  if (currentPage < totalPages - 1) nav.push({ text: "➡️ 下一页", callback_data: `users_page_${currentPage + 1}` });
  if (nav.length > 0) buttons.push(nav);
  buttons.push([{ text: "↩️ 返回管理面板", callback_data: "admin_back" }]);

  const text = `👥 <b>用户表</b>\n\n📄 第 ${currentPage + 1}/${totalPages} 页\n共 ${users.length} 位用户`;

  await sendMessage(chatId, text, { reply_markup: { inline_keyboard: buttons } });
}

async function handleUserView(chatId, from, targetUserId, callbackQueryId) {
  if (!isAdmin(from.id)) return;
  await answerCallbackQuery(callbackQueryId);

  const users = await sql`SELECT * FROM users WHERE user_id = ${targetUserId}`;
  if (users.length === 0) return;
  const u = users[0];

  const firstSeen = u.first_seen_ts ? new Date(new Date(u.first_seen_ts).getTime() + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19) : "未知";
  const lastSeen = u.last_seen_ts ? new Date(new Date(u.last_seen_ts).getTime() + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19) : "未知";

  const text = `👤 <b>用户详情</b>

📛 名字：${escapeHtml(u.first_name || "")} ${escapeHtml(u.last_name || "")}
📛 用户名：${u.username ? "@" + u.username : "无"}
🆔 ID：<code>${u.user_id}</code>
📅 首次使用：${firstSeen}（北京时间）
🕐 最近活跃：${lastSeen}（北京时间）
🚫 停用状态：${u.is_disabled ? "已停用" : "正常"}`;

  await sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: u.is_disabled ? "✅ 启用" : "🚫 停用", callback_data: `user_toggle_${u.user_id}` }],
        [{ text: "↩️ 返回用户表", callback_data: "admin_users_0" }],
      ],
    },
  });
}

async function handleUserToggle(chatId, from, targetUserId, callbackQueryId) {
  if (!isAdmin(from.id)) return;
  await answerCallbackQuery(callbackQueryId);
  const users = await sql`SELECT is_disabled FROM users WHERE user_id = ${targetUserId}`;
  if (users.length === 0) return;
  const newStatus = !users[0].is_disabled;
  await sql`UPDATE users SET is_disabled = ${newStatus} WHERE user_id = ${targetUserId}`;
  await handleUserView(chatId, from, targetUserId, null);
}

// ═══════════════════════════════════════════════════════════
//  /c 和 /cz 命令
// ═══════════════════════════════════════════════════════════
async function handleCancel(chatId, from) {
  if (!isAdmin(from.id)) return;
  await clearState(from.id);
  await sendMessage(chatId, `✅ 已取消当前操作`, {
    reply_markup: {
      inline_keyboard: [[{ text: "↩️ 返回管理面板", callback_data: "admin_back" }]],
    },
  });
}

async function handleResetSelf(chatId, from) {
  if (!isAdmin(from.id)) return;
  const dateKey = getBeijingDateKey();
  await sql`UPDATE users SET dh_date_key = ${dateKey}, dh_used_count = 0, dh_cooldown_index = 0, dh_last_use_ts = NULL, first_seen_date = ${dateKey} WHERE user_id = ${from.id}`;
  await clearState(from.id);
  await sendMessage(chatId, `✅ 已重置\n\n• 兑换次数：已清零\n• 状态：新用户（免费3次）\n• 仅影响您自己`, {
    reply_markup: {
      inline_keyboard: [[{ text: "↩️ 返回管理面板", callback_data: "admin_back" }]],
    },
  });
}

// ═══════════════════════════════════════════════════════════
//  主路由 - Webhook Handler
// ═══════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  try {
    const update = req.body;

    // ─── Callback Query 处理 ───
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;
      const from = cb.from;
      const data = cb.data;
      const msgId = cb.message.message_id;

      await ensureUser(from);

      // 首页
      if (data === "back_start") {
        await answerCallbackQuery(cb.id);
        await handleStart(chatId, from);
        return res.status(200).send("OK");
      }

      // VIP
      if (data === "vip_intro") {
        await handleVipIntro(chatId, from, cb.id);
        return res.status(200).send("OK");
      }

      if (data === "verify_pay") {
        await handleVerifyPay(chatId, from, cb.id);
        return res.status(200).send("OK");
      }

      // 兑换
      if (data === "dh_enter") {
        await answerCallbackQuery(cb.id);
        await handleDhCommand(chatId, from);
        return res.status(200).send("OK");
      }

      if (data.startsWith("dh_page_")) {
        const page = parseInt(data.split("_")[2]);
        await answerCallbackQuery(cb.id);
        await showDhPage(chatId, from, page, msgId);
        return res.status(200).send("OK");
      }

      if (data.startsWith("dh_item_")) {
        const productId = parseInt(data.split("_")[2]);
        await handleDhItem(chatId, from, productId, cb.id);
        return res.status(200).send("OK");
      }

      if (data.startsWith("dh_continue_")) {
        await answerCallbackQuery(cb.id);
        const parts = data.split("_");
        const productId = parseInt(parts[2]);
        const groupIndex = parseInt(parts[3]);
        const items = await sql`SELECT * FROM product_items WHERE product_id = ${productId} ORDER BY sort_order ASC, id ASC`;
        await sendDhGroup(chatId, from.id, items, groupIndex, 10, Math.ceil(items.length / 10));
        return res.status(200).send("OK");
      }

      // Admin
      if (data === "admin_back") {
        await handleAdmin(chatId, from);
        return res.status(200).send("OK");
      }

      if (data === "admin_fileid") {
        await handleFileIdStart(chatId, from, cb.id);
        return res.status(200).send("OK");
      }

      if (data === "admin_products") {
        await handleProducts(chatId, from, cb.id);
        return res.status(200).send("OK");
      }

      if (data.startsWith("p_page_")) {
        const page = parseInt(data.split("_")[2]);
        await answerCallbackQuery(cb.id);
        await handleProducts(chatId, from, null, page);
        return res.status(200).send("OK");
      }

      if (data === "p_add_keyword") {
        await handleAddKeyword(chatId, from, cb.id);
        return res.status(200).send("OK");
      }

      if (data.startsWith("p_finish_")) {
        const productId = parseInt(data.split("_")[2]);
        await handleFinishProduct(chatId, from, productId, cb.id);
        return res.status(200).send("OK");
      }

      if (data.startsWith("p_del_confirm_")) {
        const productId = parseInt(data.split("_")[3]);
        await handleDeleteProductConfirm(chatId, from, productId, cb.id);
        return res.status(200).send("OK");
      }

      if (data.startsWith("p_del_")) {
        const productId = parseInt(data.split("_")[2]);
        await handleDeleteProduct(chatId, from, productId, cb.id);
        return res.status(200).send("OK");
      }

      if (data.startsWith("p_view_")) {
        const productId = parseInt(data.split("_")[2]);
        await handleViewProduct(chatId, from, productId, cb.id);
        return res.status(200).send("OK");
      }

      // 工单
      if (data.startsWith("admin_tickets_")) {
        const page = parseInt(data.split("_")[2]);
        await handleTickets(chatId, from, cb.id, page);
        return res.status(200).send("OK");
      }

      if (data.startsWith("tickets_page_")) {
        const page = parseInt(data.split("_")[2]);
        await handleTickets(chatId, from, cb.id, page);
        return res.status(200).send("OK");
      }

      if (data.startsWith("ticket_view_")) {
        const ticketId = parseInt(data.split("_")[2]);
        await handleTicketView(chatId, from, ticketId, cb.id);
        return res.status(200).send("OK");
      }

      if (data.startsWith("ticket_del_")) {
        const ticketId = parseInt(data.split("_")[2]);
        await handleTicketDelete(chatId, from, ticketId, cb.id);
        return res.status(200).send("OK");
      }

      // 用户表
      if (data.startsWith("admin_users_")) {
        const page = parseInt(data.split("_")[2]);
        await handleUsers(chatId, from, cb.id, page);
        return res.status(200).send("OK");
      }

      if (data.startsWith("users_page_")) {
        const page = parseInt(data.split("_")[2]);
        await handleUsers(chatId, from, cb.id, page);
        return res.status(200).send("OK");
      }

      if (data.startsWith("user_view_")) {
        const targetId = parseInt(data.split("_")[2]);
        await handleUserView(chatId, from, targetId, cb.id);
        return res.status(200).send("OK");
      }

      if (data.startsWith("user_toggle_")) {
        const targetId = parseInt(data.split("_")[2]);
        await handleUserToggle(chatId, from, targetId, cb.id);
        return res.status(200).send("OK");
      }

      await answerCallbackQuery(cb.id);
      return res.status(200).send("OK");
    }

    // ─── Message 处理 ───
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const from = msg.from;
      const text = msg.text || "";

      // 仅处理私聊
      if (msg.chat.type !== "private") return res.status(200).send("OK");

      await ensureUser(from);

      // 检查停用状态
      const userRows = await sql`SELECT is_disabled FROM users WHERE user_id = ${from.id}`;
      if (userRows.length > 0 && userRows[0].is_disabled && !isAdmin(from.id)) {
        await sendMessage(chatId, "🚫 您的账号已被停用，请联系管理员");
        return res.status(200).send("OK");
      }

      // ── 命令处理 ──
      if (text.startsWith("/start")) {
        const param = text.split(" ")[1] || "";
        await handleStart(chatId, from, param);
        return res.status(200).send("OK");
      }

      if (text === "/admin") {
        if (!isAdmin(from.id)) {
          await sendMessage(chatId, "🚫 无权限");
          return res.status(200).send("OK");
        }
        await handleAdmin(chatId, from);
        return res.status(200).send("OK");
      }

      if (text === "/v") {
        await handleVipIntro(chatId, from);
        return res.status(200).send("OK");
      }

      if (text === "/dh") {
        await handleDhCommand(chatId, from);
        return res.status(200).send("OK");
      }

      if (text === "/p") {
        if (!isAdmin(from.id)) {
          await sendMessage(chatId, "🚫 无权限");
          return res.status(200).send("OK");
        }
        await handleProducts(chatId, from, null);
        return res.status(200).send("OK");
      }

      if (text === "/c") {
        await handleCancel(chatId, from);
        return res.status(200).send("OK");
      }

      if (text === "/cz") {
        await handleResetSelf(chatId, from);
        return res.status(200).send("OK");
      }

      // ── 状态机处理 ──
      const { state, data: stateData } = await getState(from.id);

      if (state === "awaiting_fileid" && isAdmin(from.id)) {
        await handleFileIdInput(chatId, from, msg);
        return res.status(200).send("OK");
      }

      if (state === "awaiting_order") {
        const handled = await handleOrderInput(chatId, from, text);
        if (handled) return res.status(200).send("OK");
      }

      if (state === "p_awaiting_keyword" && isAdmin(from.id)) {
        await handleKeywordInput(chatId, from, text);
        return res.status(200).send("OK");
      }

      if (state === "p_awaiting_content" && isAdmin(from.id)) {
        await handleContentInput(chatId, from, msg);
        return res.status(200).send("OK");
      }

      // 无匹配 - 默认回复
      // 不做回复，避免骚扰
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }

  return res.status(200).send("OK");
};
