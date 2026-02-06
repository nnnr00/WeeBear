const { Bot, InlineKeyboard, webhookCallback, GrammyError, HttpError, InputMediaBuilder } = require("grammy");
const { Pool } = require("pg");

/* -------------------- 固定 file_id（你给的原数据） -------------------- */

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

function isAdminUserId(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

/* -------------------- 数据库连接（不清库） -------------------- */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* -------------------- Bot 初始化 -------------------- */

const bot = new Bot(process.env.BOT_TOKEN);

/* -------------------- 时间（北京时间） -------------------- */

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

function formatBeijingDateTime(date) {
  const d = date;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  return `${year}.${month}.${day} 北京时间 ${hour}:${minute}`;
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

async function isDailyFirstVerifyValid(userRow) {
  if (!userRow) return false;
  const today = formatBeijingDateOnly(getBeijingNowDate());
  if (!userRow.first_verify_date) return false;
  const stored = userRow.first_verify_date;
  const storedDate = typeof stored === "string" ? stored : new Date(stored).toISOString().slice(0, 10);
  return storedDate === today;
}

/* -------------------- 数据库：user_states（流程 + 当日计数 + 自动删除记录） -------------------- */

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

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function getUserTempDataObject(userId) {
  const stateRow = await getUserStateRow(userId);
  if (!stateRow || !stateRow.temp_data) return {};
  const parsed = safeJsonParse(stateRow.temp_data);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed;
}

async function setUserTempDataObject(userId, tempDataObject) {
  const stateRow = await getUserStateRow(userId);
  const currentState = stateRow && stateRow.state ? String(stateRow.state) : "idle";
  await setUserState(userId, currentState, tempDataObject);
}

/* 当天领取次数：存在 user_states.temp_data.daily */
function getTodayDailyClaimCount(tempDataObject, todayDateText) {
  if (!tempDataObject || typeof tempDataObject !== "object") return 0;
  if (!tempDataObject.daily || typeof tempDataObject.daily !== "object") return 0;
  if (tempDataObject.daily.date !== todayDateText) return 0;
  const value = Number(tempDataObject.daily.claim_count);
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function setTodayDailyClaimCount(tempDataObject, todayDateText, claimCount) {
  const obj = tempDataObject && typeof tempDataObject === "object" ? tempDataObject : {};
  obj.daily = { date: todayDateText, claim_count: claimCount };
  return obj;
}

/* -------------------- pending_reviews（工单） -------------------- */

async function createPendingReview({ userId, username, firstName, reviewType, fileId, orderNumber, messageId }) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      INSERT INTO pending_reviews (user_id, username, first_name, review_type, file_id, order_number, status, message_id)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
      RETURNING id
      `,
      [userId, username || null, firstName || null, reviewType, fileId || null, orderNumber || null, messageId || null]
    );
    return result.rows[0].id;
  } finally {
    client.release();
  }
}

async function updatePendingReviewStatus(pendingId, status) {
  const client = await pool.connect();
  try {
    await client.query(`UPDATE pending_reviews SET status = $1 WHERE id = $2`, [status, pendingId]);
  } finally {
    client.release();
  }
}

async function deletePendingReview(pendingId) {
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM pending_reviews WHERE id = $1`, [pendingId]);
  } finally {
    client.release();
  }
}

async function getPendingReviewsByType(reviewType, pageNumber, pageSize) {
  const offset = (pageNumber - 1) * pageSize;
  const client = await pool.connect();
  try {
    const countResult = await client.query(
      `SELECT COUNT(*)::int AS count FROM pending_reviews WHERE status = 'pending' AND review_type = $1`,
      [reviewType]
    );
    const totalCount = countResult.rows[0] ? countResult.rows[0].count : 0;

    const listResult = await client.query(
      `
      SELECT id, user_id, username, first_name, review_type, file_id, order_number, submitted_at, status, message_id
      FROM pending_reviews
      WHERE status = 'pending' AND review_type = $1
      ORDER BY submitted_at DESC
      LIMIT $2 OFFSET $3
      `,
      [reviewType, pageSize, offset]
    );

    return { totalCount, reviews: listResult.rows };
  } finally {
    client.release();
  }
}

/* -------------------- products（商品读取/管理） -------------------- */

async function getProductsPage(pageNumber, pageSize) {
  const offset = (pageNumber - 1) * pageSize;
  const client = await pool.connect();
  try {
    const countResult = await client.query(`SELECT COUNT(*)::int AS count FROM products`);
    const totalCount = countResult.rows[0] ? countResult.rows[0].count : 0;

    const listResult = await client.query(
      `
      SELECT id, keyword, content_type, content_data, created_at
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
      SELECT id, keyword, content_type, content_data, created_at
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

async function deleteProductByKeyword(keyword) {
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM products WHERE keyword = $1`, [keyword]);
  } finally {
    client.release();
  }
}

async function upsertProduct(keyword, contentType, contentDataText) {
  const client = await pool.connect();
  try {
    await client.query(
      `
      INSERT INTO products (keyword, content_type, content_data)
      VALUES ($1, $2, $3)
      ON CONFLICT (keyword) DO UPDATE SET
        content_type = EXCLUDED.content_type,
        content_data = EXCLUDED.content_data
      `,
      [keyword, contentType, contentDataText]
    );
  } finally {
    client.release();
  }
}

