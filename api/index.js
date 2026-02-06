const { Bot, InlineKeyboard, webhookCallback, GrammyError, HttpError } = require("grammy");
const { Pool } = require("pg");

/* -------------------- 固定配置：你提供的 file_id（原数据） -------------------- */

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

/* -------------------- 工具函数：时间（北京时间）与每日重置 -------------------- */

function getBeijingNowDate() {
  const now = new Date();
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return beijingTime;
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

/* -------------------- 工具函数：管理员判定 -------------------- */

function isAdminUserId(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

/* -------------------- 数据库：初始化用户（不覆盖旧数据） -------------------- */

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

/* -------------------- user_states：用于流程状态机 -------------------- */

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

/* -------------------- /c：强制取消所有用户正在验证状态 -------------------- */

async function clearAllUserStates() {
  const client = await pool.connect();
  try {
    await client.query(`UPDATE user_states SET state = 'idle', temp_data = NULL, updated_at = NOW()`);
  } finally {
    client.release();
  }
}

/* -------------------- 产品（商品）读取与分页 -------------------- */

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

    return {
      totalCount,
      products: listResult.rows
    };
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

/* -------------------- 频道转发库上架：保存（覆盖） -------------------- */

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

/* -------------------- 待处理工单：写入与查询 -------------------- */

async function createPendingReview({
  userId,
  username,
  firstName,
  reviewType,
  fileId,
  orderNumber,
  messageId
}) {
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

    return {
      totalCount,
      reviews: listResult.rows
    };
  } finally {
    client.release();
  }
}

/* -------------------- 核心规则：当日 /y 是否有效 -------------------- */

async function isDailyFirstVerifyValid(userRow) {
  if (!userRow) return false;
  const beijingNow = getBeijingNowDate();
  const today = formatBeijingDateOnly(beijingNow);

  if (!userRow.first_verify_date) return false;

  const stored = userRow.first_verify_date;
  const storedDate = typeof stored === "string" ? stored : new Date(stored).toISOString().slice(0, 10);
  return storedDate === today;
}

/* -------------------- /dh 成功领取次数计数 -------------------- */

async function incrementSuccessClaimCount(userId) {
  const userRow = await getUserRow(userId);
  const current = userRow && Number.isFinite(userRow.click_count) ? userRow.click_count : 0;
  const next = current + 1;
  await updateUserFields(userId, { click_count: next });
  return next;
}

/* -------------------- 文案与按钮 -------------------- */

function buildStartKeyboard() {
  const keyboard = new InlineKeyboard();
  keyboard.text("兑换", "go_dh:1");
  return keyboard;
}

function buildAdminKeyboard() {
  const keyboard = new InlineKeyboard();
  keyboard.text("获取 file_id", "admin_get_file_id");
  keyboard.row();
  keyboard.text("频道转发库（上架）", "admin_upload_product");
  keyboard.row();
  keyboard.text("待处理", "admin_pending_menu");
  keyboard.row();
  keyboard.text("返回", "admin_back");
  return keyboard;
}

function buildDhKeyboard(products, pageNumber, totalPages) {
  const keyboard = new InlineKeyboard();

  for (let i = 0; i < products.length; i++) {
    keyboard.text(products[i].keyword, `dh_get:${products[i].keyword}`);
    if (i % 2 === 1) keyboard.row();
  }
  keyboard.row();

  if (pageNumber > 1) keyboard.text("上一页", `go_dh:${pageNumber - 1}`);
  keyboard.text(`第 ${pageNumber} / ${totalPages} 页`, "noop");
  if (pageNumber < totalPages) keyboard.text("下一页", `go_dh:${pageNumber + 1}`);

  return keyboard;
}

function buildJoinVipKeyboard() {
  const keyboard = new InlineKeyboard();
  keyboard.text("加入会员（新春特价）", "go_vip");
  return keyboard;
}

function buildYPassedBackKeyboard() {
  const keyboard = new InlineKeyboard();
  keyboard.text("返回兑换页", "go_dh:1");
  return keyboard;
}

function buildVipStartKeyboard() {
  const keyboard = new InlineKeyboard();
  keyboard.text("✅ 我已付款，开始验证", "vip_paid_start");
  return keyboard;
}

function buildJoinGroupKeyboard() {
  const keyboard = new InlineKeyboard();
  keyboard.url("加入会员群", "https://t.me/+495j5rWmApsxYzg9");
  return keyboard;
}

function buildReviewActionKeyboard(pendingId, reviewType, reviewOwnerUserId) {
  const keyboard = new InlineKeyboard();
  keyboard.text("✅ 通过", `review_ok:${pendingId}:${reviewType}`);
  keyboard.text("❌ 驳回", `review_reject:${pendingId}:${reviewType}`);
  keyboard.row();
  keyboard.text("⛔ 封禁", `review_ban:${pendingId}:${reviewType}`);

  if (isAdminUserId(reviewOwnerUserId)) {
    keyboard.text("🗑 删除", `review_delete:${pendingId}:${reviewType}`);
  }
  return keyboard;
}

/* -------------------- /start 与深层链接 -------------------- */

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
    "喜迎二月除夕\n\n" +
    "所有资源限时免费观看。\n" +
    "打开【兑换】，点击对应编号即可立即观看。\n";

  await ctx.reply(text, { reply_markup: buildStartKeyboard() });
});

