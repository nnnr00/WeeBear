"use strict";

/**
 * =========================================================
 * 顶部可修改配置（你要求：都放顶部）
 * =========================================================
 */

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

// 仅一个管理员
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : NaN;

// 时区：北京时间
const TIMEZONE = "Asia/Shanghai";

// /dh 配额
const DAILY_LIMIT = 10;
const NEW_USER_FREE_TODAY = 3;
const OLD_USER_FREE_DAILY = 2;

// 冷却序列：你指定 5 10 20 30 40 ...
// 超过序列后，继续按最后一步递增（例如一直 +10）保证不会报错
const COOLDOWN_SEQUENCE_MINUTES = [5, 10, 20, 30, 40];

// 触发式删除（auto_delete）
const AUTO_DELETE_EXPIRE_MINUTES = 5;

// 分页大小（用户表、工单列表等）
const PAGE_SIZE = 10;

// /v 图片
const FILE_ID_PAYMENT =
  "AgACAgUAAxkBAAIDd2mEHCq1fvS4dwIjba1YCTLObQonAAJtDWsbrPMhVNjJFj6MFYBoAQADAgADeQADOAQ";
const FILE_ID_ORDER =
  "AgACAgUAAxkBAAIdz2mO8C3H0bWB81kO_KwIr5Tw0rkUAAJTD2sbFyV5VFJNZyg1bcyEAQADAgADeQADOgQ";

// 入群链接
const VIP_GROUP_LINK = "https://t.me/+495j5rWmApsxYzg9";

// /start 文案
const START_TEXT =
  "🎉 喜迎新春｜资源免费获取\n\n" +
  "欢迎使用资源助手～\n" +
  "请选择下方功能开始👇";

// /v 文案（禁止出现20260提示）
const VIP_TEXT =
  "🧧 喜迎新春（特价）\n\n" +
  "💎 VIP会员特权说明：\n" +
  "✅ 专属中转通道\n" +
  "✅ 优先审核入群\n" +
  "✅ 7×24小时客服支持\n" +
  "✅ 定期福利活动\n\n" +
  "请按提示完成付款与验证。";

const ORDER_GUIDE_TEXT =
  "请发送你的【订单号】进行验证（请不要发送截图）。\n\n" +
  "【如何查看订单号】\n" +
  "我的 → 账单 → 账单详情 → 更多/查看详情 → 订单号\n\n" +
  "复制订单号后，直接发给我即可。";

// /v 订单号失败提示（美化）
const ORDER_FAIL_1_TEXT =
  "❌ 未识别到有效订单号，请再发送一次（仅发送订单号文本即可）。";

const ORDER_FAIL_2_TEXT =
  "❌ 验证失败次数已达上限。\n\n" +
  "请返回首页重新发起验证，或联系管理员协助。\n\n" +
  "💎 加入会员无需等待｜🧧 新春特价限时开启\n" +
  "机不可失，时不再来！";

// /dh 文案
const DH_HOME_TEXT =
  "🎁 兑换\n\n" +
  "请选择下方关键词获取内容👇\n" +
  "（内容由管理员上传，支持任意格式，私密发送）";

const DH_EMPTY_TEXT =
  "📭 暂无兑换内容\n\n" +
  "请等待管理员上传内容后再查看。";

// /admin 文案
const ADMIN_TEXT = "🛠 管理员后台\n请选择功能：";

// /p 文案
const P_HOME_TEXT =
  "🛒 商品添加\n\n" +
  "点击下方按钮开始上架。\n" +
  "你也可以删除已存在的关键词。";

// 等待提示
function buildCooldownText(remainingMilliseconds) {
  const remaining = Math.max(0, remainingMilliseconds);
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const secondsText = String(seconds).padStart(2, "0");

  return (
    "⏳ 当前需要稍候再试\n" +
    `距离下一次可用还需：**${minutes}分${secondsText}秒**\n\n` +
    "💎 加入会员无需等待｜🧧 新春特价限时开启\n" +
    "✨ 免等待｜⚡ 更稳定｜🔒 更私密\n" +
    "机不可失，时不再来！期待你的加入～"
  );
}

const DAILY_LIMIT_TEXT =
  "🚫 今日次数已用完，请明日再试或加入会员。\n\n" +
  "💎 加入会员无需等待｜🧧 新春特价限时开启\n" +
  "✨ 免等待｜⚡ 更稳定｜🔒 更私密\n" +
  "机不可失，时不再来！期待你的加入～";

// 工单通知管理员
function buildAdminTicketText(user, orderNumber) {
  const username = user.username ? `@${user.username}` : "无";
  const firstName = user.first_name ? String(user.first_name) : (user.firstName ? String(user.firstName) : "无");
  return (
    "🧾 新会员验证工单\n" +
    `- 👤 用户：${firstName}（${username}）\n` +
    `- 🆔 用户ID：${user.id}\n` +
    `- 🔢 订单号：${orderNumber}\n` +
    `- ⏰ 时间：${new Date().toISOString()}`
  );
}

/**
 * =========================================================
 * 依赖与校验
 * =========================================================
 */

const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const { Pool } = require("pg");

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN environment variable.");
if (!DATABASE_URL) throw new Error("Missing DATABASE_URL environment variable.");
if (!Number.isFinite(ADMIN_ID)) throw new Error("Missing or invalid ADMIN_ID environment variable.");

if (!(DATABASE_URL.startsWith("postgresql://") || DATABASE_URL.startsWith("postgres://"))) {
  throw new Error("Invalid DATABASE_URL format. It must start with postgresql:// or postgres://");
}

