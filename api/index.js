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
// ============================================================
// /admin 管理后台主页
// ============================================================

async function showAdminPage(ctx) {
    await clearState(ctx.from.id);
    
    const keyboard = new InlineKeyboard()
        .text("📂 File ID 工具", "admin_fileid")
        .row()
        .text("🛍️ 频道转发库", "admin_products_1")
        .row()
        .text("📋 待处理", "admin_pending");
    
    const adminText = `🔧 **后台管理面板**

━━━━━━━━━━━━━━━━━━━━

💡 输入 /c 可随时取消操作`;
    
    try {
        if (ctx.callbackQuery) {
            try {
                await ctx.deleteMessage();
            } catch (deleteError) {
                console.log("删除消息失败:", deleteError.message);
            }
        }
        
        await ctx.reply(adminText, {
            reply_markup: keyboard,
            parse_mode: "Markdown"
        });
        
    } catch (error) {
        console.error("showAdminPage 错误:", error);
    }
}

// ============================================================
// 商品管理页面
// ============================================================

async function showProductsPage(ctx, page) {
    if (!page) {
        page = 1;
    }
    
    const offset = (page - 1) * 10;
    
    const countResult = await pool.query("SELECT COUNT(*) FROM products");
    const totalCount = parseInt(countResult.rows[0].count);
    
    const productsResult = await pool.query(
        "SELECT id, keyword, content_type FROM products ORDER BY id ASC LIMIT 10 OFFSET $1",
        [offset]
    );
    
    const products = productsResult.rows;
    
    const keyboard = new InlineKeyboard()
        .text("➕ 添加商品", "admin_add_product")
        .row();
    
    // 添加商品列表（点击可删除）
    products.forEach(product => {
        keyboard.text(`❌ [${product.id}] ${product.keyword}`, `admin_delete_ask_${product.id}`).row();
    });
    
    // 添加分页按钮
    if (totalCount > 10) {
        const paginationButtons = createPaginationKeyboard(page, totalCount, "admin_products");
        paginationButtons.forEach(button => {
            keyboard.text(button.text, button.callback_data);
        });
        keyboard.row();
    }
    
    keyboard.text("🔙 返回后台", "admin_back");
    
    const productsText = `🛍️ **频道转发库**（商品管理）

📦 当前商品数量：**${totalCount}** 个
📄 第 **${page}** 页

━━━━━━━━━━━━━━━━━━━━

点击商品可删除`;
    
    try {
        if (ctx.callbackQuery) {
            try {
                await ctx.deleteMessage();
            } catch (deleteError) {
                console.log("删除消息失败:", deleteError.message);
            }
        }
        
        await ctx.reply(productsText, {
            reply_markup: keyboard,
            parse_mode: "Markdown"
        });
        
    } catch (error) {
        console.error("showProductsPage 错误:", error);
    }
}

// ============================================================
// 待处理主页面
// ============================================================

async function showPendingPage(ctx) {
    const firstCountResult = await pool.query(
        "SELECT COUNT(*) FROM pending_reviews WHERE review_type = 'first' AND status = 'pending'"
    );
    const firstCount = firstCountResult.rows[0].count;
    
    const secondCountResult = await pool.query(
        "SELECT COUNT(*) FROM pending_reviews WHERE review_type = 'second' AND status = 'pending'"
    );
    const secondCount = secondCountResult.rows[0].count;
    
    const vipCountResult = await pool.query(
        "SELECT COUNT(*) FROM pending_reviews WHERE review_type = 'vip' AND status = 'pending'"
    );
    const vipCount = vipCountResult.rows[0].count;
    
    const keyboard = new InlineKeyboard()
        .text(`🔐 首次验证 (${firstCount})`, "pending_first_1")
        .row()
        .text(`🔒 二次验证 (${secondCount})`, "pending_second_1")
        .row()
        .text(`💎 VIP验证 (${vipCount})`, "pending_vip_1")
        .row()
        .text("🔙 返回后台", "admin_back");
    
    const pendingText = `📋 **待处理中心**

━━━━━━━━━━━━━━━━━━━━

点击查看各类型待处理工单：`;
    
    try {
        if (ctx.callbackQuery) {
            try {
                await ctx.deleteMessage();
            } catch (deleteError) {
                console.log("删除消息失败:", deleteError.message);
            }
        }
        
        await ctx.reply(pendingText, {
            reply_markup: keyboard,
            parse_mode: "Markdown"
        });
        
    } catch (error) {
        console.error("showPendingPage 错误:", error);
    }
}

// ============================================================
// 待处理列表页面
// ============================================================

