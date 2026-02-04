const { Bot, webhookCallback, InlineKeyboard } = require("grammy");
const { Pool } = require("pg");

// ==================== 基础配置 ====================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

// ==================== FILE ID 配置区域 ====================
const FILE_ID_PAYMENT = "YOUR_PAYMENT_QR_FILE_ID";
const FILE_ID_ORDER = "YOUR_ORDER_TUTORIAL_FILE_ID";
const FILE_ID_Y_1 = "YOUR_Y_TUTORIAL_1_FILE_ID";
const FILE_ID_Y_2 = "YOUR_Y_TUTORIAL_2_FILE_ID";
const FILE_ID_YZ_1 = "YOUR_YZ_TUTORIAL_1_FILE_ID";
const FILE_ID_YZ_2 = "YOUR_YZ_TUTORIAL_2_FILE_ID";
const FILE_ID_YZ_3 = "YOUR_YZ_TUTORIAL_3_FILE_ID";

const VIP_GROUP_LINK = "https://t.me/+495j5rWmApsxYzg9";

// ==================== 辅助函数 ====================

function getBeijingTime() {
    const now = new Date();
    return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}

function getBeijingDateString() {
    const bt = getBeijingTime();
    return bt.toISOString().split('T')[0];
}

function getBeijingTimeString() {
    const bt = getBeijingTime();
    const year = bt.getUTCFullYear();
    const month = String(bt.getUTCMonth() + 1).padStart(2, '0');
    const day = String(bt.getUTCDate()).padStart(2, '0');
    const hours = String(bt.getUTCHours()).padStart(2, '0');
    const minutes = String(bt.getUTCMinutes()).padStart(2, '0');
    const seconds = String(bt.getUTCSeconds()).padStart(2, '0');
    return `${year}.${month}.${day} 北京时间 ${hours}:${minutes}:${seconds}`;
}

async function getOrInitUser(userId, username, firstName) {
    const today = getBeijingDateString();
    
    try {
        await pool.query(
            `INSERT INTO users (telegram_id, username, first_name, first_verify_date)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (telegram_id) DO UPDATE SET 
                username = COALESCE($2, users.username),
                first_name = COALESCE($3, users.first_name)`,
            [userId, username || null, firstName || null, today]
        );
    } catch (e) {
        console.error("插入用户失败:", e);
    }
    
    const res = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [userId]);
    
    if (res.rows.length === 0) {
        return {
            telegram_id: userId,
            username: username,
            first_name: firstName,
            is_vip: false,
            is_banned: false,
            first_verify_passed: false,
            second_verify_passed: false,
            first_verify_date: today,
            click_count: 0,
            reject_count_first: 0,
            needs_manual_review: false
        };
    }
    
    let userData = res.rows[0];
    
    // 每日重置首次验证
    if (userData.first_verify_date !== today) {
        await pool.query(
            `UPDATE users SET 
                first_verify_passed = FALSE,
                first_verify_date = $1,
                first_verify_time = NULL,
                click_count = 0,
                reject_count_first = 0,
                needs_manual_review = FALSE
             WHERE telegram_id = $2`,
            [today, userId]
        );
        userData.first_verify_passed = false;
        userData.first_verify_date = today;
        userData.first_verify_time = null;
        userData.click_count = 0;
        userData.reject_count_first = 0;
        userData.needs_manual_review = false;
    }
    
    return userData;
}

async function setState(userId, state, tempData = null) {
    const dataStr = tempData !== null ? JSON.stringify(tempData) : null;
    await pool.query(
        `INSERT INTO user_states (user_id, state, temp_data, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET 
            state = $2, 
            temp_data = $3,
            updated_at = CURRENT_TIMESTAMP`,
        [userId, state, dataStr]
    );
}

async function getState(userId) {
    const res = await pool.query("SELECT * FROM user_states WHERE user_id = $1", [userId]);
    if (res.rows.length === 0) {
        return { state: "idle", temp_data: null };
    }
    const row = res.rows[0];
    let tempData = null;
    if (row.temp_data) {
        try {
            tempData = JSON.parse(row.temp_data);
        } catch (e) {
            tempData = row.temp_data;
        }
    }
    return { state: row.state, temp_data: tempData };
}

async function clearState(userId) {
    await pool.query("DELETE FROM user_states WHERE user_id = $1", [userId]);
}

async function incrementClickCount(userId) {
    await pool.query(
        "UPDATE users SET click_count = click_count + 1 WHERE telegram_id = $1",
        [userId]
    );
    const res = await pool.query("SELECT click_count FROM users WHERE telegram_id = $1", [userId]);
    return res.rows[0]?.click_count || 0;
}

async function checkNeedSecondVerify(userId) {
    const res = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [userId]);
    if (res.rows.length === 0) return false;
    
    const user = res.rows[0];
    
    if (user.second_verify_passed) {
        return false;
    }
    
    if (!user.first_verify_passed) {
        return false;
    }
    
    // 条件1：点击次数 >= 5
    if (user.click_count >= 5) {
        return true;
    }
    
    // 条件2：首次验证成功后1小时
    if (user.first_verify_time) {
        const verifyTime = new Date(user.first_verify_time);
        const now = new Date();
        const hoursPassed = (now - verifyTime) / (1000 * 60 * 60);
        if (hoursPassed >= 1) {
            return true;
        }
    }
    
    return false;
}

function createPaginationKeyboard(currentPage, totalCount, prefix, itemsPerPage = 10) {
    const totalPages = Math.ceil(totalCount / itemsPerPage) || 1;
    const buttons = [];
    
    if (currentPage > 1) {
        buttons.push({ text: "◀️", callback_data: `${prefix}_page_${currentPage - 1}` });
    }
    buttons.push({ text: `${currentPage}/${totalPages}`, callback_data: "noop" });
    if (currentPage < totalPages) {
        buttons.push({ text: "▶️", callback_data: `${prefix}_page_${currentPage + 1}` });
    }
    
    return buttons;
}
const { Bot, webhookCallback, InlineKeyboard } = require("grammy");
const { Pool } = require("pg");

// ==================== 基础配置 ====================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

// ==================== FILE ID 配置区域 ====================
const FILE_ID_PAYMENT = "YOUR_PAYMENT_QR_FILE_ID";
const FILE_ID_ORDER = "YOUR_ORDER_TUTORIAL_FILE_ID";
const FILE_ID_Y_1 = "YOUR_Y_TUTORIAL_1_FILE_ID";
const FILE_ID_Y_2 = "YOUR_Y_TUTORIAL_2_FILE_ID";
const FILE_ID_YZ_1 = "YOUR_YZ_TUTORIAL_1_FILE_ID";
const FILE_ID_YZ_2 = "YOUR_YZ_TUTORIAL_2_FILE_ID";
const FILE_ID_YZ_3 = "YOUR_YZ_TUTORIAL_3_FILE_ID";

const VIP_GROUP_LINK = "https://t.me/+495j5rWmApsxYzg9";

// ==================== 辅助函数 ====================

function getBeijingTime() {
    const now = new Date();
    return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}

function getBeijingDateString() {
    const bt = getBeijingTime();
    return bt.toISOString().split('T')[0];
}