const bot = new Bot(BOT_TOKEN);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/**
 * =========================================================
 * 数据库初始化（新增辅助表，不动你原有表与数据）
 * products / pending_reviews / auto_delete 全保留
 * =========================================================
 */

async function ensureTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_users (
        user_id BIGINT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        first_seen_date TEXT,
        last_seen_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dh_quota (
        user_id BIGINT PRIMARY KEY,
        date_key TEXT NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0,
        next_allowed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_state (
        user_id BIGINT PRIMARY KEY,
        state_key TEXT,
        state_value TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 用于 /p 临时收集上架内容（不展示草稿列表，但需要存住）
    await client.query(`
      CREATE TABLE IF NOT EXISTS p_buffer (
        id BIGSERIAL PRIMARY KEY,
        admin_id BIGINT NOT NULL,
        keyword TEXT NOT NULL,
        content_type TEXT NOT NULL,
        content_data TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  } finally {
    client.release();
  }
}

/**
 * =========================================================
 * 时间工具（北京时间格式化）
 * =========================================================
 */

function getDateKeyInTimezone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(date); // YYYY-MM-DD
}

function formatBeijingDateTime(date) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  return formatter.format(date);
}

/**
 * =========================================================
 * 触发式删除：复用 auto_delete（先删过期，再处理请求）
 * =========================================================
 */

async function registerAutoDelete(chatId, messageId, minutes) {
  const client = await pool.connect();
  try {
    const deleteAt = new Date(Date.now() + minutes * 60 * 1000);
    await client.query(
      `INSERT INTO auto_delete (chat_id, message_id, delete_at) VALUES ($1, $2, $3);`,
      [Number(chatId), Number(messageId), deleteAt]
    );
  } finally {
    client.release();
  }
}

async function gcExpiredMessages(ctx) {
  if (!ctx.chat || !ctx.chat.id) return;
  const chatId = Number(ctx.chat.id);
  const now = new Date();

  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT id, message_id
      FROM auto_delete
      WHERE chat_id = $1
        AND delete_at IS NOT NULL
        AND delete_at <= $2
      ORDER BY delete_at ASC
      LIMIT 500;
      `,
      [chatId, now]
    );

    for (const row of res.rows) {
      try {
        await ctx.api.deleteMessage(chatId, Number(row.message_id));
      } catch (error) {}
      try {
        await client.query(`DELETE FROM auto_delete WHERE id = $1;`, [row.id]);
      } catch (error) {}
    }
  } finally {
    client.release();
  }
}

/**
 * =========================================================
 * 用户记录：新用户判定 + 最近使用时间
 * =========================================================
 */

async function upsertBotUser(user) {
  const userId = Number(user.id);
  const username = user.username ? String(user.username) : null;
  const firstName = user.first_name ? String(user.first_name) : (user.firstName ? String(user.firstName) : null);
  const lastName = user.last_name ? String(user.last_name) : (user.lastName ? String(user.lastName) : null);
  const todayKey = getDateKeyInTimezone(new Date(), TIMEZONE);

  const client = await pool.connect();
  try {
    const existing = await client.query(
      `SELECT first_seen_date FROM bot_users WHERE user_id = $1;`,
      [userId]
    );

    if (existing.rows.length === 0) {
      await client.query(
        `
        INSERT INTO bot_users (user_id, username, first_name, last_name, first_seen_date, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, NOW());
        `,
        [userId, username, firstName, lastName, todayKey]
      );
      return { isFirstDay: true, firstSeenDate: todayKey };
    }

    await client.query(
      `
      UPDATE bot_users
      SET username = $2, first_name = $3, last_name = $4, last_seen_at = NOW()
      WHERE user_id = $1;
      `,
      [userId, username, firstName, lastName]
    );

    const firstSeenDate = existing.rows[0].first_seen_date;
    return { isFirstDay: firstSeenDate === todayKey, firstSeenDate };
  } finally {
    client.release();
  }
}

/**
 * =========================================================
 * 状态表：bot_state
 * =========================================================
 */

async function setUserState(userId, key, value) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO bot_state (user_id, state_key, state_value, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET state_key = EXCLUDED.state_key, state_value = EXCLUDED.state_value, updated_at = NOW();
      `,
      [Number(userId), String(key), String(value)]
    );
  } finally {
    client.release();
  }
}

async function getUserState(userId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT state_key, state_value FROM bot_state WHERE user_id = $1;`,
      [Number(userId)]
    );
    if (res.rows.length === 0) return { key: null, value: null };
    return { key: res.rows[0].state_key, value: res.rows[0].state_value };
  } finally {
    client.release();
  }
}