async function showPendingList(ctx, type, page) {
    if (!page) {
        page = 1;
    }
    
    const offset = (page - 1) * 10;
    
    const countResult = await pool.query(
        "SELECT COUNT(*) FROM pending_reviews WHERE review_type = $1 AND status = 'pending'",
        [type]
    );
    const totalCount = parseInt(countResult.rows[0].count);
    
    const pendingResult = await pool.query(
        `SELECT * FROM pending_reviews 
         WHERE review_type = $1 AND status = 'pending' 
         ORDER BY submitted_at ASC 
         LIMIT 10 OFFSET $2`,
        [type, offset]
    );
    
    const pendingItems = pendingResult.rows;
    
    const typeNames = {
        'first': '🔐 首次验证',
        'second': '🔒 二次验证',
        'vip': '💎 VIP验证'
    };
    
    const keyboard = new InlineKeyboard();
    
    // 添加待处理项目列表
    pendingItems.forEach(item => {
        const displayName = item.first_name || item.username || 'Unknown';
        keyboard.text(`📌 ${displayName} (${item.user_id})`, `review_detail_${item.id}`).row();
    });
    
    // 添加分页按钮
    if (totalCount > 10) {
        const paginationButtons = createPaginationKeyboard(page, totalCount, `pending_${type}`);
        paginationButtons.forEach(button => {
            keyboard.text(button.text, button.callback_data);
        });
        keyboard.row();
    }
    
    keyboard.text("🔙 返回", "admin_pending");
    
    const listText = `${typeNames[type]} **待处理列表**

📊 共 **${totalCount}** 条待处理
📄 第 **${page}** 页

━━━━━━━━━━━━━━━━━━━━

点击查看详情：`;
    
    try {
        if (ctx.callbackQuery) {
            try {
                await ctx.deleteMessage();
            } catch (deleteError) {
                console.log("删除消息失败:", deleteError.message);
            }
        }
        
        await ctx.reply(listText, {
            reply_markup: keyboard,
            parse_mode: "Markdown"
        });
        
    } catch (error) {
        console.error("showPendingList 错误:", error);
    }
}

// ============================================================
// 工单详情页面
// ============================================================

async function showReviewDetail(ctx, reviewId) {
    const result = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [reviewId]);
    
    if (result.rows.length === 0) {
        await ctx.answerCallbackQuery({ text: "工单不存在", show_alert: true });
        return;
    }
    
    const review = result.rows[0];
    
    const typeNames = {
        'first': '首次验证',
        'second': '二次验证',
        'vip': 'VIP验证'
    };
    
    const keyboard = new InlineKeyboard()
        .text("✅ 确认", `review_approve_${reviewId}`)
        .text("❌ 驳回", `review_reject_${reviewId}`)
        .row()
        .text("🚫 封禁", `review_ban_${reviewId}`)
        .text("🗑️ 删除", `review_delete_${reviewId}`)
        .row()
        .text("🔙 返回列表", `pending_${review.review_type}_1`);
    
    const submitTime = new Date(review.submitted_at);
    const timeString = submitTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    
    let detailText = `📋 **【${typeNames[review.review_type]}】工单详情**

👤 用户：@${review.username || 'N/A'}
📛 昵称：${review.first_name || 'N/A'}
🆔 ID：\`${review.user_id}\`
📅 时间：${timeString}`;
    
    if (review.review_type === 'vip' && review.order_number) {
        detailText += `
🧾 订单号：\`${review.order_number}\``;
    }
    
    try {
        if (ctx.callbackQuery) {
            try {
                await ctx.deleteMessage();
            } catch (deleteError) {
                console.log("删除消息失败:", deleteError.message);
            }
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
        console.error("showReviewDetail 错误:", error);
    }
}
// ============================================================
// 命令处理
// ============================================================

bot.command("start", async (ctx) => {
    try {
        const payload = ctx.match;
        console.log(`[/start] 用户=${ctx.from.id}, payload=${payload}`);
        
        if (payload === "dh") {
            await showDhPage(ctx, 1);
        } else {
            await showStartPage(ctx);
        }
    } catch (error) {
        console.error("/start 命令错误:", error);
    }
});

bot.command("dh", async (ctx) => {
    try {
        console.log(`[/dh] 用户=${ctx.from.id}`);
        await showDhPage(ctx, 1);
    } catch (error) {
        console.error("/dh 命令错误:", error);
    }
});

bot.command("y", async (ctx) => {
    try {
        console.log(`[/y] 用户=${ctx.from.id}`);
        await showYPage(ctx);
    } catch (error) {
        console.error("/y 命令错误:", error);
    }
});

bot.command("yz", async (ctx) => {
    try {
        console.log(`[/yz] 用户=${ctx.from.id}`);
        await showYzPage(ctx);
    } catch (error) {
        console.error("/yz 命令错误:", error);
    }
});

bot.command("v", async (ctx) => {
    try {
        console.log(`[/v] 用户=${ctx.from.id}`);
        await showVPage(ctx);
    } catch (error) {
        console.error("/v 命令错误:", error);
    }
});

bot.command("admin", async (ctx) => {
    try {
        if (ctx.from.id !== ADMIN_ID) {
            console.log(`[/admin] 非管理员尝试访问: ${ctx.from.id}`);
            return;
        }
        console.log(`[/admin] 管理员访问`);
        await showAdminPage(ctx);
    } catch (error) {
        console.error("/admin 命令错误:", error);
    }
});

bot.command("c", async (ctx) => {
    try {
        if (ctx.from.id !== ADMIN_ID) {
            return;
        }
        
        console.log(`[/c] 管理员取消操作`);
        await clearState(ctx.from.id);
        await ctx.reply("🚫 **操作已取消**", { parse_mode: "Markdown" });
        await showAdminPage(ctx);
    } catch (error) {
        console.error("/c 命令错误:", error);
    }
});

bot.command("cz", async (ctx) => {
    try {
        if (ctx.from.id !== ADMIN_ID) {
            return;
        }
        
        console.log(`[/cz] 管理员进入测试模式`);
        
        const today = getBeijingDateString();
        
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
            [today, ADMIN_ID]
        );
        
        await clearState(ADMIN_ID);
        
        await ctx.reply(`✅ **测试模式已启用**

您的状态已重置为普通用户：
• 首次验证：未完成
• 二次验证：未完成
• 点击次数：0
• VIP状态：否
• 封禁状态：否

📝 现在可以测试完整流程
📝 发送的验证图片会生成工单

💡 输入 /c 可恢复管理员状态`, { parse_mode: "Markdown" });
        
        await showStartPage(ctx);
    } catch (error) {
        console.error("/cz 命令错误:", error);
    }
});
// ============================================================
// 基本回调处理
// ============================================================

bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery();
});

bot.callbackQuery("go_to_start", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        await showStartPage(ctx);
    } catch (error) {
        console.error("go_to_start 回调错误:", error);
    }
});

bot.callbackQuery("go_to_dh", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        await clearState(ctx.from.id);
        await showDhPage(ctx, 1);
    } catch (error) {
        console.error("go_to_dh 回调错误:", error);
    }
});

bot.callbackQuery("force_go_to_dh", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        await clearState(ctx.from.id);
        await showDhPage(ctx, 1);
    } catch (error) {
        console.error("force_go_to_dh 回调错误:", error);
    }
});

bot.callbackQuery("go_to_v", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        await showVPage(ctx);
    } catch (error) {
        console.error("go_to_v 回调错误:", error);
    }
});

bot.callbackQuery("go_to_y", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        await showYPage(ctx);
    } catch (error) {
        console.error("go_to_y 回调错误:", error);
    }
});

bot.callbackQuery("refresh_y_status", async (ctx) => {
    try {
        await ctx.answerCallbackQuery({ text: "正在刷新..." });
        
        const userId = ctx.from.id;
        const userData = await getOrInitUser(userId, ctx.from.username, ctx.from.first_name);
        
        if (userData.first_verify_passed === true) {
            await showDhPage(ctx, 1);
        } else {
            await showYPage(ctx);
        }
    } catch (error) {
        console.error("refresh_y_status 回调错误:", error);
    }
});

bot.callbackQuery("vip_paid", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        await showVipOrderPage(ctx, 0);
    } catch (error) {
        console.error("vip_paid 回调错误:", error);
    }
});

bot.callbackQuery(/^dh_page_(\d+)$/, async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        const page = parseInt(ctx.match[1]);
        await showDhPage(ctx, page);
    } catch (error) {
        console.error("dh_page 回调错误:", error);
    }
});
// ============================================================
// 商品点击处理
// ============================================================

bot.callbackQuery(/^product_(\d+)$/, async (ctx) => {
    try {
        const productId = parseInt(ctx.match[1]);
        const userId = ctx.from.id;
        const username = ctx.from.username;
        const firstName = ctx.from.first_name;
        
        const userData = await getOrInitUser(userId, username, firstName);
        
        console.log(`[商品点击] 用户=${userId}, 商品=${productId}, first_verify_passed=${userData.first_verify_passed}`);
        
        // 检查是否被封禁
        if (userData.is_banned === true) {
            await ctx.answerCallbackQuery({ text: "你已被封禁", show_alert: true });
            return;
        }
        
        // 检查是否需要二次验证
        if (userData.first_verify_passed === true && userData.second_verify_passed === false) {
            const newClickCount = await incrementClickCount(userId);
            console.log(`[商品点击] 用户=${userId}, click_count=${newClickCount}`);
            
            if (newClickCount >= 5) {
                await ctx.answerCallbackQuery();
                await showYzPage(ctx);
                return;
            }
            
            const needSecondVerify = await checkNeedSecondVerify(userId);
            if (needSecondVerify) {
                await ctx.answerCallbackQuery();
                await showYzPage(ctx);
                return;
            }
        }
        
        // 未通过首次验证
        if (userData.first_verify_passed !== true) {
            await ctx.answerCallbackQuery();
            
            const confirmKeyboard = new InlineKeyboard()
                .text("❌ 取消", "go_to_dh")
                .text("✅ 确认兑换", "go_to_y");
            
            try {
                await ctx.deleteMessage();
            } catch (deleteError) {
                console.log("删除消息失败:", deleteError.message);
            }
            
            await ctx.reply(`📦 **是否兑换？**

确认后需要完成首次验证
即可免费观看所有资源~`, {
                reply_markup: confirmKeyboard,
                parse_mode: "Markdown"
            });
            return;
        }
        
        // 已通过验证，发送商品内容
        await ctx.answerCallbackQuery({ text: "🎉 正在获取..." });
        
        // 增加点击次数（如果未通过二次验证）
        if (userData.second_verify_passed !== true) {
            await incrementClickCount(userId);
        }
        
        // 查询商品
        const productResult = await pool.query("SELECT * FROM products WHERE id = $1", [productId]);
        
        if (productResult.rows.length === 0) {
            await ctx.reply("⚠️ 商品不存在或已下架");
            return;
        }
        
        const product = productResult.rows[0];
        const chatId = ctx.chat.id;
        
        // 发送获取成功提示
        const tipText = `🎉 **获取成功！**

📦 商品：${product.keyword}
⏰ 内容将在 **5分钟后** 自动删除

━━━━━━━━━━━━━━━━━━━━

${userData.is_vip === true ? '👑 **VIP会员** - 无限畅享' : '🎁 验证已通过 - 无限畅享'}`;
        
        const tipMessage = await ctx.reply(tipText, { parse_mode: "Markdown" });
        scheduleMessageDeletion(chatId, tipMessage.message_id, 300000);
        
        // 发送商品内容
        try {
            if (product.content_type === 'text') {
                const contentMessage = await ctx.reply(product.content_data);
                scheduleMessageDeletion(chatId, contentMessage.message_id, 300000);
                
            } else if (product.content_type === 'photo') {
                const contentMessage = await ctx.replyWithPhoto(product.content_data);
                scheduleMessageDeletion(chatId, contentMessage.message_id, 300000);
                
            } else if (product.content_type === 'video') {
                const contentMessage = await ctx.replyWithVideo(product.content_data);
                scheduleMessageDeletion(chatId, contentMessage.message_id, 300000);
                
            } else if (product.content_type === 'document') {
                const contentMessage = await ctx.replyWithDocument(product.content_data);
                scheduleMessageDeletion(chatId, contentMessage.message_id, 300000);
                
            } else if (product.content_type === 'media_group') {
                const contents = JSON.parse(product.content_data);
                
                for (const item of contents) {
                    let contentMessage;
                    
                    if (item.type === 'photo') {
                        contentMessage = await ctx.replyWithPhoto(item.data);
                    } else if (item.type === 'video') {
                        contentMessage = await ctx.replyWithVideo(item.data);
                    } else if (item.type === 'document') {
                        contentMessage = await ctx.replyWithDocument(item.data);
                    } else {
                        contentMessage = await ctx.reply(item.data);
                    }
                    
                    scheduleMessageDeletion(chatId, contentMessage.message_id, 300000);
                }
                
            } else {
                const contentMessage = await ctx.reply(product.content_data);
                scheduleMessageDeletion(chatId, contentMessage.message_id, 300000);
            }
        } catch (sendError) {
            console.error("发送商品内容失败:", sendError);
            await ctx.reply("⚠️ 内容发送失败，请联系管理员");
        }
        
    } catch (error) {
        console.error("商品点击回调错误:", error);
    }
});
// ============================================================
// 管理后台回调处理
// ============================================================

