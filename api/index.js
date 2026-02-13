"use strict";

/**
 * =========================
 * 0) 顶部可修改配置（你要的“都放顶部”）
 * =========================
 */

// 环境变量（必须）
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

// 仅一个管理员（你说“管理员是一个的”）
// 在 Vercel 环境变量设置：ADMIN_ID=123456789
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : NaN;

// 时区与每日重置（北京时间）
const TIMEZONE = "Asia/Shanghai";

// /dh 频控参数（可自定义）
const DAILY_LIMIT = 10; // 每日最多成功放行次数（你要能改就改这里）
const NEW_USER_FREE_TODAY = 3; // 新用户当天免费次数（固定 3）
const OLD_USER_FREE_DAILY = 2; // 老用户每天免费次数（固定 2）
const COOLDOWN_BASE_MIN = 5; // 冷却起始分钟
const COOLDOWN_STEP_MIN = 3; // 每次递增分钟
const GC_EXPIRE_MIN = 5; // 触发式删除：消息保留分钟

// /dh 方案A分页
const PAGE_SIZE = 10;

// /v 两张图（你提供的 file_id）
const FILE_ID_PAYMENT =
  "AgACAgUAAxkBAAIDd2mEHCq1fvS4dwIjba1YCTLObQonAAJtDWsbrPMhVNjJFj6MFYBoAQADAgADeQADOAQ";
const FILE_ID_ORDER =
  "AgACAgUAAxkBAAIDgGmEHH9bpq3a64REkLP7QoHNoQjWAAJyDWsbrPMhVMEDi7UYH-23AQADAgADeQADOAQ";

// /start 美化文案
const START_TEXT =
  "🎉 喜迎新春｜资源免费获取\n\n欢迎使用资源助手～\n请选择下方功能开始👇";

// /dh 等待期强营销文案（定稿）
function buildCooldownText(remainingMs) {
  const remaining = Math.max(0, remainingMs);
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes);
  const ss = String(seconds).padStart(2, "0");

  return (
    "⏳ 兑换冷却中，请稍后再试\n" +
    `距离下一次兑换还需：**${mm}分${ss}秒**\n\n` +
    "💎 加入会员无需等待｜🧧 新春特价限时开启\n" +
    "✨ 免等待｜⚡ 更稳定｜🔒 更私密\n" +
    "机不可失，时不再来！期待你的加入～"
  );
}

// /dh 超限文案
const DAILY_LIMIT_TEXT =
  "🚫 今日已达上限，请明日再试或加入会员。\n\n" +
  "💎 加入会员无需等待｜🧧 新春特价限时开启\n" +
  "✨ 免等待｜⚡ 更稳定｜🔒 更私密\n" +
  "机不可失，时不再来！期待你的加入～";

// /v VIP说明文案（不包含20260）
const VIP_TEXT =
  "🧧 喜迎新春（特价）\n\n" +
  "💎 VIP会员特权说明：\n" +
  "✅ 专属中转通道\n" +
  "✅ 优先审核入群\n" +
  "✅ 7×24小时客服支持\n" +
  "✅ 定期福利活动\n\n" +
  "请按提示完成付款与验证。";

// /v 订单号教程（不包含20260）
const ORDER_GUIDE_TEXT =
  "请发送你的【订单号】进行验证（请不要发送截图）。\n\n" +
  "【如何查看订单号（详细步骤）】\n" +
  "1）打开支付平台/钱包 App\n" +
  "2）进入：我的 → 账单\n" +
  "3）找到刚刚的付款记录，进入：账单详情\n" +
  "4）点击：更多 / 查看详情（不同版本名称可能略有差异）\n" +
  "5）找到字段：订单号（或商户订单号/交易订单号）\n" +
  "6）复制订单号并发送给我";

// /v 工单通知管理员模板
function buildAdminTicketText(user, orderNumber) {
  const username = user.username ? `@${user.username}` : "无";
  const firstName = user.first_name || user.firstName || "无";
  return (
    "🧾 新会员验证工单\n" +
    `- 👤 用户：${firstName}（${username}）\n` +
    `- 🆔 用户ID：${user.id}\n` +
    `- 🔢 订单号：${orderNumber}\n` +
    `- ⏰ 时间：${new Date().toISOString()}`
  );
}

// /admin 菜单文案
const ADMIN_TEXT = "🛠 管理员后台\n请选择功能：";

// /p 文案
const P_TEXT =
  "📦 上架工作台（/p）\n\n" +
  "你可以直接发送任何内容（文本/图片/视频/文件/转发等），我会加入草稿。\n" +
  "草稿列表每页10条。\n\n" +
  "完成后点击最下方 ✅ 完成上架。";

// 健康检查
const HEALTH_TEXT = "OK";

/**
 * =========================
 * 1) 依赖与基础校验
 * =========================
 */

const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const { Pool } = require("pg");

