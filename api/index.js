const { Bot, InlineKeyboard, Keyboard } = require("grammy");
const { Pool } = require("pg");

// --- 环境变量 ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s));

if (!BOT_TOKEN || !DATABASE_URL) {
  throw new Error("BOT_TOKEN or DATABASE_URL not set");
}

const bot = new Bot(BOT_TOKEN);
const pool = new Pool({ connectionString: DATABASE_URL });
let botInitialized = false;

// ------ 时间工具（不依赖 luxon） ------
function nowInChina() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}
function getDateKey(d = nowInChina()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}
function formatDateTimeChina(d) {
  const t = new Date(d);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const day = String(t.getDate()).padStart(2, "0");
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
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
  return `📄 ${current}/${total}`;
}

// ------ 用户记录 ------
async function upsertUser(ctx) {
  const from = ctx.from;
  if (!from) return;
  const userId = from.id;
  const username = from.username || null;
  const firstName = from.first_name || null;
  const lastName = from.last_name || null;
  const now = nowInChina();
  const dateKey = getDateKey(now);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM users WHERE user_id=$1",
      [userId]
    );
    if (rows.length === 0) {
      await client.query(
        `INSERT INTO users
         (user_id, username, first_name, last_name,
          first_seen_at, last_seen_at,
          first_seen_date_key, last_date_key,
          dh_daily_count, dh_cooldown_until, is_admin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,NULL,$9)`,
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
    console.error(e);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

async function getUser(userId) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT * FROM users WHERE user_id=$1", [
      userId,
    ]);
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

// ------ 管理员状态 FSM ------
const adminState = new Map();
function cancelAdminState(adminId) {
  adminState.delete(adminId);
}
async function resetAdminDh(adminId) {
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
      [adminId, dateKey]
    );
  } finally {
    client.release();
  }
}

// ------ /start ------
bot.command("start", async (ctx) => {
  await upsertUser(ctx);
  const text =
    "🎉 喜迎马年新春 · 资源免费领取专区 🎉\n\n" +
    "🧧 新春期间，精选资源限时免费开放，先到先得！\n" +
    "📚 学习 · 影音 · 工具 · 素材，应有尽有～\n\n" +
    "👇 请选择服务：";

  const kb = new InlineKeyboard()
    .text("💎 加入会员（新春特价）", "start_join_vip")
    .row()
    .text("🎁 兑换资源", "start_dh");

  await ctx.reply(text, { reply_markup: kb });
});

// 全局消息钩子：记录用户
bot.on("message", async (ctx, next) => {
  await upsertUser(ctx);
  return next();
});

// 返回首页按钮
bot.callbackQuery("back_to_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  const text = "已返回首页，请重新选择服务：";
  const kb = new InlineKeyboard()
    .text("💎 加入会员（新春特价）", "start_join_vip")
    .row()
    .text("🎁 兑换资源", "start_dh");
  await ctx.reply(text, { reply_markup: kb });
});

// ------ 加入会员 /v / VIP 流程 ------
async function showVipPage(ctx) {
  const text =
    "🎉 喜迎新春（特价 VIP 专区）\n\n" +
    "💎 VIP会员特权说明：\n" +
    "✅ 专属中转通道\n" +
    "✅ 优先审核入群\n" +
    "✅ 7x24 小时客服支持\n" +
    "✅ 定期福利活动\n\n" +
    "请先完成付款，然后点击下方按钮提交订单号进行验证。\n\n" +
    "（此处插入宣传图等 file_id 消息）";

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

bot.callbackQuery("start_join_vip", async (ctx) => {
  await showVipPage(ctx);
});
bot.command("v", async (ctx) => {
  await showVipPage(ctx);
});

// 点击“我已付款，开始验证”
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

  await ctx.editMessageText(text).catch(async () => {
    await ctx.reply(text);
  });
});