/* -------------------- /dh 页面显示函数 -------------------- */

async function showDhPage(ctx, pageNumber) {
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);
  const userRow = await getUserRow(from.id);

  if (userRow && userRow.is_banned) {
    await ctx.reply(
      "你已被本活动封禁。\n如需继续使用，请前往加入会员（特价）。",
      { reply_markup: buildJoinVipKeyboard() }
    );
    return;
  }

  const pageSize = 10;
  const result = await getProductsPage(pageNumber, pageSize);
  const totalPages = Math.max(1, Math.ceil(result.totalCount / pageSize));

  const text =
    "兑换页说明：\n" +
    "点击下方对应编号按钮，即可立即免费观看。\n" +
    "（内容为纯图片/视频/文件/文本，不展示任何来源信息）\n";

  const keyboard = buildDhKeyboard(result.products, pageNumber, totalPages);

  const dailyVerified = await isDailyFirstVerifyValid(userRow);
  if (dailyVerified) {
    keyboard.row();
    keyboard.text("加入会员（新春特价）", "go_vip");
  }

  await ctx.reply(text, { reply_markup: keyboard });
}

/* -------------------- /dh 跳转按钮 -------------------- */

bot.callbackQuery(/^go_dh:(\d+)$/, async (ctx) => {
  const pageNumber = Number(ctx.match[1]);
  await ctx.answerCallbackQuery();
  await showDhPage(ctx, pageNumber);
});

/* -------------------- /v（隐藏 VIP） -------------------- */

bot.command("v", async (ctx) => {
  await showVipPage(ctx);
});

bot.callbackQuery("go_vip", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showVipPage(ctx);
});

async function showVipPage(ctx) {
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);

  const text =
    "喜迎新春（特价）\n\n" +
    "💎 VIP会员特权说明：\n" +
    "✅ 专属中转通道\n" +
    "✅ 优先审核入群\n" +
    "✅ 7x24小时客服支持\n" +
    "✅ 定期福利活动\n";

  await ctx.replyWithPhoto(FILE_ID_PAYMENT, {
    caption: text,
    reply_markup: buildVipStartKeyboard()
  });
}

/* -------------------- VIP：我已付款 → 教程图与输入订单号 -------------------- */