function getBeijingTimeString() {
    const bt = getBeijingTime();
    const year = bt.getUTCFullYear();
    const month = String(bt.getUTCMonth() + 1).padStart(2, '0');
    const day = String(bt.getUTCDate()).padStart(2, '0');
    const hours = String(bt.getUTCHours()).padStart(2, '0');
    const minutes = String(bt.getUTCMinutes()).padStart(2, '0');
    const seconds = String(bt.getUTCSeconds()).padStart(2, '0');
    return `${year}.${month}.${day} 北京时间 ${hours}:${minutes}:${seconds}`;
}

async function getOrInitUser(userId, username, firstName) {
    const today = getBeijingDateString();
    
    try {
        await pool.query(
            `INSERT INTO users (telegram_id, username, first_name, first_verify_date)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (telegram_id) DO UPDATE SET 
                username = COALESCE($2, users.username),
                first_name = COALESCE($3, users.first_name)`,
            [userId, username || null, firstName || null, today]
        );
    } catch (e) {
        console.error("插入用户失败:", e);
    }
    
    const res = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [userId]);
    
    if (res.rows.length === 0) {
        return {
            telegram_id: userId,
            username: username,
            first_name: firstName,
            is_vip: false,
            is_banned: false,
            first_verify_passed: false,
            second_verify_passed: false,
            first_verify_date: today,
            click_count: 0,
            reject_count_first: 0,
            needs_manual_review: false
        };
    }
    
    let userData = res.rows[0];
    
    // 每日重置首次验证
    if (userData.first_verify_date !== today) {
        await pool.query(
            `UPDATE users SET 
                first_verify_passed = FALSE,
                first_verify_date = $1,
                first_verify_time = NULL,
                click_count = 0,
                reject_count_first = 0,
                needs_manual_review = FALSE
             WHERE telegram_id = $2`,
            [today, userId]
        );
        userData.first_verify_passed = false;
        userData.first_verify_date = today;
        userData.first_verify_time = null;
        userData.click_count = 0;
        userData.reject_count_first = 0;
        userData.needs_manual_review = false;
    }
    
    return userData;
}

async function setState(userId, state, tempData = null) {
    const dataStr = tempData !== null ? JSON.stringify(tempData) : null;
    await pool.query(
        `INSERT INTO user_states (user_id, state, temp_data, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET 
            state = $2, 
            temp_data = $3,
            updated_at = CURRENT_TIMESTAMP`,
        [userId, state, dataStr]
    );
}

async function getState(userId) {
    const res = await pool.query("SELECT * FROM user_states WHERE user_id = $1", [userId]);
    if (res.rows.length === 0) {
        return { state: "idle", temp_data: null };
    }
    const row = res.rows[0];
    let tempData = null;
    if (row.temp_data) {
        try {
            tempData = JSON.parse(row.temp_data);
        } catch (e) {
            tempData = row.temp_data;
        }
    }
    return { state: row.state, temp_data: tempData };
}

async function clearState(userId) {
    await pool.query("DELETE FROM user_states WHERE user_id = $1", [userId]);
}

async function incrementClickCount(userId) {
    await pool.query(
        "UPDATE users SET click_count = click_count + 1 WHERE telegram_id = $1",
        [userId]
    );
    const res = await pool.query("SELECT click_count FROM users WHERE telegram_id = $1", [userId]);
    return res.rows[0]?.click_count || 0;
}

async function checkNeedSecondVerify(userId) {
    const res = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [userId]);
    if (res.rows.length === 0) return false;
    
    const user = res.rows[0];
    
    if (user.second_verify_passed) {
        return false;
    }
    
    if (!user.first_verify_passed) {
        return false;
    }
    
    // 条件1：点击次数 >= 5
    if (user.click_count >= 5) {
        return true;
    }
    
    // 条件2：首次验证成功后1小时
    if (user.first_verify_time) {
        const verifyTime = new Date(user.first_verify_time);
        const now = new Date();
        const hoursPassed = (now - verifyTime) / (1000 * 60 * 60);
        if (hoursPassed >= 1) {
            return true;
        }
    }
    
    return false;
}

function createPaginationKeyboard(currentPage, totalCount, prefix, itemsPerPage = 10) {
    const totalPages = Math.ceil(totalCount / itemsPerPage) || 1;
    const buttons = [];
    
    if (currentPage > 1) {
        buttons.push({ text: "◀️", callback_data: `${prefix}_page_${currentPage - 1}` });
    }
    buttons.push({ text: `${currentPage}/${totalPages}`, callback_data: "noop" });
    if (currentPage < totalPages) {
        buttons.push({ text: "▶️", callback_data: `${prefix}_page_${currentPage + 1}` });
    }
    
    return buttons;
}
// ==================== 页面显示函数 ====================

async function showStartPage(ctx) {
    const userId = ctx.from.id;
    await getOrInitUser(userId, ctx.from.username, ctx.from.first_name);
    await clearState(userId);
    
    const keyboard = new InlineKeyboard()
        .text("🎁 兑换", "go_to_dh");
    
    const welcomeText = `
🎊✨ **喜迎二月除夕** ✨🎊

🎁 所有资源都【**免费观看**】！

📦 只需打开兑换，点击相应按钮
     即可直接免费观看~

🧧 **新春快乐，万事如意！**

━━━━━━━━━━━━━━━━━━━━
`;
    
    try {
        if (ctx.callbackQuery) {
            try { await ctx.deleteMessage(); } catch (e) {}
        }
        await ctx.reply(welcomeText, { reply_markup: keyboard, parse_mode: "Markdown" });
    } catch (error) {
        console.error("showStartPage error:", error);
    }
}

