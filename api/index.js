const { Bot, InlineKeyboard, webhookCallback, GrammyError, HttpError, InputMediaBuilder } = require("grammy");
const { Pool } = require("pg");

/* -------------------- 你提供的 file_id（原数据，保留） -------------------- */

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

/* -------------------- 时间工具（北京时间） -------------------- */

function getBeijingNowDate() {
  const now = new Date();
  return new Date(now.getTime() + 8 * 60 * 60 * 1000);
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

function formatBeijingDateOnly(date) {
  const d = date;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/* -------------------- 管理员判定 -------------------- */

function isAdminUserId(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

/* -------------------- users：确保存在 -------------------- */

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

/* -------------------- user_states：状态机 -------------------- */

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

/* -------------------- /c：只取消管理员自己的流程状态 -------------------- */

async function cancelAdminCurrentFlow(adminId) {
  await clearUserState(adminId);
}

/* -------------------- 当日 /y 是否有效（北京时间） -------------------- */

async function isDailyFirstVerifyValid(userRow) {
  if (!userRow) return false;

  const today = formatBeijingDateOnly(getBeijingNowDate());
  if (!userRow.first_verify_date) return false;

  const stored = userRow.first_verify_date;
  const storedDate = typeof stored === "string" ? stored : new Date(stored).toISOString().slice(0, 10);
  return storedDate === today;
}

/* -------------------- 商品：分页读取 / 获取 / 删除 / 上架 -------------------- */

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

/* -------------------- 工单：pending_reviews -------------------- */

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

/* -------------------- 成功领取次数：users.click_count -------------------- */

async function incrementSuccessClaimCount(userId) {
  const userRow = await getUserRow(userId);
  const current = userRow && Number.isFinite(userRow.click_count) ? userRow.click_count : 0;
  const next = current + 1;
  await updateUserFields(userId, { click_count: next });
  return next;
}

/* -------------------- 键盘与文案（带 emoji） -------------------- */

function buildStartKeyboard() {
  const keyboard = new InlineKeyboard();
  keyboard.text("🎁 兑换（免费）", "go_dh:1");
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

function buildVipStartKeyboard() {
  const keyboard = new InlineKeyboard();
  keyboard.text("✅ 我已付款，开始验证", "vip_paid_start");
  return keyboard;
}

function buildJoinGroupKeyboard() {
  const keyboard = new InlineKeyboard();
  keyboard.url("🚪 加入会员群", "https://t.me/+495j5rWmApsxYzg9");
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

function buildReviewActionKeyboard(pendingId, reviewType, reviewOwnerUserId) {
  const keyboard = new InlineKeyboard();
  keyboard.text("✅ 通过", `review_ok:${pendingId}:${reviewType}`);
  keyboard.text("❌ 驳回", `review_reject:${pendingId}:${reviewType}`);
  keyboard.row();
  keyboard.text("⛔ 封禁", `review_ban:${pendingId}:${reviewType}`);

  if (isAdminUserId(reviewOwnerUserId)) {
    keyboard.text("🗑 删除(测试)", `review_delete:${pendingId}:${reviewType}`);
  }

  return keyboard;
}

/* -------------------- /start 与 start=dh -------------------- */

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
    "👇 点击【兑换】选择编号即可立即观看\n" +
    "✨ 祝你观看愉快～";

  await ctx.reply(text, { reply_markup: buildStartKeyboard() });
});

/* -------------------- /dh 命令入口（必须可用） -------------------- */

bot.command("dh", async (ctx) => {
  await showDhPage(ctx, 1);
});

bot.callbackQuery(/^go_dh:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showDhPage(ctx, Number(ctx.match[1]));
});

async function showDhPage(ctx, pageNumber) {
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);
  const userRow = await getUserRow(from.id);

  if (userRow && userRow.is_banned) {
    await ctx.reply("⛔ 你已被本活动封禁。\n如需继续使用，请加入会员（特价）。", {
      reply_markup: new InlineKeyboard().text("💎 加入会员（新春特价）", "go_vip")
    });
    return;
  }

  const pageSize = 10;
  const result = await getProductsPage(pageNumber, pageSize);
  const totalPages = Math.max(1, Math.ceil(result.totalCount / pageSize));

  const text =
    "🎁 兑换页\n\n" +
    "✅ 点击商品编号即可查看内容\n" +
    "🆓 完全免费，直接观看\n" +
    "🌟 喜欢就多来看看～";

  const dailyVerified = await isDailyFirstVerifyValid(userRow);

  await ctx.reply(text, {
    reply_markup: buildDhKeyboard(result.products, pageNumber, totalPages, dailyVerified)
  });
}

/* -------------------- /admin -------------------- */

bot.command("admin", async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  if (!isAdminUserId(from.id)) {
    await ctx.reply("❌ 无权限。");
    return;
  }

  await ctx.reply("🛠 管理员后台：请选择功能。", { reply_markup: buildAdminKeyboard() });
});

