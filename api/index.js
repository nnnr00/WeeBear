"use strict";

/**
 * =========================================================
 * 顶部可修改配置（你要求：所有修改都在顶部）
 * =========================================================
 */

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : NaN;

// 北京时间
const TIMEZONE = "Asia/Shanghai";

// /dh 配额
const DAILY_LIMIT = 10;
const NEW_USER_FREE_TODAY = 3;
const OLD_USER_FREE_DAILY = 2;

// 冷却序列：5、10、20、30、40...（按你给的）
const COOLDOWN_SEQUENCE_MINUTES = [5, 10, 20, 30, 40];

// 触发式删除：5分钟
const AUTO_DELETE_EXPIRE_MINUTES = 5;

// 分页：10条/页
const PAGE_SIZE = 10;

// 停用判定：多少天不互动算停用（可改）
const USER_INACTIVE_DAYS = 7;

// /v 两张图
const FILE_ID_PAYMENT =
  "AgACAgUAAxkBAAIDd2mEHCq1fvS4dwIjba1YCTLObQonAAJtDWsbrPMhVNjJFj6MFYBoAQADAgADeQADOAQ";
const FILE_ID_ORDER =
  "AgACAgUAAxkBAAIdz2mO8C3H0bWB81kO_KwIr5Tw0rkUAAJTD2sbFyV5VFJNZyg1bcyEAQADAgADeQADOgQ";

// 入群链接
const VIP_GROUP_LINK = "https://t.me/+495j5rWmApsxYzg9";

// 文案
const START_TEXT =
  "🎉 喜迎新春｜资源免费获取\n\n" +
  "欢迎使用资源助手～\n" +
  "请选择下方功能开始👇";

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

const ORDER_FAIL_1_TEXT =
  "❌ 未识别到有效订单号，请再发送一次（仅发送订单号文本即可）。";

const ORDER_FAIL_2_TEXT =
  "❌ 验证失败次数已达上限。\n\n" +
  "请返回首页重新发起验证，或联系管理员协助。\n\n" +
  "💎 加入会员无需等待｜🧧 新春特价限时开启\n" +
  "机不可失，时不再来！";

const DH_EMPTY_TEXT =
  "📭 暂无兑换内容\n\n" +
  "请等待管理员上传内容后再查看。";

const DH_MENU_TEXT =
  "🎁 兑换\n\n" +
  "请选择下方关键词获取内容👇\n" +
  "（每次发送10条为一组，手动点击继续发送）";

const ADMIN_TEXT =
  "🛠 管理员后台\n" +
  "请选择功能：";

const P_HOME_TEXT =
  "商品添加\n\n" +
  "点击下方按钮开始上架。\n" +
  "也可以删除已存在的关键词。";

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

