// api/index.js
const { Bot, webhookCallback, InlineKeyboard } = require("grammy");
const { Pool } = require("pg");

// --- 基础配置 ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: true,
});

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

// ==================================================================
// ⚠️⚠️⚠️ 请在此处填入你的图片 File ID ⚠️⚠️⚠️
// (部署后通过 /admin 获取，然后回来填入，再次部署)
// ==================================================================

// 1. 收款码图片 ID (用户点击"升级会员"时显示)
const PAYMENT_QR_FILE_ID = ""; 

// 2. 订单号示例图片 ID (用户点击"我已付款"后显示)
const ORDER_EXAMPLE_FILE_ID = "";

// ==================================================================


// --- 辅助函数 ---

// 获取北京时间当前日期 (格式: YYYY-MM-DD)
function getBeijingDate() {
  return new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).replace(/\//g, '-');
}

// 确保用户存在，并处理每日重置逻辑
async function getOrInitUser(ctx) {
  const user = ctx.from;
  const today = getBeijingDate();

  // 1. 尝试插入用户
  await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, daily_count, last_activity_date, is_vip, payment_attempts)
     VALUES ($1, $2, $3, 0, $4, FALSE, 0)
     ON CONFLICT (telegram_id) DO NOTHING`,
    [user.id, user.username, user.first_name, today]
  );

  // 2. 获取当前用户数据
  let res = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [user.id]);
  let userData = res.rows[0];

  // 3. 检查日期是否跨天 (北京时间)
  if (userData.last_activity_date !== today) {
    // 重置每日计数
    await pool.query(
      "UPDATE users SET daily_count = 0, last_activity_date = $1 WHERE telegram_id = $2",
      [today, user.id]
    );
    userData.daily_count = 0;
    userData.last_activity_date = today;
  }

  return userData;
}

// 增加用户兑换次数
async function incrementUserCount(userId) {
  await pool.query("UPDATE users SET daily_count = daily_count + 1 WHERE telegram_id = $1", [userId]);
}

// 状态管理
async function setState(userId, state, tempData = null) {
  await pool.query(
    `INSERT INTO user_states (user_id, state, temp_data) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET state = $2, temp_data = $3`,
    [userId, state, tempData]
  );
}

async function getState(userId) {
  const res = await pool.query("SELECT * FROM user_states WHERE user_id = $1", [userId]);
  return res.rows[0] || { state: "idle", temp_data: null };
}

async function clearState(userId) {
  await pool.query("DELETE FROM user_states WHERE user_id = $1", [userId]);
}

// 分页键盘生成器
function createPaginationKeyboard(currentPage, totalCount, prefix) {
  const totalPages = Math.ceil(totalCount / 10);
  const keyboard = new InlineKeyboard();
  const row = [];
  
  if (currentPage > 1) {
    row.push({ text: "⬅️ 上一页", callback_data: `${prefix}_page_${currentPage - 1}` });
  }
  row.push({ text: `📄 ${currentPage}/${totalPages || 1}`, callback_data: "noop" });
  if (currentPage < totalPages) {
    row.push({ text: "下一页 ➡️", callback_data: `${prefix}_page_${currentPage + 1}` });
  }
  return row;
}

// --- 统一的首页显示逻辑 ---
async function showStartPage(ctx) {
  await getOrInitUser(ctx);
  const keyboard = new InlineKeyboard()
    .text("🎁 进入兑换中心", "dh_page_1").row()
    .text("👑 升级永久会员 (无限兑换)", "vip_info");

  const welcomeText = `
👋 **欢迎使用小卫网盘兑换系统**

👤 **普通用户**: 每日免费 **3** 次
👑 **升级会员**: 永久 **无限次** 兑换