async function showDhPage(ctx, page = 1) {
    const userId = ctx.from.id;
    const userData = await getOrInitUser(userId, ctx.from.username, ctx.from.first_name);
    await clearState(userId);
    
    console.log(`[showDhPage] 用户${userId} first_verify_passed=${userData.first_verify_passed} is_banned=${userData.is_banned}`);
    
    // 检查是否封禁
    if (userData.is_banned) {
        const keyboard = new InlineKeyboard()
            .text("💎 加入会员（特价版）", "go_to_v");
        
        try {
            if (ctx.callbackQuery) {
                try { await ctx.deleteMessage(); } catch (e) {}
            }
            await ctx.reply(`
🚫 **你已被本活动封禁**

请加入会员（特价版）👇
`, { reply_markup: keyboard, parse_mode: "Markdown" });
        } catch (e) {}
        return;
    }
    
    // 检查是否需要二次验证
    if (userData.first_verify_passed && !userData.second_verify_passed) {
        const needSecond = await checkNeedSecondVerify(userId);
        if (needSecond) {
            console.log(`[showDhPage] 用户${userId} 需要二次验证`);
            if (ctx.callbackQuery) {
                try { await ctx.deleteMessage(); } catch (e) {}
            }
            await showYzPage(ctx);
            return;
        }
    }
    
    // 获取商品列表
    const offset = (page - 1) * 10;
    const countRes = await pool.query("SELECT COUNT(*) FROM products");
    const totalCount = parseInt(countRes.rows[0].count);
    const productsRes = await pool.query(
        "SELECT id, keyword FROM products ORDER BY id ASC LIMIT 10 OFFSET $1",
        [offset]
    );
    
    const keyboard = new InlineKeyboard();
    
    const products = productsRes.rows;
    for (let i = 0; i < products.length; i += 2) {
        if (i + 1 < products.length) {
            keyboard
                .text(`📦 ${products[i].keyword}`, `product_${products[i].id}`)
                .text(`📦 ${products[i + 1].keyword}`, `product_${products[i + 1].id}`)
                .row();
        } else {
            keyboard.text(`📦 ${products[i].keyword}`, `product_${products[i].id}`).row();
        }
    }
    
    if (totalCount > 10) {
        const navButtons = createPaginationKeyboard(page, totalCount, "dh");
        navButtons.forEach(btn => keyboard.text(btn.text, btn.callback_data));
        keyboard.row();
    }
    
    // 验证成功后显示加入会员按钮
    if (userData.first_verify_passed) {
        keyboard.text("💎 加入会员（新春特价）", "go_to_v").row();
    }
    
    keyboard.text("🔙 返回首页", "go_to_start");
    
    let dhText;
    if (userData.first_verify_passed) {
        dhText = `
📦 **兑换中心** ✨

🎉 验证已通过，无限畅享！
📥 点击对应编号即可免费观看

━━━━━━━━━━━━━━━━━━━━
`;
    } else {
        dhText = `
📦 **兑换中心**

🎉 点击对应的编号按钮
✨ 即可立马**免费观看**

━━━━━━━━━━━━━━━━━━━━
`;
    }
    
    if (products.length === 0) {
        dhText += `\n🌑 暂无商品，请稍后再来~`;
    }
    
    try {
        if (ctx.callbackQuery) {
            try { await ctx.deleteMessage(); } catch (e) {}
        }
        await ctx.reply(dhText, { reply_markup: keyboard, parse_mode: "Markdown" });
    } catch (error) {
        console.error("showDhPage error:", error);
    }
}
// ==================== 首次验证页面 ====================

async function showYPage(ctx) {
    const userId = ctx.from.id;
    const userData = await getOrInitUser(userId, ctx.from.username, ctx.from.first_name);
    
    // 如果需要等待管理员审核
    if (userData.needs_manual_review) {
        const keyboard = new InlineKeyboard()
            .text("🔄 刷新状态", "refresh_y_status");
        
        try {
            if (ctx.callbackQuery) {
                try { await ctx.deleteMessage(); } catch (e) {}
            }
            await ctx.reply(`
⏳ **等待管理员审核**

您的验证已提交，请等待管理员审核。
审核通过后即可使用。

━━━━━━━━━━━━━━━━━━━━
`, { reply_markup: keyboard, parse_mode: "Markdown" });
        } catch (e) {}
        return;
    }
    
    await setState(userId, "awaiting_first_verify", null);
    
    const keyboard = new InlineKeyboard()
        .text("🔙 返回兑换", "force_go_dh");
    
    const yText = `
━━━━━━━━━━━━━━━━━━━━━━━━━━
      🔐 **首 次 验 证**
━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ **无套路**！只要验证即可
🤖 机器人三秒自动审核
🎁 验证后所有资源**无限制浏览**

⚠️ **不要作弊！！**

━━━━ 📱 **验证教程** ━━━━

1️⃣ 打开支付宝，点击【扫一扫】
2️⃣ 扫描下方二维码
3️⃣ 点击【完成助力】
4️⃣ 截图上传

📝 **截图必须包含**：
   • 📅 你截图的时间
   • ✅ 助力成功文字

━━━━━━━━━━━━━━━━━━━━━━━━━━

📤 **请上传图片开始验证：**
`;
    
    try {
        if (ctx.callbackQuery) {
            try { await ctx.deleteMessage(); } catch (e) {}
        }
        
        if (FILE_ID_Y_1 && FILE_ID_Y_1 !== "YOUR_Y_TUTORIAL_1_FILE_ID") {
            try { await ctx.replyWithPhoto(FILE_ID_Y_1); } catch (e) {}
        }
        if (FILE_ID_Y_2 && FILE_ID_Y_2 !== "YOUR_Y_TUTORIAL_2_FILE_ID") {
            try { await ctx.replyWithPhoto(FILE_ID_Y_2); } catch (e) {}
        }
        
        await ctx.reply(yText, { reply_markup: keyboard, parse_mode: "Markdown" });
    } catch (error) {
        console.error("showYPage error:", error);
    }
}

// ==================== 二次验证页面 ====================

async function showYzPage(ctx) {
    const userId = ctx.from.id;
    await setState(userId, "awaiting_second_verify", null);
    
    const keyboard = new InlineKeyboard()
        .text("🔙 返回兑换", "force_go_dh");
    
    const yzText = `
━━━━━━━━━━━━━━━━━━━━━━━━━━
      🔒 **二 次 验 证**
━━━━━━━━━━━━━━━━━━━━━━━━━━

🛡️ **防止作弊，二次认证**

📌 本活动**只会验证这一次**
📌 不会多次验证
📌 完成后**永久免验证**

━━━━ 📱 **验证教程** ━━━━

1️⃣ 打开支付宝，扫描下方二维码
2️⃣ 找到【凑分】活动
3️⃣ 点击进入活动页面
4️⃣ 对当前页面**截图**
5️⃣ 上传完成验证

🎉 **完成后无需再次认证！**

━━━━━━━━━━━━━━━━━━━━━━━━━━

📤 **请上传图片完成验证：**
`;
    
    try {
        if (ctx.callbackQuery) {
            try { await ctx.deleteMessage(); } catch (e) {}
        }
        
        if (FILE_ID_YZ_1 && FILE_ID_YZ_1 !== "YOUR_YZ_TUTORIAL_1_FILE_ID") {
            try { await ctx.replyWithPhoto(FILE_ID_YZ_1); } catch (e) {}
        }
        if (FILE_ID_YZ_2 && FILE_ID_YZ_2 !== "YOUR_YZ_TUTORIAL_2_FILE_ID") {
            try { await ctx.replyWithPhoto(FILE_ID_YZ_2); } catch (e) {}
        }
        if (FILE_ID_YZ_3 && FILE_ID_YZ_3 !== "YOUR_YZ_TUTORIAL_3_FILE_ID") {
            try { await ctx.replyWithPhoto(FILE_ID_YZ_3); } catch (e) {}
        }
        
        await ctx.reply(yzText, { reply_markup: keyboard, parse_mode: "Markdown" });
    } catch (error) {
        console.error("showYzPage error:", error);
    }
}

// ==================== VIP 页面 ====================