/* -------------------- 5分钟自动删除（serverless：下次交互触发） -------------------- */

async function setLastSentMessagesForAutoDelete(userId, chatId, messageIdList, createdAtMillis) {
  const tempData = await getUserTempDataObject(userId);
  tempData.auto_delete = {
    chat_id: chatId,
    message_ids: messageIdList,
    created_at_millis: createdAtMillis
  };
  await setUserTempDataObject(userId, tempData);
}

async function tryAutoDeleteIfExpired(ctx) {
  if (!ctx.from) return;

  const tempData = await getUserTempDataObject(ctx.from.id);
  if (!tempData.auto_delete) return;

  const autoDelete = tempData.auto_delete;
  if (!autoDelete.chat_id || !Array.isArray(autoDelete.message_ids) || !autoDelete.created_at_millis) return;

  const nowMillis = Date.now();
  const expireMillis = Number(autoDelete.created_at_millis) + 5 * 60 * 1000;
  if (nowMillis < expireMillis) return;

  const chatId = Number(autoDelete.chat_id);
  const messageIds = autoDelete.message_ids.map((value) => Number(value)).filter((value) => Number.isFinite(value));

  for (const messageId of messageIds) {
    try {
      await bot.api.deleteMessage(chatId, messageId);
    } catch (e) {
      /* ignore */
    }
  }

  delete tempData.auto_delete;
  await setUserTempDataObject(ctx.from.id, tempData);
}

/* -------------------- UI：键盘与文案 -------------------- */

function buildStartKeyboard() {
  return new InlineKeyboard().text("🎁 兑换（免费）", "go_dh:1");
}

function buildBackToDhKeyboard() {
  return new InlineKeyboard().text("🎁 返回兑换页", "go_dh:1");
}

