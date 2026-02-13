"use strict";

/**
 * =========================================================
 * 顶部可修改配置（你要求：所有修改都在顶部）
 * =========================================================
 */

// 必须的环境变量
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

// 仅一个管理员（你要求：管理员是一个）
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : NaN;

// 时区（北京时间）
const TIMEZONE = "Asia/Shanghai";

// /dh 频控参数（你可自定义修改）
const DAILY_LIMIT = 10;             // 每日最多成功放行次数（可改）
const NEW_USER_FREE_TODAY = 3;      // 新用户当天免费次数（固定 3）
const OLD_USER_FREE_DAILY = 2;      // 老用户每天免费次数（固定 2）
const COOLDOWN_BASE_MINUTES = 5;    // 冷却起始分钟
const COOLDOWN_STEP_MINUTES = 3;    // 每次递增分钟

// 触发式删除（复用 auto_delete）
const AUTO_DELETE_EXPIRE_MINUTES = 5;

// 分页参数（方案A：10条为一页）
const PAGE_SIZE = 10;

// 方案A：默认“最新多少条”用于无需关键词也可直接展示
const DH_DEFAULT_LATEST_LIMIT = 100;

// /v 两张图（你提供）
const FILE_ID_PAYMENT = "AgACAgUAAxkBAAIDd2mEHCq1fvS4dwIjba1YCTLObQonAAJtDWsbrPMhVNjJFj6MFYBoAQADAgADeQADOAQ";
const FILE_ID_ORDER   = "AgACAgUAAxkBAAIDgGmEHH9bpq3a64REkLP7QoHNoQjWAAJyDWsbrPMhVMEDi7UYH-23AQADAgADeQADOAQ";

// 会员群链接（你要求必须出现）
const VIP_GROUP_LINK = "https://t.me/+495j5rWmApsxYzg9";

// /start 文案
const START_TEXT =
  "🎉 喜迎新春｜资源免费获取\n\n" +
  "欢迎使用资源助手～\n" +
  "请选择下方功能开始👇";

// /v 文案（禁止出现20260）
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
  "【如何查看订单号（详细步骤）】\n" +
  "1）打开支付平台/钱包 App\n" +
  "2）进入：我的 → 账单\n" +
  "3）找到刚刚的付款记录，进入：账单详情\n" +
  "4）点击：更多 / 查看详情（不同版本名称可能略有差异）\n" +
  "5）找到字段：订单号（或商户订单号/交易订单号）\n" +
  "6）复制订单号并发送给我";

// /dh 等待提示（美化定稿）
function buildCooldownText(remainingMilliseconds) {
  const remaining = Math.max(0, remainingMilliseconds);
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const secondsText = String(seconds).padStart(2, "0");

  return (
    "⏳ 兑换冷却中，请稍后再试\n" +
    `距离下一次兑换还需：**${minutes}分${secondsText}秒**\n\n` +
    "💎 加入会员无需等待｜🧧 新春特价限时开启\n" +
    "✨ 免等待｜⚡ 更稳定｜🔒 更私密\n" +
    "机不可失，时不再来！期待你的加入～"
  );
}

const DAILY_LIMIT_TEXT =
  "🚫 今日已达上限，请明日再试或加入会员。\n\n" +
  "💎 加入会员无需等待｜🧧 新春特价限时开启\n" +
  "✨ 免等待｜⚡ 更稳定｜🔒 更私密\n" +
  "机不可失，时不再来！期待你的加入～";

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

// /admin 文案
const ADMIN_TEXT = "🛠 管理员后台\n请选择功能：";

// /p 文案
const P_TEXT =
  "📦 上架工作台（/p）\n\n" +
  "你可以直接发送任何内容（文本/图片/视频/文件/转发等），我会加入草稿。\n" +
  "草稿列表每页10条。\n\n" +
  "完成后点击最下方 ✅ 完成上架。";

/**
 * =========================================================
 * 依赖与启动校验
 * =========================================================
 */

const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const { Pool } = require("pg");

if (!BOT_TOKEN) {
  throw new Error("Missing BOT_TOKEN environment variable.");
}
if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL environment variable. It must start with postgresql:// or postgres://");
}
if (!Number.isFinite(ADMIN_ID)) {
  throw new Error("Missing or invalid ADMIN_ID environment variable. ADMIN_ID must be a numeric Telegram user id.");
}

// 建议 DATABASE_URL 必须带协议
if (!(DATABASE_URL.startsWith("postgresql://") || DATABASE_URL.startsWith("postgres://"))) {
  throw new Error("Invalid DATABASE_URL format. It must start with postgresql:// or postgres://");
}

