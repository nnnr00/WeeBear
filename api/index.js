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

// Asia/Shanghai 时间工具
const { DateTime } = require("luxon");

// 防止在 Vercel 上多实例重复 setWebhook
let webhookSet = false;

// --- 工具函数 ---
function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

// 获取北京时间与 date_key
function nowInChina() {
  return DateTime.now().setZone("Asia/Shanghai");
}
function getDateKey(dt = nowInChina()) {
  return dt.toISODate(); // YYYY-MM-DD
}

// 记录/更新用户
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
      "SELECT * FROM users WHERE user_id = $1",
      [userId]
    );
    if (rows.length === 0) {
      await client.query(
        `INSERT INTO users
         (user_id, username, first_name, last_name, first_seen_at, last_seen_at,
          first_seen_date_key, last_date_key, dh_daily_count, dh_cooldown_until, is_admin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,NULL,$9)`,
        [
          userId,
          username,
          firstName,
          lastName,
          now.toJSDate(),
          now.toJSDate(),
          dateKey,
          dateKey,
          isAdmin(userId),
        ]
      );
    } else {
      const user = rows[0];
      let dhDailyCount = user.dh_daily_count || 0;
      // 日切：如果 last_date_key != 今天，则重置 dh_daily_count & cooldown
      if (!user.last_date_key || user.last_date_key.toISOString().slice(0, 10) !== dateKey) {
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
        [
          userId,
          username,
          firstName,
          lastName,
          now.toJSDate(),
          dateKey,
          dhDailyCount,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
  } finally {
    client.release();
  }
}

// 读取用户记录（带日切处理）
async function getUser(userId) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT * FROM users WHERE user_id=$1", [userId]);
    if (rows.length === 0) return null;

    const user = rows[0];
    const now = nowInChina();
    const todayKey = getDateKey(now);

    if (!user.last_date_key || user.last_date_key.toISOString().slice(0, 10) !== todayKey) {
      // 日切：重置
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

// 冷却描述
function formatDuration(ms) {
  const sec = Math.ceil(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m <= 0) return `${s} 秒`;
  return `${m} 分 ${s} 秒`;
}

// 发送分页列表的通用工具（工单、关键词等）
function buildPageHeader(current, total) {
  return `📄 ${current}/${total}`;
}

// --- 状态存储（简单内存 FSM，仅针对管理员个人） ---
const adminState = new Map(); // key: adminId, value: { mode, data }

// /c 取消管理员当前状态
function cancelAdminState(adminId) {
  adminState.delete(adminId);
}

// /cz：重置管理员 dh 次数与冷却
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

// --- /start 首页 ---
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

// 处理 deep link：/start start=dh -> 直接进入兑换
bot.on("message:text", async (ctx, next) => {
  // 处理外部传入命令之前，先做用户入库
  await upsertUser(ctx);
  return next();
});

bot.callbackQuery("start_dh", async (ctx) => {
  await handleDhEntry(ctx);
});

// /dh 命令入口
bot.command("dh", async (ctx) => {
  await handleDhEntry(ctx);
});

async function handleDhEntry(ctx) {
  const userId = ctx.from.id;
  const user = await getUser(userId);
  const now = nowInChina();

  // 免费次数规则：
  // 新用户：first_seen_date_key=今天 -> 当天免费3次
  // 老用户：每天免费2次
  const dateKey = getDateKey(now);
  const isNewUser =
    user && user.first_seen_date_key && user.first_seen_date_key.toISOString().slice(0, 10) === dateKey;

  const freeLimit = isNewUser ? 3 : 2;
  const maxDaily = 10;

  // 冷却检查
  if (user.dh_cooldown_until && now.toJSDate() < user.dh_cooldown_until) {
    const diff = user.dh_cooldown_until.getTime() - now.toMillis();
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

  // 日次数限制
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

  // 拉取 keywords 列表，分页显示 10 条/页
  const page = 1;
  await showDhKeywordsPage(ctx, page);
}

// 展示 /dh 关键字分页
async function showDhKeywordsPage(ctx, page) {
  const perPage = 10;
  const client = await pool.connect();
  try {
    const { rows: countRows } = await client.query("SELECT COUNT(*)::int AS c FROM keywords");
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

    let text = `${buildPageHeader(current, totalPages)}\n\n请选择要兑换的关键词：`;
    const kb = new InlineKeyboard();
    for (const r of rows) {
      kb.text(r.keyword, `dh_kw_${r.id}`).row();
    }
    // 分页按钮
    if (totalPages > 1) {
      if (current > 1) kb.text("⬅️ 上一页", `dh_page_${current - 1}`);
      if (current < totalPages) kb.text("➡️ 下一页", `dh_page_${current + 1}`);
      kb.row();
    }
    kb.text("↩️ 返回首页", "back_to_start");

    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
        await ctx.answerCallbackQuery();
      });
    } else {
      await ctx.reply(text, { reply_markup: kb });
    }
  } finally {
    client.release();
  }
}