bot.callbackQuery("vip_paid_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);

  const tutorialText =
    "订单号获取教程：\n" +
    "1）打开支付宝，进入【账单】\n" +
    "2）找到本次付款对应记录，点击进入【账单详情】\n" +
    "3）在详情页找到【更多】（或右上角更多选项）\n" +
    "4）在更多信息中找到【订单号】\n" +
    "5）长按复制订单号（仅复制数字）\n\n" +
    "请直接发送订单号数字：";

  await ctx.replyWithPhoto(FILE_ID_ORDER, { caption: tutorialText });

  await setUserState(from.id, "vip_waiting_order", {});
});

/* -------------------- /admin 后台 -------------------- */

bot.command("admin", async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  if (!isAdminUserId(from.id)) {
    await ctx.reply("无权限。");
    return;
  }

  await ctx.reply("管理员后台：请选择功能。", { reply_markup: buildAdminKeyboard() });
});

bot.callbackQuery("admin_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  await ctx.reply("管理员后台：请选择功能。", { reply_markup: buildAdminKeyboard() });
});

/* -------------------- admin：获取 file_id -------------------- */

bot.callbackQuery("admin_get_file_id", async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  await ctx.reply("请发送图片，我将返回对应的 file_id。");
  await setUserState(from.id, "admin_waiting_file_id_photo", {});
});

/* -------------------- admin：频道转发库上架（关键词 → 连续上传 → 手动完成） -------------------- */

bot.callbackQuery("admin_upload_product", async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  await ctx.reply("请输入商品关键词（例如 001）。");
  await setUserState(from.id, "admin_waiting_product_keyword", {});
});

/* -------------------- admin：待处理菜单 -------------------- */

bot.callbackQuery("admin_pending_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  const keyboard = new InlineKeyboard()
    .text("首次验证处理", "admin_pending:first:1")
    .row()
    .text("二次验证处理", "admin_pending:second:1")
    .row()
    .text("VIP订单处理", "admin_pending:vip:1")
    .row()
    .text("返回后台", "admin_back");

  await ctx.reply("待处理队列：请选择分类。", { reply_markup: keyboard });
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
  let title = "首次验证待处理";
  if (kind === "second") {
    reviewType = "second_verify";
    title = "二次验证待处理";
  }
  if (kind === "vip") {
    reviewType = "vip_order";
    title = "VIP订单待处理";
  }

  const result = await getPendingReviewsByType(reviewType, pageNumber, pageSize);
  const totalPages = Math.max(1, Math.ceil(result.totalCount / pageSize));

  if (result.reviews.length === 0) {
    await ctx.reply(`${title}：暂无待处理。`, { reply_markup: new InlineKeyboard().text("返回", "admin_pending_menu") });
    return;
  }

  await ctx.reply(`${title}（第 ${pageNumber} / ${totalPages} 页）：`);

  for (const review of result.reviews) {
    const beijing = formatBeijingDateTime(new Date(review.submitted_at));
    const userDisplay = `${review.first_name || ""}${review.username ? " @" + review.username : ""}`.trim();

    if (reviewType === "vip_order") {
      const text =
        `VIP订单工单 #${review.id}\n` +
        `用户：${userDisplay}\n` +
        `ID：${review.user_id}\n` +
        `时间：${beijing}\n` +
        `订单：${review.order_number || "(空)"}`;

      await ctx.reply(text, {
        reply_markup: buildReviewActionKeyboard(review.id, reviewType, review.user_id)
      });
    } else {
      const text =
        `审核工单 #${review.id}\n` +
        `类型：${reviewType === "first_verify" ? "首次验证" : "二次验证"}\n` +
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

  const navKeyboard = new InlineKeyboard();
  if (pageNumber > 1) navKeyboard.text("上一页", `admin_pending:${kind}:${pageNumber - 1}`);
  navKeyboard.text(`第 ${pageNumber} / ${totalPages} 页`, "noop");
  if (pageNumber < totalPages) navKeyboard.text("下一页", `admin_pending:${kind}:${pageNumber + 1}`);
  navKeyboard.row();
  navKeyboard.text("返回分类", "admin_pending_menu");

  await ctx.reply("翻页：", { reply_markup: navKeyboard });
});

/* -------------------- /c：强制取消所有正在验证状态 -------------------- */

bot.command("c", async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  if (!isAdminUserId(from.id)) {
    await ctx.reply("无权限。");
    return;
  }

  await clearAllUserStates();
  await ctx.reply("已强制取消所有用户正在进行的验证/上架流程状态。");
});