bot.callbackQuery("admin_back", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        await showAdminPage(ctx);
    } catch (error) {
        console.error("admin_back 回调错误:", error);
    }
});

bot.callbackQuery("admin_fileid", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        await setState(ctx.from.id, "awaiting_file_id", null);
        
        const keyboard = new InlineKeyboard()
            .text("🔙 取消", "admin_back");
        
        try {
            await ctx.deleteMessage();
        } catch (deleteError) {
            console.log("删除消息失败:", deleteError.message);
        }
        
        await ctx.reply(`📂 **File ID 工具**

📸 请发送一张图片，我将返回它的 File ID

━━━━━━━━━━━━━━━━━━━━

💡 输入 /c 可取消操作`, {
            reply_markup: keyboard,
            parse_mode: "Markdown"
        });
    } catch (error) {
        console.error("admin_fileid 回调错误:", error);
    }
});

bot.callbackQuery(/^admin_products_(\d+)$/, async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        const page = parseInt(ctx.match[1]);
        await showProductsPage(ctx, page);
    } catch (error) {
        console.error("admin_products 回调错误:", error);
    }
});

bot.callbackQuery("admin_add_product", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        await setState(ctx.from.id, "awaiting_product_keyword", null);
        
        const keyboard = new InlineKeyboard()
            .text("🔙 取消", "admin_products_1");
        
        try {
            await ctx.deleteMessage();
        } catch (deleteError) {
            console.log("删除消息失败:", deleteError.message);
        }
        
        await ctx.reply(`➕ **添加商品**

📝 请输入商品关键词（如：001）

━━━━━━━━━━━━━━━━━━━━

💡 输入 /c 可取消操作`, {
            reply_markup: keyboard,
            parse_mode: "Markdown"
        });
    } catch (error) {
        console.error("admin_add_product 回调错误:", error);
    }
});

bot.callbackQuery("admin_confirm_product", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        
        const userState = await getState(ctx.from.id);
        
        if (!userState.temp_data || !userState.temp_data.keyword) {
            await ctx.reply("⚠️ 没有待上架的商品");
            await showAdminPage(ctx);
            return;
        }
        
        const keyword = userState.temp_data.keyword;
        const contents = userState.temp_data.contents;
        
        if (!contents || contents.length === 0) {
            await ctx.reply("⚠️ 请至少上传一条内容");
            return;
        }
        
        let contentType;
        let contentData;
        
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
            
            await ctx.reply(`🎉 **商品上架成功！**

📦 关键词：${keyword}
📝 内容数量：${contents.length} 条`, { parse_mode: "Markdown" });
            
            await clearState(ctx.from.id);
            await showProductsPage(ctx, 1);
            
        } catch (insertError) {
            if (insertError.code === '23505') {
                await ctx.reply("⚠️ 该关键词已存在，请使用其他关键词");
            } else {
                console.error("保存商品失败:", insertError);
                await ctx.reply("⚠️ 保存失败：" + insertError.message);
            }
        }
    } catch (error) {
        console.error("admin_confirm_product 回调错误:", error);
    }
});

bot.callbackQuery("admin_cancel_product", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        await clearState(ctx.from.id);
        await ctx.reply("🚫 已取消上架");
        await showProductsPage(ctx, 1);
    } catch (error) {
        console.error("admin_cancel_product 回调错误:", error);
    }
});

bot.callbackQuery(/^admin_delete_ask_(\d+)$/, async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        const productId = ctx.match[1];
        
        const keyboard = new InlineKeyboard()
            .text("✅ 确认删除", `admin_delete_confirm_${productId}`)
            .text("🔙 取消", "admin_products_1");
        
        try {
            await ctx.deleteMessage();
        } catch (deleteError) {
            console.log("删除消息失败:", deleteError.message);
        }
        
        await ctx.reply(`⚠️ **确认删除此商品吗？**

删除后不可恢复！`, {
            reply_markup: keyboard,
            parse_mode: "Markdown"
        });
    } catch (error) {
        console.error("admin_delete_ask 回调错误:", error);
    }
});

