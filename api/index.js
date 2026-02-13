const { Bot, InlineKeyboard, Keyboard } = require("grammy");
const { Pool } = require("pg");

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

const adminState = new Map();
function isAdmin(id) {
  return ADMIN_IDS.includes(Number(id));
}

// /start
bot.command("start", async (ctx) => {
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

// 加入会员
bot.callbackQuery("start_join_vip", async (ctx) => {
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
  await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
    await ctx.reply(text, { reply_markup: kb });
  });
});

// /v
bot.command("v", async (ctx) => {
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
  await ctx.reply(text, { reply_markup: kb });
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

// 处理订单号
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

  adminState.delete(userId);

  const joinLink = "https://t.me/+495j5rWmApsxYzg9";
  const kb = new InlineKeyboard().url("💎 加入会员群", joinLink);
  await ctx.reply(
    "✅ 订单验证成功！\n\n欢迎加入会员群，解锁更多专属资源与服务：",
    { reply_markup: kb }
  );
});

// 返回首页
bot.callbackQuery("back_to_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text("💎 加入会员（新春特价）", "start_join_vip")
    .row()
    .text("🎁 兑换资源", "start_dh");
  await ctx.reply("已返回首页，请重新选择服务：", { reply_markup: kb });
});

// /admin
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

  await ctx.reply("管理员面板（仅限管理员访问）：", {
    reply_markup: kb,
  });
});

// /p 和 /dh 先占位，后面对接你原来的表
bot.callbackQuery("admin_p", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.answerCallbackQuery();
  await ctx.reply("这里将显示 /p 商品列表（后面对接你原来的 Neon 数据表）。");
});

bot.command("p", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.reply("这里将显示 /p 商品列表（后面对接你原来的 Neon 数据表）。");
});

bot.command("dh", async (ctx) => {
  await ctx.reply("这里将加载你原来 /dh 的关键词和内容（待对接 Neon 表）。");
});

bot.callbackQuery("start_dh", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("这里将加载你原来 /dh 的关键词和内容（待对接 Neon 表）。");
});

// /c 取消状态
bot.command("c", async (ctx) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return;
  adminState.delete(userId);
  await ctx.reply("已清除当前操作状态。");
});

module.exports = async (req, res) => {
  if (req.method === "POST") {
    try {
      await bot.handleUpdate(req.body);
    } catch (e) {
      console.error("Error handling update:", e);
    }
    res.status(200).json({ ok: true });
  } else {
    res.status(200).send("OK");
  }
};
