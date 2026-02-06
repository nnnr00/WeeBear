const { Bot, InlineKeyboard, webhookCallback, GrammyError, HttpError, InputMediaBuilder } = require("grammy");
const { Pool } = require("pg");

/* -------------------- 你提供的 file_id（原数据） -------------------- */

const FILE_ID_PAYMENT = "AgACAgUAAxkBAAIDd2mEHCq1fvS4dwIjba1YCTLObQonAAJtDWsbrPMhVNjJFj6MFYBoAQADAgADeQADOAQ";
const FILE_ID_ORDER = "AgACAgUAAxkBAAIDgGmEHH9bpq3a64REkLP7QoHNoQjWAAJyDWsbrPMhVMEDi7UYH-23AQADAgADeQADOAQ";
const FILE_ID_Y_1 = "AgACAgUAAxkBAAIDeGmEHCrnk74gTiB3grMPMgABShELQwACbg1rG6zzIVT6oNssdJPQiQEAAwIAA3gAAzgE";
const FILE_ID_Y_2 = "AgACAgUAAxkBAAIDdmmEHCrb0Wl9qnLkqWBJq1SBmOSxAAJsDWsbrPMhVCRxUCxfaKLvAQADAgADeQADOAQ";
const FILE_ID_YZ_1 = "AgACAgUAAxkBAAIDc2mEHCoWWn9oC8zmHY0FmtrGC71RAAJpDWsbrPMhVHfQ-xsLhufSAQADAgADeQADOAQ";
const FILE_ID_YZ_2 = "AgACAgUAAxkBAAIDdWmEHCqfztYGYvEDxhIccqfHwdTvAAJrDWsbrPMhVP3t3hHkwIg3AQADAgADeQADOAQ";
const FILE_ID_YZ_3 = "AgACAgUAAxkBAAIDdGmEHCpa7jUG1ZlWHEggcpou9v1KAAJqDWsbrPMhVB9iPYH9HXYkAQADAgADeQADOAQ";

/* -------------------- 环境变量 -------------------- */

if (!process.env.BOT_TOKEN) {
  throw new Error("Missing BOT_TOKEN");
}
if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}

const ADMIN_IDS = String(process.env.ADMIN_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0)
  .map((value) => Number(value))
  .filter((value) => Number.isFinite(value));

/* -------------------- 数据库连接（不会清库） -------------------- */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* -------------------- Bot 初始化 -------------------- */

const bot = new Bot(process.env.BOT_TOKEN);

/* -------------------- 工具：时间（北京时间） -------------------- */

function getBeijingNowDate() {
  const now = new Date();
  return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}