bot.callbackQuery(/^admin_delete_confirm_(\d+)$/, async (ctx) => {
    try {
        const productId = ctx.match[1];
        
        await pool.query("DELETE FROM products WHERE id = $1", [productId]);
        
        await ctx.answerCallbackQuery({ text: "🗑️ 删除成功" });
        await showProductsPage(ctx, 1);
    } catch (error) {
        console.error("admin_delete_confirm 回调错误:", error);
    }
});

bot.callbackQuery("admin_pending", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        await showPendingPage(ctx);
    } catch (error) {
        console.error("admin_pending 回调错误:", error);
    }
});

bot.callbackQuery(/^pending_(first|second|vip)_(\d+)$/, async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        const type = ctx.match[1];
        const page = parseInt(ctx.match[2]);
        await showPendingList(ctx, type, page);
    } catch (error) {
        console.error("pending_list 回调错误:", error);
    }
});

bot.callbackQuery(/^review_detail_(\d+)$/, async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        const reviewId = parseInt(ctx.match[1]);
        await showReviewDetail(ctx, reviewId);
    } catch (error) {
        console.error("review_detail 回调错误:", error);
    }
});
// ============================================================
// 工单审核回调处理
// ============================================================

bot.callbackQuery(/^review_approve_(\d+)$/, async (ctx) => {
    try {
        const reviewId = parseInt(ctx.match[1]);
        
        const result = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [reviewId]);
        
        if (result.rows.length === 0) {
            await ctx.answerCallbackQuery({ text: "工单不存在", show_alert: true });
            return;
        }
        
        const review = result.rows[0];
        
        await pool.query("UPDATE pending_reviews SET status = 'approved' WHERE id = $1", [reviewId]);
        
        if (review.review_type === 'first') {
            await pool.query(
                "UPDATE users SET first_verify_passed = TRUE, needs_manual_review = FALSE WHERE telegram_id = $1",
                [review.user_id]
            );
        } else if (review.review_type === 'vip') {
            await pool.query(
                "UPDATE users SET is_vip = TRUE WHERE telegram_id = $1",
                [review.user_id]
            );
        }
        
        await ctx.answerCallbackQuery({ text: "✅ 已确认" });
        await showPendingList(ctx, review.review_type, 1);
        
    } catch (error) {
        console.error("review_approve 回调错误:", error);
    }
});

bot.callbackQuery(/^review_reject_(\d+)$/, async (ctx) => {
    try {
        const reviewId = parseInt(ctx.match[1]);
        
        const result = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [reviewId]);
        
        if (result.rows.length === 0) {
            await ctx.answerCallbackQuery({ text: "工单不存在", show_alert: true });
            return;
        }
        
        const review = result.rows[0];
        
        await pool.query("UPDATE pending_reviews SET status = 'rejected' WHERE id = $1", [reviewId]);
        
        if (review.review_type === 'first') {
            const userResult = await pool.query(
                "SELECT reject_count_first FROM users WHERE telegram_id = $1",
                [review.user_id]
            );
            
            const currentRejectCount = userResult.rows[0]?.reject_count_first || 0;
            const newRejectCount = currentRejectCount + 1;
            
            if (newRejectCount >= 2) {
                await pool.query(
                    `UPDATE users SET 
                        reject_count_first = $1, 
                        first_verify_passed = FALSE, 
                        needs_manual_review = TRUE 
                     WHERE telegram_id = $2`,
                    [newRejectCount, review.user_id]
                );
                
                try {
                    await bot.api.sendMessage(review.user_id, `⚠️ **验证已被驳回**

您已被驳回 ${newRejectCount} 次，需要等待管理员重新审核。
每日凌晨 00:00 重置。

请上传正确的截图！`, { parse_mode: "Markdown" });
                } catch (sendError) {
                    console.log("通知用户失败:", sendError.message);
                }
                
            } else {
                await pool.query(
                    `UPDATE users SET 
                        reject_count_first = $1, 
                        first_verify_passed = FALSE 
                     WHERE telegram_id = $2`,
                    [newRejectCount, review.user_id]
                );
                
                try {
                    await bot.api.sendMessage(review.user_id, `⚠️ **验证被驳回**

请上传包含【时间】和【助力成功】的截图！
⚠️ 再次错误将需要等待管理员审核！

输入 /y 继续验证`, { parse_mode: "Markdown" });
                } catch (sendError) {
                    console.log("通知用户失败:", sendError.message);
                }
            }
            
        } else if (review.review_type === 'second') {
            await pool.query(
                "UPDATE users SET second_verify_passed = FALSE WHERE telegram_id = $1",
                [review.user_id]
            );
            
            try {
                await bot.api.sendMessage(review.user_id, `⚠️ **二次验证被驳回**

请不要作弊！输入 /yz 继续验证`, { parse_mode: "Markdown" });
            } catch (sendError) {
                console.log("通知用户失败:", sendError.message);
            }
            
        } else if (review.review_type === 'vip') {
            try {
                await bot.api.sendMessage(review.user_id, `❌ **订单验证失败**

未找到该订单，请确认订单号是否正确。

如有疑问请联系客服。`, { parse_mode: "Markdown" });
            } catch (sendError) {
                console.log("通知用户失败:", sendError.message);
            }
        }
        
        await ctx.answerCallbackQuery({ text: "❌ 已驳回" });
        await showPendingList(ctx, review.review_type, 1);
        
    } catch (error) {
        console.error("review_reject 回调错误:", error);
    }
});