async function showVPage(ctx) {
    const userId = ctx.from.id;
    await setState(userId, "viewing_vip", { attempts: 0 });
    
    const keyboard = new InlineKeyboard()
        .text("✅ 我已付款，开始验证", "vip_paid")
        .row()
        .text("🔙 返回", "go_to_start");
    
    const vText = `
🎊 **喜迎新春（特价）** 🧧

💎 **VIP会员特权说明**：

✅ 专属中转通道
✅ 优先审核入群
✅ 7x24小时客服支持
✅ 定期福利活动

━━━━━━━━━━━━━━━━━━━━
`;
    
    try {
        if (ctx.callbackQuery) {
            try { await ctx.deleteMessage(); } catch (e) {}
        }
        
        if (FILE_ID_PAYMENT && FILE_ID_PAYMENT !== "YOUR_PAYMENT_QR_FILE_ID") {
            await ctx.replyWithPhoto(FILE_ID_PAYMENT, {
                caption: vText,
                reply_markup: keyboard,
                parse_mode: "Markdown"
            });
        } else {
            await ctx.reply(vText + "\n(⚠️ 管理员未设置收款码)", { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        }
    } catch (error) {
        console.error("showVPage error:", error);
    }
}

async function showVipOrderPage(ctx, attempts = 0) {
    const userId = ctx.from.id;
    await setState(userId, "awaiting_order_number", { attempts: attempts });
    
    const keyboard = new InlineKeyboard()
        .text("🔙 取消", "go_to_dh");
    
    const orderText = `
🧾 **订单号验证**

请按以下步骤查找您的订单号：

📱 打开**支付宝**
      ↓
👤 点击右下角【**我的**】
      ↓
📋 点击【**账单**】
      ↓
🔍 找到该笔交易，点击进入
      ↓
📄 点击【**账单详情**】
      ↓
⚙️ 点击右上角【**更多**】
      ↓
📝 长按复制【**订单号**】

━━━━━━━━━━━━━━━━━━━━

📤 **请输入您的订单号：**
${attempts > 0 ? `\n⚠️ 已尝试 ${attempts}/2 次` : ''}
`;
    
    try {
        if (ctx.callbackQuery) {
            try { await ctx.deleteMessage(); } catch (e) {}
        }
        
        if (FILE_ID_ORDER && FILE_ID_ORDER !== "YOUR_ORDER_TUTORIAL_FILE_ID") {
            await ctx.replyWithPhoto(FILE_ID_ORDER, {
                caption: orderText,
                reply_markup: keyboard,
                parse_mode: "Markdown"
            });
        } else {
            await ctx.reply(orderText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        }
    } catch (error) {
        console.error("showVipOrderPage error:", error);
    }
}
// ==================== 管理后台页面 ====================

async function showAdminPage(ctx) {
    await clearState(ctx.from.id);
    
    const keyboard = new InlineKeyboard()
        .text("📂 File ID 工具", "admin_fileid")
        .row()
        .text("🛍️ 频道转发库", "admin_products_1")
        .row()
        .text("📋 待处理", "admin_pending");
    
    const adminText = `
🔧 **后台管理面板**

━━━━━━━━━━━━━━━━━━━━

💡 输入 /c 可随时取消操作
`;
    
    try {
        if (ctx.callbackQuery) {
            try { await ctx.deleteMessage(); } catch (e) {}
        }
        await ctx.reply(adminText, { reply_markup: keyboard, parse_mode: "Markdown" });
    } catch (error) {
        console.error("showAdminPage error:", error);
    }
}

async function showProductsPage(ctx, page = 1) {
    const offset = (page - 1) * 10;
    const countRes = await pool.query("SELECT COUNT(*) FROM products");
    const totalCount = parseInt(countRes.rows[0].count);
    const productsRes = await pool.query(
        "SELECT id, keyword, content_type FROM products ORDER BY id ASC LIMIT 10 OFFSET $1",
        [offset]
    );
    
    const keyboard = new InlineKeyboard()
        .text("➕ 添加商品", "admin_add_product")
        .row();
    
    productsRes.rows.forEach(product => {
        keyboard.text(`❌ [${product.id}] ${product.keyword}`, `admin_del_ask_${product.id}`).row();
    });
    
    if (totalCount > 10) {
        const navButtons = createPaginationKeyboard(page, totalCount, "admin_products");
        navButtons.forEach(btn => keyboard.text(btn.text, btn.callback_data));
        keyboard.row();
    }
    
    keyboard.text("🔙 返回后台", "admin_back");
    
    const productsText = `
🛍️ **频道转发库**（商品管理）

📦 当前商品数量：**${totalCount}** 个
📄 第 **${page}** 页

━━━━━━━━━━━━━━━━━━━━
`;
    
    try {
        if (ctx.callbackQuery) {
            try { await ctx.deleteMessage(); } catch (e) {}
        }
        await ctx.reply(productsText, { reply_markup: keyboard, parse_mode: "Markdown" });
    } catch (error) {
        console.error("showProductsPage error:", error);
    }
}

async function showPendingPage(ctx) {
    const firstCount = await pool.query(
        "SELECT COUNT(*) FROM pending_reviews WHERE review_type = 'first' AND status = 'pending'"
    );
    const secondCount = await pool.query(
        "SELECT COUNT(*) FROM pending_reviews WHERE review_type = 'second' AND status = 'pending'"
    );
    const vipCount = await pool.query(
        "SELECT COUNT(*) FROM pending_reviews WHERE review_type = 'vip' AND status = 'pending'"
    );
    
    const keyboard = new InlineKeyboard()
        .text(`🔐 首次验证 (${firstCount.rows[0].count})`, "pending_first_1")
        .row()
        .text(`🔒 二次验证 (${secondCount.rows[0].count})`, "pending_second_1")
        .row()
        .text(`💎 VIP验证 (${vipCount.rows[0].count})`, "pending_vip_1")
        .row()
        .text("🔙 返回后台", "admin_back");
    
    const pendingText = `
📋 **待处理中心**

━━━━━━━━━━━━━━━━━━━━

点击查看各类型待处理工单：
`;
    
    try {
        if (ctx.callbackQuery) {
            try { await ctx.deleteMessage(); } catch (e) {}
        }
        await ctx.reply(pendingText, { reply_markup: keyboard, parse_mode: "Markdown" });
    } catch (error) {
        console.error("showPendingPage error:", error);
    }
}

async function showPendingList(ctx, type, page = 1) {
    const offset = (page - 1) * 10;
    const countRes = await pool.query(
        "SELECT COUNT(*) FROM pending_reviews WHERE review_type = $1 AND status = 'pending'",
        [type]
    );
    const totalCount = parseInt(countRes.rows[0].count);
    const pendingRes = await pool.query(
        `SELECT * FROM pending_reviews 
         WHERE review_type = $1 AND status = 'pending' 
         ORDER BY submitted_at ASC 
         LIMIT 10 OFFSET $2`,
        [type, offset]
    );
    
    const typeNames = {
        'first': '🔐 首次验证',
        'second': '🔒 二次验证',
        'vip': '💎 VIP验证'
    };
    
    const keyboard = new InlineKeyboard();
    
    pendingRes.rows.forEach(item => {
        const name = item.first_name || item.username || 'Unknown';
        keyboard.text(`📌 ${name} (${item.user_id})`, `review_${item.id}`).row();
    });
    
    if (totalCount > 10) {
        const navButtons = createPaginationKeyboard(page, totalCount, `pending_${type}`);
        navButtons.forEach(btn => keyboard.text(btn.text, btn.callback_data));
        keyboard.row();
    }
    
    keyboard.text("🔙 返回", "admin_pending");
    
    const listText = `
${typeNames[type]} **待处理列表**

📊 共 **${totalCount}** 条待处理

━━━━━━━━━━━━━━━━━━━━
`;
    
    try {
        if (ctx.callbackQuery) {
            try { await ctx.deleteMessage(); } catch (e) {}
        }
        await ctx.reply(listText, { reply_markup: keyboard, parse_mode: "Markdown" });
    } catch (error) {
        console.error("showPendingList error:", error);
    }
}

async function showReviewDetail(ctx, reviewId) {
    const res = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [reviewId]);
    
    if (res.rows.length === 0) {
        await ctx.answerCallbackQuery({ text: "记录不存在", show_alert: true });
        return;
    }
    
    const review = res.rows[0];
    const typeNames = {
        'first': '首次验证',
        'second': '二次验证',
        'vip': 'VIP验证'
    };
    
    // 四个按钮
    const keyboard = new InlineKeyboard()
        .text("✅ 确认", `review_approve_${reviewId}`)
        .text("❌ 驳回", `review_reject_${reviewId}`)
        .row()
        .text("🚫 封禁", `review_ban_${reviewId}`)
        .text("🗑️ 删除", `review_delete_${reviewId}`)
        .row()
        .text("🔙 返回列表", `pending_${review.review_type}_1`);
    
    const submitTime = new Date(review.submitted_at);
    const timeStr = submitTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    
    let detailText = `
📋 **【${typeNames[review.review_type]}】工单详情**

👤 用户：@${review.username || 'N/A'}
📛 昵称：${review.first_name || 'N/A'}
🆔 ID：\`${review.user_id}\`
📅 时间：${timeStr}
`;
    
    if (review.review_type === 'vip' && review.order_number) {
        detailText += `\n🧾 订单号：\`${review.order_number}\``;
    }
    
    try {
        if (ctx.callbackQuery) {
            try { await ctx.deleteMessage(); } catch (e) {}
        }
        
        if (review.file_id && review.review_type !== 'vip') {
            await ctx.replyWithPhoto(review.file_id, {
                caption: detailText,
                reply_markup: keyboard,
                parse_mode: "Markdown"
            });
        } else {
            await ctx.reply(detailText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        }
    } catch (error) {
        console.error("showReviewDetail error:", error);
    }
}
// ==================== 命令处理 ====================

bot.command("start", async (ctx) => {
    try {
        const payload = ctx.match;
        console.log(`[/start] payload=${payload}`);
        
        if (payload === "dh") {
            await showDhPage(ctx);
        } else {
            await showStartPage(ctx);
        }
    } catch (error) {
        console.error("start error:", error);
    }
});

bot.command("dh", async (ctx) => {
    try {
        await showDhPage(ctx);
    } catch (error) {
        console.error("dh error:", error);
    }
});

bot.command("y", async (ctx) => {
    try {
        await showYPage(ctx);
    } catch (error) {
        console.error("y error:", error);
    }
});

bot.command("yz", async (ctx) => {
    try {
        await showYzPage(ctx);
    } catch (error) {
        console.error("yz error:", error);
    }
});

bot.command("v", async (ctx) => {
    try {
        await showVPage(ctx);
    } catch (error) {
        console.error("v error:", error);
    }
});

bot.command("admin", async (ctx) => {
    try {
        if (ctx.from.id !== ADMIN_ID) return;
        await showAdminPage(ctx);
    } catch (error) {
        console.error("admin error:", error);
    }
});

bot.command("c", async (ctx) => {
    try {
        if (ctx.from.id !== ADMIN_ID) return;
        await clearState(ctx.from.id);
        await ctx.reply("🚫 **操作已取消**", { parse_mode: "Markdown" });
        await showAdminPage(ctx);
    } catch (error) {
        console.error("c error:", error);
    }
});

bot.command("cz", async (ctx) => {
    try {
        if (ctx.from.id !== ADMIN_ID) return;
        
        // 重置管理员为普通用户状态
        await pool.query(
            `UPDATE users SET 
                is_vip = FALSE,
                is_banned = FALSE,
                first_verify_passed = FALSE,
                second_verify_passed = FALSE,
                first_verify_date = $1,
                first_verify_time = NULL,
                click_count = 0,
                reject_count_first = 0,
                reject_count_second = 0,
                needs_manual_review = FALSE
             WHERE telegram_id = $2`,
            [getBeijingDateString(), ADMIN_ID]
        );
        
        await clearState(ADMIN_ID);
        
        await ctx.reply(`
✅ **测试模式已启用**

您的状态已重置为普通用户：
• 首次验证：未完成
• 二次验证：未完成
• 点击次数：0

📝 现在可以测试完整流程
📝 发送的验证图片会生成工单

💡 输入 /c 可恢复管理员状态
`, { parse_mode: "Markdown" });
        
        await showStartPage(ctx);
    } catch (error) {
        console.error("cz error:", error);
    }
});
// ==================== 回调处理 ====================

bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery();
});

bot.callbackQuery("go_to_start", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showStartPage(ctx);
});

