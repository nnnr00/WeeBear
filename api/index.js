const { Bot, InlineKeyboard, Keyboard } = require("grammy");
const { Pool } = require("pg");

// --------------------- 环境变量与基础配置 ---------------------

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => Number(s));

if (!BOT_TOKEN || !DATABASE_URL) {
  throw new Error("BOT_TOKEN or DATABASE_URL not set");
}

const bot = new Bot(BOT_TOKEN);
const pool = new Pool({ connectionString: DATABASE_URL });
let botInitialized = false;

// --------------------- 通用工具函数 ---------------------

function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

// 北京时间
function nowInChina() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + 8 * 3600000);
}

function getDateKey(date) {
  const d = date || nowInChina();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateTimeChina(date) {
  if (!date) return "";
  const d = new Date(date);
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
  const cn = new Date(utcMs + 8 * 3600000);
  const y = cn.getFullYear();
  const m = String(cn.getMonth() + 1).padStart(2, "0");
  const day = String(cn.getDate()).padStart(2, "0");
  const hh = String(cn.getHours()).padStart(2, "0");
  const mm = String(cn.getMinutes()).padStart(2, "0");
  const ss = String(cn.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

function formatDuration(ms) {
  const sec = Math.ceil(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m <= 0) return `${s} 秒`;
  return `${m} 分 ${s} 秒`;
}

function buildPageHeader(current, total) {
  return `📄 第 ${current} 页 / 共 ${total} 页`;
}

// --------------------- 状态与用户处理 ---------------------

const adminState = new Map(); // key: userId, value: { mode, data }

async function upsertUserAndNotifyNew(ctx) {
  if (!ctx.from) return;
  const userId = ctx.from.id;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || null;
  const lastName = ctx.from.last_name || null;
  const now = new Date();
  const dateKey = getDateKey(nowInChina());

  const client = await pool.connect();
  let isNew = false;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM users WHERE user_id=$1",
      [userId]
    );
    if (rows.length === 0) {
      isNew = true;
      await client.query(
        `INSERT INTO users
         (user_id, username, first_name, last_name,
          first_seen_at, last_seen_at,
          first_seen_date_key, last_date_key,
          dh_daily_count, dh_cooldown_until,
          is_admin, is_vip, disabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,NULL,$9,FALSE,FALSE)`,
        [
          userId,
          username,
          firstName,
          lastName,
          now,
          now,
          dateKey,
          dateKey,
          isAdmin(userId),
        ]
      );
    } else {
      const user = rows[0];
      let dhDailyCount = user.dh_daily_count || 0;
      const lastDateKey = user.last_date_key
        ? user.last_date_key.toISOString().slice(0, 10)
        : null;
      if (lastDateKey !== dateKey) {
        dhDailyCount = 0;
      }
      await client.query(
        `UPDATE users
         SET username=$2,
             first_name=$3,
             last_name=$4,
             last_seen_at=$5,
             last_date_key=$6,
             dh_daily_count=$7,
             dh_cooldown_until=CASE
               WHEN last_date_key IS NULL OR last_date_key::date <> $6::date
               THEN NULL
               ELSE dh_cooldown_until
             END
         WHERE user_id=$1`,
        [userId, username, firstName, lastName, now, dateKey, dhDailyCount]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
  } finally {
    client.release();
  }

  if (isNew && ADMIN_IDS.length > 0) {
    const text =
      "👤 新用户加入\n\n" +
      `用户名字：${firstName || ""}\n` +
      `用户名：@${username || "无"}\n` +
      `用户ID：${userId}\n` +
      `首次使用（北京时间）：${formatDateTimeChina(now)}`;

    for (const adminId of ADMIN_IDS) {
      try {
        await bot.api.sendMessage(adminId, text);
      } catch (e) {
        // 忽略发送失败
      }
    }
  }
}

async function getUser(userId) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT * FROM users WHERE user_id=$1",
      [userId]
    );
    if (rows.length === 0) return null;

    const user = rows[0];
    const now = nowInChina();
    const todayKey = getDateKey(now);
    const lastDateKey = user.last_date_key
      ? user.last_date_key.toISOString().slice(0, 10)
      : null;

    if (lastDateKey !== todayKey) {
      await client.query(
        `UPDATE users
         SET dh_daily_count=0,
             dh_cooldown_until=NULL,
             last_date_key=$2
         WHERE user_id=$1`,
        [userId, todayKey]
      );
      user.dh_daily_count = 0;
      user.dh_cooldown_until = null;
    }

    return user;
  } finally {
    client.release();
  }
}

// --------------------- /dh 消息清理：5 分钟后删除 ---------------------