请选择下方功能：
  `;

  // 判断是回调更新还是发送新消息
  if (ctx.callbackQuery) {
    if (ctx.callbackQuery.message.photo) {
        // 如果之前是图片，删除重发
        await ctx.deleteMessage().catch(()=>{});
        await ctx.reply(welcomeText, { reply_markup: keyboard, parse_mode: "Markdown" });
    } else {
        await ctx.editMessageText(welcomeText, { reply_markup: keyboard, parse_mode: "Markdown" }).catch(()=>{});
    }
  } else {
    await ctx.reply(welcomeText, { reply_markup: keyboard, parse_mode: "Markdown" });
  }
}

// --- 业务逻辑 ---

// 1. /start 首页
bot.command("start", async (ctx) => {
    await showStartPage(ctx);
});

// 2. VIP 介绍页 (显示收款码)
bot.callbackQuery("vip_info", async (ctx) => {
  const userData = await getOrInitUser(ctx);
  
  // 检查是否被锁定
  const now = new Date();
  if (userData.payment_lockout_until && new Date(userData.payment_lockout_until) > now) {
      const diff = Math.ceil((new Date(userData.payment_lockout_until) - now) / 60000);
      return ctx.answerCallbackQuery({ 
          text: `⚠️ 系统繁忙，请 ${diff} 分钟后再试。`, 
          show_alert: true 
      });
  }

  if (userData.is_vip) {
      return ctx.answerCallbackQuery({ text: "尊贵的会员，您已经是永久 VIP 了！", show_alert: true });
  }

  const keyboard = new InlineKeyboard()
    .text("✅ 我已付款", "vip_paid_check").row()
    .text("🔙 返回首页", "back_to_start");

  const caption = `
💎 **会员特权说明**

👤 **普通用户**: 每日免费兑换 **3** 次
👑 **永久会员**: 解锁 **无限次** 兑换特权

━━━━━━━━━━━━━━
💰 **付款说明**:
请扫描上方二维码付款。
付款后，请点击下方【我已付款】按钮进行自动核验。
  `;

  if (PAYMENT_QR_FILE_ID && PAYMENT_QR_FILE_ID.length > 5) {
      await ctx.deleteMessage().catch(()=>{});
      await ctx.replyWithPhoto(PAYMENT_QR_FILE_ID, {
          caption: caption,
          parse_mode: "Markdown",
          reply_markup: keyboard
      });
  } else {
      await ctx.editMessageText(caption + "\n(⚠️ 管理员未设置收款码图片)", { 
          reply_markup: keyboard, 
          parse_mode: "Markdown" 
      });
  }
});

// 返回首页回调
bot.callbackQuery("back_to_start", async (ctx) => {
    await showStartPage(ctx);
});

// 处理文字输入时的“返回首页”按钮
bot.callbackQuery("back_to_start_msg", async (ctx) => {
    await ctx.deleteMessage().catch(()=>{});
    await showStartPage(ctx);
});

// 3. 点击“我已付款” -> 进入等待订单号状态
bot.callbackQuery("vip_paid_check", async (ctx) => {
    const userId = ctx.from.id;
    const userData = await getOrInitUser(ctx);

    const now = new Date();
    if (userData.payment_lockout_until && new Date(userData.payment_lockout_until) > now) {
        await ctx.deleteMessage().catch(()=>{});
        return ctx.reply("⚠️ **验证次数过多**\n\n为了安全起见，系统已暂时锁定验证功能。\n请 1 小时后再试。", { 
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard().text("🔙 返回首页", "back_to_start_msg")
        });
    }

    await setState(userId, "awaiting_order_number");
    
    const text = `
🧾 **订单号核验**

请参考上方图片查找您的【支付宝订单号】：

1. 打开支付宝 APP -> **【我的】**
2. 点击 **【账单】**
3. 找到交易，进入 **【账单详情】**
4. 点击 **【更多】**
5. 长按复制 **【订单号】**