const bot = new Bot(BOT_TOKEN);

// Neon 连接
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/**
 * =========================================================
 * 数据库初始化（新增必要表，不动 products/pending_reviews/auto_delete）
 * =========================================================
 */

async function ensureTables() {
  const client = await pool.connect();
  try {
    // 用户表：用于新用户判定/用户列表
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

    // /dh 配额
    await client.query(`
      CREATE TABLE IF NOT EXISTS dh_quota (
        user_id BIGINT PRIMARY KEY,
        date_key TEXT NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0,
        next_allowed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // /p 草稿
    await client.query(`
      CREATE TABLE IF NOT EXISTS p_drafts (
        id BIGSERIAL PRIMARY KEY,
        admin_id BIGINT NOT NULL,
        keyword TEXT,
        content_type TEXT NOT NULL,
        content_data TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published BOOLEAN NOT NULL DEFAULT FALSE
      );
    `);

    // 状态表（Vercel无状态，必须落库）
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_state (
        user_id BIGINT PRIMARY KEY,
        state_key TEXT,
        state_value TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  } finally {
    client.release();
  }
}

/**
 * =========================================================
 * 时区 date_key（北京时间）
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

/**
 * =========================================================
 * 触发式5分钟删除：复用 auto_delete
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
  if (!ctx.chat || !ctx.chat.id) {
    return;
  }
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
      LIMIT 200;
      `,
      [chatId, now]
    );

    for (const row of res.rows) {
      try {
        await ctx.api.deleteMessage(chatId, Number(row.message_id));
      } catch (error) {
        // 忽略（可能已删/无权限）
      }
      try {
        await client.query(`DELETE FROM auto_delete WHERE id = $1;`, [row.id]);
      } catch (error) {
        // 忽略
      }
    }
  } finally {
    client.release();
  }
}

/**
 * =========================================================
 * bot_users：新用户判定 + last_seen
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
      `SELECT user_id, first_seen_date FROM bot_users WHERE user_id = $1;`,
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
      SET username = $2,
          first_name = $3,
          last_name = $4,
          last_seen_at = NOW()
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
 * bot_state：会话状态（必须落库）
 * =========================================================
 */

async function setUserTempState(userId, stateKey, stateValue) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO bot_state (user_id, state_key, state_value, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET state_key = EXCLUDED.state_key, state_value = EXCLUDED.state_value, updated_at = NOW();
      `,
      [Number(userId), stateKey, stateValue]
    );
  } finally {
    client.release();
  }
}

async function getUserTempState(userId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT state_key, state_value FROM bot_state WHERE user_id = $1;`,
      [Number(userId)]
    );
    if (res.rows.length === 0) {
      return { stateKey: null, stateValue: null };
    }
    return { stateKey: res.rows[0].state_key, stateValue: res.rows[0].state_value };
  } finally {
    client.release();
  }
}

async function clearUserTempState(userId) {
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM bot_state WHERE user_id = $1;`, [Number(userId)]);
  } finally {
    client.release();
  }
}

/**
 * =========================================================
 * 管理员鉴权（仅一个管理员）
 * =========================================================
 */

function isAdmin(ctx) {
  return Boolean(ctx.from && Number(ctx.from.id) === Number(ADMIN_ID));
}

async function requireAdmin(ctx) {
  if (!isAdmin(ctx)) {
    const sent = await ctx.reply("⛔ 无权限访问");
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    }
    return false;
  }
  return true;
}

/**
 * =========================================================
 * /dh 配额与冷却（dh_quota）
 * =========================================================
 */

function computeCooldownMinutes(nextAttemptIndex) {
  // nextAttemptIndex 从 0 开始：0 -> 5, 1 -> 8, 2 -> 11 ...
  return COOLDOWN_BASE_MINUTES + nextAttemptIndex * COOLDOWN_STEP_MINUTES;
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
      return { dateKey: todayKey, usedCount: 0, nextAllowedAt: null };
    }

    const row = res.rows[0];
    if (row.date_key !== todayKey) {
      await client.query(
        `UPDATE dh_quota
         SET date_key = $2, used_count = 0, next_allowed_at = NULL, updated_at = NOW()
         WHERE user_id = $1;`,
        [Number(userId), todayKey]
      );
      return { dateKey: todayKey, usedCount: 0, nextAllowedAt: null };
    }

    return {
      dateKey: row.date_key,
      usedCount: Number(row.used_count || 0),
      nextAllowedAt: row.next_allowed_at ? new Date(row.next_allowed_at) : null
    };
  } finally {
    client.release();
  }
}

async function updateQuotaAfterSuccess(userId, todayKey, newUsedCount, nextAllowedAt) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE dh_quota
       SET date_key = $2, used_count = $3, next_allowed_at = $4, updated_at = NOW()
       WHERE user_id = $1;`,
      [Number(userId), todayKey, Number(newUsedCount), nextAllowedAt]
    );
  } finally {
    client.release();
  }
}