if (!BOT_TOKEN) {
  throw new Error("Missing BOT_TOKEN environment variable.");
}
if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL environment variable.");
}
if (!Number.isFinite(ADMIN_ID)) {
  throw new Error("Missing or invalid ADMIN_ID environment variable.");
}

const bot = new Bot(BOT_TOKEN);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/**
 * =========================
 * 2) 数据库初始化（只新增必要表，不动 products/pending_reviews/auto_delete）
 * =========================
 */

async function ensureTables() {
  // bot_users：用于新用户判定、使用时间、管理员用户表
  // dh_quota：用于每日次数与冷却
  // p_drafts：草稿箱
  // 注意：auto_delete / products / pending_reviews 为你已有表，不创建不修改
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
  } finally {
    client.release();
  }
}

/**
 * =========================
 * 3) 时间工具：北京时间 date_key
 * =========================
 */

function getDateKeyInTimezone(date, timeZone) {
  // 输出 YYYY-MM-DD（按指定时区）
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(date); // en-CA => 2026-02-13
}

/**
 * =========================
 * 4) 触发式删除（复用 auto_delete）
 * =========================
 */

async function gcExpiredMessages(ctx) {
  if (!ctx.chat || !ctx.chat.id) {
    return;
  }

  const chatId = ctx.chat.id;
  const now = new Date();

  const client = await pool.connect();
  try {
    const rows = await client.query(
      `
      SELECT id, chat_id, message_id
      FROM auto_delete
      WHERE chat_id = $1
        AND delete_at IS NOT NULL
        AND delete_at <= $2
      ORDER BY delete_at ASC
      LIMIT 200;
      `,
      [String(chatId), now]
    );

    for (const row of rows.rows) {
      try {
        await ctx.api.deleteMessage(chatId, row.message_id);
      } catch (error) {
        // 忽略删除失败（消息可能已被删或无权限）
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

async function registerAutoDelete(chatId, messageId, minutes) {
  const client = await pool.connect();
  try {
    const deleteAt = new Date(Date.now() + minutes * 60 * 1000);
    await client.query(
      `
      INSERT INTO auto_delete (chat_id, message_id, delete_at)
      VALUES ($1, $2, $3);
      `,
      [String(chatId), messageId, deleteAt]
    );
  } finally {
    client.release();
  }
}

/**
 * =========================
 * 5) 用户表：记录 first_seen_date 与 last_seen_at
 * =========================
 */

async function upsertBotUser(user) {
  const userId = Number(user.id);
  const username = user.username ? String(user.username) : null;
  const firstName = user.first_name || user.firstName || null;
  const lastName = user.last_name || user.lastName || null;

  const todayKey = getDateKeyInTimezone(new Date(), TIMEZONE);

  const client = await pool.connect();
  try {
    const existing = await client.query(
      `SELECT user_id, first_seen_date FROM bot_users WHERE user_id = $1;`,
      [String(userId)]
    );

    if (existing.rows.length === 0) {
      await client.query(
        `
        INSERT INTO bot_users (user_id, username, first_name, last_name, first_seen_date, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, NOW());
        `,
        [String(userId), username, firstName, lastName, todayKey]
      );
      return { isFirstDay: true, firstSeenDate: todayKey };
    } else {
      await client.query(
        `
        UPDATE bot_users
        SET username = $2,
            first_name = $3,
            last_name = $4,
            last_seen_at = NOW()
        WHERE user_id = $1;
        `,
        [String(userId), username, firstName, lastName]
      );
      const firstSeenDate = existing.rows[0].first_seen_date;
      return { isFirstDay: firstSeenDate === todayKey, firstSeenDate };
    }
  } finally {
    client.release();
  }
}

/**
 * =========================
 * 6) 会话状态（内存：Vercel无状态，不可靠；因此用数据库/或尽量无状态设计）
 * 这里用“最少状态”：
 * - /v 等待订单号：对用户用 bot_users + 内存可能丢；改为 pending_reviews 可承接
 * - 但你要求不报错，且 Vercel 无状态，所以关键状态都存数据库
 * =========================
 */

async function setUserTempState(userId, stateKey, stateValue) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      CREATE TABLE IF NOT EXISTS bot_state (
        user_id BIGINT PRIMARY KEY,
        state_key TEXT,
        state_value TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      `
    );
    await client.query(
      `
      INSERT INTO bot_state (user_id, state_key, state_value, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET state_key = EXCLUDED.state_key, state_value = EXCLUDED.state_value, updated_at = NOW();
      `,
      [String(userId), stateKey, stateValue]
    );
  } finally {
    client.release();
  }
}

async function getUserTempState(userId) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      CREATE TABLE IF NOT EXISTS bot_state (
        user_id BIGINT PRIMARY KEY,
        state_key TEXT,
        state_value TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      `
    );
    const res = await client.query(
      `SELECT state_key, state_value FROM bot_state WHERE user_id = $1;`,
      [String(userId)]
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
    await client.query(
      `
      CREATE TABLE IF NOT EXISTS bot_state (
        user_id BIGINT PRIMARY KEY,
        state_key TEXT,
        state_value TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      `
    );
    await client.query(`DELETE FROM bot_state WHERE user_id = $1;`, [String(userId)]);
  } finally {
    client.release();
  }
}

/**
 * =========================
 * 7) 管理员鉴权
 * =========================
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
 * =========================
 * 8) /dh 频控实现（dh_quota + bot_users）
 * =========================
 */

function computeCooldownMinutes(afterFreeThresholdUsedCount, freeCount, baseMin, stepMin) {
  // usedCount 表示“已成功放行次数”
  // 当 usedCount < freeCount 时：无冷却
  // 当 usedCount >= freeCount 时：下一次需要冷却
  // 冷却序列从 base 开始，每多一次 + step
  // 例如：free=3
  // used=3 => 第4次前需要 5
  // used=4 => 第5次前需要 8
  // used=5 => 第6次前需要 11
  const index = afterFreeThresholdUsedCount - freeCount;
  if (index < 0) return 0;
  return baseMin + index * stepMin;
}

async function getOrInitQuota(userId, todayKey) {
  const client = await pool.connect();
  try {
    const res = await client.query(`SELECT user_id, date_key, used_count, next_allowed_at FROM dh_quota WHERE user_id = $1;`, [
      String(userId)
    ]);
    if (res.rows.length === 0) {
      await client.query(
        `
        INSERT INTO dh_quota (user_id, date_key, used_count, next_allowed_at, updated_at)
        VALUES ($1, $2, 0, NULL, NOW());
        `,
        [String(userId), todayKey]
      );
      return { date_key: todayKey, used_count: 0, next_allowed_at: null };
    }

    const row = res.rows[0];

    // 跨天重置
    if (row.date_key !== todayKey) {
      await client.query(
        `
        UPDATE dh_quota
        SET date_key = $2,
            used_count = 0,
            next_allowed_at = NULL,
            updated_at = NOW()
        WHERE user_id = $1;
        `,
        [String(userId), todayKey]
      );
      return { date_key: todayKey, used_count: 0, next_allowed_at: null };
    }

    return {
      date_key: row.date_key,
      used_count: Number(row.used_count || 0),
      next_allowed_at: row.next_allowed_at ? new Date(row.next_allowed_at) : null
    };
  } finally {
    client.release();
  }
}

async function updateQuotaAfterSuccess(userId, todayKey, newUsedCount, nextAllowedAt) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      UPDATE dh_quota
      SET date_key = $2,
          used_count = $3,
          next_allowed_at = $4,
          updated_at = NOW()
      WHERE user_id = $1;
      `,
      [String(userId), todayKey, newUsedCount, nextAllowedAt]
    );
  } finally {
    client.release();
  }
}

/**
 * =========================
 * 9) /dh 查询 products（方案A：只发摘要列表）
 * =========================
 */

async function queryProductsByKeyword(keyword) {
  const client = await pool.connect();
  try {
    // 模糊匹配：keyword ILIKE %input%
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

function buildSummaryLine(item) {
  let count = 0;
  if (item.content_type === "media_group") {
    try {
      const arr = JSON.parse(item.content_data);
      if (Array.isArray(arr)) count = arr.length;
    } catch (error) {
      count = 0;
    }
  }
  const type = item.content_type || "unknown";
  const kw = item.keyword || "";
  const countText = count > 0 ? `（${count}项）` : "";
  return `#${item.id}  ${kw}  ·  ${type}${countText}`;
}

function buildDhListText(keyword, pageIndex, pageCount, pageItems) {
  const header = `📄 ${pageIndex + 1}/${pageCount}\n🔎 关键词：${keyword}\n\n`;
  const lines = pageItems.map(buildSummaryLine).join("\n");
  return header + (lines || "（无结果）");
}

function buildDhKeyboard(keyword, pageIndex, pageCount) {
  const keyboard = new InlineKeyboard();

  if (pageIndex > 0) {
    keyboard.text("◀️ 上一页", `dh_page:${encodeURIComponent(keyword)}:${pageIndex - 1}`);
  }
  if (pageIndex < pageCount - 1) {
    keyboard.text("▶️ 继续发送", `dh_page:${encodeURIComponent(keyword)}:${pageIndex + 1}`);
  }

  keyboard.row();
  keyboard.text("↩️ 返回兑换 (/dh)", "dh_back");
  keyboard.row();
  keyboard.text("💎 加入会员（新春特价）", "go_v");

  return keyboard;
}

/**
 * =========================
 * 10) /p 草稿与上架（写入 products，保持 JSON 格式）
 * =========================
 */

async function insertDraft(adminId, keyword, contentType, contentData) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO p_drafts (admin_id, keyword, content_type, content_data, published)
      VALUES ($1, $2, $3, $4, FALSE);
      `,
      [String(adminId), keyword, contentType, contentData]
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
      SELECT id, keyword, content_type, content_data, created_at, published
      FROM p_drafts
      WHERE admin_id = $1
        AND published = FALSE
      ORDER BY id DESC;
      `,
      [String(adminId)]
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
      WHERE admin_id = $1
        AND published = FALSE
      ORDER BY id ASC;
      `,
      [String(adminId)]
    );

    let successCount = 0;

    for (const draft of draftsRes.rows) {
      const keyword = draft.keyword || defaultKeyword || "default";
      const contentType = draft.content_type;
      const contentData = draft.content_data;

      await client.query(
        `
        INSERT INTO products (keyword, content_type, content_data, created_at)
        VALUES ($1, $2, $3, NOW());
        `,
        [keyword, contentType, contentData]
      );

      await client.query(`UPDATE p_drafts SET published = TRUE WHERE id = $1;`, [draft.id]);
      successCount += 1;
    }

    await client.query("COMMIT;");
    return { successCount, totalCount: draftsRes.rows.length };
  } catch (error) {
    try {
      await client.query("ROLLBACK;");
    } catch (rollbackError) {}
    throw error;
  } finally {
    client.release();
  }
}

function buildPDraftsText(pageIndex, pageCount, pageItems) {
  const header = `📄 ${pageIndex + 1}/${pageCount}\n🗂 草稿箱（未上架）\n\n`;
  const lines = pageItems
    .map((d) => {
      let count = 0;
      if (d.content_type === "media_group") {
        try {
          const arr = JSON.parse(d.content_data);
          if (Array.isArray(arr)) count = arr.length;
        } catch (error) {
          count = 0;
        }
      }
      const kw = d.keyword ? `关键词：${d.keyword}` : "关键词：未设置";
      const ct = d.content_type || "unknown";
      const countText = count > 0 ? `（${count}项）` : "";
      return `草稿#${d.id}  ${kw}  ·  ${ct}${countText}`;
    })
    .join("\n");

  return header + (lines || "（暂无草稿，直接发送内容即可加入草稿）");
}