bot.callbackQuery("go_to_dh", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDhPage(ctx);
});

bot.callbackQuery("force_go_dh", async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearState(ctx.from.id);
    await showDhPage(ctx);
});

bot.callbackQuery("go_to_v", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showVPage(ctx);
});

bot.callbackQuery("go_to_y", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showYPage(ctx);
});

bot.callbackQuery("refresh_y_status", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "正在刷新..." });
    const userData = await getOrInitUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    if (userData.first_verify_passed) {
        await showDhPage(ctx);
    } else if (userData.needs_manual_review) {
        await showYPage(ctx);
    } else {
        await showYPage(ctx);
    }
});

bot.callbackQuery("vip_paid", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showVipOrderPage(ctx, 0);
});

bot.callbackQuery(/^dh_page_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = parseInt(ctx.match[1]);
    await showDhPage(ctx, page);
});

// 商品点击
bot.callbackQuery(/^product_(\d+)$/, async (ctx) => {
    try {
        const productId = parseInt(ctx.match[1]);
        const userId = ctx.from.id;
        const userData = await getOrInitUser(userId, ctx.from.username, ctx.from.first_name);
        
        console.log(`[product] 用户${userId} 点击商品${productId}, first_verify_passed=${userData.first_verify_passed}`);
        
        if (userData.is_banned) {
            await ctx.answerCallbackQuery({ text: "你已被封禁", show_alert: true });
            return;
        }
        
        // 检查二次验证
        if (userData.first_verify_passed && !userData.second_verify_passed) {
            const newCount = await incrementClickCount(userId);
            console.log(`[product] 用户${userId} 点击次数=${newCount}`);
            
            if (newCount >= 5) {
                await ctx.answerCallbackQuery();
                await showYzPage(ctx);
                return;
            }
            
            const needSecond = await checkNeedSecondVerify(userId);
            if (needSecond) {
                await ctx.answerCallbackQuery();
                await showYzPage(ctx);
                return;
            }
        }
        
        // 未首次验证
        if (!userData.first_verify_passed) {
            await ctx.answerCallbackQuery();
            
            const keyboard = new InlineKeyboard()
                .text("❌ 取消", "go_to_dh")
                .text("✅ 确认兑换", "go_to_y");
            
            try { await ctx.deleteMessage(); } catch (e) {}
            
            await ctx.reply(`
📦 **是否兑换？**

确认后需要完成首次验证
即可免费观看所有资源~
`, { reply_markup: keyboard, parse_mode: "Markdown" });
            return;
        }
        
        // 已验证，发送商品内容
        await ctx.answerCallbackQuery({ text: "🎉 正在获取..." });
        
        if (!userData.second_verify_passed) {
            await incrementClickCount(userId);
        }
        
        const productRes = await pool.query("SELECT * FROM products WHERE id = $1", [productId]);
        
        if (productRes.rows.length === 0) {
            await ctx.reply("⚠️ 商品不存在或已下架");
            return;
        }
        
        const product = productRes.rows[0];
        const chatId = ctx.chat.id;
        
        // 发送提示
        const tipMsg = await ctx.reply(`
🎉 **获取成功！**

📦 商品：${product.keyword}
⏰ 内容将在 5 分钟后自动删除

━━━━━━━━━━━━━━━━━━━━

${userData.is_vip ? '👑 **VIP会员** - 无限畅享' : '🎁 **免费用户** - 验证已通过'}
`, { parse_mode: "Markdown" });
        
        scheduleDeleteMessage(chatId, tipMsg.message_id, 300000);
        
        // 发送商品内容
        try {
            let sentMsg;
            if (product.content_type === 'text') {
                sentMsg = await ctx.reply(product.content_data);
                scheduleDeleteMessage(chatId, sentMsg.message_id, 300000);
            } else if (product.content_type === 'photo') {
                sentMsg = await ctx.replyWithPhoto(product.content_data);
                scheduleDeleteMessage(chatId, sentMsg.message_id, 300000);
            } else if (product.content_type === 'video') {
                sentMsg = await ctx.replyWithVideo(product.content_data);
                scheduleDeleteMessage(chatId, sentMsg.message_id, 300000);
            } else if (product.content_type === 'document') {
                sentMsg = await ctx.replyWithDocument(product.content_data);
                scheduleDeleteMessage(chatId, sentMsg.message_id, 300000);
            } else if (product.content_type === 'media_group') {
                const contents = JSON.parse(product.content_data);
                for (const item of contents) {
                    let msg;
                    if (item.type === 'photo') {
                        msg = await ctx.replyWithPhoto(item.data);
                    } else if (item.type === 'video') {
                        msg = await ctx.replyWithVideo(item.data);
                    } else if (item.type === 'document') {
                        msg = await ctx.replyWithDocument(item.data);
                    } else {
                        msg = await ctx.reply(item.data);
                    }
                    scheduleDeleteMessage(chatId, msg.message_id, 300000);
                }
            } else {
                sentMsg = await ctx.reply(product.content_data);
                scheduleDeleteMessage(chatId, sentMsg.message_id, 300000);
            }
        } catch (e) {
            console.error("发送商品失败:", e);
            await ctx.reply("⚠️ 内容发送失败，请联系管理员");
        }
    } catch (error) {
        console.error("product callback error:", error);
    }
});