async function clearUserState(userId) {
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM bot_state WHERE user_id = $1;`, [Number(userId)]);
  } finally {
    client.release();
  }
}

/**
 * =========================================================
 * 管理员鉴权
 * =========================================================
 */

function isAdmin(ctx) {
  return Boolean(ctx.from && Number(ctx.from.id) === Number(ADMIN_ID));
}

async function requireAdmin(ctx) {
  if (!isAdmin(ctx)) {
    const sent = await ctx.reply("⛔ 无权限访问");
    if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    return false;
  }
  return true;
}

/**
 * =========================================================
 * /dh 频控：新/老用户 + 冷却序列 + 日切
 * =========================================================
 */

function getCooldownMinutesByIndex(index) {
  if (index < 0) return 0;
  if (index < COOLDOWN_SEQUENCE_MINUTES.length) return COOLDOWN_SEQUENCE_MINUTES[index];
  const last = COOLDOWN_SEQUENCE_MINUTES[COOLDOWN_SEQUENCE_MINUTES.length - 1];
  // 超过序列后继续每次 + last（例如继续 +40）
  return last + (index - (COOLDOWN_SEQUENCE_MINUTES.length - 1)) * last;
}

async function getOrInitQuota(userId, todayKey) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT date_key, used_count, next_allowed_at FROM dh_quota WHERE user_id = $1;`,
      [Number(userId)]
    );

    if (res.rows.length === 0) {
      await client.query(
        `INSERT INTO dh_quota (user_id, date_key, used_count, next_allowed_at, updated_at)
         VALUES ($1, $2, 0, NULL, NOW());`,
        [Number(userId), todayKey]
      );
      return { usedCount: 0, nextAllowedAt: null, dateKey: todayKey };
    }

    const row = res.rows[0];
    if (row.date_key !== todayKey) {
      await client.query(
        `UPDATE dh_quota
         SET date_key = $2, used_count = 0, next_allowed_at = NULL, updated_at = NOW()
         WHERE user_id = $1;`,
        [Number(userId), todayKey]
      );
      return { usedCount: 0, nextAllowedAt: null, dateKey: todayKey };
    }

    return {
      usedCount: Number(row.used_count || 0),
      nextAllowedAt: row.next_allowed_at ? new Date(row.next_allowed_at) : null,
      dateKey: row.date_key
    };
  } finally {
    client.release();
  }
}

async function updateQuotaAfterSuccess(userId, todayKey, usedCount, nextAllowedAt) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE dh_quota
       SET date_key = $2, used_count = $3, next_allowed_at = $4, updated_at = NOW()
       WHERE user_id = $1;`,
      [Number(userId), todayKey, Number(usedCount), nextAllowedAt]
    );
  } finally {
    client.release();
  }
}

async function dhCheckAndConsumeQuota(ctx) {
  const todayKey = getDateKeyInTimezone(new Date(), TIMEZONE);
  const userInfo = await upsertBotUser(ctx.from);
  const quota = await getOrInitQuota(ctx.from.id, todayKey);

  if (quota.usedCount >= DAILY_LIMIT) {
    return { allowed: false, reason: "limit" };
  }

  if (quota.nextAllowedAt && quota.nextAllowedAt.getTime() > Date.now()) {
    return { allowed: false, reason: "cooldown", nextAllowedAt: quota.nextAllowedAt };
  }

  const newUsedCount = quota.usedCount + 1;
  const freeCount = userInfo.isFirstDay ? NEW_USER_FREE_TODAY : OLD_USER_FREE_DAILY;

  let nextAllowedAt = null;
  if (newUsedCount >= freeCount) {
    const afterFreeIndex = newUsedCount - freeCount; // 0开始
    const minutes = getCooldownMinutesByIndex(afterFreeIndex);
    nextAllowedAt = new Date(Date.now() + minutes * 60 * 1000);
  }

  await updateQuotaAfterSuccess(ctx.from.id, todayKey, newUsedCount, nextAllowedAt);
  return { allowed: true };
}

async function sendDhBlocked(ctx, blockInfo) {
  const keyboard = new InlineKeyboard()
    .text("💎 加入会员（新春特价）", "go_v")
    .row()
    .text("↩️ 返回兑换 (/dh)", "go_dh");

  if (blockInfo.reason === "limit") {
    const sent = await ctx.reply(DAILY_LIMIT_TEXT, { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    return;
  }

  if (blockInfo.reason === "cooldown") {
    const remainingMs = blockInfo.nextAllowedAt.getTime() - Date.now();
    const sent = await ctx.reply(buildCooldownText(remainingMs), { reply_markup: keyboard, parse_mode: "Markdown" });
    if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    return;
  }
}

/**
 * =========================================================
 * products：/dh 关键词按钮（从 products.keyword 聚合）
 * =========================================================
 */

async function listKeywords() {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT keyword, MAX(id) AS max_id
      FROM products
      GROUP BY keyword
      ORDER BY max_id DESC;
      `
    );
    return res.rows.map((r) => String(r.keyword));
  } finally {
    client.release();
  }
}

async function listProductsByKeyword(keyword) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT id, keyword, content_type, content_data, created_at
      FROM products
      WHERE keyword = $1
      ORDER BY id ASC;
      `,
      [String(keyword)]
    );
    return res.rows;
  } finally {
    client.release();
  }
}

async function deleteProductsByKeyword(keyword) {
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM products WHERE keyword = $1;`, [String(keyword)]);
  } finally {
    client.release();
  }
}

/**
 * =========================================================
 * 发送内容：media_group 拆分10个一组，私密发送不forward
 * =========================================================
 */

function normalizeMediaType(type) {
  const t = String(type || "").toLowerCase();
  if (t === "photo") return "photo";
  if (t === "video") return "video";
  if (t === "document") return "document";
  if (t === "audio") return "audio";
  return "document";
}