function buildPKeyboard(pageIndex, pageCount) {
  const keyboard = new InlineKeyboard();

  if (pageIndex > 0) {
    keyboard.text("◀️ 上一页", `p_page:${pageIndex - 1}`);
  }
  if (pageIndex < pageCount - 1) {
    keyboard.text("▶️ 下一页", `p_page:${pageIndex + 1}`);
  }

  keyboard.row();
  keyboard.text("↩️ 返回 /admin", "admin_back");

  // 你要求：✅ 完成上架 始终在最下面（最后一行）
  keyboard.row();
  keyboard.text("✅ 完成上架", "p_publish");

  return keyboard;
}

/**
 * =========================
 * 11) 工具：解析管理员上传的消息为 products 存储格式
 * =========================
 */

function tryExtractDraftFromMessage(ctx) {
  const msg = ctx.message;
  if (!msg) return null;

  // 文本
  if (typeof msg.text === "string" && msg.text.trim().length > 0) {
    return {
      contentType: "text",
      contentData: msg.text.trim()
    };
  }

  // 图片
  if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1];
    const arr = [{ type: "photo", data: best.file_id }];
    return { contentType: "media_group", contentData: JSON.stringify(arr) };
  }

  // 视频
  if (msg.video) {
    const arr = [{ type: "video", data: msg.video.file_id }];
    return { contentType: "media_group", contentData: JSON.stringify(arr) };
  }

  // 文件
  if (msg.document) {
    const arr = [{ type: "document", data: msg.document.file_id }];
    return { contentType: "media_group", contentData: JSON.stringify(arr) };
  }

  // 音频
  if (msg.audio) {
    const arr = [{ type: "audio", data: msg.audio.file_id }];
    return { contentType: "media_group", contentData: JSON.stringify(arr) };
  }

  // 语音
  if (msg.voice) {
    const arr = [{ type: "voice", data: msg.voice.file_id }];
    return { contentType: "media_group", contentData: JSON.stringify(arr) };
  }

  // 贴纸
  if (msg.sticker) {
    const arr = [{ type: "sticker", data: msg.sticker.file_id }];
    return { contentType: "media_group", contentData: JSON.stringify(arr) };
  }

  // 不支持
  return null;
}