👉 **请直接在对话框回复您的订单号：**
(剩余重试次数: ${2 - userData.payment_attempts} 次)
    `;
    
    const keyboard = new InlineKeyboard().text("🔙 取消", "back_to_start");
    
    if (ORDER_EXAMPLE_FILE_ID && ORDER_EXAMPLE_FILE_ID.length > 5) {
        await ctx.deleteMessage().catch(()=>{});
        await ctx.replyWithPhoto(ORDER_EXAMPLE_FILE_ID, {
            caption: text,
            parse_mode: "Markdown",
            reply_markup: keyboard
        });
    } else {
        if (ctx.callbackQuery.message.photo) {
            await ctx.deleteMessage().catch(()=>{});
            await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
        } else {
            await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
        }
    }
});


// 4. /dh 兑换页面
async function showRedeemPage(ctx, page) {
  const userData = await getOrInitUser(ctx);
  const count = userData.daily_count;
  const isVip = userData.is_vip;

  let userHeader = "";
  if (isVip) {
      userHeader = `👤 **用户**: ${userData.first_name || 'Guest'} (👑 VIP)\n🆔 **ID**: \`${userData.telegram_id}\`\n♾️ **额度**: 无限次兑换`;
  } else {
      userHeader = `👤 **用户**: ${userData.first_name || 'Guest'}\n🆔 **ID**: \`${userData.telegram_id}\` (${count}/3)`;
  }

  const offset = (page - 1) * 10;
  const countRes = await pool.query("SELECT COUNT(*) FROM products");
  const totalCount = parseInt(countRes.rows[0].count);
  const itemsRes = await pool.query("SELECT id, name FROM products ORDER BY id DESC LIMIT 10 OFFSET $1", [offset]);
  
  const keyboard = new InlineKeyboard();
  
  if (itemsRes.rows.length === 0) {
    keyboard.text("🌑 暂无上架商品", "noop").row();
  } else {
    itemsRes.rows.forEach(item => {
      keyboard.text(`🎁 ${item.name}`, `try_redeem_${item.id}`).row();
    });
  }

  const navRow = createPaginationKeyboard(page, totalCount, "dh");
  keyboard.row(...navRow);

  // 如果不是VIP，增加升级按钮
  if (!isVip) {
      keyboard.row().text("👑 升级永久会员 (无限兑换)", "vip_info");
  }
  
  const text = `${userHeader}\n━━━━━━━━━━━━━━\n📢 **提示**: 升级会员可无限次兑换。\n普通用户每日免费 **3** 次。\n\n🛒 **商品列表** (第 ${page} 页)\n请点击下方按钮进行兑换：`;

  if (ctx.callbackQuery) {
    if (ctx.callbackQuery.message.photo) {
        await ctx.deleteMessage().catch(()=>{});
        await ctx.reply(text, { reply_markup: keyboard, parse_mode: "Markdown" });
    } else {
        await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: "Markdown" }).catch(()=>{});
    }
  } else {
    await ctx.reply(text, { reply_markup: keyboard, parse_mode: "Markdown" });
  }
}

bot.command("dh", (ctx) => showRedeemPage(ctx, 1));
bot.callbackQuery(/dh_page_(\d+)/, (ctx) => showRedeemPage(ctx, parseInt(ctx.match[1])));

// 兑换核心逻辑
bot.callbackQuery(/try_redeem_(\d+)/, async (ctx) => {
  const productId = ctx.match[1];
  const userData = await getOrInitUser(ctx);
  
  // 检查额度
  if (!userData.is_vip && userData.daily_count >= 3) {
    const limitKeyboard = new InlineKeyboard()
        .text("👑 立即升级 VIP (无限次)", "vip_info");
    
    await ctx.reply("🚫 **今日免费次数已用完** (3/3)\n\n升级会员即可解锁 **永久无限次** 兑换特权！", { 
        reply_markup: limitKeyboard,
        parse_mode: "Markdown" 
    });
    
    return ctx.answerCallbackQuery({
      text: "次数已用完，请升级会员！",
      show_alert: false 
    });
  }

  const prodRes = await pool.query("SELECT * FROM products WHERE id = $1", [productId]);
  if (prodRes.rows.length === 0) {
    return ctx.answerCallbackQuery({ text: "⚠️ 商品已下架", show_alert: true });
  }
  const product = prodRes.rows[0];

  await incrementUserCount(ctx.from.id);
  
  await ctx.reply(`🎉 **兑换成功**\n\n📦 **商品**: ${product.name}\n🔑 **内容**: \`${product.content}\`\n\n(点击内容可复制)`, { parse_mode: "Markdown" });
  await ctx.answerCallbackQuery({ text: "兑换成功！" });
  await showRedeemPage(ctx, 1); 
});