function buildAdminTicketMessage(user, ticketType, contentLines) {
  const username = user.username ? `@${user.username}` : "无";
  const firstName = user.first_name ? String(user.first_name) : (user.firstName ? String(user.firstName) : "无");
  const timeText = formatBeijingDateTime(new Date());

  return (
    "📮 工单通知\n\n" +
    `类型：${ticketType}\n` +
    `用户：${firstName}（${username}）\n` +
    `用户ID：${user.id}\n` +
    `${contentLines}\n` +
    `时间（北京时间）：${timeText}`
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
 * 数据库初始化（新增辅助表，不动 products/pending_reviews/auto_delete）
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
 * 时间工具（北京时间）
 * =========================================================
 */

function getDateKeyInTimezone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(date);
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

async function registerAutoDelete(chatId, messageId) {
  const client = await pool.connect();
  try {
    const deleteAt = new Date(Date.now() + AUTO_DELETE_EXPIRE_MINUTES * 60 * 1000);
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
 * bot_state
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
    if (!res.rows.length) return { key: null, value: null };
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
 * 用户记录 + 停用判断
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

    if (!existing.rows.length) {
      await client.query(
        `
        INSERT INTO bot_users (user_id, username, first_name, last_name, first_seen_date, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, NOW());
        `,
        [userId, username, firstName, lastName, todayKey]
      );
      return { isFirstDay: true, isFirstSeenEver: true, firstSeenDate: todayKey };
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
    return { isFirstDay: firstSeenDate === todayKey, isFirstSeenEver: false, firstSeenDate };
  } finally {
    client.release();
  }
}

async function getInactiveStatusText(userId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT last_seen_at FROM bot_users WHERE user_id = $1 LIMIT 1;`,
      [Number(userId)]
    );
    if (!res.rows.length || !res.rows[0].last_seen_at) {
      return "用户状态：未知";
    }
    const lastSeen = new Date(res.rows[0].last_seen_at);
    const inactiveMs = USER_INACTIVE_DAYS * 24 * 60 * 60 * 1000;
    const inactive = Date.now() - lastSeen.getTime() >= inactiveMs;
    if (inactive) {
      return `用户停用：${formatBeijingDateTime(lastSeen)}`;
    }
    return "用户状态：活跃";
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
    await ctx.reply("⛔ 无权限访问");
    return false;
  }
  return true;
}

/**
 * =========================================================
 * pending_reviews 工单（复用现有表）
 * =========================================================
 */

async function insertTicketRow(row) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO pending_reviews (user_id, username, first_name, review_type, file_id, order_number, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7);
      `,
      [
        Number(row.user_id),
        row.username,
        row.first_name,
        row.review_type,
        row.file_id,
        row.order_number,
        row.status
      ]
    );
  } finally {
    client.release();
  }
}

async function countTickets() {
  const client = await pool.connect();
  try {
    const res = await client.query(`SELECT COUNT(*)::int AS c FROM pending_reviews;`);
    return Number(res.rows[0].c || 0);
  } finally {
    client.release();
  }
}

async function listTicketsPageOldestFirst(offset, limit) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT id, user_id, username, first_name, review_type, order_number, submitted_at, status
      FROM pending_reviews
      ORDER BY id ASC
      LIMIT $1 OFFSET $2;
      `,
      [Number(limit), Number(offset)]
    );
    return res.rows;
  } finally {
    client.release();
  }
}

async function deleteTicketById(id) {
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM pending_reviews WHERE id = $1;`, [Number(id)]);
  } finally {
    client.release();
  }
}

/**
 * =========================================================
 * products：关键词（最早出现的在前）与内容
 * =========================================================
 */

async function listKeywordsOldestFirst() {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT keyword, MIN(id) AS first_id
      FROM products
      GROUP BY keyword
      ORDER BY first_id ASC;
      `
    );
    return res.rows.map((r) => String(r.keyword));
  } finally {
    client.release();
  }
}

async function listProductsByKeywordOldestFirst(keyword) {
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
 * /dh 频控
 * =========================================================
 */

function getCooldownMinutesByIndex(index) {
  if (index < 0) return 0;
  if (index < COOLDOWN_SEQUENCE_MINUTES.length) return COOLDOWN_SEQUENCE_MINUTES[index];
  const last = COOLDOWN_SEQUENCE_MINUTES[COOLDOWN_SEQUENCE_MINUTES.length - 1];
  return last + (index - (COOLDOWN_SEQUENCE_MINUTES.length - 1)) * last;
}

async function getOrInitQuota(userId, todayKey) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT date_key, used_count, next_allowed_at FROM dh_quota WHERE user_id = $1;`,
      [Number(userId)]
    );

    if (!res.rows.length) {
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
    const afterFreeIndex = newUsedCount - freeCount;
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
    .text("🏠 返回首页", "go_start");

  if (blockInfo.reason === "limit") {
    await ctx.reply(DAILY_LIMIT_TEXT, { reply_markup: keyboard });
    return;
  }
  if (blockInfo.reason === "cooldown") {
    const remainingMs = blockInfo.nextAllowedAt.getTime() - Date.now();
    await ctx.reply(buildCooldownText(remainingMs), { reply_markup: keyboard, parse_mode: "Markdown" });
    return;
  }
}

/**
 * =========================================================
 * 发送内容：media_group 拆分10媒体一组；/dh 记录10条为一组
 * =========================================================
 */

function normalizeMediaType(type) {
  const t = String(type || "").toLowerCase();
  if (t === "photo") return "photo";
  if (t === "video") return "video";
  if (t === "audio") return "audio";
  return "document";
}