/* -------------------- /cz：重置管理员自己的前台状态（测试用，不动商品库） -------------------- */

bot.command("cz", async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  if (!isAdminUserId(from.id)) {
    await ctx.reply("无权限。");
    return;
  }

  await ensureUserExists(from.id, from.username, from.first_name);

  await clearUserState(from.id);

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

  await ctx.reply("测试模式：已重置你自己的前台验证与领取计数。现在你将以全新用户状态测试。");
});

/* -------------------- /y 与 /yz 命令入口 -------------------- */

bot.command("y", async (ctx) => {
  await showFirstVerifyPage(ctx);
});

bot.command("yz", async (ctx) => {
  await showSecondVerifyPage(ctx);
});

async function showFirstVerifyPage(ctx) {
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);
  const userRow = await getUserRow(from.id);

  if (userRow && userRow.is_banned) {
    await ctx.reply("你已被封禁，如需继续使用请加入会员。", { reply_markup: buildJoinVipKeyboard() });
    return;
  }

  const text =
    "【首次验证】\n\n" +
    "无套路，提交后将自动通过并进入兑换。\n" +
    "请勿作弊，提交无效内容多次将会被封禁。\n\n" +
    "教程：打开支付宝扫一扫 → 点击完成助力 → 上传截图。\n" +
    "截图需清晰包含：时间信息与完成提示文字。\n\n" +
    "请上传图片开始验证：";

  await ctx.replyWithPhoto(FILE_ID_Y_1, { caption: text });
  await ctx.replyWithPhoto(FILE_ID_Y_2, { caption: "示例图（请按要求提交清晰截图）" });

  await setUserState(from.id, "waiting_first_verify_photo", {});
}

async function showSecondVerifyPage(ctx) {
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);
  const userRow = await getUserRow(from.id);

  if (userRow && userRow.is_banned) {
    await ctx.reply("你已被封禁，如需继续使用请加入会员。", { reply_markup: buildJoinVipKeyboard() });
    return;
  }

  const text =
    "【二次认证】\n\n" +
    "此认证仅需完成一次，通过后无需再次认证。\n" +
    "请勿提交无关内容，避免影响使用。\n\n" +
    "说明：扫码进入支付宝页面 → 找到凑分相关页面 → 截图当前页面并提交。\n\n" +
    "请上传图片开始认证：";

  await ctx.replyWithPhoto(FILE_ID_YZ_1, { caption: text });
  await ctx.replyWithPhoto(FILE_ID_YZ_2, { caption: "示例图（按指引提交截图）" });
  await ctx.replyWithPhoto(FILE_ID_YZ_3, { caption: "示例图（按指引提交截图）" });

  await setUserState(from.id, "waiting_second_verify_photo", {});
}

/* -------------------- /dh：点击商品按钮 → 核心拦截逻辑 -------------------- */