/**
 * =========================================================
 * products 查询：支持关键词 or 最新列表
 * =========================================================
 */

async function queryProductsByKeyword(keyword) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT id, keyword, content_type, content_data, created_at
      FROM products
      WHERE keyword ILIKE $1
      ORDER BY id DESC;
      `,
      [`%${keyword}%`]
    );
    return res.rows;
  } finally {
    client.release();
  }
}

async function queryLatestProducts(limit) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT id, keyword, content_type, content_data, created_at
      FROM products
      ORDER BY id DESC
      LIMIT $1;
      `,
      [Number(limit)]
    );
    return res.rows;
  } finally {
    client.release();
  }
}

function safeCountMediaGroup(contentType, contentData) {
  if (contentType !== "media_group") {
    return 0;
  }
  try {
    const parsed = JSON.parse(contentData);
    if (Array.isArray(parsed)) {
      return parsed.length;
    }
    return 0;
  } catch (error) {
    return 0;
  }
}

function buildSummaryLine(item) {
  const id = item.id;
  const kw = item.keyword ? String(item.keyword) : "";
  const type = item.content_type ? String(item.content_type) : "unknown";
  const count = safeCountMediaGroup(type, item.content_data);
  const countText = count > 0 ? `（${count}项）` : "";
  return `#${id}  ${kw}  ·  ${type}${countText}`;
}

function buildDhListText(title, pageIndex, pageCount, items) {
  const header = `📄 ${pageIndex + 1}/${pageCount}\n${title}\n\n`;
  const lines = items.map(buildSummaryLine).join("\n");
  return header + (lines || "（无结果）");
}

function buildDhKeyboard(mode, keywordOrEmpty, pageIndex, pageCount) {
  // mode: "kw" 或 "latest"
  const keyboard = new InlineKeyboard();

  if (pageIndex > 0) {
    keyboard.text("◀️ 上一页", `dh_page:${mode}:${encodeURIComponent(keywordOrEmpty)}:${pageIndex - 1}`);
  }
  if (pageIndex < pageCount - 1) {
    keyboard.text("▶️ 继续发送", `dh_page:${mode}:${encodeURIComponent(keywordOrEmpty)}:${pageIndex + 1}`);
  }

  keyboard.row();
  keyboard.text("↩️ 返回兑换 (/dh)", "dh_back");
  keyboard.row();
  keyboard.text("💎 加入会员（新春特价）", "go_v");

  return keyboard;
}

/**
 * =========================================================
 * 中间件：初始化 + 触发式删除 + 记录用户
 * =========================================================
 */

bot.use(async (ctx, next) => {
  await ensureTables();

  // 先删过期消息
  try {
    await gcExpiredMessages(ctx);
  } catch (error) {
    // 忽略
  }

  // 记录用户
  if (ctx.from) {
    try {
      await upsertBotUser(ctx.from);
    } catch (error) {
      // 忽略
    }
  }

  await next();
});

/**
 * =========================================================
 * /start（修复：加入会员按钮固定存在）
 * =========================================================
 */

async function showStart(ctx) {
  const keyboard = new InlineKeyboard()
    .text("💎 加入会员（新春特价）", "go_v")
    .text("🎁 兑换", "go_dh");

  const sent = await ctx.reply(START_TEXT, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }
}

bot.command("start", async (ctx) => {
  await showStart(ctx);
});

bot.callbackQuery("go_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showStart(ctx);
});

/**
 * =========================================================
 * /v（修复：补回入群链接按钮 + 工单）
 * =========================================================
 */