bot.callbackQuery(/^review_ban_(\d+)$/, async (ctx) => {
    try {
        const reviewId = parseInt(ctx.match[1]);
        
        const result = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [reviewId]);
        
        if (result.rows.length === 0) {
            await ctx.answerCallbackQuery({ text: "工单不存在", show_alert: true });
            return;
        }
        
        const review = result.rows[0];
        
        await pool.query("UPDATE pending_reviews SET status = 'banned' WHERE id = $1", [reviewId]);
        await pool.query("UPDATE users SET is_banned = TRUE WHERE telegram_id = $1", [review.user_id]);
        
        try {
            await bot.api.sendMessage(review.user_id, `🚫 **您已被封禁**

多次作弊已被永久封禁。
请购买会员继续使用。

输入 /v 查看会员`, { parse_mode: "Markdown" });
        } catch (sendError) {
            console.log("通知用户失败:", sendError.message);
        }
        
        await ctx.answerCallbackQuery({ text: "🚫 已封禁" });
        await showPendingList(ctx, review.review_type, 1);
        
    } catch (error) {
        console.error("review_ban 回调错误:", error);
    }
});

bot.callbackQuery(/^review_delete_(\d+)$/, async (ctx) => {
    try {
        const reviewId = parseInt(ctx.match[1]);
        
        const result = await pool.query("SELECT review_type FROM pending_reviews WHERE id = $1", [reviewId]);
        const reviewType = result.rows[0]?.review_type || 'first';
        
        await pool.query("DELETE FROM pending_reviews WHERE id = $1", [reviewId]);
        
        await ctx.answerCallbackQuery({ text: "🗑️ 已删除" });
        await showPendingList(ctx, reviewType, 1);
        
    } catch (error) {
        console.error("review_delete 回调错误:", error);
    }
});
// ============================================================
// 快捷审核回调处理（管理员收到工单时的按钮）
// ============================================================

bot.callbackQuery(/^quick_approve_(first|second|vip)_(\d+)$/, async (ctx) => {
    try {
        const reviewType = ctx.match[1];
        const targetUserId = parseInt(ctx.match[2]);
        
        console.log(`[quick_approve] type=${reviewType}, userId=${targetUserId}`);
        
        if (reviewType === 'first') {
            await pool.query(
                "UPDATE users SET first_verify_passed = TRUE, needs_manual_review = FALSE WHERE telegram_id = $1",
                [targetUserId]
            );
        } else if (reviewType === 'vip') {
            await pool.query(
                "UPDATE users SET is_vip = TRUE WHERE telegram_id = $1",
                [targetUserId]
            );
        }
        
        await pool.query(
            "UPDATE pending_reviews SET status = 'approved' WHERE user_id = $1 AND review_type = $2 AND status = 'pending'",
            [targetUserId, reviewType]
        );
        
        await ctx.answerCallbackQuery({ text: "✅ 已确认" });
        
        try {
            const message = ctx.callbackQuery.message;
            const currentText = message.caption || message.text || '';
            const newText = currentText + "\n\n✅ **已确认**";
            
            if (message.photo) {
                await ctx.editMessageCaption({ caption: newText, parse_mode: "Markdown" });
            } else {
                await ctx.editMessageText(newText, { parse_mode: "Markdown" });
            }
        } catch (editError) {
            console.log("编辑消息失败:", editError.message);
        }
        
    } catch (error) {
        console.error("quick_approve 回调错误:", error);
    }
});

bot.callbackQuery(/^quick_reject_(first|second|vip)_(\d+)$/, async (ctx) => {
    try {
        const reviewType = ctx.match[1];
        const targetUserId = parseInt(ctx.match[2]);
        
        console.log(`[quick_reject] type=${reviewType}, userId=${targetUserId}`);
        
        if (reviewType === 'first') {
            const userResult = await pool.query(
                "SELECT reject_count_first FROM users WHERE telegram_id = $1",
                [targetUserId]
            );
            
            const currentRejectCount = userResult.rows[0]?.reject_count_first || 0;
            const newRejectCount = currentRejectCount + 1;
            
            if (newRejectCount >= 2) {
                await pool.query(
                    `UPDATE users SET 
                        reject_count_first = $1, 
                        first_verify_passed = FALSE, 
                        needs_manual_review = TRUE 
                     WHERE telegram_id = $2`,
                    [newRejectCount, targetUserId]
                );
            } else {
                await pool.query(
                    `UPDATE users SET 
                        reject_count_first = $1, 
                        first_verify_passed = FALSE 
                     WHERE telegram_id = $2`,
                    [newRejectCount, targetUserId]
                );
            }
            
            try {
                await bot.api.sendMessage(targetUserId, "⚠️ 验证被驳回，请输入 /y 重新验证");
            } catch (sendError) {
                console.log("通知用户失败:", sendError.message);
            }
            
        } else if (reviewType === 'second') {
            await pool.query(
                "UPDATE users SET second_verify_passed = FALSE WHERE telegram_id = $1",
                [targetUserId]
            );
            
            try {
                await bot.api.sendMessage(targetUserId, "⚠️ 二次验证被驳回，请输入 /yz 重新验证");
            } catch (sendError) {
                console.log("通知用户失败:", sendError.message);
            }
            
        } else if (reviewType === 'vip') {
            try {
                await bot.api.sendMessage(targetUserId, "❌ 订单验证失败，请确认订单号是否正确");
            } catch (sendError) {
                console.log("通知用户失败:", sendError.message);
            }
        }
        
        await pool.query(
            "UPDATE pending_reviews SET status = 'rejected' WHERE user_id = $1 AND review_type = $2 AND status = 'pending'",
            [targetUserId, reviewType]
        );
        
        await ctx.answerCallbackQuery({ text: "❌ 已驳回" });
        
        try {
            const message = ctx.callbackQuery.message;
            const currentText = message.caption || message.text || '';
            const newText = currentText + "\n\n❌ **已驳回**";
            
            if (message.photo) {
                await ctx.editMessageCaption({ caption: newText, parse_mode: "Markdown" });
            } else {
                await ctx.editMessageText(newText, { parse_mode: "Markdown" });
            }
        } catch (editError) {
            console.log("编辑消息失败:", editError.message);
        }
        
    } catch (error) {
        console.error("quick_reject 回调错误:", error);
    }
});