bot.callbackQuery(/^dh_get:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);
  const userRow = await getUserRow(from.id);

  if (userRow && userRow.is_banned) {
    await ctx.reply("你已被本活动封禁，如需继续使用请加入会员（特价）。", {
      reply_markup: buildJoinVipKeyboard()
    });
    return;
  }

  const keyword = String(ctx.match[1]).trim();
  const product = await getProductByKeyword(keyword);
  if (!product) {
    await ctx.reply("未找到该编号内容。");
    return;
  }

  const currentDailyVerified = await isDailyFirstVerifyValid(userRow);

  const successClaimCount = userRow && Number.isFinite(userRow.click_count) ? userRow.click_count : 0;
  const nextClaimOrdinal = successClaimCount + 1;

  const secondVerifyPassed = Boolean(userRow && userRow.second_verify_passed);
  const needsManualReview = Boolean(userRow && userRow.needs_manual_review);

  /* 规则 1：第 2 次开始，如果当天未完成 /y，则必须去 /y */
  if (nextClaimOrdinal >= 2 && !currentDailyVerified) {
    await ctx.reply("今日需要完成一次首次验证后才可继续兑换。", { reply_markup: new InlineKeyboard().text("去首次验证", "go_y") });
    return;
  }

  /* 规则 2：/y 驳回两次后，需要管理员手动审核通过才放行 */
  if (needsManualReview) {
    await ctx.reply(
      "当前需要管理员审核确认后才能继续兑换。\n请耐心等待审核结果，避免重复提交无效内容。\n\n若多次提交错误内容，可能会被封禁。",
      { reply_markup: new InlineKeyboard().text("返回兑换页", "go_dh:1") }
    );
    return;
  }

  /* 规则 3：第 4 次开始触发 /yz（若未终身通过） */
  if (nextClaimOrdinal >= 4 && !secondVerifyPassed) {
    await ctx.reply("需要完成一次二次认证后才可继续兑换。", { reply_markup: new InlineKeyboard().text("去二次认证", "go_yz") });
    return;
  }

  /* 满足条件：正式发放商品内容，并将成功领取次数 +1 */
  const newCount = await incrementSuccessClaimCount(from.id);

  await sendProductContentPure(ctx, product);

  const userRowAfter = await getUserRow(from.id);
  const dailyVerifiedAfter = await isDailyFirstVerifyValid(userRowAfter);

  if (dailyVerifiedAfter) {
    await ctx.reply("已为你开启兑换权限。你也可以加入会员获取更稳定的体验。", { reply_markup: buildJoinVipKeyboard() });
  }

  await ctx.reply(`领取成功（累计领取次数：${newCount}）`);
});

/* -------------------- /y /yz 跳转按钮 -------------------- */

bot.callbackQuery("go_y", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showFirstVerifyPage(ctx);
});

bot.callbackQuery("go_yz", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showSecondVerifyPage(ctx);
});

/* -------------------- 商品内容发送：纯内容化 + 10 条一组 -------------------- */

/*
  content_type 与 content_data 的存储格式：
  - 你数据库里已有历史数据，我无法知道你以前如何存。
  - 这里采用一种兼容策略：
    1）若 content_data 是 JSON 且解析为数组：视为多条消息资源列表
    2）否则视为单条（文本或单 file_id）
  你历史数据如果不是此格式，告诉我你旧格式，我再改到完全兼容。
*/
async function sendProductContentPure(ctx, productRow) {
  const contentType = String(productRow.content_type || "").toLowerCase();
  const raw = productRow.content_data;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = null;
  }

  const items = Array.isArray(parsed) ? parsed : null;

  if (!items) {
    if (contentType === "text") {
      await ctx.reply(String(raw));
      return;
    }

    if (contentType === "photo") {
      await ctx.replyWithPhoto(String(raw));
      return;
    }

    if (contentType === "video") {
      await ctx.replyWithVideo(String(raw));
      return;
    }

    if (contentType === "document") {
      await ctx.replyWithDocument(String(raw));
      return;
    }

    await ctx.reply(String(raw));
    return;
  }

  const chunkSize = 10;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);

    for (const item of chunk) {
      if (!item || typeof item !== "object") {
        await ctx.reply(String(item));
        continue;
      }

      const itemType = String(item.type || "").toLowerCase();

      if (itemType === "text") {
        await ctx.reply(String(item.text || ""));
        continue;
      }

      if (itemType === "photo") {
        await ctx.replyWithPhoto(String(item.file_id || item.fileId || ""));
        continue;
      }

      if (itemType === "video") {
        await ctx.replyWithVideo(String(item.file_id || item.fileId || ""));
        continue;
      }

      if (itemType === "document") {
        await ctx.replyWithDocument(String(item.file_id || item.fileId || ""));
        continue;
      }

      await ctx.reply(String(item.text || ""));
    }
  }
}