function buildVipEntryKeyboard() {
  return new InlineKeyboard().text("💎 加入会员（新春特价）", "go_vip");
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

function buildAdminKeyboard() {
  const keyboard = new InlineKeyboard();
  keyboard.text("🆔 获取 file_id", "admin_get_file_id");
  keyboard.row();
  keyboard.text("📦 频道转发库（商品列表）", "admin_products_menu:1");
  keyboard.row();
  keyboard.text("🧾 待处理工单", "admin_pending_menu");
  keyboard.row();
  keyboard.text("⬅️ 返回", "admin_back");
  return keyboard;
}

function buildAdminProductsListKeyboard(products, pageNumber, totalPages) {
  const keyboard = new InlineKeyboard();

  for (let i = 0; i < products.length; i += 1) {
    keyboard.text(`📌 ${products[i].keyword}`, `admin_product_view:${products[i].keyword}`);
    if (i % 2 === 1) keyboard.row();
  }

  keyboard.row();
  if (pageNumber > 1) keyboard.text("⬅️ 上一页", `admin_products_menu:${pageNumber - 1}`);
  keyboard.text(`📄 ${pageNumber} / ${totalPages}`, "noop");
  if (pageNumber < totalPages) keyboard.text("下一页 ➡️", `admin_products_menu:${pageNumber + 1}`);

  keyboard.row();
  keyboard.text("➕ 上架新商品", "admin_upload_product_start");
  keyboard.row();
  keyboard.text("⬅️ 返回后台", "admin_back");

  return keyboard;
}

function buildPendingMenuKeyboard() {
  const keyboard = new InlineKeyboard();
  keyboard.text("🧩 首次验证处理", "admin_pending:first:1");
  keyboard.row();
  keyboard.text("🧩 二次认证处理", "admin_pending:second:1");
  keyboard.row();
  keyboard.text("💎 VIP订单处理", "admin_pending:vip:1");
  keyboard.row();
  keyboard.text("⬅️ 返回后台", "admin_back");
  return keyboard;
}

function buildReviewActionKeyboard(pendingId, reviewType, reviewOwnerUserId) {
  const keyboard = new InlineKeyboard();
  keyboard.text("✅ 通过", `review_ok:${pendingId}:${reviewType}`);
  keyboard.text("❌ 驳回", `review_reject:${pendingId}:${reviewType}`);
  keyboard.row();
  keyboard.text("⛔ 封禁", `review_ban:${pendingId}:${reviewType}`);
  if (isAdminUserId(reviewOwnerUserId)) {
    keyboard.row();
    keyboard.text("🗑 删除(测试)", `review_delete:${pendingId}:${reviewType}`);
  }
  return keyboard;
}

/* -------------------- /start 与深层链接 start=dh -------------------- */

bot.command("start", async (ctx) => {
  if (!ctx.from) return;

  await ensureUserExists(ctx.from.id, ctx.from.username, ctx.from.first_name);

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

/* -------------------- /dh -------------------- */

bot.command("dh", async (ctx) => {
  await showDhPage(ctx, 1);
});

bot.callbackQuery(/^go_dh:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showDhPage(ctx, Number(ctx.match[1]));
});

async function showDhPage(ctx, pageNumber) {
  if (!ctx.from) return;

  await ensureUserExists(ctx.from.id, ctx.from.username, ctx.from.first_name);

  await tryAutoDeleteIfExpired(ctx);

  const userRow = await getUserRow(ctx.from.id);
  if (userRow && userRow.is_banned) {
    await ctx.reply("⛔ 你已被本活动封禁。\n如需继续使用，请加入会员（特价）。", { reply_markup: buildVipEntryKeyboard() });
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
    "⏳ 内容较多会分批发送，请稍等～";

  await ctx.reply(text, { reply_markup: buildDhKeyboard(result.products, pageNumber, totalPages, dailyVerified) });
}

/* -------------------- /y 与 /yz 页面展示函数（系统触发时直接调用） -------------------- */

async function showFirstVerifyPage(ctx) {
  if (!ctx.from) return;

  await ensureUserExists(ctx.from.id, ctx.from.username, ctx.from.first_name);

  const text =
    "🧩【首次验证】\n\n" +
    "✅ 上传一张图片即可完成\n" +
    "⚠️ 请勿提交无关图片，多次违规将会被封禁\n\n" +
    "📤 请上传图片开始验证：";

  await ctx.replyWithPhoto(FILE_ID_Y_1, { caption: text });
  await ctx.replyWithPhoto(FILE_ID_Y_2, { caption: "📷 示例图（按要求提交截图）" });

  await setUserState(ctx.from.id, "waiting_first_verify_photo", {});
}

async function showSecondVerifyPage(ctx) {
  if (!ctx.from) return;

  await ensureUserExists(ctx.from.id, ctx.from.username, ctx.from.first_name);

  const text =
    "🧩【二次认证】\n\n" +
    "✅ 此认证通过后终身不再出现\n" +
    "⚠️ 若被驳回，需要重新提交正确图片\n\n" +
    "📤 请上传图片开始二次认证：";

  await ctx.replyWithPhoto(FILE_ID_YZ_1, { caption: text });
  await ctx.replyWithPhoto(FILE_ID_YZ_2, { caption: "📷 示例图" });
  await ctx.replyWithPhoto(FILE_ID_YZ_3, { caption: "📷 示例图" });

  await setUserState(ctx.from.id, "waiting_second_verify_photo", {});
}

/* 仍保留命令入口（备用） */
bot.command("y", async (ctx) => {
  await showFirstVerifyPage(ctx);
});
bot.command("yz", async (ctx) => {
  await showSecondVerifyPage(ctx);
});

/* -------------------- /v VIP -------------------- */

async function showVipPage(ctx) {
  if (!ctx.from) return;

  await ensureUserExists(ctx.from.id, ctx.from.username, ctx.from.first_name);

  const text =
    "🎉 喜迎新春（特价）\n\n" +
    "💎 VIP会员特权说明：\n" +
    "✅ 专属中转通道\n" +
    "✅ 优先审核入群\n" +
    "✅ 7x24小时客服支持\n" +
    "✅ 定期福利活动\n\n" +
    "👇 点击下方按钮开始验证：";

  const keyboard = new InlineKeyboard().text("✅ 我已付款，开始验证", "vip_paid_start");
  await ctx.replyWithPhoto(FILE_ID_PAYMENT, { caption: text, reply_markup: keyboard });
}

bot.command("v", async (ctx) => {
  await showVipPage(ctx);
});

bot.callbackQuery("go_vip", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showVipPage(ctx);
});

bot.callbackQuery("vip_paid_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;

  const tutorialText =
    "🧾 订单号获取教程：\n" +
    "1）支付宝 → 账单\n" +
    "2）进入账单详情\n" +
    "3）更多 → 订单号\n\n" +
    "📤 请发送订单号数字：";

  await ctx.replyWithPhoto(FILE_ID_ORDER, { caption: tutorialText });
  await setUserState(ctx.from.id, "vip_waiting_order", {});
});

/* -------------------- /admin -------------------- */

bot.command("admin", async (ctx) => {
  if (!ctx.from) return;

  if (!isAdminUserId(ctx.from.id)) {
    await ctx.reply("❌ 无权限。");
    return;
  }

  await ctx.reply("🛠 管理员后台：请选择功能。", { reply_markup: buildAdminKeyboard() });
});

bot.callbackQuery("admin_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  await ctx.reply("🛠 管理员后台：请选择功能。", { reply_markup: buildAdminKeyboard() });
});

bot.callbackQuery("admin_get_file_id", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  await ctx.reply("🆔 请发送图片，我将返回对应的 file_id。");
  await setUserState(ctx.from.id, "admin_waiting_file_id_photo", {});
});

bot.callbackQuery(/^admin_products_menu:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  const pageNumber = Number(ctx.match[1]);
  const pageSize = 10;

  const result = await getProductsPage(pageNumber, pageSize);
  const totalPages = Math.max(1, Math.ceil(result.totalCount / pageSize));

  await ctx.reply("📦 频道转发库：商品列表（10个一页）", {
    reply_markup: buildAdminProductsListKeyboard(result.products, pageNumber, totalPages)
  });
});