// 处理订单号输入
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
      await ctx.reply("订单号识别失败，你可以返回首页重新选择服务：", {
        reply_markup: kb,
      });
      return;
    } else {
      await ctx.reply("订单号识别失败，请检查是否复制完整后重新输入。");
      return;
    }
  }

  // 识别成功：记录订单 + 标记 VIP + 建工单 + 发送入群链接
  adminState.delete(userId);

  const client = await pool.connect();
  let ticketId;
  const now = nowInChina();
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
    await ctx.reply("系统异常，请稍后重试。");
    return;
  } finally {
    client.release();
  }

  const joinLink = "https://t.me/+495j5rWmApsxYzg9";
  const kb = new InlineKeyboard().url("💎 加入会员群", joinLink);
  await ctx.reply(
    "✅ 订单验证成功！\n\n欢迎加入会员群，解锁更多专属资源与服务：",
    { reply_markup: kb }
  );

  // 通知管理员
  const ticketText =
    `📨 新工单\n\n` +
    `用户：${ctx.from.first_name || ""} (@${ctx.from.username || "无"})\n` +
    `用户ID：${ctx.from.id}\n` +
    `订单号：${orderNo}\n` +
    `时间（北京时间）：${formatDateTimeChina(now)}\n\n` +
    `工单ID：${ticketId}`;

  const adminKb = new InlineKeyboard()
    .text("🗂 查看工单列表", "admin_tickets")
    .row()
    .text("🗑 删除此工单", `admin_ticket_del_${ticketId}`);

  for (const aid of ADMIN_IDS) {
    try {
      await bot.api.sendMessage(aid, ticketText, { reply_markup: adminKb });
    } catch {}
  }
});

// ------ /c /cz ------
bot.command("c", async (ctx) => {
  const uid = ctx.from.id;
  if (!isAdmin(uid)) return;
  cancelAdminState(uid);
  await ctx.reply("已清除当前操作状态。");
});
bot.command("cz", async (ctx) => {
  const uid = ctx.from.id;
  if (!isAdmin(uid)) return;
  await resetAdminDh(uid);
  await ctx.reply("已重置你的 /dh 次数与冷却，并将你视为“当天新用户”。");
});

// ------ /admin 面板 ------
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const kb = new InlineKeyboard()
    .text("📁 FileID 工具", "admin_fileid")
    .row()
    .text("🛒 商品添加 (/p)", "admin_p")
    .row()
    .text("📨 工单管理", "admin_tickets")
    .row()
    .text("👥 用户表", "admin_users");
  await ctx.reply("管理员面板（仅限管理员访问）：", { reply_markup: kb });
});

// FileID 工具
bot.callbackQuery("admin_fileid", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  adminState.set(ctx.from.id, { mode: "waiting_fileid", data: {} });
  await ctx
    .editMessageText(
      "请发送一张图片或任意媒体，我会返回对应的 file_id。\n\n获取完成后会自动回到 admin 面板。"
    )
    .catch(async () => {
      await ctx.reply(
        "请发送一张图片或任意媒体，我会返回对应的 file_id。"
      );
    });
});

bot.on("message", async (ctx, next) => {
  const uid = ctx.from.id;
  if (!isAdmin(uid)) return next();
  const st = adminState.get(uid);
  if (!st || st.mode !== "waiting_fileid") return next();

  const msg = ctx.message;
  let fileId = null;
  let type = null;

  if (msg.photo && msg.photo.length) {
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
    await ctx.reply("未识别到可用媒体，请发送图片、文件、视频或音频。");
    return;
  }

  await ctx.reply(
    `类型：${type}\nfile_id：\n\`${fileId}\``,
    { parse_mode: "Markdown" }
  );

  adminState.delete(uid);
  const kb = new InlineKeyboard()
    .text("📁 FileID 工具", "admin_fileid")
    .row()
    .text("🛒 商品添加 (/p)", "admin_p")
    .row()
    .text("📨 工单管理", "admin_tickets")
    .row()
    .text("👥 用户表", "admin_users");
  await ctx.reply("已返回管理员面板：", { reply_markup: kb });
});