/* -------------------- 管理员审核按钮处理 -------------------- */

bot.callbackQuery(/^review_ok:(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  const pendingId = Number(ctx.match[1]);
  const reviewType = String(ctx.match[2]);

  await updatePendingReviewStatus(pendingId, "approved");

  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT * FROM pending_reviews WHERE id = $1`, [pendingId]);
    const review = result.rows[0];
    if (review) {
      if (reviewType === "first_verify") {
        await updateUserFields(review.user_id, {
          needs_manual_review: false
        });
      }
      if (reviewType === "second_verify") {
        await updateUserFields(review.user_id, {
          second_verify_passed: true,
          needs_manual_review: false
        });
      }
    }
  } finally {
    client.release();
  }

  await ctx.reply(`已通过工单 #${pendingId}。`);
});

bot.callbackQuery(/^review_reject:(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

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

      const setManual = nextReject >= 2;

      await updateUserFields(review.user_id, {
        reject_count_first: nextReject,
        needs_manual_review: setManual
      });

      const text =
        "审核未通过。\n\n" +
        "请重新提交清晰截图：需要能看到时间信息与完成提示文字。\n" +
        "请勿重复提交无关内容，多次错误可能会被封禁。\n\n" +
        (setManual ? "你已多次提交错误内容，当前需要管理员手动审核通过后才可继续兑换。\n" : "") +
        "请继续完成首次验证。";

      await bot.api.sendMessage(review.user_id, text, {
        reply_markup: new InlineKeyboard().text("去首次验证", "go_y")
      });
    }

    if (reviewType === "second_verify") {
      const userRow = await getUserRow(review.user_id);
      const currentReject = userRow && Number.isFinite(userRow.reject_count_second) ? userRow.reject_count_second : 0;
      const nextReject = currentReject + 1;

      await updateUserFields(review.user_id, {
        reject_count_second: nextReject,
        second_verify_passed: false
      });

      const text =
        "二次认证未通过。\n\n" +
        "请重新提交认证截图。请勿提交无关内容，避免影响使用。\n" +
        "请继续完成二次认证（需要管理员最终通过后才生效）。";

      await bot.api.sendMessage(review.user_id, text, {
        reply_markup: new InlineKeyboard().text("去二次认证", "go_yz")
      });
    }

    if (reviewType === "vip_order") {
      const text =
        "订单信息未通过审核。\n" +
        "请检查后重新提交订单号（仅数字）。";

      await bot.api.sendMessage(review.user_id, text, {
        reply_markup: new InlineKeyboard().text("返回会员验证", "go_vip")
      });
    }

  } finally {
    client.release();
  }

  await ctx.reply(`已驳回工单 #${pendingId}。`);
});

bot.callbackQuery(/^review_ban:(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

  const pendingId = Number(ctx.match[1]);

  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT * FROM pending_reviews WHERE id = $1`, [pendingId]);
    const review = result.rows[0];
    if (!review) {
      await ctx.reply("工单不存在。");
      return;
    }

    await updatePendingReviewStatus(pendingId, "approved");
    await updateUserFields(review.user_id, { is_banned: true });

    const text =
      "你已因多次提交无效内容被本活动封禁。\n" +
      "如需继续使用，请前往加入会员（特价）。";

    await bot.api.sendMessage(review.user_id, text, { reply_markup: buildJoinVipKeyboard() });
  } finally {
    client.release();
  }

  await ctx.reply(`已封禁并处理工单 #${pendingId}。`);
});

bot.callbackQuery(/^review_delete:(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const from = ctx.from;
  if (!from) return;
  if (!isAdminUserId(from.id)) return;

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

  await ctx.reply(`已删除测试工单 #${pendingId}。`);
});

/* -------------------- 处理消息：图片上传、订单号输入、admin上架流程 -------------------- */