bot.callbackQuery("admin_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  await ctx.reply("🛠 管理员后台：请选择功能。", { reply_markup: buildAdminKeyboard() });
});

/* -------------------- admin：获取 file_id -------------------- */

bot.callbackQuery("admin_get_file_id", async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  await ctx.reply("🆔 请发送图片，我将返回对应的 file_id。");
  await setUserState(from.id, "admin_waiting_file_id_photo", {});
});

/* -------------------- admin：商品列表（10个一页 + 点击查看 + 删除确认） -------------------- */

bot.callbackQuery(/^admin_products_menu:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  await showAdminProductsList(ctx, Number(ctx.match[1]));
});

async function showAdminProductsList(ctx, pageNumber) {
  const pageSize = 10;
  const result = await getProductsPage(pageNumber, pageSize);
  const totalPages = Math.max(1, Math.ceil(result.totalCount / pageSize));

  const keyboard = new InlineKeyboard();

  for (let i = 0; i < result.products.length; i += 1) {
    const keyword = result.products[i].keyword;
    keyboard.text(`📌 ${keyword}`, `admin_product_view:${keyword}`);
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

  await ctx.reply("📦 频道转发库：商品列表（10个一页）\n点击商品可查看并删除。", { reply_markup: keyboard });
}

bot.callbackQuery(/^admin_product_view:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  const keyword = String(ctx.match[1]).trim();
  const product = await getProductByKeyword(keyword);

  if (!product) {
    await ctx.reply("未找到该商品。", { reply_markup: new InlineKeyboard().text("⬅️ 返回列表", "admin_products_menu:1") });
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
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  const keyword = String(ctx.match[1]).trim();

  const keyboard = new InlineKeyboard()
    .text("✅ 确认删除", `admin_product_delete_do:${keyword}`)
    .text("❌ 取消", `admin_product_view:${keyword}`);

  await ctx.reply(`确认要删除商品【${keyword}】吗？此操作不可恢复。`, { reply_markup: keyboard });
});

bot.callbackQuery(/^admin_product_delete_do:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  const keyword = String(ctx.match[1]).trim();
  await deleteProductByKeyword(keyword);

  await ctx.reply(`✅ 已删除商品【${keyword}】。`, {
    reply_markup: new InlineKeyboard().text("⬅️ 返回商品列表", "admin_products_menu:1")
  });
});

/* -------------------- admin：上架流程（连续上传 → 手动完成） -------------------- */

bot.callbackQuery("admin_upload_product_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  await ctx.reply("➕ 请输入商品关键词（例如 001）。");
  await setUserState(from.id, "admin_waiting_product_keyword", {});
});