/**
 * =========================
 * 12) 全局中间件：触发式清理 + 记录用户
 * =========================
 */

bot.use(async (ctx, next) => {
  try {
    await ensureTables();
  } catch (error) {
    // 初始化失败也尽量继续，让错误暴露给调用方
  }

  // 触发式删除：先清理过期消息
  try {
    await gcExpiredMessages(ctx);
  } catch (error) {}

  // 记录用户 first_seen/last_seen
  if (ctx.from) {
    try {
      await upsertBotUser(ctx.from);
    } catch (error) {}
  }

  await next();
});

/**
 * =========================
 * 13) /start
 * =========================
 */

bot.command("start", async (ctx) => {
  const keyboard = new InlineKeyboard()
    .text("💎 加入会员（新春特价）", "go_v")
    .text("🎁 兑换", "go_dh");

  const sent = await ctx.reply(START_TEXT, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
  }
});

/**
 * =========================
 * 14) /v：加入会员（两张图 + 工单，禁止出现20260）
 * =========================
 */

async function showVip(ctx) {
  // 发宣传/收款图
  const sent1 = await ctx.replyWithPhoto(FILE_ID_PAYMENT, { caption: VIP_TEXT });
  if (ctx.chat && sent1 && sent1.message_id) {
    await registerAutoDelete(ctx.chat.id, sent1.message_id, GC_EXPIRE_MIN);
  }

  const keyboard = new InlineKeyboard().text("✅ 我已付款，开始验证", "v_paid").row().text("↩️ 返回首页", "go_start");
  const sent2 = await ctx.reply("请点击下方按钮继续👇", { reply_markup: keyboard });
  if (ctx.chat && sent2 && sent2.message_id) {
    await registerAutoDelete(ctx.chat.id, sent2.message_id, GC_EXPIRE_MIN);
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

  // 发订单号教程图
  const sent1 = await ctx.replyWithPhoto(FILE_ID_ORDER, { caption: ORDER_GUIDE_TEXT });
  if (ctx.chat && sent1 && sent1.message_id) {
    await registerAutoDelete(ctx.chat.id, sent1.message_id, GC_EXPIRE_MIN);
  }

  // 进入等待订单号状态
  if (ctx.from) {
    await setUserTempState(ctx.from.id, "v_wait_order", "1");
  }

  const keyboard = new InlineKeyboard().text("↩️ 返回加入会员 (/v)", "go_v").row().text("🏠 返回首页", "go_start");
  const sent2 = await ctx.reply("请直接发送你的订单号：", { reply_markup: keyboard });
  if (ctx.chat && sent2 && sent2.message_id) {
    await registerAutoDelete(ctx.chat.id, sent2.message_id, GC_EXPIRE_MIN);
  }
});