async function showVip(ctx) {
  const sent1 = await ctx.replyWithPhoto(FILE_ID_PAYMENT, { caption: VIP_TEXT });
  if (ctx.chat && sent1 && sent1.message_id) {
    await registerAutoDelete(ctx.chat.id, sent1.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }

  const keyboard = new InlineKeyboard()
    .text("✅ 我已付款，开始验证", "v_paid")
    .row()
    .text("🏠 返回首页", "go_start");

  const sent2 = await ctx.reply("请点击下方按钮继续👇", { reply_markup: keyboard });
  if (ctx.chat && sent2 && sent2.message_id) {
    await registerAutoDelete(ctx.chat.id, sent2.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }
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
  if (ctx.chat && sent1 && sent1.message_id) {
    await registerAutoDelete(ctx.chat.id, sent1.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }

  if (ctx.from) {
    await setUserTempState(ctx.from.id, "v_wait_order", "1");
  }

  const keyboard = new InlineKeyboard()
    .text("↩️ 返回加入会员 (/v)", "go_v")
    .row()
    .text("🏠 返回首页", "go_start");

  const sent2 = await ctx.reply("请直接发送你的订单号：", { reply_markup: keyboard });
  if (ctx.chat && sent2 && sent2.message_id) {
    await registerAutoDelete(ctx.chat.id, sent2.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }
});

/**
 * =========================================================
 * /dh（严重修复：点兑换立刻可用 + 方案A最新100条 + 关键词搜索）
 * =========================================================
 */

async function showDhHome(ctx) {
  // 进入兑换首页：给三个入口，确保“点了就有内容”
  // 1) 发送关键词搜索
  // 2) 直接查看最新100条（方案A分页摘要）
  // 3) 返回首页
  const keyboard = new InlineKeyboard()
    .text("📄 查看最新100条", "dh_latest_100")
    .row()
    .text("🔎 关键词搜索（直接发关键词）", "dh_hint_keyword")
    .row()
    .text("💎 加入会员（新春特价）", "go_v")
    .row()
    .text("🏠 返回首页", "go_start");

  const sent = await ctx.reply(
    "🎁 兑换模式\n\n你可以：\n- 直接查看最新资源（推荐）\n- 或发送关键词进行搜索",
    { reply_markup: keyboard }
  );

  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }

  if (ctx.from) {
    await setUserTempState(ctx.from.id, "dh_wait_keyword", "1");
  }
}

bot.command("dh", async (ctx) => {
  await showDhHome(ctx);
});

bot.callbackQuery("go_dh", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showDhHome(ctx);
});

bot.callbackQuery("dh_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showDhHome(ctx);
});

bot.callbackQuery("dh_hint_keyword", async (ctx) => {
  await ctx.answerCallbackQuery();
  const keyboard = new InlineKeyboard()
    .text("📄 查看最新100条", "dh_latest_100")
    .row()
    .text("↩️ 返回兑换 (/dh)", "dh_back")
    .row()
    .text("💎 加入会员（新春特价）", "go_v");
  const sent = await ctx.reply("请直接发送关键词进行搜索：", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }
});

// 入口：最新100条（需要走频控：这是一次“成功放行”）
bot.callbackQuery("dh_latest_100", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;

  const allow = await dhCheckAndConsumeQuota(ctx);
  if (!allow.allowed) {
    await sendDhBlocked(ctx, allow);
    return;
  }

  const all = await queryLatestProducts(DH_DEFAULT_LATEST_LIMIT);
  await sendDhPage(ctx, "latest", "", all, 0, `🆕 最新${DH_DEFAULT_LATEST_LIMIT}条（摘要列表）`);
});

// 翻页：共同存在不覆盖（每页发新消息）
bot.callbackQuery(/^dh_page:(latest|kw):([^:]*):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;

  const mode = ctx.match[1];
  const key = decodeURIComponent(ctx.match[2] || "");
  const pageIndex = Number(ctx.match[3]);

  let all = [];
  let title = "";

  if (mode === "latest") {
    all = await queryLatestProducts(DH_DEFAULT_LATEST_LIMIT);
    title = `🆕 最新${DH_DEFAULT_LATEST_LIMIT}条（摘要列表）`;
  } else {
    all = await queryProductsByKeyword(key);
    title = `🔎 关键词：${key}`;
  }

  await sendDhPage(ctx, mode, key, all, pageIndex, title);
});

// 关键词搜索：需要走频控（每次成功搜索算一次成功放行）
bot.on("message:text", async (ctx) => {
  if (!ctx.from) return;

  // 先处理 /v 订单号状态（优先级最高）
  const state = await getUserTempState(ctx.from.id);

  if (state.stateKey === "v_wait_order") {
    await handleVOrderNumber(ctx);
    return;
  }

  // /dh 等待关键词状态
  if (state.stateKey === "dh_wait_keyword") {
    const keyword = String(ctx.message.text || "").trim();
    if (keyword.length === 0) {
      const sent = await ctx.reply("关键词为空，请重新发送。");
      if (ctx.chat && sent && sent.message_id) {
        await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
      }
      return;
    }

    const allow = await dhCheckAndConsumeQuota(ctx);
    if (!allow.allowed) {
      await sendDhBlocked(ctx, allow);
      return;
    }

    const all = await queryProductsByKeyword(keyword);
    await sendDhPage(ctx, "kw", keyword, all, 0, `🔎 关键词：${keyword}`);
    return;
  }
});