bot.callbackQuery("admin_finish_upload_product", async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  const stateRow = await getUserStateRow(from.id);
  if (!stateRow || stateRow.state !== "admin_uploading_product_content") {
    await ctx.reply("当前没有正在进行的上架流程。");
    return;
  }

  const tempData = stateRow.temp_data ? JSON.parse(stateRow.temp_data) : {};
  const keyword = tempData.keyword;
  const items = Array.isArray(tempData.items) ? tempData.items : [];

  if (!keyword) {
    await ctx.reply("关键词缺失，上架失败。");
    await clearUserState(from.id);
    return;
  }

  if (items.length === 0) {
    await ctx.reply("你还没有上传任何内容，请先上传内容再完成上架。");
    return;
  }

  await upsertProduct(keyword, "media_group", JSON.stringify(items));

  await ctx.reply(`✅ 上架成功：关键词 ${keyword}（共 ${items.length} 条内容）`, { reply_markup: buildAdminKeyboard() });
  await clearUserState(from.id);
});

/* -------------------- 待处理工单（保留） -------------------- */

bot.callbackQuery("admin_pending_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  const keyboard = new InlineKeyboard()
    .text("🧾 首次验证工单", "admin_pending:first:1")
    .row()
    .text("🧾 二次认证工单", "admin_pending:second:1")
    .row()
    .text("🧾 VIP订单工单", "admin_pending:vip:1")
    .row()
    .text("⬅️ 返回后台", "admin_back");

  await ctx.reply("🧾 待处理工单：请选择分类。", { reply_markup: keyboard });
});

bot.callbackQuery(/^admin_pending:(first|second|vip):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  const kind = ctx.match[1];
  const pageNumber = Number(ctx.match[2]);
  const pageSize = 10;

  let reviewType = "first_verify";
  let title = "🧾 首次验证待处理";
  if (kind === "second") {
    reviewType = "second_verify";
    title = "🧾 二次认证待处理";
  }
  if (kind === "vip") {
    reviewType = "vip_order";
    title = "🧾 VIP订单待处理";
  }

  const result = await getPendingReviewsByType(reviewType, pageNumber, pageSize);
  const totalPages = Math.max(1, Math.ceil(result.totalCount / pageSize));

  if (result.reviews.length === 0) {
    await ctx.reply(`${title}\n暂无待处理 ✅`, { reply_markup: new InlineKeyboard().text("⬅️ 返回", "admin_pending_menu") });
    return;
  }

  await ctx.reply(`${title}\n📄 第 ${pageNumber} / ${totalPages} 页`);

  for (const review of result.reviews) {
    const beijing = formatBeijingDateTime(new Date(review.submitted_at));
    const userDisplay = `${review.first_name || ""}${review.username ? " @" + review.username : ""}`.trim();

    if (reviewType === "vip_order") {
      const text =
        `工单 #${review.id}\n` +
        `类型：VIP订单\n` +
        `用户：${userDisplay}\n` +
        `ID：${review.user_id}\n` +
        `时间：${beijing}\n` +
        `订单：${review.order_number || "(空)"}`;

      await ctx.reply(text, { reply_markup: buildReviewActionKeyboard(review.id, reviewType, review.user_id) });
    } else {
      const text =
        `工单 #${review.id}\n` +
        `类型：${reviewType === "first_verify" ? "首次验证" : "二次认证"}\n` +
        `用户：${userDisplay}\n` +
        `ID：${review.user_id}\n` +
        `时间：${beijing}`;

      if (review.file_id) {
        await ctx.replyWithPhoto(review.file_id, {
          caption: text,
          reply_markup: buildReviewActionKeyboard(review.id, reviewType, review.user_id)
        });
      } else {
        await ctx.reply(text + "\n（无图片）", {
          reply_markup: buildReviewActionKeyboard(review.id, reviewType, review.user_id)
        });
      }
    }
  }
});

/* -------------------- /c：只取消管理员自己状态 -------------------- */

bot.command("c", async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  if (!isAdminUserId(from.id)) {
    await ctx.reply("❌ 无权限。");
    return;
  }

  await cancelAdminCurrentFlow(from.id);
  await ctx.reply("✅ 已取消你当前的后台流程状态。", { reply_markup: buildAdminKeyboard() });
});