async function sendProductRow(ctx, row) {
  if (!row) return;

  if (row.content_type === "text") {
    const sent = await ctx.reply(String(row.content_data || ""));
    if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    return;
  }

  if (row.content_type === "media_group") {
    let arr = [];
    try {
      const parsed = JSON.parse(row.content_data);
      if (Array.isArray(parsed)) arr = parsed;
    } catch (error) {
      arr = [];
    }

    if (arr.length === 0) {
      const sent = await ctx.reply("该内容格式异常，无法发送。");
      if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
      return;
    }

    // sendMediaGroup 一次最多10
    for (let i = 0; i < arr.length; i += 10) {
      const chunk = arr.slice(i, i + 10);
      const media = chunk.map((m) => {
        const type = normalizeMediaType(m.type);
        const fileId = String(m.data);
        if (type === "photo") return { type: "photo", media: fileId };
        if (type === "video") return { type: "video", media: fileId };
        if (type === "audio") return { type: "audio", media: fileId };
        return { type: "document", media: fileId };
      });

      try {
        const messages = await ctx.api.sendMediaGroup(ctx.chat.id, media);
        if (Array.isArray(messages)) {
          for (const msg of messages) {
            if (msg && msg.message_id) await registerAutoDelete(ctx.chat.id, msg.message_id, AUTO_DELETE_EXPIRE_MINUTES);
          }
        }
      } catch (error) {
        // 失败降级逐条发送
        for (const m of chunk) {
          const type = normalizeMediaType(m.type);
          const fileId = String(m.data);
          try {
            let sent = null;
            if (type === "photo") sent = await ctx.replyWithPhoto(fileId);
            else if (type === "video") sent = await ctx.replyWithVideo(fileId);
            else sent = await ctx.replyWithDocument(fileId);
            if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
          } catch (e) {}
        }
      }
    }
    return;
  }

  // 其它类型
  const sent = await ctx.reply(String(row.content_data || ""));
  if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
}

/**
 * =========================================================
 * 工单列表：pending_reviews（管理员后台查看）
 * =========================================================
 */

async function countTickets() {
  const client = await pool.connect();
  try {
    const res = await client.query(`SELECT COUNT(*)::int AS c FROM pending_reviews;`);
    return Number(res.rows[0].c || 0);
  } finally {
    client.release();
  }
}