bot.callbackQuery(/^admin_product_view:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  const keyword = String(ctx.match[1]).trim();
  const product = await getProductByKeyword(keyword);

  if (!product) {
    await ctx.reply("未找到该商品。");
    return;
  }

  const info =
    `📌 商品关键词：${product.keyword}\n` +
    `🧾 类型：${product.content_type}\n` +
    `🕒 创建时间：${product.created_at ? String(product.created_at) : "未知"}\n\n` +
    "请选择操作：";

  const keyboard = new InlineKeyboard()
    .text("🗑 删除此商品", `admin_product_delete_confirm:${product.keyword}`)
    .row()
    .text("⬅️ 返回列表", "admin_products_menu:1");

  await ctx.reply(info, { reply_markup: keyboard });
});

bot.callbackQuery(/^admin_product_delete_confirm:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  const keyword = String(ctx.match[1]).trim();

  const keyboard = new InlineKeyboard()
    .text("✅ 确认删除", `admin_product_delete_do:${keyword}`)
    .text("❌ 取消", `admin_product_view:${keyword}`);

  await ctx.reply(`确认删除商品【${keyword}】吗？此操作不可恢复。`, { reply_markup: keyboard });
});

bot.callbackQuery(/^admin_product_delete_do:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  const keyword = String(ctx.match[1]).trim();
  await deleteProductByKeyword(keyword);

  await ctx.reply(`✅ 已删除商品【${keyword}】。`, { reply_markup: new InlineKeyboard().text("⬅️ 返回商品列表", "admin_products_menu:1") });
});

bot.callbackQuery("admin_upload_product_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  await ctx.reply("➕ 请输入商品关键词（例如 001）。");
  await setUserState(ctx.from.id, "admin_waiting_product_keyword", {});
});

bot.callbackQuery("admin_finish_upload_product", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  const stateRow = await getUserStateRow(ctx.from.id);
  if (!stateRow || stateRow.state !== "admin_uploading_product_content") {
    await ctx.reply("当前没有正在进行的上架流程。");
    return;
  }

  const tempData = safeJsonParse(stateRow.temp_data) || {};
  const keyword = tempData.keyword;
  const items = Array.isArray(tempData.items) ? tempData.items : [];

  if (!keyword) {
    await ctx.reply("关键词缺失，上架失败。");
    await clearUserState(ctx.from.id);
    return;
  }
  if (items.length === 0) {
    await ctx.reply("你还没有上传任何内容，请先上传内容再完成上架。");
    return;
  }

  await upsertProduct(keyword, "media_group", JSON.stringify(items));
  await ctx.reply(`✅ 上架成功：关键词 ${keyword}（共 ${items.length} 条）`, { reply_markup: buildAdminKeyboard() });
  await clearUserState(ctx.from.id);
});

bot.callbackQuery("admin_pending_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  await ctx.reply("🧾 待处理工单：请选择分类。", { reply_markup: buildPendingMenuKeyboard() });
});

bot.callbackQuery(/^admin_pending:(first|second|vip):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  const kind = ctx.match[1];
  const pageNumber = Number(ctx.match[2]);
  const pageSize = 10;

  let reviewType = "first_verify";
  let title = "🧩 首次验证待处理";
  if (kind === "second") {
    reviewType = "second_verify";
    title = "🧩 二次认证待处理";
  }
  if (kind === "vip") {
    reviewType = "vip_order";
    title = "💎 VIP订单待处理";
  }

  const result = await getPendingReviewsByType(reviewType, pageNumber, pageSize);
  const totalPages = Math.max(1, Math.ceil(result.totalCount / pageSize));

  await ctx.reply(`${title}\n📄 第 ${pageNumber} / ${totalPages} 页`);

  if (result.reviews.length === 0) {
    await ctx.reply("暂无待处理 ✅", { reply_markup: buildPendingMenuKeyboard() });
    return;
  }

  for (const review of result.reviews) {
    const when = formatBeijingDateTime(new Date(review.submitted_at));
    const userDisplay = `${review.first_name || ""}${review.username ? " @" + review.username : ""}`.trim();

    if (reviewType === "vip_order") {
      const text =
        `工单 #${review.id}\n` +
        `类型：VIP订单\n` +
        `用户：${userDisplay}\n` +
        `ID：${review.user_id}\n` +
        `时间：${when}\n` +
        `订单：${review.order_number || "(空)"}`;

      await ctx.reply(text, { reply_markup: buildReviewActionKeyboard(review.id, reviewType, review.user_id) });
    } else {
      const caption =
        `工单 #${review.id}\n` +
        `类型：${reviewType === "first_verify" ? "首次验证" : "二次认证"}\n` +
        `用户：${userDisplay}\n` +
        `ID：${review.user_id}\n` +
        `时间：${when}`;

      if (review.file_id) {
        await ctx.replyWithPhoto(review.file_id, { caption: caption, reply_markup: buildReviewActionKeyboard(review.id, reviewType, review.user_id) });
      } else {
        await ctx.reply(caption, { reply_markup: buildReviewActionKeyboard(review.id, reviewType, review.user_id) });
      }
    }
  }
});

/* -------------------- /c（仅管理员取消自己流程状态） -------------------- */

bot.command("c", async (ctx) => {
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) {
    await ctx.reply("❌ 无权限。");
    return;
  }
  await clearUserState(ctx.from.id);
  await ctx.reply("✅ 已取消你当前的后台流程状态。");
});

/* -------------------- /cz（仅管理员重置自己前端状态，不清库） -------------------- */