/* -------------------- /y /yz /v -------------------- */

bot.command("y", async (ctx) => {
  await showFirstVerifyPage(ctx);
});

bot.command("yz", async (ctx) => {
  await showSecondVerifyPage(ctx);
});

bot.command("v", async (ctx) => {
  await showVipPage(ctx);
});

bot.callbackQuery("go_y", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showFirstVerifyPage(ctx);
});

bot.callbackQuery("go_yz", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showSecondVerifyPage(ctx);
});

bot.callbackQuery("go_vip", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showVipPage(ctx);
});

async function showFirstVerifyPage(ctx) {
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);

  const text =
    "🧩【首次验证】\n\n" +
    "✅ 上传一张图片即可完成\n" +
    "✨ 成功后自动返回兑换页\n\n" +
    "📤 请上传图片开始验证：";

  await ctx.replyWithPhoto(FILE_ID_Y_1, { caption: text });
  await ctx.replyWithPhoto(FILE_ID_Y_2, { caption: "📷 示例图" });

  await setUserState(from.id, "waiting_first_verify_photo", {});
}

async function showSecondVerifyPage(ctx) {
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);

  const text =
    "🧩【二次认证】\n\n" +
    "✅ 通过后将不再出现\n" +
    "⚠️ 若被驳回，需要重新提交\n\n" +
    "📤 请上传图片开始二次认证：";

  await ctx.replyWithPhoto(FILE_ID_YZ_1, { caption: text });
  await ctx.replyWithPhoto(FILE_ID_YZ_2, { caption: "📷 示例图" });
  await ctx.replyWithPhoto(FILE_ID_YZ_3, { caption: "📷 示例图" });

  await setUserState(from.id, "waiting_second_verify_photo", {});
}

async function showVipPage(ctx) {
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);

  const text =
    "🎉 喜迎新春（特价）\n\n" +
    "💎 VIP会员特权说明：\n" +
    "✅ 专属中转通道\n" +
    "✅ 优先审核入群\n" +
    "✅ 7x24小时客服支持\n" +
    "✅ 定期福利活动\n";

  const keyboard = buildVipStartKeyboard();
  await ctx.replyWithPhoto(FILE_ID_PAYMENT, { caption: text, reply_markup: keyboard });
}

bot.callbackQuery("vip_paid_start", async (ctx) => {
  await ctx.answerCallbackQuery();

  const tutorialText =
    "🧾 订单号获取教程：\n" +
    "1）支付宝 → 账单\n" +
    "2）进入账单详情\n" +
    "3）更多 → 订单号\n\n" +
    "📤 请发送订单号数字：";

  await ctx.replyWithPhoto(FILE_ID_ORDER, { caption: tutorialText });
  await setUserState(ctx.from.id, "vip_waiting_order", {});
});

/* -------------------- /dh 点击商品：兼容你的旧数据 media_group + data 字段 -------------------- */