// 用户发消息：如果处于 v_wait_order，则当作订单号
bot.on("message:text", async (ctx) => {
  if (!ctx.from) return;

  const state = await getUserTempState(ctx.from.id);
  if (state.stateKey === "v_wait_order") {
    const orderNumber = String(ctx.message.text || "").trim();
    if (orderNumber.length === 0) {
      const sent = await ctx.reply("订单号为空，请重新发送。");
      if (ctx.chat && sent && sent.message_id) {
        await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
      }
      return;
    }

    // 写入 pending_reviews（保留原表结构）
    const client = await pool.connect();
    try {
      await client.query(
        `
        INSERT INTO pending_reviews (user_id, username, first_name, review_type, file_id, order_number, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending');
        `,
        [
          String(ctx.from.id),
          ctx.from.username ? String(ctx.from.username) : null,
          ctx.from.first_name ? String(ctx.from.first_name) : null,
          "vip",
          null,
          orderNumber
        ]
      );
    } catch (error) {
      const sent = await ctx.reply("提交失败，请稍后再试或联系管理员。");
      if (ctx.chat && sent && sent.message_id) {
        await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
      }
      return;
    } finally {
      client.release();
    }

    // 给管理员发工单
    try {
      const ticketText = buildAdminTicketText(ctx.from, orderNumber);
      await ctx.api.sendMessage(ADMIN_ID, ticketText);
    } catch (error) {
      // 管理员消息发送失败不影响用户流程
    }

    // 清除状态
    await clearUserTempState(ctx.from.id);

    const keyboard = new InlineKeyboard().text("💎 返回加入会员 (/v)", "go_v").row().text("🎁 去兑换 (/dh)", "go_dh");
    const sent = await ctx.reply("✅ 已收到订单号，我们将尽快处理。", { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
    }
    return;
  }

  // 若不是 /v 状态，交给后续 /dh 关键词处理
});

/**
 * =========================
 * 15) /dh：兑换（频控 + 方案A分页摘要 + 翻页共存 + 常驻/v按钮）
 * =========================
 */

async function showDhHome(ctx) {
  const keyboard = new InlineKeyboard()
    .text("💎 加入会员（新春特价）", "go_v")
    .row()
    .text("🏠 返回首页", "go_start");

  const sent = await ctx.reply("🎁 兑换模式已开启\n\n请发送关键词进行搜索：", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
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

bot.callbackQuery("go_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  const keyboard = new InlineKeyboard()
    .text("💎 加入会员（新春特价）", "go_v")
    .text("🎁 兑换", "go_dh");
  const sent = await ctx.reply(START_TEXT, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
  }
});

// /dh 翻页：发送新消息（共同存在不覆盖）
bot.callbackQuery(/^dh_page:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();

  if (!ctx.from) return;
  const keyword = decodeURIComponent(ctx.match[1]);
  const pageIndex = Number(ctx.match[2]);

  // 翻页不计入“成功次数”，不做频控；频控只在新查询时触发
  // 直接根据缓存结果发送分页：为了无状态，这里重新查库，保证不丢不报错
  const all = await queryProductsByKeyword(keyword);
  const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);
  const start = safePageIndex * PAGE_SIZE;
  const pageItems = all.slice(start, start + PAGE_SIZE);

  const text = buildDhListText(keyword, safePageIndex, pageCount, pageItems);
  const keyboard = buildDhKeyboard(keyword, safePageIndex, pageCount);

  const sent = await ctx.reply(text, { reply_markup: keyboard, parse_mode: "Markdown" });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
  }

  // 最后一页发完后，提示“已发送完毕，返回/dh”
  if (safePageIndex === pageCount - 1) {
    const doneKeyboard = new InlineKeyboard()
      .text("↩️ 返回兑换 (/dh)", "dh_back")
      .row()
      .text("💎 加入会员（新春特价）", "go_v");
    const doneSent = await ctx.reply("✅ 已发送完全部结果。", { reply_markup: doneKeyboard });
    if (ctx.chat && doneSent && doneSent.message_id) {
      await registerAutoDelete(ctx.chat.id, doneSent.message_id, GC_EXPIRE_MIN);
    }
  }
});