bot.callbackQuery(/^quick_ban_(\d+)$/, async (ctx) => {
    try {
        const targetUserId = parseInt(ctx.match[1]);
        
        console.log(`[quick_ban] userId=${targetUserId}`);
        
        await pool.query("UPDATE users SET is_banned = TRUE WHERE telegram_id = $1", [targetUserId]);
        await pool.query(
            "UPDATE pending_reviews SET status = 'banned' WHERE user_id = $1 AND status = 'pending'",
            [targetUserId]
        );
        
        try {
            await bot.api.sendMessage(targetUserId, "🚫 您已被封禁");
        } catch (sendError) {
            console.log("通知用户失败:", sendError.message);
        }
        
        await ctx.answerCallbackQuery({ text: "🚫 已封禁" });
        
        try {
            const message = ctx.callbackQuery.message;
            const currentText = message.caption || message.text || '';
            const newText = currentText + "\n\n🚫 **已封禁**";
            
            if (message.photo) {
                await ctx.editMessageCaption({ caption: newText, parse_mode: "Markdown" });
            } else {
                await ctx.editMessageText(newText, { parse_mode: "Markdown" });
            }
        } catch (editError) {
            console.log("编辑消息失败:", editError.message);
        }
        
    } catch (error) {
        console.error("quick_ban 回调错误:", error);
    }
});

bot.callbackQuery(/^quick_delete_(first|second|vip)_(\d+)$/, async (ctx) => {
    try {
        const reviewType = ctx.match[1];
        const targetUserId = parseInt(ctx.match[2]);
        
        console.log(`[quick_delete] type=${reviewType}, userId=${targetUserId}`);
        
        await pool.query(
            "DELETE FROM pending_reviews WHERE user_id = $1 AND review_type = $2 AND status = 'pending'",
            [targetUserId, reviewType]
        );
        
        await ctx.answerCallbackQuery({ text: "🗑️ 已删除" });
        
        try {
            await ctx.deleteMessage();
        } catch (deleteError) {
            console.log("删除消息失败:", deleteError.message);
        }
        
    } catch (error) {
        console.error("quick_delete 回调错误:", error);
    }
});
// ============================================================
// 消息处理
// ============================================================