// /dh 翻页
bot.callbackQuery(/dh_page_(\d+)/, async (ctx) => {
  const page = Number(ctx.match[1]);
  await showDhKeywordsPage(ctx, page);
});

// /dh 点击具体关键词 -> 发送内容（每组10条）
bot.callbackQuery(/dh_kw_(\d+)/, async (ctx) => {
  const keywordId = Number(ctx.match[1]);
  const userId = ctx.from.id;
  const now = nowInChina();
  const user = await getUser(userId);

  // 检查冷却 & 次数（与入口一致）
  const dateKey = getDateKey(now);
  const isNewUser =
    user &&
    user.first_seen_date_key &&
    user.first_seen_date_key.toISOString().slice(0, 10) === dateKey;
  const freeLimit = isNewUser ? 3 : 2;

  // 使用次数 + 更新冷却序列
  const currentCount = user.dh_daily_count || 0;

  let newCount = currentCount + 1;
  let cooldownMs = 0;
  if (currentCount >= freeLimit) {
    // 已经消耗完免费次数，走冷却序列
    // 冷却序列: 5,10,30,40,50（分钟）
    const seq = [5, 10, 30, 40, 50];
    const index = Math.min(currentCount - freeLimit, seq.length - 1); // 0-based
    cooldownMs = seq[index] * 60 * 1000;
  }

  if (newCount > 10) {
    await ctx.answerCallbackQuery("今日次数已达上限，请明日再试", { show_alert: true });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE users
       SET dh_daily_count=$2,
           dh_cooldown_until=CASE WHEN $3 > 0 THEN (NOW() AT TIME ZONE 'Asia/Shanghai' + ($3 || ' milliseconds')::interval)
                                  ELSE NULL
                             END
       WHERE user_id=$1`,
      [userId, newCount, cooldownMs]
    );
  } finally {
    client.release();
  }

  // 发送内容
  await sendKeywordContentsInBatches(ctx, keywordId);
});

// 发送关键词内容（每10条为一组）
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

        // 为每条内容加一个“📦 文件 i/x”的进度提示
        const progressText = `📦 文件 ${fileIndex}/${groupCount}`;
        fileIndex++;

        // 先发文件，再发进度提示（也可以合并文本）
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
        // 还有下一组
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
        break; // 交给 callback 再继续
      } else {
        // 全部发送完成
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

// 继续发送下一组
bot.callbackQuery(/dh_send_next_(\d+)_(\d+)/, async (ctx) => {
  const keywordId = Number(ctx.match[1]);
  const startIndex = Number(ctx.match[2]);

  // 重新拉取内容，从 startIndex 开始
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

// 返回首页
bot.callbackQuery("back_to_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await bot.api.sendMessage(
    ctx.chat.id,
    "已返回首页，请重新选择服务。",
    {
      reply_markup: new InlineKeyboard()
        .text("💎 加入会员（新春特价）", "start_join_vip")
        .row()
        .text("🎁 兑换资源", "start_dh"),
    }
  );
});

// --- 加入会员逻辑 /v ---
// 点击“加入会员（新春特价）” -> /v 页面
bot.callbackQuery("start_join_vip", async (ctx) => {
  await showVipPage(ctx);
});

bot.command("v", async (ctx) => {
  await showVipPage(ctx);
});

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
    await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { reply_markup: kb });
    });
  } else {
    await ctx.reply(text, { reply_markup: kb });
  }
}

// 点击“我已付款，开始验证” -> 让用户输入订单号
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

// 处理订单号输入（仅限当前用户处于 waiting_order_no 状态）
bot.on("message:text", async (ctx, next) => {
  const userId = ctx.from.id;
  const st = adminState.get(userId);
  if (!st || st.mode !== "waiting_order_no") {
    return next();
  }

  const orderNo = ctx.message.text.trim();
  // 内部逻辑：识别以 20260 开头的订单号。不对用户提示任何“规则信息”。
  const isMatch = /^20260.+/.test(orderNo);

  if (!isMatch) {
    st.data.retry = (st.data.retry || 0) + 1;
    adminState.set(userId, st);

    if (st.data.retry >= 2) {
      // 连续两次失败 -> 回到 /start
      adminState.delete(userId);
      const text =
        "订单号识别失败。\n\n" +
        "你可以返回首页重新选择服务：";
      const kb = new InlineKeyboard()
        .text("🏠 返回首页", "back_to_start");
      await ctx.reply(text, { reply_markup: kb });
      return;
    } else {
      await ctx.reply(
        "订单号识别失败，请检查是否复制完整后重新输入。"
      );
      return;
    }
  }

  // 识别成功：记录订单，标记验证通过，发入群按钮，并向管理员发工单
  adminState.delete(userId);

  const client = await pool.connect();
  let ticketId;
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO orders (user_id, order_no, verified)
       VALUES ($1,$2,TRUE)`,
      [userId, orderNo]
    );

    // 标记用户为 VIP，可选
    await client.query(
      `UPDATE users SET is_vip=TRUE WHERE user_id=$1`,
      [userId]
    );

    // 建立工单
    const u = ctx.from;
    const now = nowInChina();
    const { rows: tRows } = await client.query(
      `INSERT INTO tickets
       (user_id, username, first_name, last_name, order_no, created_at, last_update, disabled)
       VALUES ($1,$2,$3,$4,$5,$6,$6,FALSE)
       RETURNING id`,
      [
        userId,
        u.username || null,
        u.first_name || null,
        u.last_name || null,
        orderNo,
        now.toJSDate(),
      ]
    );
    ticketId = tRows[0].id;

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    await ctx.reply("系统异常，请稍后再试。");
    return;
  } finally {
    client.release();
  }

  // 发送入群按钮
  const joinLink = "https://t.me/+495j5rWmApsxYzg9";
  const kb = new InlineKeyboard().url("💎 加入会员群", joinLink);
  await ctx.reply(
    "✅ 订单验证成功！\n\n欢迎加入会员群，解锁更多专属资源与服务：",
    { reply_markup: kb }
  );

  // 通知管理员工单
  const ticketText =
    `📨 新工单\n\n` +
    `用户：${ctx.from.first_name || ""} (@${ctx.from.username || "无"})\n` +
    `用户ID：${ctx.from.id}\n` +
    `订单号：${orderNo}\n` +
    `时间（北京时间）：${nowInChina().toFormat("yyyy-LL-dd HH:mm:ss")}\n\n` +
    `工单ID：${ticketId}`;

  const adminKb = new InlineKeyboard()
    .text("🗂 查看工单列表", "admin_tickets")
    .row()
    .text("🗑 删除此工单", `admin_ticket_del_${ticketId}`);

  for (const aid of ADMIN_IDS) {
    try {
      await bot.api.sendMessage(aid, ticketText, {
        reply_markup: adminKb,
      });
    } catch (e) {
      // 忽略无法发送的管理员
    }
  }
});