// 5. /c 取消
bot.command("c", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await clearState(ctx.from.id);
  await ctx.reply("🚫 **操作已取消**", { parse_mode: "Markdown" });
});

// 6. /admin 后台
bot.command("admin", (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  showAdminPanel(ctx);
});

function showAdminPanel(ctx) {
  const keyboard = new InlineKeyboard()
    .text("📂 File ID 工具", "admin_fileid").row()
    .text("🛍️ 商品上架管理 (/sj)", "sj_page_1");
  const text = "🔧 **后台管理面板**\n━━━━━━━━━━━━━━\n输入 /c 可随时取消当前操作。";
  if (ctx.callbackQuery) {
    if (ctx.callbackQuery.message.photo) {
        ctx.deleteMessage().catch(()=>{});
        ctx.reply(text, { reply_markup: keyboard, parse_mode: "Markdown" });
    } else {
        ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: "Markdown" }).catch(() => {});
    }
  } else {
    ctx.reply(text, { reply_markup: keyboard, parse_mode: "Markdown" });
  }
}

bot.callbackQuery("admin_fileid", (ctx) => {
  const keyboard = new InlineKeyboard().text("📥 上传图片获取ID", "fid_get").text("🔙 返回", "back_to_admin");
  ctx.editMessageText("📂 **File ID 工具**", { reply_markup: keyboard, parse_mode: "Markdown" });
});
bot.callbackQuery("back_to_admin", (ctx) => showAdminPanel(ctx));
bot.callbackQuery("fid_get", async (ctx) => {
  await setState(ctx.from.id, "awaiting_photo");
  const keyboard = new InlineKeyboard().text("🔙 取消", "back_to_admin");
  ctx.editMessageText("📸 请发送一张图片...", { reply_markup: keyboard });
});

// Admin - 上架管理
async function showSjPage(ctx, page) {
  const offset = (page - 1) * 10;
  const countRes = await pool.query("SELECT COUNT(*) FROM products");
  const totalCount = parseInt(countRes.rows[0].count);
  const itemsRes = await pool.query("SELECT id, name FROM products ORDER BY id DESC LIMIT 10 OFFSET $1", [offset]);
  const keyboard = new InlineKeyboard();
  keyboard.text("➕ 上架新商品", "sj_add_new").row();
  itemsRes.rows.forEach(item => {
    keyboard.text(`❌ 删除: ${item.name}`, `sj_del_ask_${item.id}`).row();
  });
  const navRow = createPaginationKeyboard(page, totalCount, "sj");
  keyboard.row(...navRow);
  keyboard.row().text("🔙 返回后台", "back_to_admin");
  const text = `🛍️ **商品管理** (第 ${page} 页)`;
  if (ctx.callbackQuery) {
    if (ctx.callbackQuery.message.photo) {
        ctx.deleteMessage().catch(()=>{});
        ctx.reply(text, { reply_markup: keyboard, parse_mode: "Markdown" });
    } else {
        ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: "Markdown" });
    }
  } else {
    await ctx.reply(text, { reply_markup: keyboard, parse_mode: "Markdown" });
  }
}
bot.command("sj", (ctx) => { if (ctx.from.id === ADMIN_ID) showSjPage(ctx, 1); });
bot.callbackQuery(/sj_page_(\d+)/, (ctx) => showSjPage(ctx, parseInt(ctx.match[1])));
bot.callbackQuery("sj_add_new", async (ctx) => {
  await setState(ctx.from.id, "awaiting_name");
  ctx.editMessageText("✏️ **请输入商品名称**：", { parse_mode: "Markdown" });
});
bot.callbackQuery(/sj_del_ask_(\d+)/, (ctx) => {
  const id = ctx.match[1];
  const keyboard = new InlineKeyboard().text("✅ 确认删除", `sj_del_confirm_${id}`).text("🔙 取消", "sj_page_1");
  ctx.editMessageText("⚠️ **确认删除此商品吗？**", { reply_markup: keyboard, parse_mode: "Markdown" });
});
bot.callbackQuery(/sj_del_confirm_(\d+)/, async (ctx) => {
  await pool.query("DELETE FROM products WHERE id = $1", [ctx.match[1]]);
  await ctx.answerCallbackQuery({ text: "🗑️ 删除成功" });
  showSjPage(ctx, 1);
});