async function sendMediaGroupSafely(ctx, mediaArray) {
  try {
    const messages = await ctx.api.sendMediaGroup(ctx.chat.id, mediaArray);
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (msg && msg.message_id) await registerAutoDelete(ctx.chat.id, msg.message_id);
      }
    }
    return true;
  } catch (error) {
    return false;
  }
}

async function sendProductRow(ctx, row) {
  if (!row) return;

  if (row.content_type === "text") {
    const sent = await ctx.reply(String(row.content_data || ""));
    if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
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

    if (!arr.length) {
      const sent = await ctx.reply("该内容格式异常，无法发送。");
      if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
      return;
    }

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

      const ok = await sendMediaGroupSafely(ctx, media);
      if (!ok) {
        for (const m of chunk) {
          const type = normalizeMediaType(m.type);
          const fileId = String(m.data);
          try {
            let sent = null;
            if (type === "photo") sent = await ctx.replyWithPhoto(fileId);
            else if (type === "video") sent = await ctx.replyWithVideo(fileId);
            else sent = await ctx.replyWithDocument(fileId);
            if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
          } catch (e) {}
        }
      }
    }
    return;
  }

  const sent = await ctx.reply(String(row.content_data || ""));
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
}

/**
 * =========================================================
 * 中间件：初始化 + 先删过期 + 用户首次工单
 * =========================================================
 */

bot.use(async (ctx, next) => {
  await ensureTables();
  await gcExpiredMessages(ctx);

  if (ctx.from) {
    const info = await upsertBotUser(ctx.from);
    if (info.isFirstSeenEver) {
      const statusText = "用户状态：首次启动";
      try {
        await insertTicketRow({
          user_id: ctx.from.id,
          username: ctx.from.username ? String(ctx.from.username) : null,
          first_name: ctx.from.first_name ? String(ctx.from.first_name) : null,
          review_type: "first_open",
          file_id: null,
          order_number: null,
          status: statusText
        });
      } catch (error) {}

      try {
        await ctx.api.sendMessage(
          ADMIN_ID,
          buildAdminTicketMessage(ctx.from, "首次启动", statusText)
        );
      } catch (error) {}
    }
  }

  await next();
});

/**
 * =========================================================
 * /start（deep link start=dh）
 * =========================================================
 */

async function showStart(ctx) {
  const keyboard = new InlineKeyboard()
    .text("💎 加入会员（新春特价）", "go_v")
    .text("🎁 兑换", "go_dh");
  const sent = await ctx.reply(START_TEXT, { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
}

bot.command("start", async (ctx) => {
  const text = ctx.message && ctx.message.text ? String(ctx.message.text) : "";
  const parts = text.split(" ").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2 && parts[1] === "dh") {
    await showDh(ctx);
    return;
  }
  await showStart(ctx);
});

bot.callbackQuery("go_start", async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await showStart(ctx);
});

/**
 * =========================================================
 * 全局：除命令外任何消息进入 /dh（但优先处理状态）
 * =========================================================
 */

bot.on("message", async (ctx) => {
  if (!ctx.from) return;

  // 命令不在这里处理
  if (ctx.message && typeof ctx.message.text === "string") {
    const t = ctx.message.text.trim();
    if (t.startsWith("/")) return;
  }

  const st = await getUserState(ctx.from.id);

  // /v 等待订单号
  if (st.key === "v_wait_order") {
    if (ctx.message && typeof ctx.message.text === "string") {
      await handleVipOrderInput(ctx);
    } else {
      await ctx.reply("请发送订单号文本（不要发送图片/文件）。");
    }
    return;
  }

  // /p 流程（仅管理员）
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

  // File ID 模式（仅管理员）
  if (isAdmin(ctx) && st.key === "admin_wait_fileid") {
    const fileId = extractFirstFileIdFromMessage(ctx.message);
    if (!fileId) {
      await ctx.reply("未检测到可提取的媒体 file_id，请重新发送媒体内容。");
      return;
    }
    await clearUserState(ctx.from.id);
    const sent = await ctx.reply(`🆔 file_id：${fileId}`);
    if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
    await showAdmin(ctx);
    return;
  }

  // 其它全部进入 /dh
  await showDh(ctx);
});