// --- 管理指令 /c /cz ---
bot.command("c", async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return;
  cancelAdminState(userId);
  await ctx.reply("已清除当前操作状态。");
});

bot.command("cz", async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return;
  await resetAdminDh(userId);
  await ctx.reply("已重置你的 /dh 次数与冷却，并将你视为“当天新用户”。");
});

// --- /admin 管理面板 ---
bot.command("admin", async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return;

  const kb = new InlineKeyboard()
    .text("📁 FileID 工具", "admin_fileid")
    .row()
    .text("🛒 商品添加 (/p)", "admin_p")
    .row()
    .text("📨 工单管理", "admin_tickets")
    .row()
    .text("👥 用户表", "admin_users");

  await ctx.reply("管理员面板（仅限管理员访问）：", {
    reply_markup: kb,
  });
});

// 1) FileID 工具
bot.callbackQuery("admin_fileid", async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) {
    await ctx.answerCallbackQuery();
    return;
  }
  adminState.set(userId, { mode: "waiting_fileid", data: {} });
  await ctx.editMessageText(
    "请发送一张图片或任意媒体，我会返回对应的 file_id。\n\n获取完成后会自动回到 admin 面板。"
  ).catch(async () => {
    await ctx.reply(
      "请发送一张图片或任意媒体，我会返回对应的 file_id。"
    );
  });
});