async function cleanupDhMessages(userId, chatId) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, message_id
       FROM dh_messages
       WHERE user_id=$1
         AND chat_id=$2
         AND deleted=FALSE
         AND created_at < (NOW() - interval '5 minutes')`,
      [userId, chatId]
    );

    for (const row of rows) {
      try {
        await bot.api.deleteMessage(chatId, row.message_id);
      } catch (e) {
        // 已被删除或不可删，忽略
      }
      await client.query(
        "UPDATE dh_messages SET deleted=TRUE WHERE id=$1",
        [row.id]
      );
    }
  } finally {
    client.release();
  }
}

async function recordDhMessage(userId, chatId, messageId) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO dh_messages (user_id, chat_id, message_id)
       VALUES ($1,$2,$3)`,
      [userId, chatId, messageId]
    );
  } finally {
    client.release();
  }
}

// --------------------- /start 首页 ---------------------

async function sendStartPage(chatId) {
  const text =
    "🎉 马年新春快乐 🎉\n\n" +
    "🧧 新春期间，精选资源限时开放\n" +
    "📦 免费领取 · 限时福利 · 不定期上新\n\n" +
    "👇 请选择服务：";

  const kb = new InlineKeyboard()
    .text("💎 加入会员（新春特价）", "start_join_vip")
    .row()
    .text("🎁 兑换资源", "start_dh");

  await bot.api.sendMessage(chatId, text, { reply_markup: kb });
}

bot.command("start", async (ctx) => {
  await upsertUserAndNotifyNew(ctx);
  await sendStartPage(ctx.chat.id);
});

bot.callbackQuery("back_to_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendStartPage(ctx.chat.id);
});

// --------------------- /v 会员逻辑 ---------------------

async function showVipPage(ctx) {
  const text =
    "🎉 喜迎新春（特价 VIP 专区）\n\n" +
    "💎 VIP会员特权说明：\n" +
    "✅ 专属中转通道\n" +
    "✅ 优先审核入群\n" +
    "✅ 7x24 小时客服支持\n" +
    "✅ 定期福利活动\n\n" +
    "请先完成付款，然后点击下方按钮提交订单号进行验证。\n\n" +
    "（此处可插入宣传图等 file_id 消息）";

  const kb = new InlineKeyboard().text("✅ 我已付款，开始验证", "vip_paid");

  if (ctx.callbackQuery) {
    await ctx
      .editMessageText(text, { reply_markup: kb })
      .catch(async () => {
        await ctx.reply(text, { reply_markup: kb });
      });
  } else {
    await ctx.reply(text, { reply_markup: kb });
  }
}

bot.command("v", async (ctx) => {
  await showVipPage(ctx);
});

bot.callbackQuery("start_join_vip", async (ctx) => {
  await showVipPage(ctx);
});

bot.callbackQuery("vip_paid", async (ctx) => {
  const userId = ctx.from.id;
  adminState.set(userId, { mode: "waiting_order_no", data: { retry: 0 } });

  const text =
    "📄 订单验证流程说明：\n\n" +
    "1. 打开你的支付平台/账单页面\n" +
    "2. 找到本次付款记录\n" +
    "3. 进入【账单详情】或【订单详情】\n" +
    "4. 在页面中找到【订单号】字段\n" +
    "5. 复制完整订单号并粘贴发送到本聊天\n\n" +
    "请在此输入你的订单号：";

  await ctx
    .editMessageText(text)
    .catch(async () => await ctx.reply(text));
});