async function listTicketsPage(offset, limit) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT id, user_id, username, first_name, order_number, submitted_at, status
      FROM pending_reviews
      ORDER BY id DESC
      LIMIT $1 OFFSET $2;
      `,
      [Number(limit), Number(offset)]
    );
    return res.rows;
  } finally {
    client.release();
  }
}

/**
 * =========================================================
 * 中间件：初始化 + 触发式删除 + 记录用户
 * =========================================================
 */

bot.use(async (ctx, next) => {
  await ensureTables();
  await gcExpiredMessages(ctx);
  if (ctx.from) await upsertBotUser(ctx.from);
  await next();
});

/**
 * =========================================================
 * /start（支持 deep link start=dh）
 * =========================================================
 */

async function showStart(ctx) {
  const keyboard = new InlineKeyboard()
    .text("💎 加入会员（新春特价）", "go_v")
    .text("🎁 兑换", "go_dh");
  const sent = await ctx.reply(START_TEXT, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
}

bot.command("start", async (ctx) => {
  // deep link 参数：/start dh
  const text = ctx.message && ctx.message.text ? String(ctx.message.text) : "";
  const parts = text.split(" ").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2 && parts[1] === "dh") {
    await showDh(ctx);
    return;
  }
  await showStart(ctx);
});

bot.callbackQuery("go_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showStart(ctx);
});

/**
 * =========================================================
 * 全局要求：除命令外，用户发任何消息都跳 /dh
 * =========================================================
 */

async function showDh(ctx) {
  // /dh 入口需要频控
  const allow = await dhCheckAndConsumeQuota(ctx);
  if (!allow.allowed) {
    await sendDhBlocked(ctx, allow);
    return;
  }

  const keywords = await listKeywords();
  if (!keywords.length) {
    const keyboard = new InlineKeyboard()
      .text("💎 加入会员（新春特价）", "go_v")
      .row()
      .text("🏠 返回首页", "go_start");
    const sent = await ctx.reply(DH_EMPTY_TEXT, { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    return;
  }

  // 关键词按钮：10个一页（翻页不覆盖）
  await sendDhKeywordPage(ctx, 0);
}

bot.command("dh", async (ctx) => {
  await showDh(ctx);
});

bot.callbackQuery("go_dh", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showDh(ctx);
});

// 非命令消息：全部跳 /dh（你要求）
bot.on("message", async (ctx) => {
  if (!ctx.from) return;

  // 命令消息交给命令处理
  if (ctx.message && typeof ctx.message.text === "string" && ctx.message.text.trim().startsWith("/")) {
    return;
  }

  // 优先处理 /v 的订单号输入状态
  const st = await getUserState(ctx.from.id);
  if (st.key === "v_wait_order") {
    if (ctx.message && typeof ctx.message.text === "string") {
      await handleVipOrderInput(ctx);
      return;
    } else {
      // 订单号必须是文字
      await ctx.reply("请发送订单号文本（不要发送图片/文件）。");
      return;
    }
  }

  // 优先处理 /p 的“等待关键词/等待内容”
  if (isAdmin(ctx)) {
    if (st.key === "p_wait_keyword" && ctx.message && typeof ctx.message.text === "string") {
      await handlePKeywordInput(ctx);
      return;
    }
    if (st.key === "p_wait_content") {
      await handlePContentInput(ctx);
      return;
    }
  }

  // 其它任何消息 -> /dh
  await showDh(ctx);
});

/**
 * =========================================================
 * /dh：关键词菜单分页（10个一页，翻页不覆盖）
 * =========================================================
 */

async function sendDhKeywordPage(ctx, pageIndex) {
  const keywords = await listKeywords();
  const total = keywords.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);

  const start = safePageIndex * PAGE_SIZE;
  const pageItems = keywords.slice(start, start + PAGE_SIZE);

  const text = `📄 ${safePageIndex + 1}/${pageCount}\n\n${DH_HOME_TEXT}`;
  const keyboard = new InlineKeyboard();

  // 每个关键词一个按钮：点击直接发送该关键词内容
  for (const kw of pageItems) {
    keyboard.text(String(kw), `dh_kw:${encodeURIComponent(String(kw))}`).row();
  }

  if (safePageIndex > 0) keyboard.text("◀️ 上一页", `dh_kw_page:${safePageIndex - 1}`);
  if (safePageIndex < pageCount - 1) keyboard.text("▶️ 继续发送", `dh_kw_page:${safePageIndex + 1}`);

  keyboard.row();
  keyboard.text("💎 加入会员（新春特价）", "go_v");
  keyboard.row();
  keyboard.text("🏠 返回首页", "go_start");

  const sent = await ctx.reply(text, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
}

bot.callbackQuery(/^dh_kw_page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendDhKeywordPage(ctx, Number(ctx.match[1]));
});

// 点击关键词 -> 发送对应内容（10条为一组，用户手动继续）
bot.callbackQuery(/^dh_kw:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const keyword = decodeURIComponent(ctx.match[1]);

  // 发送该关键词的内容：按 products 的记录顺序
  const rows = await listProductsByKeyword(keyword);
  if (!rows.length) {
    const sent = await ctx.reply("该关键词暂无内容，请等待管理员上传。");
    if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    return;
  }

  // 存一个“当前关键词发送进度”状态（用户分页继续发送）
  await setUserState(ctx.from.id, "dh_send_kw", keyword);
  await setUserState(ctx.from.id, "dh_send_offset", "0");

  await sendDhContentChunk(ctx, keyword, 0);
});

async function sendDhContentChunk(ctx, keyword, offset) {
  const rows = await listProductsByKeyword(keyword);
  const total = rows.length;

  const chunk = rows.slice(offset, offset + 10);
  for (const row of chunk) {
    await sendProductRow(ctx, row);
  }

  const nextOffset = offset + chunk.length;
  const finished = nextOffset >= total;

  const keyboard = new InlineKeyboard()
    .text("↩️ 返回兑换 (/dh)", "go_dh")
    .row()
    .text("💎 加入会员（新春特价）", "go_v");

  if (!finished) {
    keyboard.row().text("▶️ 继续发送", `dh_send_more:${encodeURIComponent(keyword)}:${nextOffset}`);
  }

  const sent = await ctx.reply(
    finished ? "✅ 已发送完该关键词的全部内容。" : "已发送本组内容，点击继续发送下一组👇",
    { reply_markup: keyboard }
  );
  if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);

  if (finished) {
    await clearUserState(ctx.from.id);
  }
}

bot.callbackQuery(/^dh_send_more:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const keyword = decodeURIComponent(ctx.match[1]);
  const offset = Number(ctx.match[2]);
  await sendDhContentChunk(ctx, keyword, offset);
});

/**
 * =========================================================
 * /v：恢复 20260 自动验证 + 两次失败回 /start
 * =========================================================
 */

async function showVip(ctx) {
  const sent1 = await ctx.replyWithPhoto(FILE_ID_PAYMENT, { caption: VIP_TEXT });
  if (ctx.chat && sent1 && sent1.message_id) await registerAutoDelete(ctx.chat.id, sent1.message_id, AUTO_DELETE_EXPIRE_MINUTES);

  const keyboard = new InlineKeyboard()
    .text("✅ 我已付款，开始验证", "v_paid")
    .row()
    .text("🏠 返回首页", "go_start");

  const sent2 = await ctx.reply("请点击下方按钮继续👇", { reply_markup: keyboard });
  if (ctx.chat && sent2 && sent2.message_id) await registerAutoDelete(ctx.chat.id, sent2.message_id, AUTO_DELETE_EXPIRE_MINUTES);
}

bot.command("v", async (ctx) => {
  await showVip(ctx);
});

bot.callbackQuery("go_v", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showVip(ctx);
});

bot.callbackQuery("v_paid", async (ctx) => {
  await ctx.answerCallbackQuery();

  const sent1 = await ctx.replyWithPhoto(FILE_ID_ORDER, { caption: ORDER_GUIDE_TEXT });
  if (ctx.chat && sent1 && sent1.message_id) await registerAutoDelete(ctx.chat.id, sent1.message_id, AUTO_DELETE_EXPIRE_MINUTES);

  await setUserState(ctx.from.id, "v_wait_order", "0"); // value=失败次数
  const sent2 = await ctx.reply("请发送订单号：");
  if (ctx.chat && sent2 && sent2.message_id) await registerAutoDelete(ctx.chat.id, sent2.message_id, AUTO_DELETE_EXPIRE_MINUTES);
});

function extractOrderNumber20260(text) {
  // 识别以20260开头的连续数字串，长度不限
  const match = String(text || "").match(/\b20260\d+\b/);
  return match ? match[0] : null;
}

async function handleVipOrderInput(ctx) {
  const st = await getUserState(ctx.from.id);
  const failCount = Number(st.value || "0");

  const text = String(ctx.message.text || "").trim();
  const orderNumber = extractOrderNumber20260(text);

  if (!orderNumber) {
    const newFail = failCount + 1;
    if (newFail >= 2) {
      await clearUserState(ctx.from.id);
      const keyboard = new InlineKeyboard()
        .text("🏠 返回首页", "go_start")
        .row()
        .text("💎 加入会员（新春特价）", "go_v");
      await ctx.reply(ORDER_FAIL_2_TEXT, { reply_markup: keyboard });
      await showStart(ctx);
      return;
    }

    await setUserState(ctx.from.id, "v_wait_order", String(newFail));
    const keyboard = new InlineKeyboard().text("↩️ 重新输入订单号", "v_paid").row().text("🏠 返回首页", "go_start");
    const sent = await ctx.reply(ORDER_FAIL_1_TEXT, { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    return;
  }

  // 成功：写 pending_reviews + 发管理员工单（私发）
  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO pending_reviews (user_id, username, first_name, review_type, file_id, order_number, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending');
      `,
      [
        Number(ctx.from.id),
        ctx.from.username ? String(ctx.from.username) : null,
        ctx.from.first_name ? String(ctx.from.first_name) : null,
        "vip",
        null,
        orderNumber
      ]
    );
  } finally {
    client.release();
  }

  try {
    await ctx.api.sendMessage(ADMIN_ID, buildAdminTicketText(ctx.from, orderNumber));
  } catch (error) {}

  await clearUserState(ctx.from.id);

  const keyboard = new InlineKeyboard()
    .url("✅ 加入会员群", VIP_GROUP_LINK)
    .row()
    .text("🎁 去兑换", "go_dh")
    .row()
    .text("🏠 返回首页", "go_start");

  const sent = await ctx.reply("✅ 验证通过，欢迎加入会员！\n点击下方按钮进群：", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
}