function formatBeijingDateOnly(date) {
  const d = date;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isAdminUserId(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

function sleepMilliseconds(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/* -------------------- 数据库：users -------------------- */

async function ensureUserExists(telegramId, username, firstName) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO users (telegram_id, username, first_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (telegram_id) DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name
      `,
      [telegramId, username || null, firstName || null]
    );
  } finally {
    client.release();
  }
}

async function getUserRow(telegramId) {
  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

async function updateUserFields(telegramId, fieldsObject) {
  const keys = Object.keys(fieldsObject);
  if (keys.length === 0) return;

  const setParts = [];
  const values = [];
  let index = 1;

  for (const key of keys) {
    setParts.push(`${key} = $${index}`);
    values.push(fieldsObject[key]);
    index += 1;
  }

  values.push(telegramId);

  const client = await pool.connect();
  try {
    await client.query(`UPDATE users SET ${setParts.join(", ")} WHERE telegram_id = $${index}`, values);
  } finally {
    client.release();
  }
}

/* -------------------- 数据库：user_states（用于流程状态 + 延迟删除记录） -------------------- */

async function getUserStateRow(userId) {
  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT * FROM user_states WHERE user_id = $1`, [userId]);
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

async function setUserState(userId, state, tempDataObject) {
  const tempDataText = tempDataObject ? JSON.stringify(tempDataObject) : null;
  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO user_states (user_id, state, temp_data, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        state = EXCLUDED.state,
        temp_data = EXCLUDED.temp_data,
        updated_at = NOW()
      `,
      [userId, state, tempDataText]
    );
  } finally {
    client.release();
  }
}

async function clearUserState(userId) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO user_states (user_id, state, temp_data, updated_at)
      VALUES ($1, 'idle', NULL, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        state = 'idle',
        temp_data = NULL,
        updated_at = NOW()
      `,
      [userId]
    );
  } finally {
    client.release();
  }
}

/* -------------------- 当日 /y 是否有效 -------------------- */

async function isDailyFirstVerifyValid(userRow) {
  if (!userRow) return false;

  const today = formatBeijingDateOnly(getBeijingNowDate());
  if (!userRow.first_verify_date) return false;

  const stored = userRow.first_verify_date;
  const storedDate = typeof stored === "string" ? stored : new Date(stored).toISOString().slice(0, 10);
  return storedDate === today;
}

/* -------------------- products：分页读取 / 获取 -------------------- */

async function getProductsPage(pageNumber, pageSize) {
  const offset = (pageNumber - 1) * pageSize;
  const client = await pool.connect();
  try {
    const countResult = await client.query(`SELECT COUNT(*)::int AS count FROM products`);
    const totalCount = countResult.rows[0] ? countResult.rows[0].count : 0;

    const listResult = await client.query(
      `
      SELECT id, keyword, content_type, content_data
      FROM products
      ORDER BY keyword ASC
      LIMIT $1 OFFSET $2
      `,
      [pageSize, offset]
    );

    return { totalCount, products: listResult.rows };
  } finally {
    client.release();
  }
}

async function getProductByKeyword(keyword) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      SELECT id, keyword, content_type, content_data
      FROM products
      WHERE keyword = $1
      `,
      [keyword]
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

/* -------------------- 成功领取次数：users.click_count -------------------- */

async function incrementSuccessClaimCount(userId) {
  const userRow = await getUserRow(userId);
  const current = userRow && Number.isFinite(userRow.click_count) ? userRow.click_count : 0;
  const next = current + 1;
  await updateUserFields(userId, { click_count: next });
  return next;
}

/* -------------------- 键盘 -------------------- */

function buildStartKeyboard() {
  const keyboard = new InlineKeyboard();
  keyboard.text("🎁 兑换（免费）", "go_dh:1");
  return keyboard;
}

function buildDhKeyboard(products, pageNumber, totalPages, showVipButton) {
  const keyboard = new InlineKeyboard();

  for (let i = 0; i < products.length; i += 1) {
    keyboard.text(`📌 ${products[i].keyword}`, `dh_get:${products[i].keyword}`);
    if (i % 2 === 1) keyboard.row();
  }

  keyboard.row();
  if (pageNumber > 1) keyboard.text("⬅️ 上一页", `go_dh:${pageNumber - 1}`);
  keyboard.text(`📄 ${pageNumber} / ${totalPages}`, "noop");
  if (pageNumber < totalPages) keyboard.text("下一页 ➡️", `go_dh:${pageNumber + 1}`);

  if (showVipButton) {
    keyboard.row();
    keyboard.text("💎 加入会员（新春特价）", "go_vip");
  }

  return keyboard;
}

function buildGoVerifyKeyboard(type) {
  const keyboard = new InlineKeyboard();
  if (type === "y") {
    keyboard.text("🧩 去首次验证", "go_y");
  } else {
    keyboard.text("🧩 去二次认证", "go_yz");
  }
  keyboard.row();
  keyboard.text("⬅️ 返回兑换页", "go_dh:1");
  return keyboard;
}

function buildBackToDhKeyboard() {
  const keyboard = new InlineKeyboard();
  keyboard.text("🎁 返回兑换页", "go_dh:1");
  return keyboard;
}

/* -------------------- 延迟删除：记录与清理（serverless 兼容） -------------------- */

async function setLastSentMessagesForAutoDelete(userId, chatId, messageIdList, createdAtMillis) {
  await setUserState(userId, "idle", {
    auto_delete: {
      chat_id: chatId,
      message_ids: messageIdList,
      created_at_millis: createdAtMillis
    }
  });
}

async function tryAutoDeleteIfExpired(ctx) {
  const from = ctx.from;
  if (!from) return;

  const stateRow = await getUserStateRow(from.id);
  if (!stateRow || !stateRow.temp_data) return;

  let tempData;
  try {
    tempData = JSON.parse(stateRow.temp_data);
  } catch (e) {
    return;
  }

  if (!tempData || !tempData.auto_delete) return;

  const autoDelete = tempData.auto_delete;
  if (!autoDelete.chat_id || !Array.isArray(autoDelete.message_ids) || !autoDelete.created_at_millis) return;

  const nowMillis = Date.now();
  const expireMillis = Number(autoDelete.created_at_millis) + 5 * 60 * 1000;

  if (nowMillis < expireMillis) {
    return;
  }

  const chatId = Number(autoDelete.chat_id);
  const messageIds = autoDelete.message_ids.map((value) => Number(value)).filter((value) => Number.isFinite(value));

  for (const messageId of messageIds) {
    try {
      await bot.api.deleteMessage(chatId, messageId);
    } catch (e) {
      /* 删除失败不影响后续 */
    }
  }

  await clearUserState(from.id);
}

/* -------------------- /start 与深层链接 start=dh -------------------- */

bot.command("start", async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);

  const args = ctx.match ? String(ctx.match).trim() : "";
  if (args === "dh") {
    await showDhPage(ctx, 1);
    return;
  }

  const text =
    "🎊 喜迎二月除夕 🎊\n\n" +
    "🆓 全部资源免费观看\n" +
    "👇 点击【兑换】选择编号即可观看\n" +
    "✨ 祝你观看愉快～";

  await ctx.reply(text, { reply_markup: buildStartKeyboard() });
});

/* -------------------- /dh 命令入口 -------------------- */

bot.command("dh", async (ctx) => {
  await showDhPage(ctx, 1);
});

/* -------------------- /cz：管理员重置自己前端状态（不重置商品库/后台/数据库数据） -------------------- */

bot.command("cz", async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  if (!isAdminUserId(from.id)) {
    await ctx.reply("❌ 无权限。");
    return;
  }

  await ensureUserExists(from.id, from.username, from.first_name);

  await updateUserFields(from.id, {
    first_verify_passed: false,
    second_verify_passed: false,
    first_verify_date: null,
    first_verify_time: null,
    click_count: 0,
    reject_count_first: 0,
    reject_count_second: 0,
    needs_manual_review: false
  });

  await clearUserState(from.id);

  await ctx.reply("✅ 测试重置完成：你当前已恢复为全新前端状态（不影响商品库与后台数据）。");
});

/* -------------------- /c：只取消管理员自己的流程状态 -------------------- */

bot.command("c", async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  if (!isAdminUserId(from.id)) {
    await ctx.reply("❌ 无权限。");
    return;
  }

  await clearUserState(from.id);
  await ctx.reply("✅ 已取消你当前的后台流程状态。");
});

/* -------------------- /y 与 /yz（这里只保留入口，具体图片上传逻辑你现有的可继续用） -------------------- */

bot.command("y", async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);

  const text =
    "🧩【首次验证】\n\n" +
    "✅ 上传一张图片即可完成\n" +
    "📤 请上传图片开始验证：";

  await ctx.replyWithPhoto(FILE_ID_Y_1, { caption: text });
  await ctx.replyWithPhoto(FILE_ID_Y_2, { caption: "📷 示例图" });

  await setUserState(from.id, "waiting_first_verify_photo", {});
});

bot.command("yz", async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);

  const text =
    "🧩【二次认证】\n\n" +
    "✅ 通过后将不再出现\n" +
    "📤 请上传图片开始二次认证：";

  await ctx.replyWithPhoto(FILE_ID_YZ_1, { caption: text });
  await ctx.replyWithPhoto(FILE_ID_YZ_2, { caption: "📷 示例图" });
  await ctx.replyWithPhoto(FILE_ID_YZ_3, { caption: "📷 示例图" });

  await setUserState(from.id, "waiting_second_verify_photo", {});
});

bot.callbackQuery("go_y", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("请发送 /y 开始首次验证。");
});

bot.callbackQuery("go_yz", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("请发送 /yz 开始二次认证。");
});

/* -------------------- /dh 页面显示 -------------------- */

bot.callbackQuery(/^go_dh:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showDhPage(ctx, Number(ctx.match[1]));
});

async function showDhPage(ctx, pageNumber) {
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);

  await tryAutoDeleteIfExpired(ctx);

  const userRow = await getUserRow(from.id);
  if (userRow && userRow.is_banned) {
    await ctx.reply("⛔ 你已被本活动封禁。");
    return;
  }

  const pageSize = 10;
  const result = await getProductsPage(pageNumber, pageSize);
  const totalPages = Math.max(1, Math.ceil(result.totalCount / pageSize));
  const dailyVerified = await isDailyFirstVerifyValid(userRow);

  const text =
    "🎁 兑换页\n\n" +
    "✅ 点击商品编号即可查看内容\n" +
    "🆓 完全免费，直接观看\n" +
    "⏳ 内容可能分批发送，请稍等～";

  await ctx.reply(text, {
    reply_markup: buildDhKeyboard(result.products, pageNumber, totalPages, dailyVerified)
  });
}

/* -------------------- 发送商品：兼容 media_group + data 字段，并且防超时 -------------------- */

function parseContentDataToArray(contentDataText) {
  if (!contentDataText) return null;
  try {
    const parsed = JSON.parse(contentDataText);
    if (Array.isArray(parsed)) return parsed;
    return null;
  } catch (e) {
    return null;
  }
}

function normalizeItem(item) {
  if (!item || typeof item !== "object") return null;

  const type = String(item.type || "").toLowerCase();

  if (type === "text") {
    return { type: "text", text: String(item.text || "") };
  }

  if (type === "photo" || type === "video" || type === "document") {
    const fileId = item.file_id || item.fileId || item.data || item.file || item.id;
    if (!fileId) return null;
    return { type: type, file_id: String(fileId) };
  }

  return null;
}

async function sendProductContentCompatibleWithProgress(ctx, productRow) {
  const contentType = String(productRow.content_type || "").toLowerCase();
  const itemsArray = parseContentDataToArray(productRow.content_data);

  const createdMessageIds = [];

  const sendingMessage = await ctx.reply("📦 正在发送中，请稍等…");
  if (sendingMessage && sendingMessage.message_id) {
    createdMessageIds.push(sendingMessage.message_id);
  }

  if (contentType === "media_group" && Array.isArray(itemsArray)) {
    const normalized = itemsArray.map(normalizeItem).filter((value) => value);

    const textOnly = normalized.filter((value) => value.type === "text");
    const mediaOnly = normalized.filter((value) => value.type === "photo" || value.type === "video");

    for (const textItem of textOnly) {
      const text = String(textItem.text || "").trim();
      if (text.length > 0) {
        const sent = await ctx.reply(text);
        if (sent && sent.message_id) createdMessageIds.push(sent.message_id);
        await sleepMilliseconds(150);
      }
    }

    const chunkSize = 10;
    for (let i = 0; i < mediaOnly.length; i += chunkSize) {
      const chunk = mediaOnly.slice(i, i + chunkSize);

      const mediaGroup = [];
      for (const mediaItem of chunk) {
        if (mediaItem.type === "photo") {
          mediaGroup.push(InputMediaBuilder.photo(mediaItem.file_id));
        } else if (mediaItem.type === "video") {
          mediaGroup.push(InputMediaBuilder.video(mediaItem.file_id));
        }
      }

      if (mediaGroup.length > 0) {
        const sentList = await ctx.replyWithMediaGroup(mediaGroup);
        if (Array.isArray(sentList)) {
          for (const sent of sentList) {
            if (sent && sent.message_id) createdMessageIds.push(sent.message_id);
          }
        }
        await sleepMilliseconds(300);
      }
    }

    const finished = await ctx.reply("✅ 发送完毕！5 分钟后自动清理本次内容，你可以再次免费获取。", {
      reply_markup: buildBackToDhKeyboard()
    });
    if (finished && finished.message_id) createdMessageIds.push(finished.message_id);

    return createdMessageIds;
  }

  if (Array.isArray(itemsArray)) {
    const normalized = itemsArray.map(normalizeItem).filter((value) => value);

    const chunkSize = 10;
    for (let i = 0; i < normalized.length; i += chunkSize) {
      const chunk = normalized.slice(i, i + chunkSize);

      for (const item of chunk) {
        if (item.type === "text") {
          const sent = await ctx.reply(item.text);
          if (sent && sent.message_id) createdMessageIds.push(sent.message_id);
        } else if (item.type === "photo") {
          const sent = await ctx.replyWithPhoto(item.file_id);
          if (sent && sent.message_id) createdMessageIds.push(sent.message_id);
        } else if (item.type === "video") {
          const sent = await ctx.replyWithVideo(item.file_id);
          if (sent && sent.message_id) createdMessageIds.push(sent.message_id);
        } else if (item.type === "document") {
          const sent = await ctx.replyWithDocument(item.file_id);
          if (sent && sent.message_id) createdMessageIds.push(sent.message_id);
        }
        await sleepMilliseconds(150);
      }

      await sleepMilliseconds(250);
    }

    const finished = await ctx.reply("✅ 发送完毕！5 分钟后自动清理本次内容，你可以再次免费获取。", {
      reply_markup: buildBackToDhKeyboard()
    });
    if (finished && finished.message_id) createdMessageIds.push(finished.message_id);

    return createdMessageIds;
  }

  const fallbackText = String(productRow.content_data || "");
  const sentFallback = await ctx.reply(fallbackText);
  if (sentFallback && sentFallback.message_id) createdMessageIds.push(sentFallback.message_id);

  const finished = await ctx.reply("✅ 发送完毕！5 分钟后自动清理本次内容，你可以再次免费获取。", {
    reply_markup: buildBackToDhKeyboard()
  });
  if (finished && finished.message_id) createdMessageIds.push(finished.message_id);

  return createdMessageIds;
}

/* -------------------- dh_get：严重修复“发送一半死机” -------------------- */

bot.callbackQuery(/^dh_get:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "📦 正在发送…", show_alert: false });

  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);

  await tryAutoDeleteIfExpired(ctx);

  const userRow = await getUserRow(from.id);
  if (userRow && userRow.is_banned) {
    await ctx.reply("⛔ 你已被本活动封禁。");
    return;
  }

  const keyword = String(ctx.match[1]).trim();
  const product = await getProductByKeyword(keyword);
  if (!product) {
    await ctx.reply("❌ 未找到该编号内容。", { reply_markup: buildBackToDhKeyboard() });
    return;
  }

  const currentSuccessClaimCount = userRow && Number.isFinite(userRow.click_count) ? userRow.click_count : 0;
  const nextClaimOrdinal = currentSuccessClaimCount + 1;

  const dailyVerified = await isDailyFirstVerifyValid(userRow);
  const secondVerifyPassed = Boolean(userRow && userRow.second_verify_passed);

  const rejectCountFirst = userRow && Number.isFinite(userRow.reject_count_first) ? userRow.reject_count_first : 0;
  const needsManualReview = Boolean(userRow && userRow.needs_manual_review);

  if (needsManualReview && rejectCountFirst >= 3) {
    await ctx.reply("🕒 错误次数过多，请等待管理员审核通过后再继续兑换。", { reply_markup: buildBackToDhKeyboard() });
    return;
  }

  if (nextClaimOrdinal >= 4 && !secondVerifyPassed) {
    await ctx.reply("🧩 继续观看前，请先完成一次二次认证：发送 /yz", { reply_markup: buildGoVerifyKeyboard("yz") });
    return;
  }

  if (nextClaimOrdinal >= 2 && !dailyVerified) {
    await ctx.reply("🧩 今日需要完成一次首次验证：发送 /y", { reply_markup: buildGoVerifyKeyboard("y") });
    return;
  }

  /* 关键修复：
     - 发送内容拆批 + 延迟
     - 发送完成提示
     - 记录 message_id，5 分钟后清理（下次交互触发）
  */
  const messageIdList = await sendProductContentCompatibleWithProgress(ctx, product);

  await incrementSuccessClaimCount(from.id);

  await setLastSentMessagesForAutoDelete(from.id, ctx.chat.id, messageIdList, Date.now());
});

/* -------------------- noop -------------------- */

bot.callbackQuery("noop", async (ctx) => {
  await ctx.answerCallbackQuery();
});

/* -------------------- 错误处理 -------------------- */

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error("GrammyError:", e.description);
  } else if (e instanceof HttpError) {
    console.error("HttpError:", e);
  } else {
    console.error("Unknown error:", e);
  }
});

/* -------------------- 导出给 Vercel -------------------- */

module.exports = webhookCallback(bot, "http");
