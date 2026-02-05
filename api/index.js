const { Bot, webhookCallback, InlineKeyboard } = require("grammy");
const { Pool } = require("pg");

// ============================================================
// 基础配置
// ============================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

// ============================================================
// FILE ID 配置（部署后通过 /admin -> File ID工具 获取）
// ============================================================

const FILE_ID_PAYMENT = "YOUR_PAYMENT_QR_FILE_ID";
const FILE_ID_ORDER = "YOUR_ORDER_TUTORIAL_FILE_ID";
const FILE_ID_Y_1 = "YOUR_Y_TUTORIAL_1_FILE_ID";
const FILE_ID_Y_2 = "YOUR_Y_TUTORIAL_2_FILE_ID";
const FILE_ID_YZ_1 = "YOUR_YZ_TUTORIAL_1_FILE_ID";
const FILE_ID_YZ_2 = "YOUR_YZ_TUTORIAL_2_FILE_ID";
const FILE_ID_YZ_3 = "YOUR_YZ_TUTORIAL_3_FILE_ID";

const VIP_GROUP_LINK = "https://t.me/+495j5rWmApsxYzg9";
// ============================================================
// 辅助函数
// ============================================================

function getBeijingTime() {
    const now = new Date();
    const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    return beijingTime;
}

function getBeijingDateString() {
    const beijingTime = getBeijingTime();
    const year = beijingTime.getUTCFullYear();
    const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(beijingTime.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getBeijingTimeString() {
    const beijingTime = getBeijingTime();
    const year = beijingTime.getUTCFullYear();
    const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(beijingTime.getUTCDate()).padStart(2, '0');
    const hours = String(beijingTime.getUTCHours()).padStart(2, '0');
    const minutes = String(beijingTime.getUTCMinutes()).padStart(2, '0');
    const seconds = String(beijingTime.getUTCSeconds()).padStart(2, '0');
    return `${year}.${month}.${day} 北京时间 ${hours}:${minutes}:${seconds}`;
}

// 【修复】获取或初始化用户 - 修复日期比较逻辑
async function getOrInitUser(userId, username, firstName) {
    const today = getBeijingDateString();
    
    // 先查询用户是否存在
    const checkResult = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [userId]);
    
    if (checkResult.rows.length === 0) {
        // 用户不存在，创建新用户
        console.log(`[getOrInitUser] 创建新用户: ${userId}`);
        await pool.query(
            `INSERT INTO users (telegram_id, username, first_name, first_verify_date, first_verify_passed, second_verify_passed, is_vip, is_banned, click_count, reject_count_first, reject_count_second, needs_manual_review)
             VALUES ($1, $2, $3, $4, FALSE, FALSE, FALSE, FALSE, 0, 0, 0, FALSE)`,
            [userId, username || null, firstName || null, today]
        );
        
        const newResult = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [userId]);
        return newResult.rows[0];
    }
    
    let userData = checkResult.rows[0];
    
    // 更新用户名和昵称
    await pool.query(
        `UPDATE users SET 
            username = COALESCE($1, username),
            first_name = COALESCE($2, first_name)
         WHERE telegram_id = $3`,
        [username || null, firstName || null, userId]
    );
    
    // 【修复】检查是否需要每日重置 - 正确比较日期
    const userDate = userData.first_verify_date;
    let userDateString = null;
    
    if (userDate) {
        if (typeof userDate === 'string') {
            userDateString = userDate.substring(0, 10);
        } else if (userDate instanceof Date) {
            const year = userDate.getFullYear();
            const month = String(userDate.getMonth() + 1).padStart(2, '0');
            const day = String(userDate.getDate()).padStart(2, '0');
            userDateString = `${year}-${month}-${day}`;
        }
    }
    
    console.log(`[getOrInitUser] 用户${userId}: 数据库日期=${userDateString}, 今天=${today}, first_verify_passed=${userData.first_verify_passed}`);
    
    // 只有日期不同才重置
    if (userDateString !== today) {
        console.log(`[getOrInitUser] 用户${userId}: 日期不同，执行每日重置`);
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
    } else {
        console.log(`[getOrInitUser] 用户${userId}: 日期相同，不重置`);
    }
    
    // 重新获取最新数据
    const freshResult = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [userId]);
    return freshResult.rows[0];
}

async function setState(userId, state, tempData) {
    let dataString = null;
    if (tempData !== undefined && tempData !== null) {
        dataString = JSON.stringify(tempData);
    }
    
    await pool.query(
        `INSERT INTO user_states (user_id, state, temp_data, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET 
            state = $2, 
            temp_data = $3,
            updated_at = CURRENT_TIMESTAMP`,
        [userId, state, dataString]
    );
}