// 处理关键词：必须先通过频控，成功放行才发第一页列表
bot.on("message:text", async (ctx) => {
  if (!ctx.from) return;

  const state = await getUserTempState(ctx.from.id);
  if (state.stateKey !== "dh_wait_keyword") {
    return;
  }

  const keyword = String(ctx.message.text || "").trim();
  if (keyword.length === 0) {
    const sent = await ctx.reply("关键词为空，请重新发送。");
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
    }
    return;
  }

  // 频控检查
  const todayKey = getDateKeyInTimezone(new Date(), TIMEZONE);
  const userInfo = await upsertBotUser(ctx.from); // 更新并拿 first day 判断
  const quota = await getOrInitQuota(ctx.from.id, todayKey);

  // 超限
  if (quota.used_count >= DAILY_LIMIT) {
    const keyboard = new InlineKeyboard()
      .text("💎 加入会员（新春特价）", "go_v")
      .row()
      .text("↩️ 返回兑换 (/dh)", "dh_back");
    const sent = await ctx.reply(DAILY_LIMIT_TEXT, { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
    }
    return;
  }

  // 冷却中
  if (quota.next_allowed_at && quota.next_allowed_at.getTime() > Date.now()) {
    const remainingMs = quota.next_allowed_at.getTime() - Date.now();
    const keyboard = new InlineKeyboard()
      .text("💎 加入会员（新春特价）", "go_v")
      .row()
      .text("↩️ 返回兑换 (/dh)", "dh_back");
    const sent = await ctx.reply(buildCooldownText(remainingMs), { reply_markup: keyboard, parse_mode: "Markdown" });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
    }
    return;
  }

  // 通过频控：执行查询并发送第一页
  const all = await queryProductsByKeyword(keyword);
  const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const pageIndex = 0;
  const pageItems = all.slice(0, PAGE_SIZE);

  const text = buildDhListText(keyword, pageIndex, pageCount, pageItems);
  const keyboard = buildDhKeyboard(keyword, pageIndex, pageCount);

  const sent = await ctx.reply(text, { reply_markup: keyboard, parse_mode: "Markdown" });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
  }

  // 更新 used_count 与 next_allowed_at
  const newUsedCount = quota.used_count + 1;

  const freeCount = userInfo.isFirstDay ? NEW_USER_FREE_TODAY : OLD_USER_FREE_DAILY;

  let nextAllowedAt = null;
  if (newUsedCount >= freeCount) {
    // 根据“已成功次数 newUsedCount”，计算下一次需要等待多久
    const cooldownMin = computeCooldownMinutes(newUsedCount, freeCount, COOLDOWN_BASE_MIN, COOLDOWN_STEP_MIN);
    nextAllowedAt = new Date(Date.now() + cooldownMin * 60 * 1000);
  }

  await updateQuotaAfterSuccess(ctx.from.id, todayKey, newUsedCount, nextAllowedAt);
});