/**
 * =========================================================
 * /dh 发送页（方案A摘要分页 + 发完自动回/dh）
 * =========================================================
 */

async function sendDhPage(ctx, mode, key, allItems, pageIndex, title) {
  const pageCount = Math.max(1, Math.ceil(allItems.length / PAGE_SIZE));
  const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);
  const start = safePageIndex * PAGE_SIZE;
  const items = allItems.slice(start, start + PAGE_SIZE);

  const text = buildDhListText(title, safePageIndex, pageCount, items);
  const keyboard = buildDhKeyboard(mode, key, safePageIndex, pageCount);

  const sent = await ctx.reply(text, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }

  // 最后一页：提示“已发送完毕”，并给返回/dh按钮（跳转回/dh）
  if (safePageIndex === pageCount - 1) {
    const doneKeyboard = new InlineKeyboard()
      .text("↩️ 返回兑换 (/dh)", "dh_back")
      .row()
      .text("💎 加入会员（新春特价）", "go_v");

    const doneSent = await ctx.reply("✅ 已发送完全部结果。", { reply_markup: doneKeyboard });
    if (ctx.chat && doneSent && doneSent.message_id) {
      await registerAutoDelete(ctx.chat.id, doneSent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    }
  }
}

/**
 * =========================================================
 * /dh 频控：检查并消耗一次成功放行
 * =========================================================
 */

async function dhCheckAndConsumeQuota(ctx) {
  const todayKey = getDateKeyInTimezone(new Date(), TIMEZONE);
  const userInfo = await upsertBotUser(ctx.from);
  const quota = await getOrInitQuota(ctx.from.id, todayKey);

  // 超限
  if (quota.usedCount >= DAILY_LIMIT) {
    return { allowed: false, reason: "limit" };
  }

  // 冷却中
  if (quota.nextAllowedAt && quota.nextAllowedAt.getTime() > Date.now()) {
    return { allowed: false, reason: "cooldown", nextAllowedAt: quota.nextAllowedAt };
  }

  // 允许放行：消耗一次 usedCount，并设置下一次冷却
  const newUsedCount = quota.usedCount + 1;

  const freeCount = userInfo.isFirstDay ? NEW_USER_FREE_TODAY : OLD_USER_FREE_DAILY;

  let nextAllowedAt = null;
  if (newUsedCount >= freeCount) {
    const afterFreeIndex = newUsedCount - freeCount; // 0开始：0->5,1->8...
    const cooldownMinutes = computeCooldownMinutes(afterFreeIndex);
    nextAllowedAt = new Date(Date.now() + cooldownMinutes * 60 * 1000);
  }

  await updateQuotaAfterSuccess(ctx.from.id, todayKey, newUsedCount, nextAllowedAt);

  return { allowed: true };
}

async function sendDhBlocked(ctx, blockInfo) {
  const keyboard = new InlineKeyboard()
    .text("💎 加入会员（新春特价）", "go_v")
    .row()
    .text("↩️ 返回兑换 (/dh)", "dh_back");

  if (blockInfo.reason === "limit") {
    const sent = await ctx.reply(DAILY_LIMIT_TEXT, { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    }
    return;
  }

  if (blockInfo.reason === "cooldown") {
    const remainingMs = blockInfo.nextAllowedAt.getTime() - Date.now();
    const sent = await ctx.reply(buildCooldownText(remainingMs), { reply_markup: keyboard, parse_mode: "Markdown" });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    }
    return;
  }

  const sent = await ctx.reply("当前不可用，请稍后再试。", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }
}

/**
 * =========================================================
 * /v 订单号处理（写 pending_reviews + 管理员工单 + 入群链接按钮）
 * =========================================================
 */