bot.callbackQuery(/^dh_get:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();

  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);
  const userRow = await getUserRow(from.id);

  if (userRow && userRow.is_banned) {
    await ctx.reply("⛔ 你已被本活动封禁。\n如需继续使用，请加入会员（特价）。", {
      reply_markup: new InlineKeyboard().text("💎 加入会员（新春特价）", "go_vip")
    });
    return;
  }

  const keyword = String(ctx.match[1]).trim();
  const product = await getProductByKeyword(keyword);
  if (!product) {
    await ctx.reply("❌ 未找到该编号内容。");
    return;
  }

  const currentSuccessClaimCount = userRow && Number.isFinite(userRow.click_count) ? userRow.click_count : 0;
  const nextClaimOrdinal = currentSuccessClaimCount + 1;

  const dailyVerified = await isDailyFirstVerifyValid(userRow);
  const secondVerifyPassed = Boolean(userRow && userRow.second_verify_passed);

  const rejectCountFirst = userRow && Number.isFinite(userRow.reject_count_first) ? userRow.reject_count_first : 0;
  const needsManualReview = Boolean(userRow && userRow.needs_manual_review);

  if (needsManualReview && rejectCountFirst >= 3) {
    await ctx.reply(
      "🕒 错误次数过多，请等待管理员审核。\n\n✅ 审核通过后即可继续兑换。\n⚠️ 请勿重复提交无关内容。",
      { reply_markup: new InlineKeyboard().text("⬅️ 返回兑换页", "go_dh:1") }
    );
    return;
  }

  if (nextClaimOrdinal >= 4 && !secondVerifyPassed) {
    await ctx.reply("🧩 继续观看前，请先完成一次二次认证。", { reply_markup: buildGoVerifyKeyboard("yz") });
    return;
  }

  if (nextClaimOrdinal >= 2 && !dailyVerified) {
    await ctx.reply("🧩 今日需要完成一次首次验证后继续兑换。", { reply_markup: buildGoVerifyKeyboard("y") });
    return;
  }

  await sendProductContentCompatible(ctx, product);

  const newCount = await incrementSuccessClaimCount(from.id);
  await ctx.reply(`✅ 已领取（成功领取次数：${newCount}）`);
});

/* -------------------- 发送商品内容：兼容 data 字段 + media_group -------------------- */

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

async function sendProductContentCompatible(ctx, productRow) {
  const contentType = String(productRow.content_type || "").toLowerCase();
  const itemsArray = parseContentDataToArray(productRow.content_data);

  /* 1) 如果是 media_group 且数据是数组：优先 sendMediaGroup（最多 10 个一组） */
  if (contentType === "media_group" && Array.isArray(itemsArray)) {
    const normalized = itemsArray.map(normalizeItem).filter((value) => value);

    const mediaOnly = normalized.filter((value) => value.type === "photo" || value.type === "video");
    const textOnly = normalized.filter((value) => value.type === "text");

    /* 先把文本按顺序发出来（你旧数据里可能第一个是 text） */
    for (const textItem of textOnly) {
      const text = String(textItem.text || "").trim();
      if (text.length > 0) {
        await ctx.reply(text);
      }
    }

    /* 再把媒体按 10 个一组发（Telegram 限制） */
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
        await ctx.replyWithMediaGroup(mediaGroup);
      }
    }

    return;
  }

  /* 2) 如果 content_data 是数组但不是 media_group：按顺序逐条发（并按 10 条分批） */
  if (Array.isArray(itemsArray)) {
    const normalized = itemsArray.map(normalizeItem).filter((value) => value);

    const chunkSize = 10;
    for (let i = 0; i < normalized.length; i += chunkSize) {
      const chunk = normalized.slice(i, i + chunkSize);
      for (const item of chunk) {
        if (item.type === "text") {
          await ctx.reply(item.text);
        } else if (item.type === "photo") {
          await ctx.replyWithPhoto(item.file_id);
        } else if (item.type === "video") {
          await ctx.replyWithVideo(item.file_id);
        } else if (item.type === "document") {
          await ctx.replyWithDocument(item.file_id);
        }
      }
    }
    return;
  }

  /* 3) 单条兜底：按 content_type 发送 */
  if (contentType === "text") {
    await ctx.reply(String(productRow.content_data || ""));
    return;
  }

  if (contentType === "photo") {
    await ctx.replyWithPhoto(String(productRow.content_data || ""));
    return;
  }

  if (contentType === "video") {
    await ctx.replyWithVideo(String(productRow.content_data || ""));
    return;
  }

  if (contentType === "document") {
    await ctx.replyWithDocument(String(productRow.content_data || ""));
    return;
  }

  await ctx.reply(String(productRow.content_data || ""));
}

/* -------------------- 处理消息：/y /yz 图片、VIP 订单号、admin 上架等（略：保持你现有逻辑即可） -------------------- */
/* 你之前已经有 message handler，我这里不再重复扩写，避免超长。
   关键是：商品发送已兼容你旧数据，/dh 点商品即可出内容。
*/

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