/**
 * =========================
 * 16) /admin：后台（仅管理员）
 * =========================
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
    await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
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
    await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
  }
});

// File ID 模式
bot.callbackQuery("admin_fileid", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;

  await setUserTempState(ctx.from.id, "admin_wait_file", "1");

  const keyboard = new InlineKeyboard().text("↩️ 返回 /admin", "admin_back");
  const sent = await ctx.reply("请发送媒体（图片/视频/文件/语音/贴纸等）以获取 file_id：", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
  }
});

// 用户表
bot.callbackQuery("admin_users", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;

  await sendUsersPage(ctx, 0);
});

bot.callbackQuery(/^admin_users_page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;

  const pageIndex = Number(ctx.match[1]);
  await sendUsersPage(ctx, pageIndex);
});

async function sendUsersPage(ctx, pageIndex) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      SELECT user_id, username, first_name, first_seen_date, last_seen_at
      FROM bot_users
      ORDER BY last_seen_at DESC NULLS LAST
      LIMIT $1 OFFSET $2;
      `,
      [PAGE_SIZE, PAGE_SIZE * pageIndex]
    );

    const countRes = await client.query(`SELECT COUNT(*)::int AS c FROM bot_users;`);
    const total = Number(countRes.rows[0].c || 0);
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);

    const header = `📄 ${safePageIndex + 1}/${pageCount}\n👥 用户表\n\n`;
    const lines = res.rows
      .map((u) => {
        const uname = u.username ? `@${u.username}` : "无";
        const fname = u.first_name || "无";
        const firstSeen = u.first_seen_date || "未知";
        const lastSeen = u.last_seen_at ? new Date(u.last_seen_at).toISOString() : "未知";
        return `- ${fname}（${uname}）\n  🆔 ${u.user_id}\n  📅 首次：${firstSeen}\n  🕒 最近：${lastSeen}`;
      })
      .join("\n\n");

    const keyboard = new InlineKeyboard();
    if (safePageIndex > 0) keyboard.text("◀️ 上一页", `admin_users_page:${safePageIndex - 1}`);
    if (safePageIndex < pageCount - 1) keyboard.text("▶️ 下一页", `admin_users_page:${safePageIndex + 1}`);
    keyboard.row().text("↩️ 返回 /admin", "admin_back");

    const sent = await ctx.reply(header + (lines || "暂无用户"), { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
    }
  } finally {
    client.release();
  }
}

/**
 * =========================
 * 17) /p：上架工作台（仅管理员）
 * =========================
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

async function showPHome(ctx, pageIndex) {
  // 进入 /p 模式：等待管理员发送内容（草稿）
  await setUserTempState(ctx.from.id, "p_mode", "1");

  const drafts = await listDrafts(ctx.from.id);
  const pageCount = Math.max(1, Math.ceil(drafts.length / PAGE_SIZE));
  const safePageIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);
  const pageItems = drafts.slice(safePageIndex * PAGE_SIZE, safePageIndex * PAGE_SIZE + PAGE_SIZE);

  const text = P_TEXT + "\n\n" + buildPDraftsText(safePageIndex, pageCount, pageItems);
  const keyboard = buildPKeyboard(safePageIndex, pageCount);

  const sent = await ctx.reply(text, { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
  }
}

// /p 完成上架（按钮永远最底行）
bot.callbackQuery("p_publish", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireAdmin(ctx))) return;

  // 要求管理员先设置一个默认 keyword（如果草稿没有 keyword）
  // 这里为了不复杂：若草稿 keyword 为空，则用 "default"
  const defaultKeyword = "default";

  try {
    const result = await publishDraftsToProducts(ctx.from.id, defaultKeyword);
    const keyboard = new InlineKeyboard().text("↩️ 返回 /p", "admin_go_p").row().text("↩️ 返回 /admin", "admin_back");
    const sent = await ctx.reply(`✅ 已完成上架：${result.successCount}/${result.totalCount}`, { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
    }
  } catch (error) {
    const keyboard = new InlineKeyboard().text("↩️ 返回 /p", "admin_go_p").row().text("↩️ 返回 /admin", "admin_back");
    const sent = await ctx.reply("❌ 上架失败，请检查数据库或稍后再试。", { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
    }
  }
});

// 管理员在 /p 模式下发送内容 -> 入草稿
bot.on("message", async (ctx) => {
  if (!ctx.from) return;

  // File ID 模式优先
  const st = await getUserTempState(ctx.from.id);
  if (st.stateKey === "admin_wait_file") {
    if (!(await requireAdmin(ctx))) return;

    const extracted = tryExtractDraftFromMessage(ctx);
    if (!extracted) {
      const sent = await ctx.reply("未检测到可提取的媒体 file_id，请重新发送媒体内容。");
      if (ctx.chat && sent && sent.message_id) {
        await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
      }
      return;
    }

    // extracted 的 content_data 是 JSON 数组（若是 text 则直接输出）
    let fileId = null;
    if (extracted.contentType === "text") {
      fileId = "(文本消息，无 file_id)";
    } else {
      try {
        const arr = JSON.parse(extracted.contentData);
        if (Array.isArray(arr) && arr.length > 0) {
          fileId = arr[0].data;
        }
      } catch (error) {}
    }

    const keyboard = new InlineKeyboard().text("↩️ 返回 /admin", "admin_back");
    const sent = await ctx.reply(`🆔 获取结果：\n类型：${extracted.contentType}\nfile_id：${fileId || "未获取到"}`, {
      reply_markup: keyboard
    });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
    }
    return;
  }

  // /p 模式：入草稿
  if (st.stateKey === "p_mode") {
    if (!(await requireAdmin(ctx))) return;

    const extracted = tryExtractDraftFromMessage(ctx);
    if (!extracted) {
      const sent = await ctx.reply("该消息类型暂不支持加入草稿，请发送文本/图片/视频/文件/语音/贴纸等。");
      if (ctx.chat && sent && sent.message_id) {
        await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
      }
      return;
    }

    // 关键词：当前版本不做交互设置，先留空；发布时用 defaultKeyword
    await insertDraft(ctx.from.id, null, extracted.contentType, extracted.contentData);

    const keyboard = new InlineKeyboard().text("📄 查看草稿箱", "admin_go_p").row().text("↩️ 返回 /admin", "admin_back");
    const sent = await ctx.reply("✅ 已加入草稿箱。", { reply_markup: keyboard });
    if (ctx.chat && sent && sent.message_id) {
      await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
    }
    return;
  }
});

/**
 * =========================
 * 18) /c 与 /cz（仅管理员，且仅作用于管理员自己）
 * =========================
 */