async function handleVOrderNumber(ctx) {
  const orderNumber = String(ctx.message.text || "").trim();
  if (orderNumber.length === 0) {
    const sent = await ctx.reply("订单号为空，请重新发送。");
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    }
    return;
  }

  // 写入 pending_reviews
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

  // 发管理员工单
  try {
    await ctx.api.sendMessage(ADMIN_ID, buildAdminTicketText(ctx.from, orderNumber));
  } catch (error) {
    // 忽略
  }

  // 清状态
  await clearUserTempState(ctx.from.id);

  // 用户成功提示 + 入群链接按钮（修复遗漏）
  const keyboard = new InlineKeyboard()
    .url("✅ 加入会员群", VIP_GROUP_LINK)
    .row()
    .text("💎 返回加入会员 (/v)", "go_v")
    .row()
    .text("🎁 去兑换 (/dh)", "go_dh");

  const sent = await ctx.reply("✅ 已收到订单号。加入会员群请点击下方按钮：", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }
}

/**
 * =========================================================
 * /admin（仅管理员）：File ID / /p / 用户表
 * =========================================================
 */

bot.command("admin", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const keyboard = new InlineKeyboard()
    .text("🆔 获取 File ID", "admin_fileid")
    .row()
    .text("📦 上架工作台 (/p)", "admin_go_p")
    .row()
    .text("👥 用户表", "admin_users");

  const sent = await ctx.reply(ADMIN_TEXT, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }
});

bot.callbackQuery("admin_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;

  const keyboard = new InlineKeyboard()
    .text("🆔 获取 File ID", "admin_fileid")
    .row()
    .text("📦 上架工作台 (/p)", "admin_go_p")
    .row()
    .text("👥 用户表", "admin_users");

  const sent = await ctx.reply(ADMIN_TEXT, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }
});

// File ID 模式
bot.callbackQuery("admin_fileid", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;

  await setUserTempState(ctx.from.id, "admin_wait_fileid", "1");

  const keyboard = new InlineKeyboard().text("↩️ 返回 /admin", "admin_back");
  const sent = await ctx.reply("请发送媒体（图片/视频/文件/语音/贴纸等）以获取 file_id：", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }
});

// 用户表分页
bot.callbackQuery("admin_users", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  await sendUsersPage(ctx, 0);
});

bot.callbackQuery(/^admin_users_page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  await sendUsersPage(ctx, Number(ctx.match[1]));
});

async function sendUsersPage(ctx, pageIndex) {
  const client = await pool.connect();
  try {
    const countRes = await client.query(`SELECT COUNT(*)::int AS c FROM bot_users;`);
    const total = Number(countRes.rows[0].c || 0);
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);

    const res = await client.query(
      `
      SELECT user_id, username, first_name, first_seen_date, last_seen_at
      FROM bot_users
      ORDER BY last_seen_at DESC NULLS LAST
      LIMIT $1 OFFSET $2;
      `,
      [PAGE_SIZE, PAGE_SIZE * safePageIndex]
    );

    const header = `📄 ${safePageIndex + 1}/${pageCount}\n👥 用户表\n\n`;
    const lines = res.rows.map((u) => {
      const username = u.username ? `@${u.username}` : "无";
      const firstName = u.first_name ? String(u.first_name) : "无";
      const firstSeen = u.first_seen_date ? String(u.first_seen_date) : "未知";
      const lastSeen = u.last_seen_at ? new Date(u.last_seen_at).toISOString() : "未知";
      return `- ${firstName}（${username}）\n  🆔 ${u.user_id}\n  📅 首次：${firstSeen}\n  🕒 最近：${lastSeen}`;
    }).join("\n\n");

    const keyboard = new InlineKeyboard();
    if (safePageIndex > 0) keyboard.text("◀️ 上一页", `admin_users_page:${safePageIndex - 1}`);
    if (safePageIndex < pageCount - 1) keyboard.text("▶️ 下一页", `admin_users_page:${safePageIndex + 1}`);
    keyboard.row().text("↩️ 返回 /admin", "admin_back");

    const sent = await ctx.reply(header + (lines || "暂无用户"), { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    }
  } finally {
    client.release();
  }
}

/**
 * =========================================================
 * /p（仅管理员）：草稿上传 + 10条/页 + 完成上架按钮最底
 * =========================================================
 */

bot.command("p", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  await showPHome(ctx, 0);
});

bot.callbackQuery("admin_go_p", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  await showPHome(ctx, 0);
});

bot.callbackQuery(/^p_page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;
  await showPHome(ctx, Number(ctx.match[1]));
});

async function insertDraft(adminId, contentType, contentData) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO p_drafts (admin_id, keyword, content_type, content_data, published) VALUES ($1, NULL, $2, $3, FALSE);`,
      [Number(adminId), String(contentType), String(contentData)]
    );
  } finally {
    client.release();
  }
}

async function listDrafts(adminId) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT id, keyword, content_type, content_data, created_at
      FROM p_drafts
      WHERE admin_id = $1 AND published = FALSE
      ORDER BY id DESC;
      `,
      [Number(adminId)]
    );
    return res.rows;
  } finally {
    client.release();
  }
}