bot.command("cz", async (ctx) => {
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) {
    await ctx.reply("❌ 无权限。");
    return;
  }

  await ensureUserExists(ctx.from.id, ctx.from.username, ctx.from.first_name);

  await updateUserFields(ctx.from.id, {
    first_verify_passed: false,
    second_verify_passed: false,
    first_verify_date: null,
    first_verify_time: null,
    reject_count_first: 0,
    reject_count_second: 0,
    needs_manual_review: false,
    click_count: 0
  });

  const tempData = await getUserTempDataObject(ctx.from.id);
  delete tempData.daily;
  delete tempData.auto_delete;
  await setUserTempDataObject(ctx.from.id, tempData);

  await clearUserState(ctx.from.id);

  await ctx.reply("✅ 测试重置完成：你已恢复为全新前端状态（不影响商品库与后台数据）。");
});

/* -------------------- 审核驳回：强制跳转 /y /yz + 文本（美化） -------------------- */

function buildRejectTextAndAction(reviewType) {
  const text =
    "❌ 审核未通过\n\n" +
    "请重新上传正确的示例图片再试 ✅\n" +
    "⚠️ 请勿上传无关图片或重复无效图片，多次违规将会被封禁。\n\n" +
    "📤 已为你重新打开验证页面，请直接上传图片：";

  if (reviewType === "first_verify") {
    return { text: text, target: "y" };
  }
  if (reviewType === "second_verify") {
    return { text: text, target: "yz" };
  }
  return { text: text, target: null };
}

bot.callbackQuery(/^review_ok:(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  const pendingId = Number(ctx.match[1]);
  const reviewType = String(ctx.match[2]);

  await updatePendingReviewStatus(pendingId, "approved");

  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT * FROM pending_reviews WHERE id = $1`, [pendingId]);
    const review = result.rows[0];
    if (review) {
      if (reviewType === "first_verify") {
        await updateUserFields(review.user_id, { needs_manual_review: false });
      }
      if (reviewType === "second_verify") {
        await updateUserFields(review.user_id, { second_verify_passed: true });
      }
      if (reviewType === "vip_order") {
        await updateUserFields(review.user_id, { is_vip: true });
      }
    }
  } finally {
    client.release();
  }

  await ctx.reply(`✅ 已通过工单 #${pendingId}`);
});

bot.callbackQuery(/^review_reject:(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  const pendingId = Number(ctx.match[1]);
  const reviewType = String(ctx.match[2]);

  await updatePendingReviewStatus(pendingId, "rejected");

  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT * FROM pending_reviews WHERE id = $1`, [pendingId]);
    const review = result.rows[0];
    if (!review) {
      await ctx.reply("工单不存在。");
      return;
    }

    if (reviewType === "first_verify") {
      const userRow = await getUserRow(review.user_id);
      const currentReject = userRow && Number.isFinite(userRow.reject_count_first) ? userRow.reject_count_first : 0;
      const nextReject = currentReject + 1;

      const needsManualReview = nextReject >= 3;

      await updateUserFields(review.user_id, {
        reject_count_first: nextReject,
        needs_manual_review: needsManualReview
      });

      const rejectInfo = buildRejectTextAndAction("first_verify");
      await bot.api.sendMessage(review.user_id, rejectInfo.text);
      await bot.api.sendMessage(review.user_id, "🧩 正在为你打开【首次验证】页面…");
      await bot.api.sendPhoto(review.user_id, FILE_ID_Y_1, {
        caption:
          "🧩【首次验证】\n\n" +
          "✅ 上传一张图片即可完成\n" +
          "📤 请直接上传图片："
      });
      await bot.api.sendPhoto(review.user_id, FILE_ID_Y_2, { caption: "📷 示例图" });

      await setUserState(review.user_id, "waiting_first_verify_photo", {});
    }

    if (reviewType === "second_verify") {
      const userRow = await getUserRow(review.user_id);
      const currentReject = userRow && Number.isFinite(userRow.reject_count_second) ? userRow.reject_count_second : 0;
      const nextReject = currentReject + 1;

      await updateUserFields(review.user_id, {
        reject_count_second: nextReject,
        second_verify_passed: false
      });

      const rejectInfo = buildRejectTextAndAction("second_verify");
      await bot.api.sendMessage(review.user_id, rejectInfo.text);
      await bot.api.sendMessage(review.user_id, "🧩 正在为你打开【二次认证】页面…");
      await bot.api.sendPhoto(review.user_id, FILE_ID_YZ_1, {
        caption:
          "🧩【二次认证】\n\n" +
          "✅ 通过后将不再出现\n" +
          "📤 请直接上传图片："
      });
      await bot.api.sendPhoto(review.user_id, FILE_ID_YZ_2, { caption: "📷 示例图" });
      await bot.api.sendPhoto(review.user_id, FILE_ID_YZ_3, { caption: "📷 示例图" });

      await setUserState(review.user_id, "waiting_second_verify_photo", {});
    }

    if (reviewType === "vip_order") {
      await bot.api.sendMessage(review.user_id, "❌ 订单未通过审核，请返回重新提交：发送 /v");
    }
  } finally {
    client.release();
  }

  await ctx.reply(`已驳回工单 #${pendingId}（并已强制引导用户重新验证）`);
});