bot.on("message", async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  await ensureUserExists(from.id, from.username, from.first_name);

  const stateRow = await getUserStateRow(from.id);
  const currentState = stateRow ? stateRow.state : "idle";

  /* 1) admin 获取 file_id */
  if (currentState === "admin_waiting_file_id_photo") {
    if (ctx.message.photo && ctx.message.photo.length > 0) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      await ctx.reply(`file_id：\n${photo.file_id}\n\n你可以手动返回后台。`, {
        reply_markup: buildAdminKeyboard()
      });
      await clearUserState(from.id);
      return;
    }
    await ctx.reply("请发送图片。");
    return;
  }

  /* 2) admin 上架：等待关键词 */
  if (currentState === "admin_waiting_product_keyword") {
    const keyword = ctx.message.text ? String(ctx.message.text).trim() : "";
    if (!keyword) {
      await ctx.reply("请输入有效关键词（例如 001）。");
      return;
    }

    await setUserState(from.id, "admin_uploading_product_content", {
      keyword: keyword,
      items: []
    });

    const keyboard = new InlineKeyboard().text("完成上架", "admin_finish_upload_product").row().text("取消并返回后台", "admin_back");
    await ctx.reply(
      `已设置关键词：${keyword}\n请开始上传内容（可连续多条）。上传完成后点击【完成上架】。`,
      { reply_markup: keyboard }
    );
    return;
  }

  /* 3) admin 上架：持续收内容 */
  if (currentState === "admin_uploading_product_content") {
    if (!isAdminUserId(from.id)) {
      await ctx.reply("无权限。");
      await clearUserState(from.id);
      return;
    }

    const tempData = stateRow && stateRow.temp_data ? JSON.parse(stateRow.temp_data) : {};
    const keyword = tempData.keyword;
    const items = Array.isArray(tempData.items) ? tempData.items : [];

    const captured = extractPureContentFromMessage(ctx.message);
    if (!captured) {
      await ctx.reply("该内容类型暂不支持或无法提取纯内容，请换一种方式发送。");
      return;
    }

    items.push(captured);

    await setUserState(from.id, "admin_uploading_product_content", {
      keyword: keyword,
      items: items
    });

    await ctx.reply(`已加入上架队列：当前共 ${items.length} 条内容。继续上传或点击【完成上架】。`);
    return;
  }

  /* 4) VIP：等待订单号 */
  if (currentState === "vip_waiting_order") {
    const text = ctx.message.text ? String(ctx.message.text).trim() : "";
    const digits = text.replace(/\s+/g, "");

    if (!/^\d+$/.test(digits)) {
      await ctx.reply("未识别成功，请仅发送数字订单号。");
      return;
    }

    if (!digits.startsWith("20260")) {
      await ctx.reply("未识别成功，请检查后重新发送订单号。");
      return;
    }

    await ctx.reply("订单已提交验证。", { reply_markup: buildJoinGroupKeyboard() });

    const beijing = formatBeijingDateTime(getBeijingNowDate());
    const adminText =
      "VIP订单提交：\n" +
      `用户：${from.first_name || ""}${from.username ? " @" + from.username : ""}\n` +
      `ID：${from.id}\n` +
      `时间：${beijing}\n` +
      `订单：${digits}`;

    for (const adminId of ADMIN_IDS) {
      await bot.api.sendMessage(adminId, adminText, {
        reply_markup: buildReviewActionKeyboard(0, "vip_order", from.id)
      });
    }

    await createPendingReview({
      userId: from.id,
      username: from.username,
      firstName: from.first_name,
      reviewType: "vip_order",
      fileId: null,
      orderNumber: digits,
      messageId: null
    });

    await clearUserState(from.id);
    return;
  }

  /* 5) 首次验证：等待图片 */
  if (currentState === "waiting_first_verify_photo") {
    if (!ctx.message.photo || ctx.message.photo.length === 0) {
      await ctx.reply("请上传图片完成验证。");
      return;
    }

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const beijingNow = getBeijingNowDate();
    const beijingTextTime = formatBeijingDateTime(beijingNow);
    const today = formatBeijingDateOnly(beijingNow);

    await updateUserFields(from.id, {
      first_verify_passed: true,
      first_verify_date: today,
      first_verify_time: new Date()
    });

    await ctx.reply("验证成功，管理员将进行复核。", { reply_markup: buildYPassedBackKeyboard() });

    const reviewCaption =
      "首次验证工单：\n" +
      `用户：${from.first_name || ""}${from.username ? " @" + from.username : ""}\n` +
      `ID：${from.id}\n` +
      `时间：${beijingTextTime}`;

    for (const adminId of ADMIN_IDS) {
      const sent = await bot.api.sendPhoto(adminId, photo.file_id, {
        caption: reviewCaption,
        reply_markup: buildReviewActionKeyboard(0, "first_verify", from.id)
      });
      await createPendingReview({
        userId: from.id,
        username: from.username,
        firstName: from.first_name,
        reviewType: "first_verify",
        fileId: photo.file_id,
        orderNumber: null,
        messageId: sent && sent.message_id ? sent.message_id : null
      });
    }

    await clearUserState(from.id);
    return;
  }

  /* 6) 二次认证：等待图片 */
  if (currentState === "waiting_second_verify_photo") {
    if (!ctx.message.photo || ctx.message.photo.length === 0) {
      await ctx.reply("请上传图片完成二次认证。");
      return;
    }

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const beijingNow = getBeijingNowDate();
    const beijingTextTime = formatBeijingDateTime(beijingNow);

    await ctx.reply("二次认证已提交，管理员将进行复核。", { reply_markup: buildYPassedBackKeyboard() });

    const reviewCaption =
      "二次认证工单：\n" +
      `用户：${from.first_name || ""}${from.username ? " @" + from.username : ""}\n` +
      `ID：${from.id}\n` +
      `时间：${beijingTextTime}`;

    for (const adminId of ADMIN_IDS) {
      const sent = await bot.api.sendPhoto(adminId, photo.file_id, {
        caption: reviewCaption,
        reply_markup: buildReviewActionKeyboard(0, "second_verify", from.id)
      });
      await createPendingReview({
        userId: from.id,
        username: from.username,
        firstName: from.first_name,
        reviewType: "second_verify",
        fileId: photo.file_id,
        orderNumber: null,
        messageId: sent && sent.message_id ? sent.message_id : null
      });
    }

    await clearUserState(from.id);
    return;
  }

  /* 默认：不处理 */
});