async function publishDraftsToProducts(adminId, defaultKeyword) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN;");

    const draftsRes = await client.query(
      `
      SELECT id, keyword, content_type, content_data
      FROM p_drafts
      WHERE admin_id = $1 AND published = FALSE
      ORDER BY id ASC;
      `,
      [Number(adminId)]
    );

    let successCount = 0;

    for (const draft of draftsRes.rows) {
      const keyword = draft.keyword ? String(draft.keyword) : String(defaultKeyword);
      await client.query(
        `INSERT INTO products (keyword, content_type, content_data, created_at) VALUES ($1, $2, $3, NOW());`,
        [keyword, String(draft.content_type), String(draft.content_data)]
      );
      await client.query(`UPDATE p_drafts SET published = TRUE WHERE id = $1;`, [Number(draft.id)]);
      successCount += 1;
    }

    await client.query("COMMIT;");
    return { successCount, totalCount: draftsRes.rows.length };
  } catch (error) {
    try { await client.query("ROLLBACK;"); } catch (rollbackError) {}
    throw error;
  } finally {
    client.release();
  }
}

function buildPDraftsText(pageIndex, pageCount, items) {
  const header = `📄 ${pageIndex + 1}/${pageCount}\n🗂 草稿箱（未上架）\n\n`;
  const lines = items.map((d) => {
    const type = d.content_type ? String(d.content_type) : "unknown";
    let count = 0;
    if (type === "media_group") {
      try {
        const parsed = JSON.parse(d.content_data);
        if (Array.isArray(parsed)) count = parsed.length;
      } catch (error) {}
    }
    const countText = count > 0 ? `（${count}项）` : "";
    return `草稿#${d.id} · ${type}${countText}`;
  }).join("\n");
  return header + (lines || "（暂无草稿，直接发送内容即可加入草稿）");
}

function buildPKeyboard(pageIndex, pageCount) {
  const keyboard = new InlineKeyboard();

  if (pageIndex > 0) keyboard.text("◀️ 上一页", `p_page:${pageIndex - 1}`);
  if (pageIndex < pageCount - 1) keyboard.text("▶️ 下一页", `p_page:${pageIndex + 1}`);

  keyboard.row();
  keyboard.text("↩️ 返回 /admin", "admin_back");

  // ✅ 完成上架：必须始终在最底部（最后一行）
  keyboard.row();
  keyboard.text("✅ 完成上架", "p_publish");

  return keyboard;
}

async function showPHome(ctx, pageIndex) {
  await setUserTempState(ctx.from.id, "p_mode", "1");

  const drafts = await listDrafts(ctx.from.id);
  const pageCount = Math.max(1, Math.ceil(drafts.length / PAGE_SIZE));
  const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);
  const items = drafts.slice(safePageIndex * PAGE_SIZE, safePageIndex * PAGE_SIZE + PAGE_SIZE);

  const text = P_TEXT + "\n\n" + buildPDraftsText(safePageIndex, pageCount, items);
  const keyboard = buildPKeyboard(safePageIndex, pageCount);

  const sent = await ctx.reply(text, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }
}