// /c：取消管理员自己当前验证状态（清除 bot_state）
bot.command("c", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  await clearUserTempState(ctx.from.id);

  const keyboard = new InlineKeyboard().text("↩️ 返回 /admin", "admin_back").row().text("💎 加入会员 (/v)", "go_v");
  const sent = await ctx.reply("✅ 已取消你当前的验证/等待状态。", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
  }
});

// /cz：重置管理员自己的前端测试状态（清除冷却、次数，并让你变回“新用户当天”）
bot.command("cz", async (ctx) => {
  if (!(await requireAdmin(ctx))) return;

  const adminId = ctx.from.id;
  const todayKey = getDateKeyInTimezone(new Date(), TIMEZONE);

  const client = await pool.connect();
  try {
    // 1) 清除管理员会话状态
    await clearUserTempState(adminId);

    // 2) 清除管理员 dh_quota 计数与冷却（只重置自己）
    await client.query(
      `
      INSERT INTO dh_quota (user_id, date_key, used_count, next_allowed_at, updated_at)
      VALUES ($1, $2, 0, NULL, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET date_key = EXCLUDED.date_key, used_count = 0, next_allowed_at = NULL, updated_at = NOW();
      `,
      [String(adminId), todayKey]
    );

    // 3) 让管理员“变回新用户当天”：把 bot_users.first_seen_date 改为今天（只作用于管理员）
    await client.query(
      `
      INSERT INTO bot_users (user_id, username, first_name, last_name, first_seen_date, last_seen_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET first_seen_date = EXCLUDED.first_seen_date, last_seen_at = NOW();
      `,
      [
        String(adminId),
        ctx.from.username ? String(ctx.from.username) : null,
        ctx.from.first_name ? String(ctx.from.first_name) : null,
        ctx.from.last_name ? String(ctx.from.last_name) : null,
        todayKey
      ]
    );
  } finally {
    client.release();
  }

  const keyboard = new InlineKeyboard().text("🎁 去兑换 (/dh)", "go_dh").row().text("↩️ 返回 /admin", "admin_back");
  const sent = await ctx.reply("♻️ 已重置你自己的前端测试状态：次数/冷却/新用户状态已恢复。", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
  }
});

/**
 * =========================
 * 19) 兜底：未知命令提示
 * =========================
 */

bot.on("message", async (ctx) => {
  // 若用户乱发内容且不在特定状态，给一个温和提示（不强制）
  if (!ctx.from) return;

  const st = await getUserTempState(ctx.from.id);
  if (st.stateKey) {
    return;
  }

  const keyboard = new InlineKeyboard().text("🏠 首页 /start", "go_start").row().text("🎁 兑换 /dh", "go_dh");
  const sent = await ctx.reply("请输入 /start 开始使用，或点击下方按钮。", { reply_markup: keyboard });
  if (ctx.chat && sent && sent.message_id) {
    await registerAutoDelete(ctx.chat.id, sent.message_id, GC_EXPIRE_MIN);
  }
});

/**
 * =========================
 * 20) Vercel Webhook Handler
 * =========================
 */

const handler = webhookCallback(bot, "http");

module.exports = async (req, res) => {
  // 健康检查
  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(HEALTH_TEXT);
    return;
  }

  // 只处理 Telegram webhook POST
  if (req.method === "POST") {
    return handler(req, res);
  }

  res.statusCode = 405;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Method Not Allowed");
};