/**
 * =========================================================
 * /admin：FileID / 商品添加 / 用户表 / 工单
 * =========================================================
 */

bot.command("admin", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const keyboard = new InlineKeyboard()
    .text("🆔 获取 File ID", "admin_fileid")
    .row()
    .text("🛒 商品添加", "admin_p")
    .row()
    .text("📮 工单", "admin_tickets")
    .row()
    .text("👥 用户表", "admin_users")
    .row()
    .text("🏠 返回首页", "go_start");

  const sent = await ctx.reply(ADMIN_TEXT, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
});

bot.callbackQuery("admin_fileid", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;

  await setUserState(ctx.from.id, "admin_wait_fileid", "1");
  const keyboard = new InlineKeyboard().text("↩️ 返回 /admin", "admin_back");
  const sent = await ctx.reply("请发送媒体以获取 file_id：", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
});

bot.callbackQuery("admin_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  await ctx.reply("/admin");
});

// 工单列表
bot.callbackQuery("admin_tickets", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  await sendTicketsPage(ctx, 0);
});

bot.callbackQuery(/^admin_tickets_page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  await sendTicketsPage(ctx, Number(ctx.match[1]));
});

async function sendTicketsPage(ctx, pageIndex) {
  const total = await countTickets();
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);
  const offset = safePageIndex * PAGE_SIZE;

  const rows = await listTicketsPage(offset, PAGE_SIZE);
  const header = `📄 ${safePageIndex + 1}/${pageCount}\n📮 工单列表\n\n`;

  const lines = rows.map((r) => {
    const uname = r.username ? `@${r.username}` : "无";
    const fname = r.first_name ? String(r.first_name) : "无";
    const order = r.order_number ? String(r.order_number) : "无";
    const status = r.status ? String(r.status) : "pending";
    const time = r.submitted_at ? formatBeijingDateTime(new Date(r.submitted_at)) : "未知";
    return `#${r.id}  ${fname}（${uname}）\n🆔 ${r.user_id}\n🔢 ${order}\n🕒 ${time}\n📌 ${status}`;
  }).join("\n\n");

  const keyboard = new InlineKeyboard();
  if (safePageIndex > 0) keyboard.text("◀️ 上一页", `admin_tickets_page:${safePageIndex - 1}`);
  if (safePageIndex < pageCount - 1) keyboard.text("▶️ 下一页", `admin_tickets_page:${safePageIndex + 1}`);
  keyboard.row().text("↩️ 返回 /admin", "admin_back");

  const sent = await ctx.reply(header + (lines || "暂无工单"), { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
}

// 用户表：按钮列表 + 点击详情
bot.callbackQuery("admin_users", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  await sendUsersButtonPage(ctx, 0);
});

bot.callbackQuery(/^admin_users_page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  await sendUsersButtonPage(ctx, Number(ctx.match[1]));
});

bot.callbackQuery(/^admin_user:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  await sendUserDetail(ctx, Number(ctx.match[1]));
});

async function countUsers() {
  const client = await pool.connect();
  try {
    const res = await client.query(`SELECT COUNT(*)::int AS c FROM bot_users;`);
    return Number(res.rows[0].c || 0);
  } finally {
    client.release();
  }
}

async function listUsersPage(offset, limit) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT user_id, username, first_name, first_seen_date, last_seen_at
      FROM bot_users
      ORDER BY last_seen_at DESC NULLS LAST
      LIMIT $1 OFFSET $2;
      `,
      [Number(limit), Number(offset)]
    );
    return res.rows;
  } finally {
    client.release();
  }
}

async function getUserRow(userId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT user_id, username, first_name, first_seen_date, last_seen_at FROM bot_users WHERE user_id = $1 LIMIT 1;`,
      [Number(userId)]
    );
    return res.rows.length ? res.rows[0] : null;
  } finally {
    client.release();
  }
}

async function sendUsersButtonPage(ctx, pageIndex) {
  const total = await countUsers();
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);
  const offset = safePageIndex * PAGE_SIZE;

  const rows = await listUsersPage(offset, PAGE_SIZE);
  const text = `📄 ${safePageIndex + 1}/${pageCount}\n👥 用户表（点击查看详情）`;

  const keyboard = new InlineKeyboard();
  for (const r of rows) {
    const uname = r.username ? `@${r.username}` : "无用户名";
    const label = `${uname}（${r.user_id}）`;
    keyboard.text(label, `admin_user:${r.user_id}`).row();
  }

  if (safePageIndex > 0) keyboard.text("◀️ 上一页", `admin_users_page:${safePageIndex - 1}`);
  if (safePageIndex < pageCount - 1) keyboard.text("▶️ 下一页", `admin_users_page:${safePageIndex + 1}`);
  keyboard.row().text("↩️ 返回 /admin", "admin_back");

  const sent = await ctx.reply(text, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
}