/**
 * =========================================================
 * /v：加入会员（两张图 + 20260 内部校验 + 工单）
 * =========================================================
 */

async function showVip(ctx) {
  const sent1 = await ctx.replyWithPhoto(FILE_ID_PAYMENT, { caption: VIP_TEXT });
  if (sent1 && sent1.message_id) await registerAutoDelete(ctx.chat.id, sent1.message_id);

  const keyboard = new InlineKeyboard()
    .text("✅ 我已付款，开始验证", "v_paid")
    .row()
    .text("🏠 返回首页", "go_start");
  const sent2 = await ctx.reply("请点击下方按钮继续👇", { reply_markup: keyboard });
  if (sent2 && sent2.message_id) await registerAutoDelete(ctx.chat.id, sent2.message_id);
}

bot.command("v", async (ctx) => {
  await showVip(ctx);
});

bot.callbackQuery("go_v", async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await showVip(ctx);
});

bot.callbackQuery("v_paid", async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}

  const sent1 = await ctx.replyWithPhoto(FILE_ID_ORDER, { caption: ORDER_GUIDE_TEXT });
  if (sent1 && sent1.message_id) await registerAutoDelete(ctx.chat.id, sent1.message_id);

  await setUserState(ctx.from.id, "v_wait_order", "0");
  const sent2 = await ctx.reply("请发送订单号：");
  if (sent2 && sent2.message_id) await registerAutoDelete(ctx.chat.id, sent2.message_id);
});

function extractOrderNumber20260(text) {
  const match = String(text || "").match(/\b20260\d+\b/);
  return match ? match[0] : null;
}