async function getState(userId) {
    const result = await pool.query("SELECT * FROM user_states WHERE user_id = $1", [userId]);
    
    if (result.rows.length === 0) {
        return { state: "idle", temp_data: null };
    }
    
    const row = result.rows[0];
    let tempData = null;
    
    if (row.temp_data) {
        try {
            tempData = JSON.parse(row.temp_data);
        } catch (error) {
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
    
    const result = await pool.query(
        "SELECT click_count FROM users WHERE telegram_id = $1",
        [userId]
    );
    
    if (result.rows.length > 0) {
        return result.rows[0].click_count;
    }
    return 0;
}

async function checkNeedSecondVerify(userId) {
    const result = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [userId]);
    
    if (result.rows.length === 0) {
        return false;
    }
    
    const user = result.rows[0];
    
    if (user.second_verify_passed) {
        return false;
    }
    
    if (!user.first_verify_passed) {
        return false;
    }
    
    if (user.click_count >= 5) {
        return true;
    }
    
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

function createPaginationKeyboard(currentPage, totalCount, prefix) {
    const itemsPerPage = 10;
    const totalPages = Math.ceil(totalCount / itemsPerPage) || 1;
    const buttons = [];
    
    if (currentPage > 1) {
        buttons.push({
            text: "◀️",
            callback_data: `${prefix}_page_${currentPage - 1}`
        });
    }
    
    buttons.push({
        text: `${currentPage}/${totalPages}`,
        callback_data: "noop"
    });
    
    if (currentPage < totalPages) {
        buttons.push({
            text: "▶️",
            callback_data: `${prefix}_page_${currentPage + 1}`
        });
    }
    
    return buttons;
}

function scheduleMessageDeletion(chatId, messageId, delayMs) {
    setTimeout(async () => {
        try {
            await bot.api.deleteMessage(chatId, messageId);
            console.log(`[自动删除] 消息 ${messageId} 已删除`);
        } catch (error) {
            console.log(`[自动删除] 删除消息 ${messageId} 失败:`, error.message);
        }
    }, delayMs);
}
// ============================================================
// 【修复】发送工单给管理员 - 确保管理员测试也能收到工单
// ============================================================

async function sendToAdmin(userId, username, firstName, reviewType, fileId, orderNumber) {
    const timeString = getBeijingTimeString();
    
    const typeLabels = {
        'first': '🔐 首次验证',
        'second': '🔒 二次验证',
        'vip': '💎 VIP订单'
    };
    
    let caption = "";
    
    if (reviewType === 'first') {
        caption = `📋 **【${typeLabels[reviewType]}】待审核**

👤 用户：@${username || '无用户名'}
📛 昵称：${firstName || '无昵称'}
🆔 ID：\`${userId}\`
📅 时间：${timeString}`;
    } else if (reviewType === 'second') {
        caption = `📋 **【${typeLabels[reviewType]}】待审核**

👤 用户：@${username || '无用户名'}
📛 昵称：${firstName || '无昵称'}
🆔 ID：\`${userId}\`（二次验证）
📅 时间：${timeString}`;
    } else if (reviewType === 'vip') {
        caption = `📋 **【${typeLabels[reviewType]}】待审核**

👤 用户：@${username || '无用户名'}
📛 昵称：${firstName || '无昵称'}
🆔 ID：\`${userId}\`
📅 时间：${timeString}
🧾 订单号：\`${orderNumber}\``;
    }
    
    // 【修复】如果是管理员自己测试，添加标识
    if (userId === ADMIN_ID) {
        caption += `\n\n🧪 **[测试模式]**`;
    }
    
    console.log(`[sendToAdmin] 开始发送工单: type=${reviewType}, userId=${userId}, fileId=${fileId ? '有' : '无'}`);
    
    try {
        const keyboard = new InlineKeyboard()
            .text("✅", `quick_approve_${reviewType}_${userId}`)
            .text("❌", `quick_reject_${reviewType}_${userId}`)
            .text("🚫", `quick_ban_${userId}`)
            .text("🗑️", `quick_delete_${reviewType}_${userId}`);
        
        let adminMessage;
        
        if (fileId && reviewType !== 'vip') {
            console.log(`[sendToAdmin] 发送图片工单给管理员 ${ADMIN_ID}`);
            adminMessage = await bot.api.sendPhoto(ADMIN_ID, fileId, {
                caption: caption,
                parse_mode: "Markdown",
                reply_markup: keyboard
            });
            console.log(`[sendToAdmin] 图片工单发送成功, message_id=${adminMessage.message_id}`);
        } else {
            console.log(`[sendToAdmin] 发送文本工单给管理员 ${ADMIN_ID}`);
            adminMessage = await bot.api.sendMessage(ADMIN_ID, caption, {
                parse_mode: "Markdown",
                reply_markup: keyboard
            });
            console.log(`[sendToAdmin] 文本工单发送成功, message_id=${adminMessage.message_id}`);
        }
        
        // 保存到待处理队列
        await pool.query(
            `INSERT INTO pending_reviews 
             (user_id, username, first_name, review_type, file_id, order_number, submitted_at, message_id, status)
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7, 'pending')`,
            [userId, username, firstName, reviewType, fileId, orderNumber, adminMessage.message_id]
        );
        
        console.log(`[sendToAdmin] 工单已保存到数据库`);
        return true;
        
    } catch (error) {
        console.error("[sendToAdmin] 发送失败:", error);
        console.error("[sendToAdmin] 错误详情:", error.message);
        return false;
    }
}
// ============================================================
// /start 首页
// ============================================================

async function showStartPage(ctx) {
    const userId = ctx.from.id;
    const username = ctx.from.username;
    const firstName = ctx.from.first_name;
    
    await getOrInitUser(userId, username, firstName);
    await clearState(userId);
    
    const keyboard = new InlineKeyboard()
        .text("🎁 兑换", "go_to_dh");
    
    const welcomeText = `🎊✨ **喜迎二月除夕** ✨🎊

🎁 所有资源都【**免费观看**】！

📦 只需打开兑换，点击相应按钮
     即可直接免费观看~

🧧 **新春快乐，万事如意！**

━━━━━━━━━━━━━━━━━━━━`;
    
    try {
        if (ctx.callbackQuery) {
            try {
                await ctx.deleteMessage();
            } catch (deleteError) {
                console.log("删除消息失败:", deleteError.message);
            }
        }
        
        await ctx.reply(welcomeText, {
            reply_markup: keyboard,
            parse_mode: "Markdown"
        });
    } catch (error) {
        console.error("showStartPage 错误:", error);
    }
}
// ============================================================
// 【修复】/dh 兑换页面 - 修复验证状态检查
// ============================================================

async function showDhPage(ctx, page) {
    if (!page) {
        page = 1;
    }
    
    const userId = ctx.from.id;
    const username = ctx.from.username;
    const firstName = ctx.from.first_name;
    
    // 【修复】获取用户数据但不清除状态（状态在消息处理中已清除）
    const userData = await getOrInitUser(userId, username, firstName);
    
    console.log(`[showDhPage] 用户=${userId}, first_verify_passed=${userData.first_verify_passed}, second_verify_passed=${userData.second_verify_passed}, is_banned=${userData.is_banned}`);
    
    // 检查是否被封禁
    if (userData.is_banned) {
        const bannedKeyboard = new InlineKeyboard()
            .text("💎 加入会员（特价版）", "go_to_v");
        
        const bannedText = `🚫 **你已被本活动封禁**

请加入会员（特价版）👇`;
        
        try {
            if (ctx.callbackQuery) {
                try {
                    await ctx.deleteMessage();
                } catch (deleteError) {
                    console.log("删除消息失败:", deleteError.message);
                }
            }
            
            await ctx.reply(bannedText, {
                reply_markup: bannedKeyboard,
                parse_mode: "Markdown"
            });
        } catch (error) {
            console.error("显示封禁页面错误:", error);
        }
        return;
    }
    
    // 检查是否需要二次验证
    if (userData.first_verify_passed === true && userData.second_verify_passed === false) {
        const needSecondVerify = await checkNeedSecondVerify(userId);
        console.log(`[showDhPage] 用户=${userId}, needSecondVerify=${needSecondVerify}`);
        
        if (needSecondVerify) {
            if (ctx.callbackQuery) {
                try {
                    await ctx.deleteMessage();
                } catch (deleteError) {
                    console.log("删除消息失败:", deleteError.message);
                }
            }
            
            await showYzPage(ctx);
            return;
        }
    }
    
    // 获取商品列表
    const offset = (page - 1) * 10;
    
    const countResult = await pool.query("SELECT COUNT(*) FROM products");
    const totalCount = parseInt(countResult.rows[0].count);
    
    const productsResult = await pool.query(
        "SELECT id, keyword FROM products ORDER BY id ASC LIMIT 10 OFFSET $1",
        [offset]
    );
    
    const products = productsResult.rows;
    
    // 构建键盘
    const keyboard = new InlineKeyboard();
    
    // 添加商品按钮（每行2个）
    for (let i = 0; i < products.length; i += 2) {
        if (i + 1 < products.length) {
            keyboard
                .text(`📦 ${products[i].keyword}`, `product_${products[i].id}`)
                .text(`📦 ${products[i + 1].keyword}`, `product_${products[i + 1].id}`)
                .row();
        } else {
            keyboard
                .text(`📦 ${products[i].keyword}`, `product_${products[i].id}`)
                .row();
        }
    }
    
    // 添加分页按钮
    if (totalCount > 10) {
        const paginationButtons = createPaginationKeyboard(page, totalCount, "dh");
        paginationButtons.forEach(button => {
            keyboard.text(button.text, button.callback_data);
        });
        keyboard.row();
    }
    
    // 【修复】验证成功后显示加入会员按钮
    if (userData.first_verify_passed === true) {
        keyboard.text("💎 加入会员（新春特价）", "go_to_v").row();
    }
    
    // 返回首页按钮
    keyboard.text("🔙 返回首页", "go_to_start");
    
    // 构建文本
    let dhText;
    
    if (userData.first_verify_passed === true) {
        dhText = `📦 **兑换中心** ✨

🎉 验证已通过，**无限畅享**！
📥 点击编号即可免费观看

━━━━━━━━━━━━━━━━━━━━`;
    } else {
        dhText = `📦 **兑换中心**

🎉 点击对应编号按钮
✨ 即可立马**免费观看**

━━━━━━━━━━━━━━━━━━━━`;
    }
    
    if (products.length === 0) {
        dhText += `

🌑 暂无商品，请稍后再来~`;
    }
    
    try {
        if (ctx.callbackQuery) {
            try {
                await ctx.deleteMessage();
            } catch (deleteError) {
                console.log("删除消息失败:", deleteError.message);
            }
        }
        
        await ctx.reply(dhText, {
            reply_markup: keyboard,
            parse_mode: "Markdown"
        });
    } catch (error) {
        console.error("showDhPage 错误:", error);
    }
}
// ============================================================
// /y 首次验证页面
// ============================================================

async function showYPage(ctx) {
    const userId = ctx.from.id;
    const username = ctx.from.username;
    const firstName = ctx.from.first_name;
    
    const userData = await getOrInitUser(userId, username, firstName);
    
    // 检查是否需要等待管理员手动审核
    if (userData.needs_manual_review === true) {
        const waitingKeyboard = new InlineKeyboard()
            .text("🔄 刷新状态", "refresh_y_status");
        
        const waitingText = `⏳ **等待管理员审核**

您的验证已提交，请等待管理员审核。
审核通过后即可使用。

每日凌晨 00:00 重置。

━━━━━━━━━━━━━━━━━━━━`;
        
        try {
            if (ctx.callbackQuery) {
                try {
                    await ctx.deleteMessage();
                } catch (deleteError) {
                    console.log("删除消息失败:", deleteError.message);
                }
            }
            
            await ctx.reply(waitingText, {
                reply_markup: waitingKeyboard,
                parse_mode: "Markdown"
            });
        } catch (error) {
            console.error("显示等待审核页面错误:", error);
        }
        return;
    }
    
    // 设置用户状态为等待首次验证
    await setState(userId, "awaiting_first_verify", null);
    
    const keyboard = new InlineKeyboard()
        .text("🔙 返回兑换", "force_go_to_dh");
    
    const yText = `━━━━━━━━━━━━━━━━━━━━━━━━━━
      🔐 **首 次 验 证**
━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ **无套路**！只要验证即可
🤖 机器人三秒自动审核
🎁 验证后**无限畅享**所有资源

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

📤 **请上传图片开始验证：**`;
    
    try {
        if (ctx.callbackQuery) {
            try {
                await ctx.deleteMessage();
            } catch (deleteError) {
                console.log("删除消息失败:", deleteError.message);
            }
        }
        
        // 发送教程图片1
        if (FILE_ID_Y_1 && FILE_ID_Y_1 !== "YOUR_Y_TUTORIAL_1_FILE_ID") {
            try {
                await ctx.replyWithPhoto(FILE_ID_Y_1);
            } catch (photoError) {
                console.log("发送Y教程图片1失败:", photoError.message);
            }
        }
        
        // 发送教程图片2
        if (FILE_ID_Y_2 && FILE_ID_Y_2 !== "YOUR_Y_TUTORIAL_2_FILE_ID") {
            try {
                await ctx.replyWithPhoto(FILE_ID_Y_2);
            } catch (photoError) {
                console.log("发送Y教程图片2失败:", photoError.message);
            }
        }
        
        // 发送验证提示文本
        await ctx.reply(yText, {
            reply_markup: keyboard,
            parse_mode: "Markdown"
        });
        
    } catch (error) {
        console.error("showYPage 错误:", error);
    }
}
// ============================================================
// /yz 二次验证页面
// ============================================================

async function showYzPage(ctx) {
    const userId = ctx.from.id;
    
    // 设置用户状态为等待二次验证
    await setState(userId, "awaiting_second_verify", null);
    
    const keyboard = new InlineKeyboard()
        .text("🔙 返回兑换", "force_go_to_dh");
    
    const yzText = `━━━━━━━━━━━━━━━━━━━━━━━━━━
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

📤 **请上传图片完成验证：**`;
    
    try {
        if (ctx.callbackQuery) {
            try {
                await ctx.deleteMessage();
            } catch (deleteError) {
                console.log("删除消息失败:", deleteError.message);
            }
        }
        
        // 发送教程图片1
        if (FILE_ID_YZ_1 && FILE_ID_YZ_1 !== "YOUR_YZ_TUTORIAL_1_FILE_ID") {
            try {
                await ctx.replyWithPhoto(FILE_ID_YZ_1);
            } catch (photoError) {
                console.log("发送YZ教程图片1失败:", photoError.message);
            }
        }
        
        // 发送教程图片2
        if (FILE_ID_YZ_2 && FILE_ID_YZ_2 !== "YOUR_YZ_TUTORIAL_2_FILE_ID") {
            try {
                await ctx.replyWithPhoto(FILE_ID_YZ_2);
            } catch (photoError) {
                console.log("发送YZ教程图片2失败:", photoError.message);
            }
        }
        
        // 发送教程图片3
        if (FILE_ID_YZ_3 && FILE_ID_YZ_3 !== "YOUR_YZ_TUTORIAL_3_FILE_ID") {
            try {
                await ctx.replyWithPhoto(FILE_ID_YZ_3);
            } catch (photoError) {
                console.log("发送YZ教程图片3失败:", photoError.message);
            }
        }
        
        // 发送验证提示文本
        await ctx.reply(yzText, {
            reply_markup: keyboard,
            parse_mode: "Markdown"
        });
        
    } catch (error) {
        console.error("showYzPage 错误:", error);
    }
}
// ============================================================
// /v VIP页面
// ============================================================

async function showVPage(ctx) {
    const userId = ctx.from.id;
    
    // 设置用户状态
    await setState(userId, "viewing_vip", { attempts: 0 });
    
    const keyboard = new InlineKeyboard()
        .text("✅ 我已付款，开始验证", "vip_paid")
        .row()
        .text("🔙 返回", "go_to_start");
    
    const vText = `🎊 **喜迎新春（特价）** 🧧

💎 **VIP会员特权说明**：

✅ 专属中转通道
✅ 优先审核入群
✅ 7x24小时客服支持
✅ 定期福利活动

━━━━━━━━━━━━━━━━━━━━`;
    
    try {
        if (ctx.callbackQuery) {
            try {
                await ctx.deleteMessage();
            } catch (deleteError) {
                console.log("删除消息失败:", deleteError.message);
            }
        }
        
        // 发送付款二维码图片
        if (FILE_ID_PAYMENT && FILE_ID_PAYMENT !== "YOUR_PAYMENT_QR_FILE_ID") {
            await ctx.replyWithPhoto(FILE_ID_PAYMENT, {
                caption: vText,
                reply_markup: keyboard,
                parse_mode: "Markdown"
            });
        } else {
            await ctx.reply(vText + "\n\n(⚠️ 管理员未设置收款码图片)", {
                reply_markup: keyboard,
                parse_mode: "Markdown"
            });
        }
        
    } catch (error) {
        console.error("showVPage 错误:", error);
    }
}

// ============================================================
// VIP 订单号输入页面
// ============================================================

async function showVipOrderPage(ctx, attempts) {
    const userId = ctx.from.id;
    
    // 设置用户状态
    await setState(userId, "awaiting_order_number", { attempts: attempts });
    
    const keyboard = new InlineKeyboard()
        .text("🔙 取消", "go_to_dh");
    
    let orderText = `🧾 **订单号验证**

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

📤 **请输入您的订单号：**`;
    
    if (attempts > 0) {
        orderText += `

⚠️ 已尝试 ${attempts}/2 次`;
    }
    
    try {
        if (ctx.callbackQuery) {
            try {
                await ctx.deleteMessage();
            } catch (deleteError) {
                console.log("删除消息失败:", deleteError.message);
            }
        }
        
        // 发送订单号查找教程图片
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
        console.error("showVipOrderPage 错误:", error);
    }
}