// ==================== 管理后台回调 ====================

bot.callbackQuery("admin_back", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showAdminPage(ctx);
});

bot.callbackQuery("admin_fileid", async (ctx) => {
    await ctx.answerCallbackQuery();
    await setState(ctx.from.id, "awaiting_file_id", null);
    
    const keyboard = new InlineKeyboard().text("🔙 取消", "admin_back");
    
    try { await ctx.deleteMessage(); } catch (e) {}
    await ctx.reply(`
📂 **File ID 工具**

📸 请发送一张图片

━━━━━━━━━━━━━━━━━━━━

💡 输入 /c 可取消
`, { reply_markup: keyboard, parse_mode: "Markdown" });
});

bot.callbackQuery(/^admin_products_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showProductsPage(ctx, parseInt(ctx.match[1]));
});

bot.callbackQuery("admin_add_product", async (ctx) => {
    await ctx.answerCallbackQuery();
    await setState(ctx.from.id, "awaiting_product_keyword", null);
    
    const keyboard = new InlineKeyboard().text("🔙 取消", "admin_products_1");
    
    try { await ctx.deleteMessage(); } catch (e) {}
    await ctx.reply(`
➕ **添加商品**

📝 请输入商品关键词（如：001）
`, { reply_markup: keyboard, parse_mode: "Markdown" });
});

bot.callbackQuery("admin_confirm_product", async (ctx) => {
    await ctx.answerCallbackQuery();
    
    const userState = await getState(ctx.from.id);
    
    if (!userState.temp_data || !userState.temp_data.keyword) {
        await ctx.reply("⚠️ 没有待上架的商品");
        await showAdminPage(ctx);
        return;
    }
    
    const { keyword, contents } = userState.temp_data;
    
    if (!contents || contents.length === 0) {
        await ctx.reply("⚠️ 请至少上传一条内容");
        return;
    }
    
    let contentType, contentData;
    if (contents.length === 1) {
        contentType = contents[0].type;
        contentData = contents[0].data;
    } else {
        contentType = 'media_group';
        contentData = JSON.stringify(contents);
    }
    
    try {
        await pool.query(
            "INSERT INTO products (keyword, content_type, content_data) VALUES ($1, $2, $3)",
            [keyword, contentType, contentData]
        );
        
        await ctx.reply(`
🎉 **商品上架成功！**

📦 关键词：${keyword}
📝 内容数量：${contents.length} 条
`, { parse_mode: "Markdown" });
        
        await clearState(ctx.from.id);
        await showProductsPage(ctx);
    } catch (e) {
        if (e.code === '23505') {
            await ctx.reply("⚠️ 该关键词已存在");
        } else {
            await ctx.reply("⚠️ 保存失败");
        }
    }
});

bot.callbackQuery("admin_cancel_product", async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearState(ctx.from.id);
    await ctx.reply("🚫 已取消");
    await showProductsPage(ctx);
});

bot.callbackQuery(/^admin_del_ask_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const productId = ctx.match[1];
    
    const keyboard = new InlineKeyboard()
        .text("✅ 确认删除", `admin_del_confirm_${productId}`)
        .text("🔙 取消", "admin_products_1");
    
    try { await ctx.deleteMessage(); } catch (e) {}
    await ctx.reply("⚠️ **确认删除此商品吗？**", { reply_markup: keyboard, parse_mode: "Markdown" });
});

bot.callbackQuery(/^admin_del_confirm_(\d+)$/, async (ctx) => {
    await pool.query("DELETE FROM products WHERE id = $1", [ctx.match[1]]);
    await ctx.answerCallbackQuery({ text: "🗑️ 已删除" });
    await showProductsPage(ctx);
});

bot.callbackQuery("admin_pending", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showPendingPage(ctx);
});

bot.callbackQuery(/^pending_(first|second|vip)_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showPendingList(ctx, ctx.match[1], parseInt(ctx.match[2]));
});

bot.callbackQuery(/^review_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showReviewDetail(ctx, parseInt(ctx.match[1]));
});
// ==================== 审核回调 ====================

bot.callbackQuery(/^review_approve_(\d+)$/, async (ctx) => {
    const reviewId = parseInt(ctx.match[1]);
    const res = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [reviewId]);
    if (res.rows.length === 0) return ctx.answerCallbackQuery({ text: "不存在", show_alert: true });
    
    const review = res.rows[0];
    await pool.query("UPDATE pending_reviews SET status = 'approved' WHERE id = $1", [reviewId]);
    
    if (review.review_type === 'first') {
        await pool.query("UPDATE users SET first_verify_passed = TRUE, needs_manual_review = FALSE WHERE telegram_id = $1", [review.user_id]);
    } else if (review.review_type === 'vip') {
        await pool.query("UPDATE users SET is_vip = TRUE WHERE telegram_id = $1", [review.user_id]);
    }
    
    await ctx.answerCallbackQuery({ text: "✅ 已确认" });
    await showPendingList(ctx, review.review_type);
});