bot.callbackQuery(/^review_ban:(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  const pendingId = Number(ctx.match[1]);

  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT * FROM pending_reviews WHERE id = $1`, [pendingId]);
    const review = result.rows[0];
    if (!review) {
      await ctx.reply("工单不存在。");
      return;
    }

    await updateUserFields(review.user_id, { is_banned: true });
    await updatePendingReviewStatus(pendingId, "approved");

    await bot.api.sendMessage(
      review.user_id,
      "⛔ 你已因多次提交无效内容被本活动封禁。\n\n如需继续使用，请前往加入会员（特价）：发送 /v"
    );
  } finally {
    client.release();
  }

  await ctx.reply(`⛔ 已封禁用户并处理工单 #${pendingId}`);
});

bot.callbackQuery(/^review_delete:(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (!isAdminUserId(ctx.from.id)) return;

  const pendingId = Number(ctx.match[1]);

  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT * FROM pending_reviews WHERE id = $1`, [pendingId]);
    const review = result.rows[0];
    if (!review) {
      await ctx.reply("工单不存在。");
      return;
    }

    if (!isAdminUserId(review.user_id)) {
      await ctx.reply("仅允许删除你自己测试产生的工单。");
      return;
    }

    await deletePendingReview(pendingId);
  } finally {
    client.release();
  }

  await ctx.reply(`🗑 已删除测试工单 #${pendingId}`);
});

/* -------------------- 商品内容解析：兼容 media_group + data 字段 -------------------- */

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

async function sendProductContentWithSafeBatches(ctx, productRow) {
  const messageIdList = [];

  const progress = await ctx.reply("📦 正在发送中，请稍等…");
  if (progress && progress.message_id) messageIdList.push(progress.message_id);

  const contentType = String(productRow.content_type || "").toLowerCase();
  const itemsArray = parseContentDataToArray(productRow.content_data);

  if (contentType === "media_group" && Array.isArray(itemsArray)) {
    const normalized = itemsArray.map(normalizeItem).filter((value) => value);

    const textItems = normalized.filter((v) => v.type === "text");
    const mediaItems = normalized.filter((v) => v.type === "photo" || v.type === "video");

    for (const textItem of textItems) {
      const text = String(textItem.text || "").trim();
      if (text.length > 0) {
        const sent = await ctx.reply(text);
        if (sent && sent.message_id) messageIdList.push(sent.message_id);
        await sleepMilliseconds(150);
      }
    }

    const chunkSize = 10;
    for (let i = 0; i < mediaItems.length; i += chunkSize) {
      const chunk = mediaItems.slice(i, i + chunkSize);

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
            if (sent && sent.message_id) messageIdList.push(sent.message_id);
          }
        }
      }

      await sleepMilliseconds(300);
    }

    const finished = await ctx.reply(
      "✅ 发送完毕！\n🕒 5 分钟后自动清理本次内容，你可以重新免费获取。",
      { reply_markup: buildBackToDhKeyboard() }
    );
    if (finished && finished.message_id) messageIdList.push(finished.message_id);

    return messageIdList;
  }

  if (Array.isArray(itemsArray)) {
    const normalized = itemsArray.map(normalizeItem).filter((value) => value);

    const chunkSize = 10;
    for (let i = 0; i < normalized.length; i += chunkSize) {
      const chunk = normalized.slice(i, i + chunkSize);

      for (const item of chunk) {
        if (item.type === "text") {
          const sent = await ctx.reply(item.text);
          if (sent && sent.message_id) messageIdList.push(sent.message_id);
        } else if (item.type === "photo") {
          const sent = await ctx.replyWithPhoto(item.file_id);
          if (sent && sent.message_id) messageIdList.push(sent.message_id);
        } else if (item.type === "video") {
          const sent = await ctx.replyWithVideo(item.file_id);
          if (sent && sent.message_id) messageIdList.push(sent.message_id);
        } else if (item.type === "document") {
          const sent = await ctx.replyWithDocument(item.file_id);
          if (sent && sent.message_id) messageIdList.push(sent.message_id);
        }
        await sleepMilliseconds(150);
      }

      await sleepMilliseconds(250);
    }

    const finished = await ctx.reply(
      "✅ 发送完毕！\n🕒 5 分钟后自动清理本次内容，你可以重新免费获取。",
      { reply_markup: buildBackToDhKeyboard() }
    );
    if (finished && finished.message_id) messageIdList.push(finished.message_id);

    return messageIdList;
  }

  const sentFallback = await ctx.reply(String(productRow.content_data || ""));
  if (sentFallback && sentFallback.message_id) messageIdList.push(sentFallback.message_id);

  const finished = await ctx.reply(
    "✅ 发送完毕！\n🕒 5 分钟后自动清理本次内容，你可以重新免费获取。",
    { reply_markup: buildBackToDhKeyboard() }
  );
  if (finished && finished.message_id) messageIdList.push(finished.message_id);

  return messageIdList;
}

/* -------------------- /dh 点击商品：每日计数 + 自动跳 /y + 第5次跳 /yz -------------------- */