// ------ /p 商品添加 ------
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

    let text = `🛒 商品关键词列表\n${buildPageHeader(
      current,
      totalPages
    )}\n\n`;
    if (rows.length === 0) {
      text += "当前没有已上架的关键词。";
    } else {
      for (const r of rows) {
        text += `- ${r.keyword} (ID: ${r.id})\n`;
      }
    }

    const kb = new InlineKeyboard();
    kb.text("➕ 上架新关键词", "p_add_new").row();
    for (const r of rows) {
      kb.text(`🗑 删 ${r.keyword}`, `p_del_${r.id}`).row();
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
        .catch(async () => {
          await ctx.reply(text, { reply_markup: kb });
        });
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

// 上架新关键词
bot.callbackQuery("p_add_new", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  adminState.set(ctx.from.id, { mode: "p_waiting_keyword", data: {} });
  await ctx
    .editMessageText("请输入要上架的关键词（例如：1）：")
    .catch(async () => {
      await ctx.reply("请输入要上架的关键词（例如：1）：");
    });
});

bot.on("message:text", async (ctx, next) => {
  const uid = ctx.from.id;
  if (!isAdmin(uid)) return next();
  const st = adminState.get(uid);
  if (!st || st.mode !== "p_waiting_keyword") return next();

  const keyword = ctx.message.text.trim();
  if (!keyword) {
    await ctx.reply("关键词不能为空，请重新输入：");
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
    `关键词 "${keyword}" 已创建。\n\n请连续发送该商品的所有内容（支持文本、图片、文件、视频等，逐条发送）。\n\n发送完成后，请点击键盘下方的“✅ 完成上架”。`,
    { reply_markup: kb }
  );
});

// 记录 /p 内容
bot.on("message", async (ctx, next) => {
  const uid = ctx.from.id;
  if (!isAdmin(uid)) return next();
  const st = adminState.get(uid);
  if (!st || st.mode !== "p_waiting_contents") return next();

  if (ctx.message.text === "✅ 完成上架") return next();

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
    } else if (msg.photo && msg.photo.length) {
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
      await ctx.reply("已收到一条暂不支持的消息类型，未记录。");
    }
  } finally {
    client.release();
  }
});

// 完成上架
bot.on("message:text", async (ctx, next) => {
  const uid = ctx.from.id;
  if (!isAdmin(uid)) return next();
  const st = adminState.get(uid);
  if (!st || st.mode !== "p_waiting_contents") return next();
  if (ctx.message.text !== "✅ 完成上架") return next();

  adminState.delete(uid);
  await ctx.reply("已完成上架。", { reply_markup: { remove_keyboard: true } });
  await showPList(ctx, 1);
});

// 删除关键词
bot.callbackQuery(/p_del_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const kid = Number(ctx.match[1]);
  const kb = new InlineKeyboard()
    .text("❌ 确认删除", `p_del_confirm_${kid}`)
    .row()
    .text("↩️ 取消", "admin_p");
  await ctx.answerCallbackQuery();
  await ctx.reply("确定要删除该关键词及其所有内容吗？", { reply_markup: kb });
});
bot.callbackQuery(/p_del_confirm_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const kid = Number(ctx.match[1]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM keyword_contents WHERE keyword_id=$1", [
      kid,
    ]);
    await client.query("DELETE FROM keywords WHERE id=$1", [kid]);
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  await ctx.answerCallbackQuery("已删除。", { show_alert: true });
  await showPList(ctx, 1);
});

// 返回 admin
bot.callbackQuery("back_admin", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const kb = new InlineKeyboard()
    .text("📁 FileID 工具", "admin_fileid")
    .row()
    .text("🛒 商品添加 (/p)", "admin_p")
    .row()
    .text("📨 工单管理", "admin_tickets")
    .row()
    .text("👥 用户表", "admin_users");
  await ctx
    .editMessageText("管理员面板：", { reply_markup: kb })
    .catch(async () => {
      await ctx.reply("管理员面板：", { reply_markup: kb });
    });
});