// --- 消息监听 (包含万能回复逻辑) ---
bot.on("message", async (ctx) => {
  const userId = ctx.from.id;
  const userState = await getState(userId);
  const text = ctx.message.text || "";

  // 1. 处理需要输入的特定状态 (优先级最高)
  
  // A. 订单号验证状态
  if (userState.state === "awaiting_order_number") {
      const userData = await getOrInitUser(ctx);
      const now = new Date();
      if (userData.payment_lockout_until && new Date(userData.payment_lockout_until) > now) {
           await clearState(userId);
           const keyboard = new InlineKeyboard().text("🔙 返回首页", "back_to_start_msg");
           return ctx.reply("⚠️ 系统已锁定，请稍后再试。", { reply_markup: keyboard });
      }

      if (text.startsWith("4768")) {
          await pool.query("UPDATE users SET is_vip = TRUE, payment_attempts = 0 WHERE telegram_id = $1", [userId]);
          await clearState(userId);
          const keyboard = new InlineKeyboard().text("🎁 立即去兑换", "dh_page_1");
          return ctx.reply("🎉 **恭喜您！升级成功！**\n\n您现在是尊贵的永久 VIP 会员。\n享有 **无限次** 兑换特权。", { 
              parse_mode: "Markdown", 
              reply_markup: keyboard 
          });
      } else {
          const newAttempts = (userData.payment_attempts || 0) + 1;
          if (newAttempts >= 2) {
              const lockoutTime = new Date(now.getTime() + 60 * 60 * 1000); 
              await pool.query("UPDATE users SET payment_attempts = 0, payment_lockout_until = $1 WHERE telegram_id = $2", [lockoutTime.toISOString(), userId]);
              await clearState(userId);
              const keyboard = new InlineKeyboard().text("🔙 返回首页", "back_to_start_msg");
              return ctx.reply("🚫 **验证失败次数过多**\n\n未查询到订单信息。\n为防止恶意尝试，系统已暂停您的验证功能。\n\n请 **1 小时后** 再次尝试。", { 
                  parse_mode: "Markdown", 
                  reply_markup: keyboard 
              });
          } else {
              await pool.query("UPDATE users SET payment_attempts = $1 WHERE telegram_id = $2", [newAttempts, userId]);
              return ctx.reply(`❌ **未查询到订单信息**\n\n请检查订单号是否正确，并重新发送。\n(剩余重试次数: ${2 - newAttempts} 次)`, { parse_mode: "Markdown" });
          }
      }
      return; // 结束处理
  }

  // B. 管理员状态
  if (userId === ADMIN_ID && userState.state !== "idle") {
    if (userState.state === "awaiting_photo") {
      if (ctx.message.photo) {
        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        await ctx.reply(`🆔 **File ID**:\n\`${fileId}\`\n\n(请根据用途，将此ID填入代码顶部的 PAYMENT_QR_FILE_ID 或 ORDER_EXAMPLE_FILE_ID 变量中)`, { parse_mode: "MarkdownV2" });
        await clearState(userId);
      } else {
        ctx.reply("⚠️ 请发送图片，或输入 /c 取消。");
      }
      return;
    } 
    else if (userState.state === "awaiting_name") {
        await setState(userId, "awaiting_content", text);
        await ctx.reply(`✅ 商品名: **${text}**\n\n📝 **请输入商品内容**：`, { parse_mode: "Markdown" });
        return;
    } 
    else if (userState.state === "awaiting_content") {
        const name = userState.temp_data;
        await pool.query("INSERT INTO products (name, content) VALUES ($1, $2)", [name, text]);
        await ctx.reply(`🎉 **上架成功！**`, { parse_mode: "Markdown" });
        await clearState(userId);
        showSjPage(ctx, 1);
        return;
    }
  }

  // 2. 万能回复逻辑 (Fallback)
  // 如果代码执行到这里，说明不是命令，也不是在特定状态下
  // 直接显示首页
  await showStartPage(ctx);
});

module.exports = webhookCallback(bot, "http");