bot.callbackQuery(/^dh_get:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "📦 正在处理…", show_alert: false });

  if (!ctx.from) return;

  await ensureUserExists(ctx.from.id, ctx.from.username, ctx.from.first_name);
  await tryAutoDeleteIfExpired(ctx);

  const userRow = await getUserRow(ctx.from.id);

  if (userRow && userRow.is_banned) {
    await ctx.reply("⛔ 你已被本活动封禁。\n如需继续使用，请加入会员（特价）。", { reply_markup: buildVipEntryKeyboard() });
    return;
  }

  const keyword = String(ctx.match[1]).trim();
  const product = await getProductByKeyword(keyword);

  if (!product) {
    await ctx.reply("❌ 未找到该编号内容。", { reply_markup: buildBackToDhKeyboard() });
    return;
  }

  const today = formatBeijingDateOnly(getBeijingNowDate());

  const tempData = await getUserTempDataObject(ctx.from.id);
  const todayClaimCount = getTodayDailyClaimCount(tempData, today);
  const nextTodayOrdinal = todayClaimCount + 1;

  const dailyVerified = await isDailyFirstVerifyValid(userRow);
  const secondVerifyPassed = Boolean(userRow && userRow.second_verify_passed);

  const rejectCountFirst = userRow && Number.isFinite(userRow.reject_count_first) ? userRow.reject_count_first : 0;
  const needsManualReview = Boolean(userRow && userRow.needs_manual_review);

  if (needsManualReview && rejectCountFirst >= 3) {
    await ctx.reply(
      "🕒 错误次数过多，请等待管理员审核通过后再继续兑换。\n\n⚠️ 请勿重复提交无关内容，以免被封禁。",
      { reply_markup: buildBackToDhKeyboard() }
    );
    return;
  }

  /* 第5次触发 /yz（终身一次，除非驳回） */
  if (nextTodayOrdinal >= 5 && !secondVerifyPassed) {
    await ctx.reply("🧩 需要完成二次认证后继续观看，正在为你打开二次认证页…");
    await showSecondVerifyPage(ctx);
    return;
  }

  /* 每天 /y：当天第2次触发（当日未验证才触发） */
  if (nextTodayOrdinal >= 2 && !dailyVerified) {
    await ctx.reply("🧩 今日需要完成一次首次验证，正在为你打开验证页…");
    await showFirstVerifyPage(ctx);
    return;
  }

  /* 发放商品内容 */
  let messageIdList = [];
  try {
    messageIdList = await sendProductContentWithSafeBatches(ctx, product);
  } catch (e) {
    await ctx.reply("❌ 发送失败，请稍后重试。", { reply_markup: buildBackToDhKeyboard() });
    return;
  }

  /* 更新当天领取次数（仅在成功发送后） */
  const updatedTempData = setTodayDailyClaimCount(tempData, today, nextTodayOrdinal);
  await setUserTempDataObject(ctx.from.id, updatedTempData);

  /* 记录本次消息用于5分钟后删除 */
  if (ctx.chat && ctx.chat.id && Array.isArray(messageIdList) && messageIdList.length > 0) {
    await setLastSentMessagesForAutoDelete(ctx.from.id, ctx.chat.id, messageIdList, Date.now());
  }
});

/* -------------------- message：处理上传图片（/y /yz）与后台上架、file_id、VIP订单 -------------------- */

async function sendAdminReviewTicketForPhoto(reviewType, user, fileId) {
  const beijingTime = formatBeijingDateTime(getBeijingNowDate());
  const caption =
    (reviewType === "first_verify" ? "🧩 首次验证工单" : "🧩 二次认证工单") +
    "\n\n" +
    `用户：${user.first_name || ""}${user.username ? " @" + user.username : ""}\n` +
    `ID：${user.id}\n` +
    `时间：${beijingTime}`;

  for (const adminId of ADMIN_IDS) {
    const sent = await bot.api.sendPhoto(adminId, fileId, { caption: caption });

    const pendingId = await createPendingReview({
      userId: user.id,
      username: user.username,
      firstName: user.first_name,
      reviewType: reviewType,
      fileId: fileId,
      orderNumber: null,
      messageId: sent && sent.message_id ? sent.message_id : null
    });

    await bot.api.sendMessage(adminId, `工单操作：#${pendingId}`, {
      reply_markup: buildReviewActionKeyboard(pendingId, reviewType, user.id)
    });
  }
}

function extractPureContentFromMessage(message) {
  if (!message) return null;

  if (message.text) {
    return { type: "text", text: String(message.text) };
  }

  if (message.photo && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    return { type: "photo", data: photo.file_id };
  }

  if (message.video && message.video.file_id) {
    return { type: "video", data: message.video.file_id };
  }

  if (message.document && message.document.file_id) {
    return { type: "document", data: message.document.file_id };
  }

  return null;
}