// ------ /dh 兑换（用 keywords / keyword_contents） ------
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
    await ctx.reply("用户数据初始化中，请稍后重试。");
    return;
  }
  const now = nowInChina();
  const dateKey = getDateKey(now);
  const isNewUser =
    user.first_seen_date_key &&
    user.first_seen_date_key.toISOString().slice(0, 10) === dateKey;
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

  if (user.dh_daily_count >= maxDaily) {
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
      if (ctx.callbackQuery) {
        await ctx.editMessageText(text).catch(() => {});
      } else {
        await ctx.reply(text);
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
    let text = `${buildPageHeader(
      current,
      totalPages
    )}\n\n请选择要兑换的关键词：`;
    const kb = new InlineKeyboard();
    for (const r of rows) {
      kb.text(r.keyword, `dh_kw_${r.id}`).row();
    }
    if (totalPages > 1) {
      if (current > 1) kb.text("⬅️ 上一页", `dh_page_${current - 1}`);
      if (current < totalPages) kb.text("➡️ 下一页", `dh_page_${current + 1}`);
      kb.row();
    }
    kb.text("↩️ 返回首页", "back_to_start");

    if (ctx.callbackQuery) {
      await ctx
        .editMessageText(text, { reply_markup: kb })
        .catch(async () => {
          await ctx.reply(text, { reply_markup: kb });
        });
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

// 点击关键词，发送内容 + 更新次数/冷却
bot.callbackQuery(/dh_kw_(\d+)/, async (ctx) => {
  const keywordId = Number(ctx.match[1]);
  const userId = ctx.from.id;
  const now = nowInChina();
  const user = await getUser(userId);
  if (!user) {
    await ctx.answerCallbackQuery("用户数据异常，请稍后再试", {
      show_alert: true,
    });
    return;
  }

  const dateKey = getDateKey(now);
  const isNewUser =
    user.first_seen_date_key &&
    user.first_seen_date_key.toISOString().slice(0, 10) === dateKey;
  const freeLimit = isNewUser ? 3 : 2;
  const maxDaily = 10;
  const currentCount = user.dh_daily_count || 0;

  let newCount = currentCount + 1;
  let cooldownMs = 0;
  if (currentCount >= freeLimit) {
    const seq = [5, 10, 30, 40, 50]; // 分钟
    const index = Math.min(currentCount - freeLimit, seq.length - 1);
    cooldownMs = seq[index] * 60 * 1000;
  }
  if (newCount > maxDaily) {
    await ctx.answerCallbackQuery("今日次数已达上限，请明日再试", {
      show_alert: true,
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE users
       SET dh_daily_count=$2,
           dh_cooldown_until=CASE WHEN $3 > 0
                                  THEN (NOW() AT TIME ZONE 'UTC' + ($3 || ' milliseconds')::interval)
                                  ELSE NULL END
       WHERE user_id=$1`,
      [userId, newCount, cooldownMs]
    );
  } finally {
    client.release();
  }

  await sendKeywordContentsInBatches(ctx, keywordId);
});

async function sendKeywordContentsInBatches(ctx, keywordId) {
  const client = await pool.connect();
  try {
    const { rows: kwRows } = await client.query(
      "SELECT keyword FROM keywords WHERE id=$1",
      [keywordId]
    );
    if (kwRows.length === 0) {
      await ctx.answerCallbackQuery("该资源已下架", { show_alert: true });
      return;
    }
    const { rows } = await client.query(
      `SELECT id, content_type, payload
       FROM keyword_contents
       WHERE keyword_id=$1
       ORDER BY created_at ASC`,
      [keywordId]
    );
    if (rows.length === 0) {
      await ctx.answerCallbackQuery("该资源暂时没有内容", { show_alert: true });
      return;
    }

    const total = rows.length;
    const batchSize = 10;
    let batchStart = 0;
    let batchIndex = 1;

    while (batchStart < total) {
      const batch = rows.slice(batchStart, batchStart + batchSize);
      const groupCount = Math.min(batchSize, total - batchStart);
      let fileIndex = 1;
      for (const item of batch) {
        const payload = item.payload;
        const type = item.content_type;
        const progressText = `📦 文件 ${fileIndex}/${groupCount}`;
        fileIndex++;
        switch (type) {
          case "text":
            await ctx.api.sendMessage(ctx.chat.id, payload.text);
            break;
          case "photo":
            await ctx.api.sendPhoto(ctx.chat.id, payload.file_id, {
              caption: payload.caption || undefined,
            });
            break;
          case "document":
            await ctx.api.sendDocument(ctx.chat.id, payload.file_id, {
              caption: payload.caption || undefined,
            });
            break;
          case "video":
            await ctx.api.sendVideo(ctx.chat.id, payload.file_id, {
              caption: payload.caption || undefined,
            });
            break;
          default:
            await ctx.api.sendMessage(
              ctx.chat.id,
              `收到一种不支持的内容类型：${type}`
            );
        }
        await ctx.api.sendMessage(ctx.chat.id, progressText);
      }

      batchStart += batchSize;
      if (batchStart < total) {
        const kb = new InlineKeyboard()
          .text("✨👉 继续发送", `dh_send_next_${keywordId}_${batchStart}`)
          .row()
          .text("💎 加入会员（新春特价）", "start_join_vip")
          .row()
          .text("↩️ 返回兑换", "start_dh");
        await ctx.reply(
          `本组文件发送完毕（第 ${batchIndex} 组）`,
          { reply_markup: kb }
        );
        break;
      } else {
        const kb = new InlineKeyboard()
          .text("💎 加入会员（新春特价）", "start_join_vip")
          .row()
          .text("↩️ 返回兑换", "start_dh");
        await ctx.reply("✅ 文件发送完毕（全部组已完成）。", {
          reply_markup: kb,
        });
      }
      batchIndex++;
    }
  } finally {
    client.release();
  }
}

bot.callbackQuery(/dh_send_next_(\d+)_(\d+)/, async (ctx) => {
  const keywordId = Number(ctx.match[1]);
  const startIndex = Number(ctx.match[2]);

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, content_type, payload
       FROM keyword_contents
       WHERE keyword_id=$1
       ORDER BY created_at ASC`,
      [keywordId]
    );
    const total = rows.length;
    const batchSize = 10;
    let batchStart = startIndex;
    let batchIndex = Math.floor(startIndex / batchSize) + 1;

    if (batchStart >= total) {
      await ctx.answerCallbackQuery("没有更多内容了", { show_alert: true });
      return;
    }

    while (batchStart < total) {
      const batch = rows.slice(batchStart, batchStart + batchSize);
      const groupCount = Math.min(batchSize, total - batchStart);
      let fileIndex = 1;
      for (const item of batch) {
        const payload = item.payload;
        const type = item.content_type;
        const progressText = `📦 文件 ${fileIndex}/${groupCount}`;
        fileIndex++;
        switch (type) {
          case "text":
            await ctx.api.sendMessage(ctx.chat.id, payload.text);
            break;
          case "photo":
            await ctx.api.sendPhoto(ctx.chat.id, payload.file_id, {
              caption: payload.caption || undefined,
            });
            break;
          case "document":
            await ctx.api.sendDocument(ctx.chat.id, payload.file_id, {
              caption: payload.caption || undefined,
            });
            break;
          case "video":
            await ctx.api.sendVideo(ctx.chat.id, payload.file_id, {
              caption: payload.caption || undefined,
            });
            break;
          default:
            await ctx.api.sendMessage(
              ctx.chat.id,
              `收到一种不支持的内容类型：${type}`
            );
        }
        await ctx.api.sendMessage(ctx.chat.id, progressText);
      }
      batchStart += batchSize;
      if (batchStart < total) {
        const kb = new InlineKeyboard()
          .text("✨👉 继续发送", `dh_send_next_${keywordId}_${batchStart}`)
          .row()
          .text("💎 加入会员（新春特价）", "start_join_vip")
          .row()
          .text("↩️ 返回兑换", "start_dh");
        await ctx.reply(
          `本组文件发送完毕（第 ${batchIndex} 组）`,
          { reply_markup: kb }
        );
        break;
      } else {
        const kb = new InlineKeyboard()
          .text("💎 加入会员（新春特价）", "start_join_vip")
          .row()
          .text("↩️ 返回兑换", "start_dh");
        await ctx.reply("✅ 文件发送完毕（全部组已完成）。", {
          reply_markup: kb,
        });
      }
      batchIndex++;
    }
  } finally {
    client.release();
  }
});

// ------ 工单列表 & 用户表（简化版） ------
// 工单列表
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
        .editMessageText("目前没有工单。")
        .catch(async () => await ctx.reply("目前没有工单。"));
      return;
    }
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(Math.max(page, 1), totalPages);
    const offset = (current - 1) * perPage;
    const { rows } = await client.query(
      `SELECT id, user_id, username, first_name, disabled
       FROM tickets
       ORDER BY created_at ASC
       LIMIT $1 OFFSET $2`,
      [perPage, offset]
    );
    let text = `📨 工单列表\n${buildPageHeader(
      current,
      totalPages
    )}\n\n`;
    const kb = new InlineKeyboard();
    for (const t of rows) {
      const uname = t.username
        ? `@${t.username}`
        : t.first_name || t.user_id;
      const label = `${uname} (${t.user_id})` + (t.disabled ? " [停用]" : "");
      text += `- ${label}\n`;
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
      `SELECT * FROM tickets WHERE id=$1`,
      [id]
    );
    if (rows.length === 0) {
      await ctx.answerCallbackQuery("该工单不存在");
      return;
    }
    const t = rows[0];
    const first = formatDateTimeChina(t.created_at);
    const last = formatDateTimeChina(t.last_update);
    const text =
      `📨 工单详情（ID: ${t.id}）\n\n` +
      `用户名字：${t.first_name || ""}\n` +
      `用户名：@${t.username || "无"}\n` +
      `用户ID：${t.user_id}\n` +
      `订单编号：${t.order_no}\n\n` +
      `首次（北京时间）：${first}\n` +
      `最近（北京时间）：${last}\n` +
      `停用状态：${t.disabled ? "已停用" : "正常"}`;
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
  await ctx.answerCallbackQuery("工单已删除", { show_alert: true });
  await showTicketList(ctx, 1);
});

// 用户表
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
        .editMessageText("当前没有用户记录。")
        .catch(async () => await ctx.reply("当前没有用户记录。"));
      return;
    }
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(Math.max(page, 1), totalPages);
    const offset = (current - 1) * perPage;
    const { rows } = await client.query(
      `SELECT user_id, username, first_name, is_vip, is_admin
       FROM users
       ORDER BY first_seen_at ASC
       LIMIT $1 OFFSET $2`,
      [perPage, offset]
    );
    let text = `👥 用户表\n${buildPageHeader(
      current,
      totalPages
    )}\n\n`;
    for (const u of rows) {
      text += `ID: ${u.user_id}, 用户名: @${
        u.username || "无"
      }, 名称: ${u.first_name || ""}, VIP: ${
        u.is_vip ? "是" : "否"
      }, 管理员: ${u.is_admin ? "是" : "否"}\n`;
    }
    const kb = new InlineKeyboard();
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

// ------ Vercel 入口（WebHook）------
module.exports = async (req, res) => {
  if (req.method === "POST") {
    try {
      if (!botInitialized) {
        await bot.init();
        botInitialized = true;
      }
      await bot.handleUpdate(req.body);
    } catch (e) {
      console.error("Error handling update:", e);
    }
    res.status(200).json({ ok: true });
  } else {
    res.status(200).send("OK");
  }
};