/* -------------------- admin：完成上架按钮 -------------------- */

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
    await ctx.reply("你还没有上传任何内容。请先上传内容再完成上架。");
    return;
  }

  const contentType = "bundle";
  const contentDataText = JSON.stringify(items);

  await upsertProduct(keyword, contentType, contentDataText);

  await ctx.reply(`上架成功：关键词 ${keyword}，共 ${items.length} 条内容。`, { reply_markup: buildAdminKeyboard() });

  await clearUserState(from.id);
});

/* -------------------- 提取“纯内容”的函数（去掉来源、caption 等） -------------------- */

function extractPureContentFromMessage(message) {
  if (!message) return null;

  if (message.text) {
    return { type: "text", text: String(message.text) };
  }

  if (message.photo && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    return { type: "photo", file_id: photo.file_id };
  }

  if (message.video && message.video.file_id) {
    return { type: "video", file_id: message.video.file_id };
  }

  if (message.document && message.document.file_id) {
    return { type: "document", file_id: message.document.file_id };
  }

  return null;
}

/* -------------------- callback noop -------------------- */
bot.callbackQuery("noop", async (ctx) => {
  await ctx.answerCallbackQuery();
});

/* -------------------- 全局错误处理 -------------------- */

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

/* -------------------- 导出给 Vercel：webhookCallback -------------------- */

module.exports = webhookCallback(bot, "http");