bot.on("message", async (ctx, next) => {
  const userId = ctx.from && ctx.from.id;
  if (!userId || !isAdmin(userId)) return next();

  const st = adminState.get(userId);
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

  // 取到一次就回到 admin
  adminState.delete(userId);
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

// 2) /p 商品添加与管理
bot.command("p", async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return;
  await showPList(ctx, 1);
});

bot.callbackQuery("admin_p", async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCallbackQuery();
    return;
  }
  await showPList(ctx, 1);
});

// /p 列表页（与 /dh 同源 keywords）
async function showPList(ctx, page) {
  const perPage = 10;
  const client = await pool.connect();
  try {
    const { rows: countRows } = await client.query("SELECT COUNT(*)::int AS c FROM keywords");
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

    let text = `🛒 商品关键词列表\n${buildPageHeader(current, totalPages)}\n\n`;
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
      await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
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

// 上架新关键词流程
bot.callbackQuery("p_add_new", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const userId = ctx.from.id;
  adminState.set(userId, { mode: "p_waiting_keyword", data: {} });
  await ctx.editMessageText("请输入要上架的关键词（例如：1）：").catch(async () => {
    await ctx.reply("请输入要上架的关键词（例如：1）：");
  });
});

bot.on("message:text", async (ctx, next) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return next();

  const st = adminState.get(userId);
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

  adminState.set(userId, {
    mode: "p_waiting_contents",
    data: { keywordId, keyword },
  });

  const kb = new Keyboard().text("✅ 完成上架").resized();
  await ctx.reply(
    `关键词 "${keyword}" 已创建。\n\n请连续发送该商品的所有内容（支持文本、图片、文件、视频等，逐条发送）。\n\n发送完成后，请点击键盘下方的“✅ 完成上架”。`,
    { reply_markup: kb }
  );
});

// 在“等待内容”状态下，记录所有消息
bot.on("message", async (ctx, next) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return next();

  const st = adminState.get(userId);
  if (!st || st.mode !== "p_waiting_contents") return next();

  const { keywordId } = st.data;
  const msg = ctx.message;

  // 如果文本刚好是 “✅ 完成上架”，让另一段逻辑处理
  if (msg.text && msg.text === "✅ 完成上架") return next();

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

  return;
});