async function sendUserDetail(ctx, userId) {
  const r = await getUserRow(userId);
  if (!r) {
    await ctx.reply("未找到该用户。");
    return;
  }

  const uname = r.username ? `@${r.username}` : "无";
  const fname = r.first_name ? String(r.first_name) : "无";
  const firstSeen = r.first_seen_date ? String(r.first_seen_date) : "未知";
  const lastSeen = r.last_seen_at ? formatBeijingDateTime(new Date(r.last_seen_at)) : "未知";

  const text =
    "👤 用户详情\n\n" +
    `用户名字：${fname}\n` +
    `用户名：${uname}\n` +
    `用户ID：${r.user_id}\n` +
    `首次（北京时间）：${firstSeen}\n` +
    `最近（北京时间）：${lastSeen}`;

  const keyboard = new InlineKeyboard()
    .text("↩️ 返回用户表", "admin_users")
    .row()
    .text("↩️ 返回 /admin", "admin_back");

  const sent = await ctx.reply(text, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
}

/**
 * =========================================================
 * /p：商品添加（无草稿列表展示，但内部用 p_buffer 存）
 * 流程：上架+ -> 输入关键词 -> 输入内容(逐条记录) -> 完成上架 -> 返回/p
 * 支持删除关键词：两次确认
 * =========================================================
 */

bot.command("p", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  await showP(ctx);
});

bot.callbackQuery("admin_p", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  await showP(ctx);
});

async function showP(ctx) {
  // 展示已存在关键词（按钮），并提供 “➕ 上架” 按钮
  const keywords = await listKeywords();

  const keyboard = new InlineKeyboard()
    .text("➕ 上架新关键词", "p_add")
    .row();

  // 关键词删除按钮
  // 每页10个关键词（分页这里简化：关键词不多时足够；如要分页可再加）
  let count = 0;
  for (const kw of keywords.slice(0, 20)) {
    keyboard.text(`🗑 删除 ${kw}`, `p_del1:${encodeURIComponent(kw)}`).row();
    count += 1;
    if (count >= 20) break;
  }

  keyboard.row().text("↩️ 返回 /admin", "admin_back");

  const sent = await ctx.reply(P_HOME_TEXT, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
}

bot.callbackQuery("p_add", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;

  await setUserState(ctx.from.id, "p_wait_keyword", "1");

  const keyboard = new InlineKeyboard().text("↩️ 返回 /p", "admin_p");
  const sent = await ctx.reply("请输入关键词（例如：1）：", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
});

async function handlePKeywordInput(ctx) {
  const keyword = String(ctx.message.text || "").trim();
  if (!keyword) {
    await ctx.reply("关键词不能为空，请重新输入。");
    return;
  }

  // 进入等待内容状态：state_value 存 keyword
  await setUserState(ctx.from.id, "p_wait_content", keyword);

  // 清空该管理员该关键词的旧 buffer（防止混杂）
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM p_buffer WHERE admin_id = $1 AND keyword = $2;`, [Number(ctx.from.id), keyword]);
  } finally {
    client.release();
  }

  const keyboard = new InlineKeyboard()
    .text("✅ 完成上架", "p_publish")
    .row()
    .text("↩️ 返回 /p", "admin_p");

  const sent = await ctx.reply(
    `关键词已设置为：${keyword}\n\n请开始发送内容（支持任何格式，逐条记录）。\n发送完后点击 ✅ 完成上架。`,
    { reply_markup: keyboard }
  );
  if (ctx.chat && sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
}

function extractFirstFileIdFromMessage(message) {
  if (!message) return null;

  if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
    return message.photo[message.photo.length - 1].file_id;
  }
  if (message.video) return message.video.file_id;
  if (message.document) return message.document.file_id;
  if (message.audio) return message.audio.file_id;
  if (message.voice) return message.voice.file_id;
  if (message.sticker) return message.sticker.file_id;

  return null;
}

function tryExtractContentForStorage(message) {
  // 存储格式必须与 products 兼容
  if (!message) return null;

  // 文本
  if (typeof message.text === "string" && message.text.trim().length > 0) {
    return { contentType: "text", contentData: message.text.trim() };
  }

  // 媒体
  const fileId = extractFirstFileIdFromMessage(message);
  if (fileId) {
    let type = "document";
    if (message.photo) type = "photo";
    else if (message.video) type = "video";
    else if (message.audio) type = "audio";
    else if (message.document) type = "document";
    else if (message.voice) type = "voice";
    else if (message.sticker) type = "sticker";

    // voice/sticker 不适合 media_group，统一当 document 保存，发送时也会降级
    if (type === "voice" || type === "sticker") type = "document";

    const contentData = JSON.stringify([{ type, data: fileId }]);
    return { contentType: "media_group", contentData };
  }

  return null;
}

async function handlePContentInput(ctx) {
  // 管理员发送任意内容 -> 记录到 p_buffer
  const st = await getUserState(ctx.from.id);
  const keyword = st.value;

  const extracted = tryExtractContentForStorage(ctx.message);
  if (!extracted) {
    await ctx.reply("该类型暂不支持记录，请发送文本/图片/视频/文件等。");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO p_buffer (admin_id, keyword, content_type, content_data) VALUES ($1, $2, $3, $4);`,
      [Number(ctx.from.id), String(keyword), extracted.contentType, extracted.contentData]
    );
  } finally {
    client.release();
  }

  await ctx.reply("✅ 已记录一条内容。继续发送，或点击下方 ✅ 完成上架。");
}