bot.callbackQuery(/^review_reject_(\d+)$/, async (ctx) => {
    const reviewId = parseInt(ctx.match[1]);
    const res = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [reviewId]);
    if (res.rows.length === 0) return ctx.answerCallbackQuery({ text: "不存在", show_alert: true });
    
    const review = res.rows[0];
    await pool.query("UPDATE pending_reviews SET status = 'rejected' WHERE id = $1", [reviewId]);
    
    if (review.review_type === 'first') {
        const userRes = await pool.query("SELECT reject_count_first FROM users WHERE telegram_id = $1", [review.user_id]);
        const newCount = (userRes.rows[0]?.reject_count_first || 0) + 1;
        
        if (newCount >= 2) {
            await pool.query("UPDATE users SET reject_count_first = $1, first_verify_passed = FALSE, needs_manual_review = TRUE WHERE telegram_id = $2", [newCount, review.user_id]);
            try {
                await bot.api.sendMessage(review.user_id, `
⚠️ **验证已被驳回**

您已被驳回 ${newCount} 次，需要等待管理员重新审核。
每日凌晨 00:00 重置。

请上传正确的截图！
`, { parse_mode: "Markdown" });
            } catch (e) {}
        } else {
            await pool.query("UPDATE users SET reject_count_first = $1, first_verify_passed = FALSE WHERE telegram_id = $2", [newCount, review.user_id]);
            try {
                await bot.api.sendMessage(review.user_id, `
⚠️ **验证被驳回**

请上传包含【时间】和【助力成功】的截图！
⚠️ 再次错误将需要等待管理员审核！

输入 /y 继续验证
`, { parse_mode: "Markdown" });
            } catch (e) {}
        }
    } else if (review.review_type === 'second') {
        await pool.query("UPDATE users SET second_verify_passed = FALSE WHERE telegram_id = $1", [review.user_id]);
        try {
            await bot.api.sendMessage(review.user_id, `
⚠️ **二次验证被驳回**

请不要作弊！输入 /yz 继续验证
`, { parse_mode: "Markdown" });
        } catch (e) {}
    }
    
    await ctx.answerCallbackQuery({ text: "❌ 已驳回" });
    await showPendingList(ctx, review.review_type);
});

bot.callbackQuery(/^review_ban_(\d+)$/, async (ctx) => {
    const reviewId = parseInt(ctx.match[1]);
    const res = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [reviewId]);
    if (res.rows.length === 0) return ctx.answerCallbackQuery({ text: "不存在", show_alert: true });
    
    const review = res.rows[0];
    await pool.query("UPDATE pending_reviews SET status = 'banned' WHERE id = $1", [reviewId]);
    await pool.query("UPDATE users SET is_banned = TRUE WHERE telegram_id = $1", [review.user_id]);
    
    try {
        await bot.api.sendMessage(review.user_id, `
🚫 **您已被封禁**

多次作弊已被永久封禁。
请购买会员继续使用。

输入 /v 查看会员
`, { parse_mode: "Markdown" });
    } catch (e) {}
    
    await ctx.answerCallbackQuery({ text: "🚫 已封禁" });
    await showPendingList(ctx, review.review_type);
});

bot.callbackQuery(/^review_delete_(\d+)$/, async (ctx) => {
    const reviewId = parseInt(ctx.match[1]);
    const res = await pool.query("SELECT review_type FROM pending_reviews WHERE id = $1", [reviewId]);
    const type = res.rows[0]?.review_type || 'first';
    
    await pool.query("DELETE FROM pending_reviews WHERE id = $1", [reviewId]);
    await ctx.answerCallbackQuery({ text: "🗑️ 已删除" });
    await showPendingList(ctx, type);
});

// 快捷审核
bot.callbackQuery(/^quick_approve_(first|second|vip)_(\d+)$/, async (ctx) => {
    const type = ctx.match[1];
    const userId = parseInt(ctx.match[2]);
    
    if (type === 'first') {
        await pool.query("UPDATE users SET first_verify_passed = TRUE, needs_manual_review = FALSE WHERE telegram_id = $1", [userId]);
    } else if (type === 'vip') {
        await pool.query("UPDATE users SET is_vip = TRUE WHERE telegram_id = $1", [userId]);
    }
    await pool.query("UPDATE pending_reviews SET status = 'approved' WHERE user_id = $1 AND review_type = $2 AND status = 'pending'", [userId, type]);
    
    await ctx.answerCallbackQuery({ text: "✅ 已确认" });
    try {
        const msg = ctx.callbackQuery.message;
        const newCaption = (msg.caption || msg.text) + "\n\n✅ **已确认**";
        if (msg.photo) {
            await ctx.editMessageCaption({ caption: newCaption, parse_mode: "Markdown" });
        } else {
            await ctx.editMessageText(newCaption, { parse_mode: "Markdown" });
        }
    } catch (e) {}
});

bot.callbackQuery(/^quick_reject_(first|second|vip)_(\d+)$/, async (ctx) => {
    const type = ctx.match[1];
    const userId = parseInt(ctx.match[2]);
    
    if (type === 'first') {
        const userRes = await pool.query("SELECT reject_count_first FROM users WHERE telegram_id = $1", [userId]);
        const newCount = (userRes.rows[0]?.reject_count_first || 0) + 1;
        if (newCount >= 2) {
            await pool.query("UPDATE users SET reject_count_first = $1, first_verify_passed = FALSE, needs_manual_review = TRUE WHERE telegram_id = $2", [newCount, userId]);
        } else {
            await pool.query("UPDATE users SET reject_count_first = $1, first_verify_passed = FALSE WHERE telegram_id = $2", [newCount, userId]);
        }
        try { await bot.api.sendMessage(userId, "⚠️ 验证被驳回，请输入 /y 重新验证"); } catch (e) {}
    } else if (type === 'second') {
        await pool.query("UPDATE users SET second_verify_passed = FALSE WHERE telegram_id = $1", [userId]);
        try { await bot.api.sendMessage(userId, "⚠️ 二次验证被驳回，请输入 /yz 重新验证"); } catch (e) {}
    }
    
    await pool.query("UPDATE pending_reviews SET status = 'rejected' WHERE user_id = $1 AND review_type = $2 AND status = 'pending'", [userId, type]);
    await ctx.answerCallbackQuery({ text: "❌ 已驳回" });
    
    try {
        const msg = ctx.callbackQuery.message;
        const newCaption = (msg.caption || msg.text) + "\n\n❌ **已驳回**";
        if (msg.photo) {
            await ctx.editMessageCaption({ caption: newCaption, parse_mode: "Markdown" });
        } else {
            await ctx.editMessageText(newCaption, { parse_mode: "Markdown" });
        }
    } catch (e) {}
});