// 捕捉“✅ 完成上架”
bot.on("message:text", async (ctx, next) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return next();

  const st = adminState.get(userId);
  if (!st || st.mode !== "p_waiting_contents") return next();

  if (ctx.message.text !== "✅ 完成上架") return next();

  adminState.delete(userId);
  // 切回普通键盘
  await ctx.reply("已完成上架。", {
    reply_markup: { remove_keyboard: true },
  });
  await showPList(ctx, 1);
});

// 删除关键词（两次确认）
bot.callbackQuery(/p_del_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const kid = Number(ctx.match[1]);
  const kb = new InlineKeyboard()
    .text("❌ 确认删除", `p_del_confirm_${kid}`)
    .row()
    .text("↩️ 取消", "admin_p");
  await ctx.answerCallbackQuery();
  await ctx.reply("确定要删除该关键词及其所有内容吗？", {
    reply_markup: kb,
  });
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
  } catch (e) {
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
  await ctx.editMessageText("管理员面板：", { reply_markup: kb }).catch(async () => {
    await ctx.reply("管理员面板：", { reply_markup: kb });
  });
});

// 3) 工单系统
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
      await ctx.editMessageText("目前没有工单。").catch(async () => {
        await ctx.reply("目前没有工单。");
      });
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

    let text = `📨 工单列表\n${buildPageHeader(current, totalPages)}\n\n`;
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

    await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { reply_markup: kb });
    });
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
      `SELECT *
       FROM tickets
       WHERE id=$1`,
      [id]
    );
    if (rows.length === 0) {
      await ctx.answerCallbackQuery("该工单不存在");
      return;
    }
    const t = rows[0];
    const first = DateTime.fromJSDate(t.created_at)
      .setZone("Asia/Shanghai")
      .toFormat("yyyy-LL-dd HH:mm:ss");
    const last = DateTime.fromJSDate(t.last_update)
      .setZone("Asia/Shanghai")
      .toFormat("yyyy-LL-dd HH:mm:ss");

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

    await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { reply_markup: kb });
    });
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

// 4) 用户表（简单分页展示）
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
      await ctx.editMessageText("当前没有用户记录。").catch(async () => {
        await ctx.reply("当前没有用户记录。");
      });
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

    let text = `👥 用户表\n${buildPageHeader(current, totalPages)}\n\n`;
    for (const u of rows) {
      text += `ID: ${u.user_id}, 用户名: @${u.username || "无"}, 名称: ${
        u.first_name || ""
      }, VIP: ${u.is_vip ? "是" : "否"}, 管理员: ${
        u.is_admin ? "是" : "否"
      }\n`;
    }

    const kb = new InlineKeyboard();
    if (totalPages > 1) {
      if (current > 1) kb.text("⬅️ 上一页", `users_page_${current - 1}`);
      if (current < totalPages) kb.text("➡️ 下一页", `users_page_${current + 1}`);
      kb.row();
    }
    kb.text("↩️ 返回 admin", "back_admin");

    await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { reply_markup: kb });
    });
  } finally {
    client.release();
  }
}

bot.callbackQuery(/users_page_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const page = Number(ctx.match[1]);
  await showUserList(ctx, page);
});

// --- Vercel 入口函数（Webhook）---
module.exports = async (req, res) => {
  // 设置 Webhook（仅第一次）
  if (!webhookSet) {
    const url = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}/api/index`;
    try {
      await bot.api.setWebhook(url);
      webhookSet = true;
      console.log("Webhook set to:", url);
    } catch (e) {
      console.error("Failed to set webhook:", e);
    }
  }

  if (req.method === "POST") {
    const body = req.body;
    try {
      await bot.handleUpdate(body);
    } catch (e) {
      console.error("Error handling update:", e);
    }
    res.status(200).json({ ok: true });
  } else {
    res.status(200).send("OK");
  }
};