// 订单号输入
bot.on("message:text", async (ctx, next) => {
  const userId = ctx.from.id;
  const st = adminState.get(userId);
  if (!st || st.mode !== "waiting_order_no") return next();

  const orderNo = ctx.message.text.trim();
  const isMatch = /^20260.+/.test(orderNo);

  if (!isMatch) {
    st.data.retry = (st.data.retry || 0) + 1;
    adminState.set(userId, st);

    if (st.data.retry >= 2) {
      adminState.delete(userId);
      const kb = new InlineKeyboard().text("🏠 返回首页", "back_to_start");
      await ctx.reply(
        "订单号识别失败，你可以返回首页重新选择服务：",
        { reply_markup: kb }
      );
      return;
    } else {
      await ctx.reply(
        "订单号识别失败，请检查是否复制完整后重新输入。"
      );
      return;
    }
  }

  // 验证成功
  adminState.delete(userId);
  const client = await pool.connect();
  const now = nowInChina();
  let ticketId;

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO orders (user_id, order_no, verified)
       VALUES ($1,$2,TRUE)`,
      [userId, orderNo]
    );
    await client.query(
      `UPDATE users SET is_vip=TRUE WHERE user_id=$1`,
      [userId]
    );

    const u = ctx.from;
    const { rows } = await client.query(
      `INSERT INTO tickets
       (user_id, username, first_name, last_name, order_no,
        created_at, last_update, disabled)
       VALUES ($1,$2,$3,$4,$5,$6,$6,FALSE)
       RETURNING id`,
      [
        userId,
        u.username || null,
        u.first_name || null,
        u.last_name || null,
        orderNo,
        now,
      ]
    );
    ticketId = rows[0].id;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    await ctx.reply("系统异常，请稍后再试。");
    return;
  } finally {
    client.release();
  }

  // 给用户发入群按钮
  const joinLink = "https://t.me/+495j5rWmApsxYzg9";
  const kb = new InlineKeyboard().url("💎 加入会员群", joinLink);
  await ctx.reply(
    "✅ 订单验证成功！\n\n欢迎加入会员群，解锁更多专属资源与服务：",
    { reply_markup: kb }
  );

  // 通知管理员工单
  const text =
    "📨 新工单\n\n" +
    `用户名字：${ctx.from.first_name || ""}\n` +
    `用户名：@${ctx.from.username || "无"}\n` +
    `用户ID：${ctx.from.id}\n` +
    `订单编号：${orderNo}\n` +
    `时间（北京时间）：${formatDateTimeChina(now)}\n` +
    `工单ID：${ticketId}`;

  const adminKb = new InlineKeyboard()
    .text("🗂 查看工单列表", "admin_tickets")
    .row()
    .text("🗑 删除此工单", `admin_ticket_del_${ticketId}`);

  for (const aid of ADMIN_IDS) {
    try {
      await bot.api.sendMessage(aid, text, { reply_markup: adminKb });
    } catch (e) {}
  }
});

// --------------------- /c /cz （仅管理员） ---------------------

bot.command("c", async (ctx) => {
  const uid = ctx.from.id;
  if (!isAdmin(uid)) return;
  adminState.delete(uid);
  await ctx.reply("✅ 已清除当前操作状态。");
  await showAdminPanel(ctx.chat.id);
});

bot.command("cz", async (ctx) => {
  const uid = ctx.from.id;
  if (!isAdmin(uid)) return;

  const client = await pool.connect();
  try {
    const now = nowInChina();
    const dateKey = getDateKey(now);
    await client.query(
      `UPDATE users
       SET dh_daily_count=0,
           dh_cooldown_until=NULL,
           first_seen_date_key=$2,
           last_date_key=$2
       WHERE user_id=$1`,
      [uid, dateKey]
    );
  } finally {
    client.release();
  }

  await ctx.reply(
    "✅ 已重置你的 /dh 次数与冷却，并将你视为当天新用户。"
  );
  await sendStartPage(ctx.chat.id);
});

// --------------------- /admin 面板 ---------------------

async function showAdminPanel(chatId) {
  const kb = new InlineKeyboard()
    .text("📁 FileID 工具", "admin_fileid")
    .row()
    .text("🛒 商品添加", "admin_p")
    .row()
    .text("📨 工单管理", "admin_tickets")
    .row()
    .text("👥 用户表", "admin_users");

  await bot.api.sendMessage(
    chatId,
    "🛠 管理员面板（仅限管理员访问）：\n\n请从下方选择要执行的功能 👇",
    { reply_markup: kb }
  );
}

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await showAdminPanel(ctx.chat.id);
});

bot.callbackQuery("back_admin", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.answerCallbackQuery();
  await showAdminPanel(ctx.chat.id);
});

// --------------------- FileID 工具 ---------------------

bot.callbackQuery("admin_fileid", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  adminState.set(ctx.from.id, { mode: "waiting_fileid", data: {} });

  const text =
    "📁 FileID 获取工具\n\n" +
    "请发送一张图片、视频、文件或音频，我会返回对应的 file_id。\n\n" +
    "获取完成后，你可以通过下方按钮返回 admin 或进入商品管理。";

  await ctx
    .editMessageText(text)
    .catch(async () => await ctx.reply(text));
});

// 全局 message 处理：先 upsert 用户，然后处理 fileid / /dh 自动跳转
bot.on("message", async (ctx, next) => {
  await upsertUserAndNotifyNew(ctx);

  const uid = ctx.from.id;
  const st = adminState.get(uid);

  // FileID 模式
  if (isAdmin(uid) && st && st.mode === "waiting_fileid") {
    const msg = ctx.message;
    let fileId = null;
    let type = null;

    if (msg.photo && msg.photo.length > 0) {
      const ph = msg.photo[msg.photo.length - 1];
      fileId = ph.file_id;
      type = "photo";
    } else if (msg.document) {
      fileId = msg.document.file_id;
      type = "document";
    } else if (msg.video) {
      fileId = msg.video.file_id;
      type = "video";
    } else if (msg.audio) {
      fileId = msg.audio.file_id;
      type = "audio";
    }

    if (!fileId) {
      await ctx.reply(
        "❗ 未识别到可用媒体，请发送图片、文件、视频或音频。"
      );
      return;
    }

    await ctx.reply(
      `📁 FileID 获取成功\n\n类型：${type}\nfile_id：\n\`${fileId}\``,
      { parse_mode: "Markdown" }
    );

    adminState.delete(uid);

    const kb = new InlineKeyboard()
      .text("↩️ 返回 admin", "back_admin")
      .row()
      .text("🛒 商品添加", "admin_p");

    await ctx.reply("✅ 操作完成，你可以选择继续操作：", {
      reply_markup: kb,
    });
    return;
  }

  // 如果是命令（/xxx），交给后面的命令处理
  if (ctx.message.text && ctx.message.text.startsWith("/")) {
    return next();
  }

  // 非命令文本：自动跳转为 /dh 入口（start=dh）
  await handleDhEntry(ctx);
});