bot.callbackQuery(/^quick_ban_(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    await pool.query("UPDATE users SET is_banned = TRUE WHERE telegram_id = $1", [userId]);
    await pool.query("UPDATE pending_reviews SET status = 'banned' WHERE user_id = $1 AND status = 'pending'", [userId]);
    
    try { await bot.api.sendMessage(userId, "🚫 您已被封禁"); } catch (e) {}
    await ctx.answerCallbackQuery({ text: "🚫 已封禁" });
    
    try {
        const msg = ctx.callbackQuery.message;
        const newCaption = (msg.caption || msg.text) + "\n\n🚫 **已封禁**";
        if (msg.photo) {
            await ctx.editMessageCaption({ caption: newCaption, parse_mode: "Markdown" });
        } else {
            await ctx.editMessageText(newCaption, { parse_mode: "Markdown" });
        }
    } catch (e) {}
});

bot.callbackQuery(/^quick_delete_(first|second|vip)_(\d+)$/, async (ctx) => {
    const type = ctx.match[1];
    const userId = parseInt(ctx.match[2]);
    await pool.query("DELETE FROM pending_reviews WHERE user_id = $1 AND review_type = $2 AND status = 'pending'", [userId, type]);
    await ctx.answerCallbackQuery({ text: "🗑️ 已删除" });
    try { await ctx.deleteMessage(); } catch (e) {}
});

// ==================== 消息处理 ====================

bot.on("message", async (ctx) => {
    try {
        const userId = ctx.from.id;
        const userState = await getState(userId);
        const text = ctx.message.text || "";
        
        console.log(`[message] 用户${userId} state=${userState.state} text=${text.substring(0, 20)}`);
        
        // ========== 管理员状态 ==========
        if (userId === ADMIN_ID) {
            if (userState.state === "awaiting_file_id") {
                if (ctx.message.photo) {
                    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                    await ctx.reply(`📂 **File ID：**\n\n\`${fileId}\``, { parse_mode: "Markdown" });
                    await clearState(userId);
                    await showAdminPage(ctx);
                } else {
                    await ctx.reply("⚠️ 请发送图片");
                }
                return;
            }
            
            if (userState.state === "awaiting_product_keyword") {
                const keyword = text.trim();
                if (!keyword) {
                    await ctx.reply("⚠️ 关键词不能为空");
                    return;
                }
                
                const exist = await pool.query("SELECT id FROM products WHERE keyword = $1", [keyword]);
                if (exist.rows.length > 0) {
                    await ctx.reply("⚠️ 关键词已存在");
                    return;
                }
                
                await setState(userId, "collecting_product_content", { keyword: keyword, contents: [] });
                
                const keyboard = new InlineKeyboard()
                    .text("✅ 完成上架", "admin_confirm_product")
                    .text("❌ 取消", "admin_cancel_product");
                
                await ctx.reply(`
✅ 关键词：**${keyword}**

📤 **请上传商品内容**

可以发送多条（图片、视频、文件、文字）
发送完毕后点击【完成上架】
`, { reply_markup: keyboard, parse_mode: "Markdown" });
                return;
            }
            
            if (userState.state === "collecting_product_content") {
                const tempData = userState.temp_data || { keyword: "", contents: [] };
                let item = null;
                
                if (ctx.message.photo) {
                    item = { type: 'photo', data: ctx.message.photo[ctx.message.photo.length - 1].file_id };
                } else if (ctx.message.video) {
                    item = { type: 'video', data: ctx.message.video.file_id };
                } else if (ctx.message.document) {
                    item = { type: 'document', data: ctx.message.document.file_id };
                } else if (text && !text.startsWith('/')) {
                    item = { type: 'text', data: text };
                }
                
                if (item) {
                    tempData.contents.push(item);
                    await setState(userId, "collecting_product_content", tempData);
                    
                    const keyboard = new InlineKeyboard()
                        .text("✅ 完成上架", "admin_confirm_product")
                        .text("❌ 取消", "admin_cancel_product");
                    
                    await ctx.reply(`📥 已收到第 **${tempData.contents.length}** 条\n\n继续发送或点击【完成上架】`, { reply_markup: keyboard, parse_mode: "Markdown" });
                }
                return;
            }
        }
        
        // ========== 首次验证 ==========
        if (userState.state === "awaiting_first_verify") {
            if (ctx.message.photo) {
                const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                
                console.log(`[首次验证] 用户${userId} 上传图片 fileId=${fileId}`);
                
                // 更新用户状态
                await pool.query(
                    `UPDATE users SET 
                        first_verify_passed = TRUE,
                        first_verify_time = CURRENT_TIMESTAMP
                     WHERE telegram_id = $1`,
                    [userId]
                );
                
                console.log(`[首次验证] 用户${userId} 已设置 first_verify_passed = TRUE`);
                
                // 发送给管理员
                const sent = await sendToAdmin(userId, ctx.from.username, ctx.from.first_name, 'first', fileId, null);
                console.log(`[首次验证] 发送给管理员结果: ${sent}`);
                
                await ctx.reply(`
✅ **验证成功！**

🎉 现在可以无限畅享所有资源啦~
`, { parse_mode: "Markdown" });
                
                await clearState(userId);
                await showDhPage(ctx);
            } else {
                await ctx.reply("❌ 请上传**图片**！", { parse_mode: "Markdown" });
            }
            return;
        }
        
        // ========== 二次验证 ==========
        if (userState.state === "awaiting_second_verify") {
            if (ctx.message.photo) {
                const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                
                console.log(`[二次验证] 用户${userId} 上传图片`);
                
                await pool.query("UPDATE users SET second_verify_passed = TRUE WHERE telegram_id = $1", [userId]);
                
                await sendToAdmin(userId, ctx.from.username, ctx.from.first_name, 'second', fileId, null);
                
                await ctx.reply(`
✅ **二次验证成功！**

🎉 永久免验证，畅享所有资源！
`, { parse_mode: "Markdown" });
                
                await clearState(userId);
                await showDhPage(ctx);
            } else {
                await ctx.reply("❌ 请上传**图片**！", { parse_mode: "Markdown" });
            }
            return;
        }
        
        // ========== VIP订单验证 ==========
        if (userState.state === "awaiting_order_number") {
            const attempts = userState.temp_data?.attempts || 0;
            
            if (text.startsWith("20260")) {
                const keyboard = new InlineKeyboard().url("🎁 加入会员群", VIP_GROUP_LINK);
                
                await ctx.reply(`
🎉 **验证成功！**

欢迎加入VIP会员！
`, { parse_mode: "Markdown", reply_markup: keyboard });
                
                await sendToAdmin(userId, ctx.from.username, ctx.from.first_name, 'vip', null, text);
                await clearState(userId);
            } else {
                const newAttempts = attempts + 1;
                if (newAttempts >= 2) {
                    await ctx.reply("❌ 订单号错误次数过多，请返回兑换页面");
                    await clearState(userId);
                    await showDhPage(ctx);
                } else {
                    await showVipOrderPage(ctx, newAttempts);
                }
            }
            return;
        }
        
        // 其他消息
        if (text && !text.startsWith('/')) {
            await showStartPage(ctx);
        }
    } catch (error) {
        console.error("message error:", error);
    }
});

// ==================== 错误处理 ====================
bot.catch((err) => {
    console.error("Bot error:", err);
});

// ==================== 导出 ====================
module.exports = webhookCallback(bot, "http");