bot.callbackQuery("p_publish", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;

  try {
    const result = await publishDraftsToProducts(ctx.from.id, "default");
    const keyboard = new InlineKeyboard()
      .text("↩️ 返回 /p", "admin_go_p")
      .row()
      .text("↩️ 返回 /admin", "admin_back");

    const sent = await ctx.reply(`✅ 已完成上架：${result.successCount}/${result.totalCount}`, { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    }
  } catch (error) {
    const keyboard = new InlineKeyboard()
      .text("↩️ 返回 /p", "admin_go_p")
      .row()
      .text("↩️ 返回 /admin", "admin_back");

    const sent = await ctx.reply("❌ 上架失败，请检查数据库或稍后再试。", { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    }
  }
});

/**
 * =========================================================
 * 管理员消息处理：File ID 模式 与 /p 草稿入库
 * =========================================================
 */

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

function tryExtractDraftFromMessage(message) {
  if (!message) return null;

  // 文本
  if (typeof message.text === "string" && message.text.trim().length > 0) {
    return { contentType: "text", contentData: message.text.trim() };
  }

  // 媒体 -> 统一存 media_group JSON 数组（保持与你 products 兼容的 [{type,data}] 格式）
  const fileId = extractFirstFileIdFromMessage(message);
  if (fileId) {
    let type = "document";
    if (message.photo) type = "photo";
    else if (message.video) type = "video";
    else if (message.audio) type = "audio";
    else if (message.voice) type = "voice";
    else if (message.sticker) type = "sticker";
    else if (message.document) type = "document";

    const contentData = JSON.stringify([{ type, data: fileId }]);
    return { contentType: "media_group", contentData };
  }

  return null;
}

bot.on("message", async (ctx) => {
  if (!ctx.from) return;

  const state = await getUserTempState(ctx.from.id);

  // admin File ID 模式
  if (state.stateKey === "admin_wait_fileid") {
    if (!(await requireAdmin(ctx))) return;

    const fileId = extractFirstFileIdFromMessage(ctx.message);
    if (!fileId) {
      const sent = await ctx.reply("未检测到可提取的媒体 file_id，请重新发送媒体内容。");
      if (ctx.chat && sent && sent.message_id) {
        await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
      }
      return;
    }

    const keyboard = new InlineKeyboard().text("↩️ 返回 /admin", "admin_back");
    const sent = await ctx.reply(`🆔 获取结果：\nfile_id：${fileId}`, { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    }
    return;
  }

  // /p 模式：入草稿（管理员）
  if (state.stateKey === "p_mode") {
    if (!(await requireAdmin(ctx))) return;

    const extracted = tryExtractDraftFromMessage(ctx.message);
    if (!extracted) {
      const sent = await ctx.reply("该消息类型暂不支持加入草稿，请发送文本/图片/视频/文件/语音/贴纸等。");
      if (ctx.chat && sent && sent.message_id) {
        await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
      }
      return;
    }

    await insertDraft(ctx.from.id, extracted.contentType, extracted.contentData);

    const keyboard = new InlineKeyboard()
      .text("📄 查看草稿箱", "admin_go_p")
      .row()
      .text("↩️ 返回 /admin", "admin_back");

    const sent = await ctx.reply("✅ 已加入草稿箱。", { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
    }
    return;
  }
});

/**
 * =========================================================
 * /c 与 /cz（仅管理员且只作用管理员自己）
 * =========================================================
 */

// /c：取消管理员自己当前验证/等待状态
bot.command("c", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  await clearUserTempState(ctx.from.id);

  const keyboard = new InlineKeyboard()
    .text("↩️ 返回 /admin", "admin_back")
    .row()
    .text("💎 加入会员 (/v)", "go_v")
    .row()
    .text("🎁 兑换 (/dh)", "go_dh");

  const sent = await ctx.reply("✅ 已取消你当前的验证/等待状态。", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }
});

// /cz：管理员自测重置（次数冷却清零 + 变回新用户当天），不影响其他用户
bot.command("cz", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const adminId = Number(ctx.from.id);
  const todayKey = getDateKeyInTimezone(new Date(), TIMEZONE);

  const client = await pool.connect();
  try {
    // 清除管理员状态
    await clearUserTempState(adminId);

    // 重置管理员 dh_quota
    await client.query(
      `
      INSERT INTO dh_quota (user_id, date_key, used_count, next_allowed_at, updated_at)
      VALUES ($1, $2, 0, NULL, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET date_key = EXCLUDED.date_key, used_count = 0, next_allowed_at = NULL, updated_at = NOW();
      `,
      [adminId, todayKey]
    );

    // 把管理员 first_seen_date 改为今天（让你变回新用户当天）
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

  const keyboard = new InlineKeyboard()
    .text("🎁 去兑换 (/dh)", "go_dh")
    .row()
    .text("↩️ 返回 /admin", "admin_back");

  const sent = await ctx.reply("♻️ 已重置你自己的前端测试状态：次数/冷却/新用户状态已恢复。", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }
});

/**
 * =========================================================
 * 兜底提示
 * =========================================================
 */

bot.on("message", async (ctx) => {
  if (!ctx.from) return;

  const state = await getUserTempState(ctx.from.id);
  if (state.stateKey) {
    return;
  }

  const keyboard = new InlineKeyboard()
    .text("🏠 首页 /start", "go_start")
    .row()
    .text("🎁 兑换 /dh", "go_dh")
    .row()
    .text("💎 加入会员 /v", "go_v");

  const sent = await ctx.reply("请输入 /start 开始使用，或点击下方按钮。", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, AUTO_DELETE_EXPIRE_MINUTES);
  }
});

/**
 * =========================================================
 * Vercel Webhook Handler
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