// --------------------- /p 商品添加与管理 ---------------------

bot.callbackQuery("admin_p", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await showPList(ctx, 1);
});

bot.command("p", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await showPList(ctx, 1);
});

async function showPList(ctx, page) {
  const perPage = 10;
  const client = await pool.connect();
  try {
    const { rows: countRows } = await client.query(
      "SELECT COUNT(*)::int AS c FROM keywords"
    );
    const total = countRows[0].c;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(Math.max(page, 1), totalPages);
    const offset = (current - 1) * perPage;

    const { rows } = await client.query(
      `SELECT id, keyword, created_at
       FROM keywords
       ORDER BY created_at ASC
       LIMIT $1 OFFSET $2`,
      [perPage, offset]
    );

    let text =
      "🛒 商品关键词管理\n" +
      buildPageHeader(current, totalPages) +
      "\n\n";

    if (rows.length === 0) {
      text += "当前还没有任何商品关键词，请点击下方按钮进行上架。";
    } else {
      text += "以下为已上架的关键词列表：\n\n";
      for (const r of rows) {
        text += `▫️ 关键词：${r.keyword}（ID: ${r.id}）\n`;
      }
    }

    const kb = new InlineKeyboard();
    kb.text("➕ 上架新关键词", "p_add_new").row();

    for (const r of rows) {
      kb.text(`⚙ 管理「${r.keyword}」`, `p_manage_${r.id}`).row();
    }

    if (totalPages > 1) {
      if (current > 1) kb.text("⬅️ 上一页", `p_page_${current - 1}`);
      if (current < totalPages) kb.text("➡️ 下一页", `p_page_${current + 1}`);
      kb.row();
    }

    kb.text("↩️ 返回 admin", "back_admin");

    if (ctx.callbackQuery) {
      await ctx
        .editMessageText(text, { reply_markup: kb })
        .catch(async () => await ctx.reply(text, { reply_markup: kb }));
    } else {
      await ctx.reply(text, { reply_markup: kb });
    }
  } finally {
    client.release();
  }
}

bot.callbackQuery(/p_page_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const page = Number(ctx.match[1]);
  await showPList(ctx, page);
});

bot.callbackQuery("p_add_new", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  adminState.set(ctx.from.id, { mode: "p_waiting_keyword", data: {} });

  await ctx
    .editMessageText(
      "🆕 上架新关键词\n\n请发送要上架的关键词（例如：1）："
    )
    .catch(async () => await ctx.reply(
      "🆕 上架新关键词\n\n请发送要上架的关键词（例如：1）："
    ));
});

bot.on("message:text", async (ctx, next) => {
  const uid = ctx.from.id;
  const st = adminState.get(uid);

  if (!isAdmin(uid) || !st || st.mode !== "p_waiting_keyword") {
    return next();
  }

  const keyword = ctx.message.text.trim();
  if (!keyword) {
    await ctx.reply("❗ 关键词不能为空，请重新输入：");
    return;
  }

  const client = await pool.connect();
  let keywordId;
  try {
    const { rows } = await client.query(
      `INSERT INTO keywords (keyword) VALUES ($1) RETURNING id`,
      [keyword]
    );
    keywordId = rows[0].id;
  } finally {
    client.release();
  }

  adminState.set(uid, {
    mode: "p_waiting_contents",
    data: { keywordId, keyword },
  });

  const kb = new Keyboard().text("✅ 完成上架").resized();
  await ctx.reply(
    `✅ 关键词「${keyword}」已创建。\n\n请连续发送该商品的所有内容（支持文本、图片、文件、视频等，逐条发送）。\n\n发送完成后，请点击键盘下方的“✅ 完成上架”。`,
    { reply_markup: kb }
  );
});

bot.on("message", async (ctx, next) => {
  const uid = ctx.from.id;
  const st = adminState.get(uid);

  if (!isAdmin(uid) || !st || st.mode !== "p_waiting_contents") {
    return next();
  }

  if (ctx.message.text === "✅ 完成上架") {
    return next();
  }

  const { keywordId } = st.data;
  const msg = ctx.message;
  const client = await pool.connect();

  try {
    if (msg.text) {
      await client.query(
        `INSERT INTO keyword_contents (keyword_id, content_type, payload)
         VALUES ($1,'text',$2::jsonb)`,
        [keywordId, JSON.stringify({ text: msg.text })]
      );
    } else if (msg.photo && msg.photo.length > 0) {
      const ph = msg.photo[msg.photo.length - 1];
      await client.query(
        `INSERT INTO keyword_contents (keyword_id, content_type, payload)
         VALUES ($1,'photo',$2::jsonb)`,
        [
          keywordId,
          JSON.stringify({
            file_id: ph.file_id,
            caption: msg.caption || null,
          }),
        ]
      );
    } else if (msg.document) {
      await client.query(
        `INSERT INTO keyword_contents (keyword_id, content_type, payload)
         VALUES ($1,'document',$2::jsonb)`,
        [
          keywordId,
          JSON.stringify({
            file_id: msg.document.file_id,
            caption: msg.caption || null,
          }),
        ]
      );
    } else if (msg.video) {
      await client.query(
        `INSERT INTO keyword_contents (keyword_id, content_type, payload)
         VALUES ($1,'video',$2::jsonb)`,
        [
          keywordId,
          JSON.stringify({
            file_id: msg.video.file_id,
            caption: msg.caption || null,
          }),
        ]
      );
    } else {
      await ctx.reply("⚠ 已收到一条暂不支持的消息类型，未记录。");
    }
  } finally {
    client.release();
  }
});