async function handleVipOrderInput(ctx) {
  const st = await getUserState(ctx.from.id);
  const failCount = Number(st.value || "0");

  const orderNumber = extractOrderNumber20260(String(ctx.message.text || "").trim());

  if (!orderNumber) {
    const newFail = failCount + 1;
    if (newFail >= 2) {
      await clearUserState(ctx.from.id);
      await ctx.reply(ORDER_FAIL_2_TEXT);
      await showStart(ctx);
      return;
    }
    await setUserState(ctx.from.id, "v_wait_order", String(newFail));
    await ctx.reply(ORDER_FAIL_1_TEXT);
    return;
  }

  const statusText = await getInactiveStatusText(ctx.from.id);

  try {
    await insertTicketRow({
      user_id: ctx.from.id,
      username: ctx.from.username ? String(ctx.from.username) : null,
      first_name: ctx.from.first_name ? String(ctx.from.first_name) : null,
      review_type: "vip",
      file_id: null,
      order_number: orderNumber,
      status: statusText
    });
  } catch (error) {}

  try {
    const contentLines = `订单号：${orderNumber}\n${statusText}`;
    await ctx.api.sendMessage(ADMIN_ID, buildAdminTicketMessage(ctx.from, "VIP验证成功", contentLines));
  } catch (error) {}

  await clearUserState(ctx.from.id);

  const keyboard = new InlineKeyboard()
    .url("✅ 加入会员群", VIP_GROUP_LINK)
    .row()
    .text("🎁 去兑换", "go_dh")
    .row()
    .text("🏠 返回首页", "go_start");

  const sent = await ctx.reply("✅ 验证通过，欢迎加入会员！\n点击下方按钮进群：", { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
}

/**
 * =========================================================
 * /dh：关键词菜单分页（📄 1/3），最早上传在前
 * =========================================================
 */

async function showDh(ctx) {
  const allow = await dhCheckAndConsumeQuota(ctx);
  if (!allow.allowed) {
    await sendDhBlocked(ctx, allow);
    return;
  }

  const keywords = await listKeywordsOldestFirst();
  if (!keywords.length) {
    const keyboard = new InlineKeyboard()
      .text("💎 加入会员（新春特价）", "go_v")
      .row()
      .text("🏠 返回首页", "go_start");
    const sent = await ctx.reply(DH_EMPTY_TEXT, { reply_markup: keyboard });
    if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
    return;
  }

  await sendDhKeywordPage(ctx, 0);
}

bot.command("dh", async (ctx) => {
  await showDh(ctx);
});

bot.callbackQuery("go_dh", async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await showDh(ctx);
});

async function sendDhKeywordPage(ctx, pageIndex) {
  const keywords = await listKeywordsOldestFirst();
  const total = keywords.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);

  const start = safePageIndex * PAGE_SIZE;
  const pageItems = keywords.slice(start, start + PAGE_SIZE);

  const text = `📄 ${safePageIndex + 1}/${pageCount}\n\n${DH_MENU_TEXT}`;
  const keyboard = new InlineKeyboard();

  for (const kw of pageItems) {
    keyboard.text(String(kw), `dh_kw:${encodeURIComponent(String(kw))}`).row();
  }

  if (safePageIndex > 0) keyboard.text("◀️ 上一页", `dh_page:${safePageIndex - 1}`);
  if (safePageIndex < pageCount - 1) keyboard.text("▶️ 下一页", `dh_page:${safePageIndex + 1}`);

  keyboard.row().text("💎 加入会员（新春特价）", "go_v");
  keyboard.row().text("🏠 返回首页", "go_start");

  const sent = await ctx.reply(text, { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
}

bot.callbackQuery(/^dh_page:(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await sendDhKeywordPage(ctx, Number(ctx.match[1]));
});

/**
 * 点击关键词：按10条记录为一组发送，组进度 📦 文件 x/y
 * 继续发送按钮携带 offset
 */

bot.callbackQuery(/^dh_kw:(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}

  const keyword = decodeURIComponent(ctx.match[1]);
  const rows = await listProductsByKeywordOldestFirst(keyword);

  if (!rows.length) {
    const sent = await ctx.reply("该关键词暂无内容，请等待管理员上传。");
    if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
    return;
  }

  await sendDhChunk(ctx, keyword, 0);
});

async function sendDhChunk(ctx, keyword, offset) {
  const rows = await listProductsByKeywordOldestFirst(keyword);
  const totalRecords = rows.length;

  const chunk = rows.slice(offset, offset + 10);
  const groupIndex = Math.floor(offset / 10) + 1;
  const groupCount = Math.ceil(totalRecords / 10);

  const tip = await ctx.reply(`📦 文件 ${groupIndex}/${groupCount}`);
  if (tip && tip.message_id) await registerAutoDelete(ctx.chat.id, tip.message_id);

  for (const row of chunk) {
    await sendProductRow(ctx, row);
  }

  const nextOffset = offset + chunk.length;
  const finished = nextOffset >= totalRecords;

  if (finished) {
    const keyboard = new InlineKeyboard()
      .text("💎 加入会员（新春特价）", "go_v")
      .row()
      .text("↩️ 返回兑换", "go_dh");

    const sent = await ctx.reply("✅ 文件发送完毕（全部组已完成）。", { reply_markup: keyboard });
    if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
    return;
  }

  const keyboard = new InlineKeyboard()
    .text("✨👉 请点击继续发送", `dh_more:${encodeURIComponent(keyword)}:${nextOffset}`)
    .row()
    .text("💎 加入会员（新春特价）", "go_v")
    .row()
    .text("↩️ 返回兑换", "go_dh");

  const sent = await ctx.reply("已发送本组内容，点击继续发送下一组👇", { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
}

bot.callbackQuery(/^dh_more:(.+):(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  const keyword = decodeURIComponent(ctx.match[1]);
  const offset = Number(ctx.match[2]);
  await sendDhChunk(ctx, keyword, offset);
});

/**
 * =========================================================
 * /admin（仅管理员）
 * =========================================================
 */

async function showAdmin(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const keyboard = new InlineKeyboard()
    .text("🆔 获取 File ID", "admin_fileid")
    .row()
    .text("商品添加", "admin_p")
    .row()
    .text("工单", "admin_tickets")
    .row()
    .text("用户表", "admin_users")
    .row()
    .text("🏠 返回首页", "go_start");

  const sent = await ctx.reply(ADMIN_TEXT, { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
}

bot.command("admin", async (ctx) => {
  await showAdmin(ctx);
});

bot.callbackQuery("admin_fileid", async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;

  await setUserState(ctx.from.id, "admin_wait_fileid", "1");

  const keyboard = new InlineKeyboard().text("返回", "admin_back");
  const sent = await ctx.reply("请发送媒体（图片/视频/文件等）以获取 file_id：", { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
});

bot.callbackQuery("admin_back", async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  await clearUserState(ctx.from.id);
  await showAdmin(ctx);
});

/**
 * 工单列表：最早在前，分页同 /dh（📄 1/3），含删除（两次确认）
 */

bot.callbackQuery("admin_tickets", async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;
  await sendTicketPage(ctx, 0);
});

bot.callbackQuery(/^admin_tickets_page:(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;
  await sendTicketPage(ctx, Number(ctx.match[1]));
});

async function sendTicketPage(ctx, pageIndex) {
  const total = await countTickets();
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);
  const offset = safePageIndex * PAGE_SIZE;

  const rows = await listTicketsPageOldestFirst(offset, PAGE_SIZE);

  const header = `📄 ${safePageIndex + 1}/${pageCount}\n\n工单列表`;
  const keyboard = new InlineKeyboard();

  let body = header + "\n\n";
  if (!rows.length) {
    body += "暂无工单。";
  } else {
    for (const r of rows) {
      const uname = r.username ? `@${r.username}` : "无";
      const fname = r.first_name ? String(r.first_name) : "无";
      const type = r.review_type ? String(r.review_type) : "unknown";
      const order = r.order_number ? String(r.order_number) : "无";
      const timeText = r.submitted_at ? formatBeijingDateTime(new Date(r.submitted_at)) : "未知";
      const status = r.status ? String(r.status) : "pending";

      body +=
        `#${r.id}  类型：${type}\n` +
        `👤 ${fname}（${uname}）\n` +
        `🆔 ${r.user_id}\n` +
        `🔢 ${order}\n` +
        `🕒 ${timeText}\n` +
        `📌 ${status}\n\n`;

      keyboard.text(`删除#${r.id}`, `ticket_del1:${r.id}`).row();
    }
  }

  if (safePageIndex > 0) keyboard.text("◀️ 上一页", `admin_tickets_page:${safePageIndex - 1}`);
  if (safePageIndex < pageCount - 1) keyboard.text("▶️ 下一页", `admin_tickets_page:${safePageIndex + 1}`);
  keyboard.row().text("返回", "admin_back");

  const sent = await ctx.reply(body, { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
}

bot.callbackQuery(/^ticket_del1:(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;

  const id = Number(ctx.match[1]);
  const keyboard = new InlineKeyboard()
    .text("确认删除", `ticket_del2:${id}`)
    .row()
    .text("返回", "admin_tickets");

  const sent = await ctx.reply(`⚠️ 是否删除工单 #${id}？`, { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
});

bot.callbackQuery(/^ticket_del2:(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;

  const id = Number(ctx.match[1]);
  const keyboard = new InlineKeyboard()
    .text("真的确定删除", `ticket_del3:${id}`)
    .row()
    .text("返回", "admin_tickets");

  const sent = await ctx.reply(`❗最后确认：真的要删除工单 #${id} 吗？`, { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
});

bot.callbackQuery(/^ticket_del3:(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;

  const id = Number(ctx.match[1]);
  await deleteTicketById(id);

  const sent = await ctx.reply(`✅ 已删除工单 #${id}`);
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);

  await sendTicketPage(ctx, 0);
});

/**
 * 用户表：按钮 @用户名（123） -> 详情
 */

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
      ORDER BY user_id ASC;
      `
    );
    // 你要“最早在前”类逻辑，这里按 user_id asc；若你要按 first_seen_date 也可改
    return res.rows.slice(offset, offset + limit);
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

bot.callbackQuery("admin_users", async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;
  await sendUsersPage(ctx, 0);
});

bot.callbackQuery(/^admin_users_page:(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;
  await sendUsersPage(ctx, Number(ctx.match[1]));
});

bot.callbackQuery(/^admin_user:(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;
  await sendUserDetail(ctx, Number(ctx.match[1]));
});

async function sendUsersPage(ctx, pageIndex) {
  const total = await countUsers();
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);
  const offset = safePageIndex * PAGE_SIZE;

  const rows = await listUsersPage(offset, PAGE_SIZE);

  const text = `📄 ${safePageIndex + 1}/${pageCount}\n\n用户表（点击查看详情）`;

  const keyboard = new InlineKeyboard();
  for (const r of rows) {
    const uname = r.username ? `@${r.username}` : "无用户名";
    const label = `${uname}（${r.user_id}）`;
    keyboard.text(label, `admin_user:${r.user_id}`).row();
  }

  if (safePageIndex > 0) keyboard.text("◀️ 上一页", `admin_users_page:${safePageIndex - 1}`);
  if (safePageIndex < pageCount - 1) keyboard.text("▶️ 下一页", `admin_users_page:${safePageIndex + 1}`);
  keyboard.row().text("返回", "admin_back");

  const sent = await ctx.reply(text, { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
}

async function sendUserDetail(ctx, userId) {
  const r = await getUserRow(userId);
  if (!r) {
    const sent = await ctx.reply("未找到该用户。");
    if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
    return;
  }

  const uname = r.username ? `@${r.username}` : "无";
  const fname = r.first_name ? String(r.first_name) : "无";
  const firstSeen = r.first_seen_date ? String(r.first_seen_date) : "未知";
  const lastSeen = r.last_seen_at ? formatBeijingDateTime(new Date(r.last_seen_at)) : "未知";
  const statusText = await getInactiveStatusText(userId);

  const text =
    "用户详情\n\n" +
    `用户名字：${fname}\n` +
    `用户名：${uname}\n` +
    `用户ID：${r.user_id}\n` +
    `首次（北京时间）：${firstSeen}\n` +
    `最近（北京时间）：${lastSeen}\n` +
    `${statusText}`;

  const keyboard = new InlineKeyboard()
    .text("返回", "admin_users")
    .row()
    .text("返回后台", "admin_back");

  const sent = await ctx.reply(text, { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
}

/**
 * =========================================================
 * /p 商品添加（命令 /p，界面不出现 /p 字样）
 * =========================================================
 */

bot.callbackQuery("admin_p", async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;
  await showP(ctx);
});

async function showP(ctx) {
  const keywords = await listKeywordsOldestFirst();

  const keyboard = new InlineKeyboard()
    .text("➕ 上架新关键词", "p_add")
    .row();

  for (const kw of keywords.slice(0, 30)) {
    keyboard.text(`🗑 删除 ${kw}`, `p_del1:${encodeURIComponent(kw)}`).row();
  }

  // ✅ 完成上架按钮不在首页出现（只在内容输入阶段出现，并且永远在最底行）
  keyboard.row().text("返回后台", "admin_back");

  const sent = await ctx.reply(P_HOME_TEXT, { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
}

bot.callbackQuery("p_add", async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;

  await setUserState(ctx.from.id, "p_wait_keyword", "1");
  const sent = await ctx.reply("请输入关键词（例如：1）：");
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
});

async function handlePKeywordInput(ctx) {
  const keyword = String(ctx.message.text || "").trim();
  if (!keyword) {
    const sent = await ctx.reply("关键词不能为空，请重新输入。");
    if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
    return;
  }

  await setUserState(ctx.from.id, "p_wait_content", keyword);

  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM p_buffer WHERE admin_id = $1 AND keyword = $2;`, [Number(ctx.from.id), keyword]);
  } finally {
    client.release();
  }

  const keyboard = new InlineKeyboard()
    .text("返回", "admin_p")
    .row()
    // ✅ 必须永远在最下方：因此键盘最后一行放它
    .text("✅ 完成上架", "p_publish");

  const sent = await ctx.reply(
    `关键词已设置为：${keyword}\n\n请开始发送内容（支持任何格式，逐条记录）。\n发送完后点击 ✅ 完成上架。`,
    { reply_markup: keyboard }
  );
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
}

function extractFirstFileIdFromMessage(message) {
  if (!message) return null;
  if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) return message.photo[message.photo.length - 1].file_id;
  if (message.video) return message.video.file_id;
  if (message.document) return message.document.file_id;
  if (message.audio) return message.audio.file_id;
  return null;
}

function tryExtractContentForStorage(message) {
  if (!message) return null;

  if (typeof message.text === "string" && message.text.trim().length > 0) {
    return { contentType: "text", contentData: message.text.trim() };
  }

  const fileId = extractFirstFileIdFromMessage(message);
  if (fileId) {
    let type = "document";
    if (message.photo) type = "photo";
    else if (message.video) type = "video";
    else if (message.audio) type = "audio";
    else if (message.document) type = "document";

    const contentData = JSON.stringify([{ type, data: fileId }]);
    return { contentType: "media_group", contentData };
  }

  return null;
}

async function handlePContentInput(ctx) {
  const st = await getUserState(ctx.from.id);
  const keyword = st.value;

  const extracted = tryExtractContentForStorage(ctx.message);
  if (!extracted) {
    const sent = await ctx.reply("该类型暂不支持记录，请发送文本/图片/视频/文件等。");
    if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
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

  const sent = await ctx.reply("✅ 已记录一条内容。继续发送，或点击 ✅ 完成上架。");
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
}

bot.callbackQuery("p_publish", async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;

  const st = await getUserState(ctx.from.id);
  if (st.key !== "p_wait_content") {
    const sent = await ctx.reply("当前不在上架流程中，请先点击 ➕ 上架新关键词。");
    if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
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

    if (!res.rows.length) {
      await client.query("ROLLBACK;");
      const sent = await ctx.reply("未检测到任何内容，请先发送内容再上架。");
      if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
      return;
    }

    for (const row of res.rows) {
      await client.query(
        `INSERT INTO products (keyword, content_type, content_data, created_at) VALUES ($1, $2, $3, NOW());`,
        [String(keyword), String(row.content_type), String(row.content_data)]
      );
    }

    await client.query(`DELETE FROM p_buffer WHERE admin_id = $1 AND keyword = $2;`, [Number(ctx.from.id), String(keyword)]);
    await client.query("COMMIT;");
  } catch (error) {
    try { await client.query("ROLLBACK;"); } catch (e) {}
    const sent = await ctx.reply("❌ 上架失败，请检查数据库或稍后再试。");
    if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
    return;
  } finally {
    client.release();
  }

  await clearUserState(ctx.from.id);

  const sent = await ctx.reply(`✅ 上架完成：关键词「${keyword}」已生效。`);
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);

  await showP(ctx);
});

// 删除 keyword 两次确认
bot.callbackQuery(/^p_del1:(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;

  const kw = decodeURIComponent(ctx.match[1]);
  const keyboard = new InlineKeyboard()
    .text("确认删除", `p_del2:${encodeURIComponent(kw)}`)
    .row()
    .text("返回", "admin_p");

  const sent = await ctx.reply(`⚠️ 是否删除关键词「${kw}」的全部内容？`, { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
});

bot.callbackQuery(/^p_del2:(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;

  const kw = decodeURIComponent(ctx.match[1]);
  const keyboard = new InlineKeyboard()
    .text("真的确定删除", `p_del3:${encodeURIComponent(kw)}`)
    .row()
    .text("返回", "admin_p");

  const sent = await ctx.reply(`❗最后确认：真的要删除关键词「${kw}」吗？`, { reply_markup: keyboard });
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
});

bot.callbackQuery(/^p_del3:(.+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch (e) {}
  if (!(await requireAdmin(ctx))) return;

  const kw = decodeURIComponent(ctx.match[1]);
  await deleteProductsByKeyword(kw);

  const sent = await ctx.reply(`✅ 已删除关键词「${kw}」的全部内容。`);
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);

  await showP(ctx);
});

/**
 * =========================================================
 * /c 与 /cz（仅管理员）
 * =========================================================
 */

bot.command("c", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  await clearUserState(ctx.from.id);
  const sent = await ctx.reply("✅ 已取消你当前的验证/上架等待状态。");
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
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
      `UPDATE bot_users SET first_seen_date = $2, last_seen_at = NOW() WHERE user_id = $1;`,
      [adminId, todayKey]
    );
  } finally {
    client.release();
  }

  const sent = await ctx.reply("♻️ 已重置你的测试状态：冷却与次数清零，并视为“新用户当天”。");
  if (sent && sent.message_id) await registerAutoDelete(ctx.chat.id, sent.message_id);
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