bot.on("message", async (ctx) => {
  if (!ctx.from) return;

  await ensureUserExists(ctx.from.id, ctx.from.username, ctx.from.first_name);
  await tryAutoDeleteIfExpired(ctx);

  const stateRow = await getUserStateRow(ctx.from.id);
  const currentState = stateRow ? String(stateRow.state) : "idle";

  /* admin 获取 file_id */
  if (currentState === "admin_waiting_file_id_photo") {
    if (ctx.message.photo && ctx.message.photo.length > 0) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      await ctx.reply(`🆔 file_id：\n${photo.file_id}`, { reply_markup: buildAdminKeyboard() });
      await clearUserState(ctx.from.id);
      return;
    }
    await ctx.reply("❌ 请发送图片。");
    return;
  }

  /* admin 上架等待关键词 */
  if (currentState === "admin_waiting_product_keyword") {
    if (!isAdminUserId(ctx.from.id)) {
      await ctx.reply("❌ 无权限。");
      await clearUserState(ctx.from.id);
      return;
    }

    const keyword = ctx.message.text ? String(ctx.message.text).trim() : "";
    if (!keyword) {
      await ctx.reply("❌ 请输入有效关键词（例如 001）。");
      return;
    }

    await setUserState(ctx.from.id, "admin_uploading_product_content", { keyword: keyword, items: [] });

    const keyboard = new InlineKeyboard()
      .text("✅ 完成上架", "admin_finish_upload_product")
      .row()
      .text("⬅️ 返回商品列表", "admin_products_menu:1");

    await ctx.reply(`✅ 已设置关键词：${keyword}\n📤 请开始连续上传内容，完成后点【完成上架】。`, { reply_markup: keyboard });
    return;
  }

  /* admin 上架持续收内容 */
  if (currentState === "admin_uploading_product_content") {
    if (!isAdminUserId(ctx.from.id)) {
      await ctx.reply("❌ 无权限。");
      await clearUserState(ctx.from.id);
      return;
    }

    const tempData = safeJsonParse(stateRow.temp_data) || {};
    const keyword = tempData.keyword;
    const items = Array.isArray(tempData.items) ? tempData.items : [];

    const captured = extractPureContentFromMessage(ctx.message);
    if (!captured) {
      await ctx.reply("❌ 暂不支持该内容类型，请发送文本/图片/视频/文件。");
      return;
    }

    items.push(captured);
    await setUserState(ctx.from.id, "admin_uploading_product_content", { keyword: keyword, items: items });
    await ctx.reply(`📦 已加入队列：当前共 ${items.length} 条内容。继续上传或点击【完成上架】。`);
    return;
  }

  /* VIP：等待订单号 */
  if (currentState === "vip_waiting_order") {
    const text = ctx.message.text ? String(ctx.message.text).trim() : "";
    const digits = text.replace(/\s+/g, "");

    if (!/^\d+$/.test(digits)) {
      await ctx.reply("❌ 未识别成功，请仅发送数字订单号。");
      return;
    }

    if (!digits.startsWith("20260")) {
      await ctx.reply("❌ 未识别成功，请检查后重新发送订单号。");
      return;
    }

    await ctx.reply("✅ 订单已提交验证。", {
      reply_markup: new InlineKeyboard().url("🚪 加入会员群", "https://t.me/+495j5rWmApsxYzg9")
    });

    for (const adminId of ADMIN_IDS) {
      const beijingTime = formatBeijingDateTime(getBeijingNowDate());
      const adminText =
        "💎 VIP订单提交\n\n" +
        `用户：${ctx.from.first_name || ""}${ctx.from.username ? " @" + ctx.from.username : ""}\n` +
        `ID：${ctx.from.id}\n` +
        `时间：${beijingTime}\n` +
        `订单：${digits}`;

      await bot.api.sendMessage(adminId, adminText);
    }

    await createPendingReview({
      userId: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      reviewType: "vip_order",
      fileId: null,
      orderNumber: digits,
      messageId: null
    });

    await clearUserState(ctx.from.id);
    return;
  }

  /* /y：等待图片（图片即通过） */
  if (currentState === "waiting_first_verify_photo") {
    if (!ctx.message.photo || ctx.message.photo.length === 0) {
      await ctx.reply("❌ 请上传图片完成首次验证。");
      return;
    }

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const today = formatBeijingDateOnly(getBeijingNowDate());

    await updateUserFields(ctx.from.id, {
      first_verify_passed: true,
      first_verify_date: today,
      first_verify_time: new Date()
    });

    await ctx.reply("✅ 首次验证完成！🎉");
    await ctx.reply("🎁 正在为你返回兑换页…");
    await showDhPage(ctx, 1);

    await ctx.reply("💎 你也可以选择加入会员获得更稳定体验：", { reply_markup: buildVipEntryKeyboard() });

    await sendAdminReviewTicketForPhoto("first_verify", ctx.from, photo.file_id);

    await clearUserState(ctx.from.id);
    return;
  }

  /* /yz：等待图片（图片即通过） */
  if (currentState === "waiting_second_verify_photo") {
    if (!ctx.message.photo || ctx.message.photo.length === 0) {
      await ctx.reply("❌ 请上传图片完成二次认证。");
      return;
    }

    const photo = ctx.message.photo[ctx.message.photo.length - 1];

    await updateUserFields(ctx.from.id, { second_verify_passed: true });

    await ctx.reply("✅ 二次认证完成！🎉");
    await ctx.reply("🎁 正在为你返回兑换页…");
    await showDhPage(ctx, 1);

    await sendAdminReviewTicketForPhoto("second_verify", ctx.from, photo.file_id);

    await clearUserState(ctx.from.id);
    return;
  }
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