bot.on("message:text", async (ctx, next) => {
  const uid = ctx.from.id;
  const st = adminState.get(uid);

  if (!isAdmin(uid) || !st || st.mode !== "p_waiting_contents") {
    return next();
  }

  if (ctx.message.text !== "✅ 完成上架") return next();

  adminState.delete(uid);
  await ctx.reply("✅ 已完成上架。", {
    reply_markup: { remove_keyboard: true },
  });
  await showPList(ctx, 1);
});

// 管理单个关键词（详情页）
bot.callbackQuery(/p_manage_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const kid = Number(ctx.match[1]);

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, keyword, created_at
       FROM keywords
       WHERE id=$1`,
      [kid]
    );
    if (rows.length === 0) {
      await ctx.answerCallbackQuery("该关键词不存在");
      return;
    }
    const k = rows[0];

    const text =
      `🧾 关键词详情\n\n` +
      `关键词：${k.keyword}\n` +
      `ID：${k.id}\n` +
      `上架时间（北京时间）：${formatDateTimeChina(k.created_at)}\n\n` +
      "你可以在此删除该关键词及其所有内容。";

    const kb = new InlineKeyboard()
      .text("❌ 确认删除", `p_del_confirm_${k.id}`)
      .row()
      .text("↩️ 返回商品列表", "admin_p");

    await ctx
      .editMessageText(text, { reply_markup: kb })
      .catch(async () => await ctx.reply(text, { reply_markup: kb }));
  } finally {
    client.release();
  }
});

// 删除关键词（已确认）
bot.callbackQuery(/p_del_confirm_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const kid = Number(ctx.match[1]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM keyword_contents WHERE keyword_id=$1",
      [kid]
    );
    await client.query("DELETE FROM keywords WHERE id=$1", [kid]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
  } finally {
    client.release();
  }

  await ctx.answerCallbackQuery("✅ 关键词已删除。", { show_alert: true });
  await showPList(ctx, 1);
});

// --------------------- /dh 兑换逻辑 ---------------------

bot.command("dh", async (ctx) => {
  await handleDhEntry(ctx);
});

bot.callbackQuery("start_dh", async (ctx) => {
  await handleDhEntry(ctx);
});

async function handleDhEntry(ctx) {
  const userId = ctx.from.id;
  const user = await getUser(userId);

  if (!user) {
    await ctx.reply("用户数据初始化中，请稍后再试。");
    return;
  }

  const now = nowInChina();
  const todayKey = getDateKey(now);
  const isNewUser =
    user.first_seen_date_key &&
    user.first_seen_date_key.toISOString().slice(0, 10) === todayKey;

  const freeLimit = isNewUser ? 3 : 2;
  const maxDaily = 10;

  if (user.dh_cooldown_until && now < user.dh_cooldown_until) {
    const diff = user.dh_cooldown_until.getTime() - now.getTime();
    const text =
      "⏳ 当前处于冷却期，请稍后再试。\n\n" +
      `预计剩余时间：${formatDuration(diff)}\n\n` +
      "如需立即解锁更多次数，可考虑升级会员～";

    const kb = new InlineKeyboard()
      .text("💎 加入会员（新春特价）", "start_join_vip")
      .row()
      .text("↩️ 返回兑换", "start_dh");

    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
    } else {
      await ctx.reply(text, { reply_markup: kb });
    }
    return;
  }

  if ((user.dh_daily_count || 0) >= maxDaily) {
    const text =
      "📈 今日兑换次数已达到上限。\n\n" +
      "🔄 请明天再来，或升级会员解锁更多权益。";

    const kb = new InlineKeyboard()
      .text("💎 加入会员（新春特价）", "start_join_vip")
      .row()
      .text("↩️ 返回首页", "back_to_start");

    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
    } else {
      await ctx.reply(text, { reply_markup: kb });
    }
    return;
  }

  await showDhKeywordsPage(ctx, 1);
}

async function showDhKeywordsPage(ctx, page) {
  const perPage = 10;
  const client = await pool.connect();
  try {
    const { rows: countRows } = await client.query(
      "SELECT COUNT(*)::int AS c FROM keywords"
    );
    const total = countRows[0].c;
    if (total === 0) {
      const text =
        "🎁 当前暂无可兑换资源\n\n" +
        "请耐心等待管理员上架～";

      const kb = new InlineKeyboard()
        .text("💎 加入会员（新春特价）", "start_join_vip")
        .row()
        .text("↩️ 返回首页", "back_to_start");

      if (ctx.callbackQuery) {
        await ctx
          .editMessageText(text, { reply_markup: kb })
          .catch(() => {});
      } else {
        await ctx.reply(text, { reply_markup: kb });
      }
      return;
    }

    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(Math.max(page, 1), totalPages);
    const offset = (current - 1) * perPage;

    const { rows } = await client.query(
      `SELECT id, keyword
       FROM keywords
       ORDER BY created_at ASC
       LIMIT $1 OFFSET $2`,
      [perPage, offset]
    );

    let text =
      "🎁 可兑换资源关键词\n" +
      buildPageHeader(current, totalPages) +
      "\n\n请选择要兑换的关键词：\n\n";

    const kb = new InlineKeyboard();
    for (const r of rows) {
      text += `▫️ 关键词：${r.keyword}（ID: ${r.id}）\n`;
      kb.text(r.keyword, `dh_kw_${r.id}`).row();
    }

    if (totalPages > 1) {
      kb.text("⬅️ 上一页", `dh_page_${current - 1}`).text(
        "➡️ 下一页",
        `dh_page_${current + 1}`
      );
      kb.row();
    }

    kb.text("💎 加入会员（新春特价）", "start_join_vip").row();
    kb.text("↩️ 返回首页", "back_to_start");

    if (ctx.callbackQuery) {
      await ctx
        .editMessageText(text, { reply_markup: kb })
        .catch(async () => await ctx.reply(text, { reply_markup: kb }));
    } else {
      await ctx.reply(text, { reply_markup: kb });
    }
  } finally {
    client.release();
  }
}

bot.callbackQuery(/dh_page_(\d+)/, async (ctx) => {
  const page = Number(ctx.match[1]);
  await showDhKeywordsPage(ctx, page);
});

// 点击关键词：计数 + 冷却 + 分页发送
bot.callbackQuery(/dh_kw_(\d+)/, async (ctx) => {
  const keywordId = Number(ctx.match[1]);
  const userId = ctx.from.id;
  const user = await getUser(userId);

  if (!user) {
    await ctx.answerCallbackQuery("用户数据异常，请稍后再试", {
      show_alert: true,
    });
    return;
  }

  const now = nowInChina();
  const todayKey = getDateKey(now);
  const isNewUser =
    user.first_seen_date_key &&
    user.first_seen_date_key.toISOString().slice(0, 10) === todayKey;

  const freeLimit = isNewUser ? 3 : 2;
  const maxDaily = 10;
  const currentCount = user.dh_daily_count || 0;

  if (currentCount >= maxDaily) {
    await ctx.answerCallbackQuery("今日次数已达上限，请明日再试", {
      show_alert: true,
    });
    return;
  }

  const newCount = currentCount + 1;
  let cooldownMs = 0;

  if (currentCount >= freeLimit) {
    const seqMinutes = [5, 10, 30, 40, 50, 60];
    const index = Math.min(
      currentCount - freeLimit,
      seqMinutes.length - 1
    );
    cooldownMs = seqMinutes[index] * 60 * 1000;
  }

  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE users
       SET dh_daily_count=$2,
           dh_cooldown_until=CASE
             WHEN $3 > 0
             THEN (NOW() + ($3 || ' milliseconds')::interval)
             ELSE NULL
           END
       WHERE user_id=$1`,
      [userId, newCount, cooldownMs]
    );
  } finally {
    client.release();
  }

  await sendKeywordContentsGrouped(ctx, keywordId, 0);
});