bot.callbackQuery("p_publish", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;

  const st = await getUserState(ctx.from.id);
  if (st.key !== "p_wait_content") {
    await ctx.reply("当前不在上架流程中，请先点击 ➕ 上架新关键词。");
    return;
  }

  const keyword = st.value;

  const client = await pool.connect();
  try {
    await client.query("BEGIN;");

    const res = await client.query(
      `SELECT id, content_type, content_data FROM p_buffer WHERE admin_id = $1 AND keyword = $2 ORDER BY id ASC;`,
      [Number(ctx.from.id), String(keyword)]
    );

    if (res.rows.length === 0) {
      await client.query("ROLLBACK;");
      await ctx.reply("未检测到任何内容，请先发送内容再上架。");
      return;
    }

    for (const row of res.rows) {
      await client.query(
        `INSERT INTO products (keyword, content_type, content_data, created_at) VALUES ($1, $2, $3, NOW());`,
        [String(keyword), String(row.content_type), String(row.content_data)]
      );
    }

    await client.query(
      `DELETE FROM p_buffer WHERE admin_id = $1 AND keyword = $2;`,
      [Number(ctx.from.id), String(keyword)]
    );

    await client.query("COMMIT;");
  } catch (error) {
    try { await client.query("ROLLBACK;"); } catch (e) {}
    await ctx.reply("❌ 上架失败，请检查数据库或稍后再试。");
    return;
  } finally {
    client.release();
  }

  await clearUserState(ctx.from.id);

  const keyboard = new InlineKeyboard()
    .text("↩️ 返回 /p", "admin_p")
    .row()
    .text("🎁 去兑换 (/dh)", "go_dh");

  await ctx.reply(`✅ 上架完成：关键词「${keyword}」已生效。`, { reply_markup: keyboard });
});

// 删除关键词两次确认
bot.callbackQuery(/^p_del1:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;

  const kw = decodeURIComponent(ctx.match[1]);
  const keyboard = new InlineKeyboard()
    .text("✅ 确认删除", `p_del2:${encodeURIComponent(kw)}`)
    .row()
    .text("↩️ 取消", "admin_p");

  await ctx.reply(
    `⚠️ 是否删除关键词「${kw}」的全部内容？\n删除后不可恢复。`,
    { reply_markup: keyboard }
  );
});

bot.callbackQuery(/^p_del2:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;

  const kw = decodeURIComponent(ctx.match[1]);
  const keyboard = new InlineKeyboard()
    .text("🗑 真的确定删除", `p_del3:${encodeURIComponent(kw)}`)
    .row()
    .text("↩️ 取消", "admin_p");

  await ctx.reply(
    `❗最后确认：真的要删除关键词「${kw}」吗？`,
    { reply_markup: keyboard }
  );
});

bot.callbackQuery(/^p_del3:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;

  const kw = decodeURIComponent(ctx.match[1]);
  await deleteProductsByKeyword(kw);

  await ctx.reply(`✅ 已删除关键词「${kw}」的全部内容。`);
  await showP(ctx);
});

/**
 * =========================================================
 * /c 与 /cz（仅管理员，且只影响管理员自己）
 * =========================================================
 */

bot.command("c", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  await clearUserState(ctx.from.id);
  await ctx.reply("✅ 已取消你当前的验证/上架等待状态。");
});

bot.command("cz", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const adminId = Number(ctx.from.id);
  const todayKey = getDateKeyInTimezone(new Date(), TIMEZONE);

  const client = await pool.connect();
  try {
    await clearUserState(adminId);

    await client.query(
      `
      INSERT INTO dh_quota (user_id, date_key, used_count, next_allowed_at, updated_at)
      VALUES ($1, $2, 0, NULL, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET date_key = EXCLUDED.date_key, used_count = 0, next_allowed_at = NULL, updated_at = NOW();
      `,
      [adminId, todayKey]
    );

    await client.query(
      `
      INSERT INTO bot_users (user_id, username, first_name, last_name, first_seen_date, last_seen_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET first_seen_date = EXCLUDED.first_seen_date, last_seen_at = NOW();
      `,
      [
        adminId,
        ctx.from.username ? String(ctx.from.username) : null,
        ctx.from.first_name ? String(ctx.from.first_name) : null,
        ctx.from.last_name ? String(ctx.from.last_name) : null,
        todayKey
      ]
    );
  } finally {
    client.release();
  }

  await ctx.reply("♻️ 已重置你自己的测试状态：次数/冷却/新用户状态已恢复。");
});

/**
 * =========================================================
 * /admin 与 /p 的按钮入口
 * =========================================================
 */

bot.callbackQuery("admin_p", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  await showP(ctx);
});

bot.callbackQuery("admin_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  await ctx.reply("/admin");
});

/**
 * =========================================================
 * admin：FileID 获取
 * =========================================================
 */

bot.on("message", async (ctx) => {
  if (!ctx.from) return;

  const st = await getUserState(ctx.from.id);

  if (st.key === "admin_wait_fileid") {
    if (!isAdmin(ctx)) return;

    const fileId = extractFirstFileIdFromMessage(ctx.message);
    if (!fileId) {
      await ctx.reply("未检测到可提取的媒体 file_id，请重新发送媒体内容。");
      return;
    }
    await clearUserState(ctx.from.id);
    await ctx.reply(`🆔 file_id：${fileId}`);
    return;
  }
});

/**
 * =========================================================
 * Vercel handler
 * =========================================================
 */

const handler = webhookCallback(bot, "http");

module.exports = async (req, res) => {
  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("OK");
    return;
  }
  if (req.method === "POST") {
    return handler(req, res);
  }
  res.statusCode = 405;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Method Not Allowed");
};