bot.on("message", async (ctx) => {
    try {
        const userId = ctx.from.id;
        const username = ctx.from.username;
        const firstName = ctx.from.first_name;
        const messageText = ctx.message.text || "";
        
        const userState = await getState(userId);
        
        console.log(`[消息] 用户=${userId}, state=${userState.state}, isAdmin=${userId === ADMIN_ID}`);
        
        // ========== 管理员状态处理 ==========
        if (userId === ADMIN_ID) {
            
            // File ID 工具
            if (userState.state === "awaiting_file_id") {
                if (ctx.message.photo) {
                    const photoArray = ctx.message.photo;
                    const largestPhoto = photoArray[photoArray.length - 1];
                    const fileId = largestPhoto.file_id;
                    
                    await ctx.reply(`📂 **File ID 获取成功**

\`${fileId}\`

请复制上方代码`, { parse_mode: "Markdown" });
                    
                    await clearState(userId);
                    await showAdminPage(ctx);
                } else {
                    await ctx.reply("⚠️ 请发送图片，或输入 /c 取消");
                }
                return;
            }
            
            // 添加商品 - 输入关键词
            if (userState.state === "awaiting_product_keyword") {
                const keyword = messageText.trim();
                
                if (!keyword) {
                    await ctx.reply("⚠️ 关键词不能为空，请重新输入");
                    return;
                }
                
                const existResult = await pool.query("SELECT id FROM products WHERE keyword = $1", [keyword]);
                
                if (existResult.rows.length > 0) {
                    await ctx.reply("⚠️ 该关键词已存在，请使用其他关键词");
                    return;
                }
                
                await setState(userId, "collecting_product_content", { keyword: keyword, contents: [] });
                
                const keyboard = new InlineKeyboard()
                    .text("✅ 完成上架", "admin_confirm_product")
                    .text("❌ 取消", "admin_cancel_product");
                
                await ctx.reply(`✅ 关键词：**${keyword}**

📤 **请上传商品内容**：

• 可以发送多条消息（图片、视频、文件、文字）
• 可以转发频道消息
• 每发一条我都会记录

✅ 发送完毕后，点击【完成上架】按钮确认

━━━━━━━━━━━━━━━━━━━━

💡 输入 /c 可取消操作`, { reply_markup: keyboard, parse_mode: "Markdown" });
                return;
            }
            
            // 收集商品内容
            if (userState.state === "collecting_product_content") {
                const tempData = userState.temp_data || { keyword: "", contents: [] };
                
                let contentItem = null;
                
                if (ctx.message.photo) {
                    const photoArray = ctx.message.photo;
                    const largestPhoto = photoArray[photoArray.length - 1];
                    contentItem = { type: 'photo', data: largestPhoto.file_id };
                } else if (ctx.message.video) {
                    contentItem = { type: 'video', data: ctx.message.video.file_id };
                } else if (ctx.message.document) {
                    contentItem = { type: 'document', data: ctx.message.document.file_id };
                } else if (messageText && !messageText.startsWith('/')) {
                    contentItem = { type: 'text', data: messageText };
                }
                
                if (contentItem) {
                    tempData.contents.push(contentItem);
                    await setState(userId, "collecting_product_content", tempData);
                    
                    const keyboard = new InlineKeyboard()
                        .text("✅ 完成上架", "admin_confirm_product")
                        .text("❌ 取消", "admin_cancel_product");
                    
                    await ctx.reply(`📥 已收到第 **${tempData.contents.length}** 条内容

继续发送更多内容，或点击【完成上架】确认`, { reply_markup: keyboard, parse_mode: "Markdown" });
                }
                return;
            }
        }
        
        // ========== 【修复】首次验证 - 确保正确设置状态并发送工单 ==========
        if (userState.state === "awaiting_first_verify") {
            if (ctx.message.photo) {
                const photoArray = ctx.message.photo;
                const largestPhoto = photoArray[photoArray.length - 1];
                const fileId = largestPhoto.file_id;
                
                console.log(`[首次验证] 用户=${userId} 上传图片, fileId=${fileId.substring(0, 20)}...`);
                
                // 【修复】更新用户状态为已验证
                await pool.query(
                    `UPDATE users SET 
                        first_verify_passed = TRUE,
                        first_verify_time = CURRENT_TIMESTAMP
                     WHERE telegram_id = $1`,
                    [userId]
                );
                
                console.log(`[首次验证] 用户=${userId} 数据库已更新 first_verify_passed = TRUE`);
                
                // 【修复】发送工单给管理员（包括管理员自己测试时）
                const sendResult = await sendToAdmin(userId, username, firstName, 'first', fileId, null);
                console.log(`[首次验证] 发送工单结果: ${sendResult}`);
                
                // 回复用户
                await ctx.reply(`✅ **验证成功！**

🎉 现在可以**无限畅享**所有资源啦~`, { parse_mode: "Markdown" });
                
                // 清除状态
                await clearState(userId);
                
                // 跳转到兑换页面
                await showDhPage(ctx, 1);
                
            } else {
                await ctx.reply("❌ 请上传**图片**！", { parse_mode: "Markdown" });
            }
            return;
        }
        
        // ========== 二次验证 ==========
        if (userState.state === "awaiting_second_verify") {
            if (ctx.message.photo) {
                const photoArray = ctx.message.photo;
                const largestPhoto = photoArray[photoArray.length - 1];
                const fileId = largestPhoto.file_id;
                
                console.log(`[二次验证] 用户=${userId} 上传图片`);
                
                // 更新用户状态
                await pool.query(
                    "UPDATE users SET second_verify_passed = TRUE WHERE telegram_id = $1",
                    [userId]
                );
                
                // 发送工单给管理员
                await sendToAdmin(userId, username, firstName, 'second', fileId, null);
                
                // 回复用户
                await ctx.reply(`✅ **二次验证成功！**

🎉 永久免验证，无限畅享所有资源！`, { parse_mode: "Markdown" });
                
                // 清除状态并跳转
                await clearState(userId);
                await showDhPage(ctx, 1);
                
            } else {
                await ctx.reply("❌ 请上传**图片**！", { parse_mode: "Markdown" });
            }
            return;
        }
        
        // ========== VIP订单号验证 ==========
        if (userState.state === "awaiting_order_number") {
            const attempts = userState.temp_data?.attempts || 0;
            
            if (messageText.startsWith("20260")) {
                // 订单号格式正确
                const keyboard = new InlineKeyboard()
                    .url("🎁 加入会员群", VIP_GROUP_LINK);
                
                await ctx.reply(`🎉 **验证成功！**

欢迎加入VIP会员！
点击下方按钮加入会员群：`, { parse_mode: "Markdown", reply_markup: keyboard });
                
                // 发送工单给管理员
                await sendToAdmin(userId, username, firstName, 'vip', null, messageText);
                
                // 清除状态
                await clearState(userId);
                
            } else {
                // 订单号格式错误
                const newAttempts = attempts + 1;
                
                if (newAttempts >= 2) {
                    await ctx.reply("❌ 订单号错误次数过多，请返回兑换页面");
                    await clearState(userId);
                    await showDhPage(ctx, 1);
                } else {
                    await showVipOrderPage(ctx, newAttempts);
                }
            }
            return;
        }
        
        // 其他消息 - 显示首页
        if (messageText && !messageText.startsWith('/')) {
            await showStartPage(ctx);
        }
        
    } catch (error) {
        console.error("消息处理错误:", error);
    }
});

// ============================================================
// 错误处理
// ============================================================

bot.catch((err) => {
    console.error("Bot 错误:", err);
});

// ============================================================
// 导出
// ============================================================

module.exports = webhookCallback(bot, "http");