// 每页 10 条内容，合并为一条信息发送
async function sendKeywordContentsGrouped(ctx, keywordId, pageIndex) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, content_type, payload
       FROM keyword_contents
       WHERE keyword_id=$1
       ORDER BY created_at ASC`,
      [keywordId]
    );
    if (rows.length === 0) {
      await ctx.answerCallbackQuery("该资源暂无内容", { show_alert: true });
      return;
    }

    const perPage = 10;
    const total = rows.length;
    const totalPages = Math.ceil(total / perPage);
    if (pageIndex >= totalPages) {
      await ctx.answerCallbackQuery("没有更多内容了", { show_alert: true });
      return;
    }

    const start = pageIndex * perPage;
    const end = Math.min(start + perPage, total);
    const groupItems = rows.slice(start, end);

    // 将这一页的 10 条内容合并为一条文本信息
    let combinedText = `📦 本页共 ${groupItems.length} 条内容\n\n`;
    let index = start + 1;

    for (const item of groupItems) {
      const payload = item.payload;
      const type = item.content_type;

      if (type === "text") {
        combinedText += `📝 [文本 ${index}]\n${payload.text}\n\n`;
      } else if (type === "photo") {
        combinedText +=
          `🖼 [图片 ${index}] file_id：${payload.file_id}\n` +
          (payload.caption ? `说明：${payload.caption}\n\n` : "\n");
      } else if (type === "document") {
        combinedText +=
          `📄 [文件 ${index}] file_id：${payload.file_id}\n` +
          (payload.caption ? `说明：${payload.caption}\n\n` : "\n");
      } else if (type === "video") {
        combinedText +=
          `🎬 [视频 ${index}] file_id：${payload.file_id}\n` +
          (payload.caption ? `说明：${payload.caption}\n\n` : "\n");
      } else {
        combinedText += `❔ [未知类型 ${index}] type=${type}\n\n`;
      }

      index++;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    const sent = await ctx.api.sendMessage(chatId, combinedText);
    if (sent && sent.message_id) {
      await recordDhMessage(userId, chatId, sent.message_id);
    }

    const currentPage = pageIndex + 1;
    const footerText = `📑 第 ${currentPage} 页 / 共 ${totalPages} 页`;

    const kb = new InlineKeyboard();
    if (currentPage < totalPages) {
      kb.text("✨👉 继续发送下一页", `dh_send_next_${keywordId}_${pageIndex + 1}`);
    }
    kb.row().text("💎 加入会员（新春特价）", "start_join_vip").row();
    kb.text("↩️ 返回兑换", "start_dh");

    const footerMsg = await ctx.reply(footerText, { reply_markup: kb });
    if (footerMsg && footerMsg.message_id) {
      await recordDhMessage(userId, chatId, footerMsg.message_id);
    }
  } finally {
    client.release();
  }
}

bot.callbackQuery(/dh_send_next_(\d+)_(\d+)/, async (ctx) => {
  const keywordId = Number(ctx.match[1]);
  const pageIndex = Number(ctx.match[2]);
  await sendKeywordContentsGrouped(ctx, keywordId, pageIndex);
});

// --------------------- 工单管理 ---------------------

bot.callbackQuery("admin_tickets", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await showTicketList(ctx, 1);
});

async function showTicketList(ctx, page) {
  const perPage = 10;
  const client = await pool.connect();
  try {
    const { rows: countRows } = await client.query(
      "SELECT COUNT(*)::int AS c FROM tickets"
    );
    const total = countRows[0].c;
    if (total === 0) {
      await ctx
        .editMessageText("📭 当前没有工单记录。")
        .catch(async () => await ctx.reply("📭 当前没有工单记录。"));
      return;
    }

    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(Math.max(page, 1), totalPages);
    const offset = (current - 1) * perPage;

    const { rows } = await client.query(
      `SELECT id, user_id, username, first_name
       FROM tickets
       ORDER BY created_at ASC
       LIMIT $1 OFFSET $2`,
      [perPage, offset]
    );

    let text =
      "📨 工单列表\n" +
      buildPageHeader(current, totalPages) +
      "\n\n";

    const kb = new InlineKeyboard();
    for (const t of rows) {
      const labelName = t.first_name || "无名";
      const label = `${labelName}(${t.user_id})`;
      text += `▫️ ${label}\n`;
      kb.text(label, `ticket_detail_${t.id}`).row();
    }

    if (totalPages > 1) {
      if (current > 1) kb.text("⬅️ 上一页", `ticket_page_${current - 1}`);
      if (current < totalPages) kb.text("➡️ 下一页", `ticket_page_${current + 1}`);
      kb.row();
    }

    kb.text("↩️ 返回 admin", "back_admin");

    await ctx
      .editMessageText(text, { reply_markup: kb })
      .catch(async () => await ctx.reply(text, { reply_markup: kb }));
  } finally {
    client.release();
  }
}

bot.callbackQuery(/ticket_page_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const page = Number(ctx.match[1]);
  await showTicketList(ctx, page);
});

bot.callbackQuery(/ticket_detail_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = Number(ctx.match[1]);

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT * FROM tickets WHERE id=$1",
      [id]
    );
    if (rows.length === 0) {
      await ctx.answerCallbackQuery("该工单不存在");
      return;
    }
    const t = rows[0];

    const text =
      `📨 工单详情（ID: ${t.id}）\n\n` +
      `用户名字：${t.first_name || ""}\n` +
      `用户名：@${t.username || "无"}\n` +
      `用户ID：${t.user_id}\n` +
      `订单编号：${t.order_no}\n` +
      `时间（北京时间）：${formatDateTimeChina(t.created_at)}`;

    const kb = new InlineKeyboard()
      .text("🗑 删除工单", `admin_ticket_del_${t.id}`)
      .row()
      .text("↩️ 返回工单列表", "admin_tickets");

    await ctx
      .editMessageText(text, { reply_markup: kb })
      .catch(async () => await ctx.reply(text, { reply_markup: kb }));
  } finally {
    client.release();
  }
});

bot.callbackQuery(/admin_ticket_del_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = Number(ctx.match[1]);

  const client = await pool.connect();
  try {
    await client.query("DELETE FROM tickets WHERE id=$1", [id]);
  } finally {
    client.release();
  }

  await ctx.answerCallbackQuery("✅ 工单已删除", { show_alert: true });
  await showTicketList(ctx, 1);
});

// --------------------- 用户表 ---------------------

bot.callbackQuery("admin_users", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await showUserList(ctx, 1);
});

async function showUserList(ctx, page) {
  const perPage = 10;
  const client = await pool.connect();
  try {
    const { rows: countRows } = await client.query(
      "SELECT COUNT(*)::int AS c FROM users"
    );
    const total = countRows[0].c;
    if (total === 0) {
      await ctx
        .editMessageText("👥 当前没有用户记录。")
        .catch(async () => await ctx.reply("👥 当前没有用户记录。"));
      return;
    }

    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(Math.max(page, 1), totalPages);
    const offset = (current - 1) * perPage;

    const { rows } = await client.query(
      `SELECT user_id, username, first_name, first_seen_at, last_seen_at, disabled
       FROM users
       ORDER BY first_seen_at ASC
       LIMIT $1 OFFSET $2`,
      [perPage, offset]
    );

    let text =
      "👥 用户表\n" +
      buildPageHeader(current, totalPages) +
      "\n\n";

    const kb = new InlineKeyboard();
    for (const u of rows) {
      text +=
        `▫️ 用户：${u.first_name || ""}\n` +
        `   用户名：@${u.username || "无"}\n` +
        `   用户ID：${u.user_id}\n` +
        `   首次使用（北京时间）：${formatDateTimeChina(
          u.first_seen_at
        )}\n` +
        `   最近使用（北京时间）：${formatDateTimeChina(
          u.last_seen_at
        )}\n` +
        `   是否停用：${u.disabled ? "是" : "否"}\n\n`;

      const label = `${u.first_name || "无名"}(${u.user_id})`;
      kb.text(label, `user_detail_${u.user_id}`).row();
    }

    if (totalPages > 1) {
      if (current > 1) kb.text("⬅️ 上一页", `users_page_${current - 1}`);
      if (current < totalPages) kb.text("➡️ 下一页", `users_page_${current + 1}`);
      kb.row();
    }

    kb.text("↩️ 返回 admin", "back_admin");

    await ctx
      .editMessageText(text, { reply_markup: kb })
      .catch(async () => await ctx.reply(text, { reply_markup: kb }));
  } finally {
    client.release();
  }
}

bot.callbackQuery(/users_page_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const page = Number(ctx.match[1]);
  await showUserList(ctx, page);
});

bot.callbackQuery(/user_detail_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const uid = Number(ctx.match[1]);

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT user_id, username, first_name, first_seen_at, last_seen_at, disabled
       FROM users
       WHERE user_id=$1`,
      [uid]
    );
    if (rows.length === 0) {
      await ctx.answerCallbackQuery("该用户不存在");
      return;
    }

    const u = rows[0];
    const text =
      "👤 用户详情\n\n" +
      `用户：${u.first_name || ""}\n` +
      `用户名：@${u.username || "无"}\n` +
      `用户ID：${u.user_id}\n` +
      `首次使用（北京时间）：${formatDateTimeChina(
        u.first_seen_at
      )}\n` +
      `最近使用（北京时间）：${formatDateTimeChina(
        u.last_seen_at
      )}\n` +
      `是否停用：${u.disabled ? "是" : "否"}`;

    const kb = new InlineKeyboard().text(
      "↩️ 返回用户列表",
      "admin_users"
    );

    await ctx
      .editMessageText(text, { reply_markup: kb })
      .catch(async () => await ctx.reply(text, { reply_markup: kb }));
  } finally {
    client.release();
  }
});

// --------------------- Vercel Webhook 入口 ---------------------

module.exports = async (req, res) => {
  if (req.method === "POST") {
    try {
      if (!botInitialized) {
        await bot.init();
        botInitialized = true;
      }

      const update = req.body;

      const userId =
        (update.message && update.message.from && update.message.from.id) ||
        (update.callback_query &&
          update.callback_query.from &&
          update.callback_query.from.id) ||
        null;

      const chatId =
        (update.message && update.message.chat && update.message.chat.id) ||
        (update.callback_query &&
          update.callback_query.message &&
          update.callback_query.message.chat &&
          update.callback_query.message.chat.id) ||
        null;

      // 所有按钮/消息处理前，先清理该用户该会话中过期的 /dh 消息
      if (userId && chatId) {
        await cleanupDhMessages(userId, chatId);
      }

      await bot.handleUpdate(update);
    } catch (e) {
      console.error("Error handling update:", e);
    }
    res.status(200).json({ ok: true });
  } else {
    res.status(200).send("OK");
  }
};
