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
// ⚠️ 部署后通过 /admin -> File ID工具 获取，然后填入下方

const FILE_ID_PAYMENT = "YOUR_PAYMENT_QR_FILE_ID";      // VIP付款二维码
const FILE_ID_ORDER = "YOUR_ORDER_TUTORIAL_FILE_ID";    // 订单号教程图
const FILE_ID_Y_1 = "YOUR_Y_TUTORIAL_1_FILE_ID";        // 首次验证教程图1
const FILE_ID_Y_2 = "YOUR_Y_TUTORIAL_2_FILE_ID";        // 首次验证教程图2
const FILE_ID_YZ_1 = "YOUR_YZ_TUTORIAL_1_FILE_ID";      // 二次验证教程图1
const FILE_ID_YZ_2 = "YOUR_YZ_TUTORIAL_2_FILE_ID";      // 二次验证教程图2
const FILE_ID_YZ_3 = "YOUR_YZ_TUTORIAL_3_FILE_ID";      // 二次验证教程图3

const VIP_GROUP_LINK = "https://t.me/+495j5rWmApsxYzg9";

// ==================== 辅助函数 ====================

// 获取北京时间
function getBeijingTime() {
    const now = new Date();
    const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    return beijingTime;
}

// 获取北京日期字符串 YYYY-MM-DD
function getBeijingDateString() {
    const bt = getBeijingTime();
    return bt.toISOString().split('T')[0];
}

// 获取北京时间完整字符串
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

// 获取或初始化用户
async function getOrInitUser(userId, username, firstName) {
    const today = getBeijingDateString();
    
    // 尝试插入新用户
    await pool.query(
        `INSERT INTO users (telegram_id, username, first_name, first_verify_date)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (telegram_id) DO UPDATE SET 
            username = COALESCE($2, users.username),
            first_name = COALESCE($3, users.first_name)`,
        [userId, username, firstName, today]
    );
    
    // 获取用户数据
    const res = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [userId]);
    let userData = res.rows[0];
    
    // 检查是否需要重置首次验证（每日重置）
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

// 设置用户状态
async function setState(userId, state, tempData = null) {
    await pool.query(
        `INSERT INTO user_states (user_id, state, temp_data, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET 
            state = $2, 
            temp_data = $3,
            updated_at = CURRENT_TIMESTAMP`,
        [userId, state, tempData]
    );
}

// 获取用户状态
async function getState(userId) {
    const res = await pool.query("SELECT * FROM user_states WHERE user_id = $1", [userId]);
    return res.rows[0] || { state: "idle", temp_data: null };
}

// 清除用户状态
async function clearState(userId) {
    await pool.query("DELETE FROM user_states WHERE user_id = $1", [userId]);
}

// 增加点击次数
async function incrementClickCount(userId) {
    await pool.query(
        "UPDATE users SET click_count = click_count + 1 WHERE telegram_id = $1",
        [userId]
    );
}

// 检查是否需要二次验证
async function checkNeedSecondVerify(userId) {
    const res = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [userId]);
    const user = res.rows[0];
    
    if (!user || user.second_verify_passed) {
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

// 创建分页键盘
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

// 添加待处理记录
async function addPendingReview(userId, username, firstName, reviewType, fileId = null, orderNumber = null, messageId = null) {
    await pool.query(
        `INSERT INTO pending_reviews (user_id, username, first_name, review_type, file_id, order_number, submitted_at, message_id)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7)`,
        [userId, username, firstName, reviewType, fileId, orderNumber, messageId]
    );
}
// ==================== 页面显示函数 ====================

// /start 首页
async function showStartPage(ctx) {
    const userId = ctx.from.id;
    const userData = await getOrInitUser(userId, ctx.from.username, ctx.from.first_name);
    
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
            await ctx.editMessageText(welcomeText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        } else {
            await ctx.reply(welcomeText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        }
    } catch (e) {
        await ctx.reply(welcomeText, { 
            reply_markup: keyboard, 
            parse_mode: "Markdown" 
        });
    }
}

// /dh 兑换页面
async function showDhPage(ctx, page = 1) {
    const userId = ctx.from.id;
    const userData = await getOrInitUser(userId, ctx.from.username, ctx.from.first_name);
    
    // 检查是否封禁
    if (userData.is_banned) {
        const keyboard = new InlineKeyboard()
            .text("💎 加入会员（特价版）", "go_to_v");
        
        const banText = `
🚫 **你已被本活动封禁**

请加入会员（特价版）👇
`;
        
        try {
            if (ctx.callbackQuery) {
                await ctx.editMessageText(banText, { 
                    reply_markup: keyboard, 
                    parse_mode: "Markdown" 
                });
            } else {
                await ctx.reply(banText, { 
                    reply_markup: keyboard, 
                    parse_mode: "Markdown" 
                });
            }
        } catch (e) {
            await ctx.reply(banText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        }
        return;
    }
    
    // 检查是否需要二次验证
    if (userData.first_verify_passed && !userData.second_verify_passed) {
        const needSecond = await checkNeedSecondVerify(userId);
        if (needSecond) {
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
    
    // 添加商品按钮（每行2个）
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
    
    // 添加分页按钮
    if (totalCount > 10) {
        const navButtons = createPaginationKeyboard(page, totalCount, "dh");
        keyboard.row();
        navButtons.forEach(btn => keyboard.text(btn.text, btn.callback_data));
        keyboard.row();
    }
    
    // 验证成功后显示加入会员按钮
    if (userData.first_verify_passed) {
        keyboard.text("💎 加入会员（新春特价）", "go_to_v").row();
    }
    
    let dhText = `
📦 **兑换中心**

🎉 点击对应的编号按钮
✨ 即可立马**免费观看**

━━━━━━━━━━━━━━━━━━━━
`;
    
    if (products.length === 0) {
        dhText += `\n🌑 暂无商品，请稍后再来~`;
    }
    
    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(dhText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        } else {
            await ctx.reply(dhText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        }
    } catch (e) {
        await ctx.reply(dhText, { 
            reply_markup: keyboard, 
            parse_mode: "Markdown" 
        });
    }
}

// /y 首次验证页面
async function showYPage(ctx) {
    const userId = ctx.from.id;
    await setState(userId, "awaiting_first_verify");
    
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
    
    const keyboard = new InlineKeyboard()
        .text("🔙 返回", "go_to_dh");
    
    try {
        // 发送教程图片1
        if (FILE_ID_Y_1 && FILE_ID_Y_1 !== "YOUR_Y_TUTORIAL_1_FILE_ID") {
            await ctx.replyWithPhoto(FILE_ID_Y_1);
        }
        // 发送教程图片2
        if (FILE_ID_Y_2 && FILE_ID_Y_2 !== "YOUR_Y_TUTORIAL_2_FILE_ID") {
            await ctx.replyWithPhoto(FILE_ID_Y_2);
        }
        
        await ctx.reply(yText, { 
            reply_markup: keyboard, 
            parse_mode: "Markdown" 
        });
    } catch (e) {
        await ctx.reply(yText, { 
            reply_markup: keyboard, 
            parse_mode: "Markdown" 
        });
    }
}

// /yz 二次验证页面
async function showYzPage(ctx) {
    const userId = ctx.from.id;
    await setState(userId, "awaiting_second_verify");
    
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
    
    const keyboard = new InlineKeyboard()
        .text("🔙 返回", "go_to_dh");
    
    try {
        // 发送教程图片1
        if (FILE_ID_YZ_1 && FILE_ID_YZ_1 !== "YOUR_YZ_TUTORIAL_1_FILE_ID") {
            await ctx.replyWithPhoto(FILE_ID_YZ_1);
        }
        // 发送教程图片2
        if (FILE_ID_YZ_2 && FILE_ID_YZ_2 !== "YOUR_YZ_TUTORIAL_2_FILE_ID") {
            await ctx.replyWithPhoto(FILE_ID_YZ_2);
        }
        // 发送教程图片3
        if (FILE_ID_YZ_3 && FILE_ID_YZ_3 !== "YOUR_YZ_TUTORIAL_3_FILE_ID") {
            await ctx.replyWithPhoto(FILE_ID_YZ_3);
        }
        
        await ctx.reply(yzText, { 
            reply_markup: keyboard, 
            parse_mode: "Markdown" 
        });
    } catch (e) {
        await ctx.reply(yzText, { 
            reply_markup: keyboard, 
            parse_mode: "Markdown" 
        });
    }
}

// /v VIP页面
async function showVPage(ctx) {
    const userId = ctx.from.id;
    await setState(userId, "viewing_vip");
    
    const vText = `
🎊 **喜迎新春（特价）** 🧧

💎 **VIP会员特权说明**：

✅ 专属中转通道
✅ 优先审核入群
✅ 7x24小时客服支持
✅ 定期福利活动

━━━━━━━━━━━━━━━━━━━━
`;
    
    const keyboard = new InlineKeyboard()
        .text("✅ 我已付款，开始验证", "vip_paid")
        .row()
        .text("🔙 返回", "go_to_start");
    
    try {
        if (FILE_ID_PAYMENT && FILE_ID_PAYMENT !== "YOUR_PAYMENT_QR_FILE_ID") {
            if (ctx.callbackQuery && ctx.callbackQuery.message.photo) {
                await ctx.editMessageCaption({ 
                    caption: vText, 
                    reply_markup: keyboard, 
                    parse_mode: "Markdown" 
                });
            } else {
                if (ctx.callbackQuery) {
                    await ctx.deleteMessage().catch(() => {});
                }
                await ctx.replyWithPhoto(FILE_ID_PAYMENT, {
                    caption: vText,
                    reply_markup: keyboard,
                    parse_mode: "Markdown"
                });
            }
        } else {
            const textOnly = vText + "\n(⚠️ 管理员未设置收款码图片)";
            if (ctx.callbackQuery) {
                await ctx.editMessageText(textOnly, { 
                    reply_markup: keyboard, 
                    parse_mode: "Markdown" 
                });
            } else {
                await ctx.reply(textOnly, { 
                    reply_markup: keyboard, 
                    parse_mode: "Markdown" 
                });
            }
        }
    } catch (e) {
        await ctx.reply(vText, { 
            reply_markup: keyboard, 
            parse_mode: "Markdown" 
        });
    }
}

// VIP订单号输入页面
async function showVipOrderPage(ctx) {
    const userId = ctx.from.id;
    await setState(userId, "awaiting_order_number");
    
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
`;
    
    const keyboard = new InlineKeyboard()
        .text("🔙 取消", "go_to_v");
    
    try {
        if (FILE_ID_ORDER && FILE_ID_ORDER !== "YOUR_ORDER_TUTORIAL_FILE_ID") {
            if (ctx.callbackQuery) {
                await ctx.deleteMessage().catch(() => {});
            }
            await ctx.replyWithPhoto(FILE_ID_ORDER, {
                caption: orderText,
                reply_markup: keyboard,
                parse_mode: "Markdown"
            });
        } else {
            if (ctx.callbackQuery) {
                await ctx.editMessageText(orderText, { 
                    reply_markup: keyboard, 
                    parse_mode: "Markdown" 
                });
            } else {
                await ctx.reply(orderText, { 
                    reply_markup: keyboard, 
                    parse_mode: "Markdown" 
                });
            }
        }
    } catch (e) {
        await ctx.reply(orderText, { 
            reply_markup: keyboard, 
            parse_mode: "Markdown" 
        });
    }
}
// ==================== 管理后台页面 ====================

// /admin 后台主页
async function showAdminPage(ctx) {
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
            await ctx.editMessageText(adminText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        } else {
            await ctx.reply(adminText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        }
    } catch (e) {
        await ctx.reply(adminText, { 
            reply_markup: keyboard, 
            parse_mode: "Markdown" 
        });
    }
}

// 商品管理页面
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
    
    // 添加商品列表（每个一行，可删除）
    productsRes.rows.forEach(product => {
        keyboard.text(`❌ [${product.id}] ${product.keyword}`, `admin_del_ask_${product.id}`).row();
    });
    
    // 添加分页按钮
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

点击商品可删除
`;
    
    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(productsText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        } else {
            await ctx.reply(productsText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        }
    } catch (e) {
        await ctx.reply(productsText, { 
            reply_markup: keyboard, 
            parse_mode: "Markdown" 
        });
    }
}

// 待处理主页面
async function showPendingPage(ctx) {
    // 统计各类型待处理数量
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

请选择要处理的类型：
`;
    
    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(pendingText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        } else {
            await ctx.reply(pendingText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        }
    } catch (e) {
        await ctx.reply(pendingText, { 
            reply_markup: keyboard, 
            parse_mode: "Markdown" 
        });
    }
}

// 显示待处理列表
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
        const label = type === 'second' ? `${name} (二次验证)` : name;
        keyboard.text(`📌 ${label}`, `review_${item.id}`).row();
    });
    
    // 添加分页按钮
    if (totalCount > 10) {
        const navButtons = createPaginationKeyboard(page, totalCount, `pending_${type}`);
        navButtons.forEach(btn => keyboard.text(btn.text, btn.callback_data));
        keyboard.row();
    }
    
    keyboard.text("🔙 返回", "admin_pending");
    
    const listText = `
${typeNames[type]} **待处理列表**

📊 共 **${totalCount}** 条待处理
📄 第 **${page}** 页

━━━━━━━━━━━━━━━━━━━━

点击查看详情并处理：
`;
    
    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(listText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        } else {
            await ctx.reply(listText, { 
                reply_markup: keyboard, 
                parse_mode: "Markdown" 
            });
        }
    } catch (e) {
        await ctx.reply(listText, { 
            reply_markup: keyboard, 
            parse_mode: "Markdown" 
        });
    }
}

// 显示待处理详情
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
    
    const keyboard = new InlineKeyboard()
        .text("✅ 确认", `review_approve_${reviewId}`)
        .text("❌ 驳回", `review_reject_${reviewId}`)
        .text("🚫 封禁", `review_ban_${reviewId}`)
        .row()
        .text("🔙 返回列表", `pending_${review.review_type}_1`);
    
    // 格式化时间
    const submitTime = new Date(review.submitted_at);
    const timeStr = submitTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    
    let detailText = `
📋 **【${typeNames[review.review_type]}】待审核**

👤 用户：@${review.username || 'N/A'}
📛 昵称：${review.first_name || 'N/A'}
🆔 ID：\`${review.user_id}\`
📅 时间：${timeStr}
`;
    
    if (review.review_type === 'vip' && review.order_number) {
        detailText += `\n🧾 订单号：\`${review.order_number}\``;
    }
    
    try {
        if (review.file_id && review.review_type !== 'vip') {
            // 有图片的情况
            if (ctx.callbackQuery) {
                await ctx.deleteMessage().catch(() => {});
            }
            await ctx.replyWithPhoto(review.file_id, {
                caption: detailText,
                reply_markup: keyboard,
                parse_mode: "Markdown"
            });
        } else {
            // 无图片的情况（VIP验证）
            if (ctx.callbackQuery) {
                await ctx.editMessageText(detailText, { 
                    reply_markup: keyboard, 
                    parse_mode: "Markdown" 
                });
            } else {
                await ctx.reply(detailText, { 
                    reply_markup: keyboard, 
                    parse_mode: "Markdown" 
                });
            }
        }
    } catch (e) {
        await ctx.reply(detailText, { 
            reply_markup: keyboard, 
            parse_mode: "Markdown" 
        });
    }
}
// ==================== 命令处理 ====================

// /start 命令
bot.command("start", async (ctx) => {
    const payload = ctx.match;
    
    if (payload === "dh") {
        await showDhPage(ctx);
    } else {
        await showStartPage(ctx);
    }
});

// /dh 命令
bot.command("dh", async (ctx) => {
    await showDhPage(ctx);
});

// /y 命令
bot.command("y", async (ctx) => {
    await showYPage(ctx);
});

// /yz 命令
bot.command("yz", async (ctx) => {
    await showYzPage(ctx);
});

// /v 命令（隐藏）
bot.command("v", async (ctx) => {
    await showVPage(ctx);
});

// /admin 命令
bot.command("admin", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await showAdminPage(ctx);
});

// /c 命令 - 取消所有状态
bot.command("c", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await clearState(ctx.from.id);
    await ctx.reply("🚫 **操作已取消**", { parse_mode: "Markdown" });
    await showAdminPage(ctx);
});

// /cz 命令 - 测试模式
bot.command("cz", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    // 重置管理员的用户状态为普通用户
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

您的状态已重置为：
• 普通用户
• 未验证状态
• 首次验证：未完成
• 二次验证：未完成

现在可以测试完整流程。

💡 输入 /c 可恢复管理员状态
`, { parse_mode: "Markdown" });
    
    await showStartPage(ctx);
});
// ==================== 回调查询处理 ====================

// 空操作
bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery();
});

// 返回首页
bot.callbackQuery("go_to_start", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showStartPage(ctx);
});

// 去兑换页面
bot.callbackQuery("go_to_dh", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const userData = await getOrInitUser(userId, ctx.from.username, ctx.from.first_name);
    
    // 检查是否封禁
    if (userData.is_banned) {
        const keyboard = new InlineKeyboard()
            .text("💎 加入会员（特价版）", "go_to_v");
        
        await ctx.editMessageText(`
🚫 **你已被本活动封禁**

请加入会员（特价版）👇
`, { reply_markup: keyboard, parse_mode: "Markdown" });
        return;
    }
    
    await showDhPage(ctx);
});

// 去VIP页面
bot.callbackQuery("go_to_v", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showVPage(ctx);
});

// 去首次验证页面
bot.callbackQuery("go_to_y", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.callbackQuery.message) {
        await ctx.deleteMessage().catch(() => {});
    }
    await showYPage(ctx);
});

// VIP已付款
bot.callbackQuery("vip_paid", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showVipOrderPage(ctx);
});

// 兑换页面分页
bot.callbackQuery(/^dh_page_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = parseInt(ctx.match[1]);
    await showDhPage(ctx, page);
});

// 点击商品按钮
bot.callbackQuery(/^product_(\d+)$/, async (ctx) => {
    const productId = parseInt(ctx.match[1]);
    const userId = ctx.from.id;
    const userData = await getOrInitUser(userId, ctx.from.username, ctx.from.first_name);
    
    // 检查是否封禁
    if (userData.is_banned) {
        await ctx.answerCallbackQuery({ text: "你已被封禁", show_alert: true });
        return;
    }
    
    // 检查是否需要二次验证
    if (userData.first_verify_passed && !userData.second_verify_passed) {
        const needSecond = await checkNeedSecondVerify(userId);
        if (needSecond) {
            await ctx.answerCallbackQuery();
            if (ctx.callbackQuery.message) {
                await ctx.deleteMessage().catch(() => {});
            }
            await showYzPage(ctx);
            return;
        }
    }
    
    // 如果未首次验证，显示确认弹窗
    if (!userData.first_verify_passed) {
        const keyboard = new InlineKeyboard()
            .text("❌ 取消", "go_to_dh")
            .text("✅ 确认", "go_to_y");
        
        await ctx.editMessageText(`
📦 **是否兑换？**

确认后需要完成首次验证
即可免费观看所有资源~
`, { reply_markup: keyboard, parse_mode: "Markdown" });
        await ctx.answerCallbackQuery();
        return;
    }
    
    // 已验证，直接发送商品内容
    await ctx.answerCallbackQuery({ text: "正在获取内容..." });
    
    // 增加点击次数
    await incrementClickCount(userId);
    
    // 获取商品内容
    const productRes = await pool.query("SELECT * FROM products WHERE id = $1", [productId]);
    
    if (productRes.rows.length === 0) {
        await ctx.reply("⚠️ 商品不存在或已下架");
        return;
    }
    
    const product = productRes.rows[0];
    
    // 发送商品内容
    try {
        if (product.content_type === 'text') {
            await ctx.reply(product.content_data);
        } else if (product.content_type === 'photo') {
            await ctx.replyWithPhoto(product.content_data);
        } else if (product.content_type === 'video') {
            await ctx.replyWithVideo(product.content_data);
        } else if (product.content_type === 'document') {
            await ctx.replyWithDocument(product.content_data);
        } else if (product.content_type === 'media_group') {
            // 媒体组（多条消息整体发送）
            const mediaGroup = JSON.parse(product.content_data);
            await ctx.replyWithMediaGroup(mediaGroup);
        } else {
            await ctx.reply(product.content_data);
        }
    } catch (e) {
        await ctx.reply("⚠️ 内容发送失败，请联系管理员");
    }
});

// ==================== 管理后台回调 ====================

// 返回后台
bot.callbackQuery("admin_back", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showAdminPage(ctx);
});

// File ID 工具
bot.callbackQuery("admin_fileid", async (ctx) => {
    await ctx.answerCallbackQuery();
    await setState(ctx.from.id, "awaiting_file_id");
    
    const keyboard = new InlineKeyboard()
        .text("🔙 取消", "admin_back");
    
    await ctx.editMessageText(`
📂 **File ID 工具**

📸 请发送一张图片，我将返回它的 File ID

━━━━━━━━━━━━━━━━━━━━

💡 输入 /c 可取消操作
`, { reply_markup: keyboard, parse_mode: "Markdown" });
});

// 商品管理页面
bot.callbackQuery(/^admin_products_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const page = parseInt(ctx.match[1]);
    await showProductsPage(ctx, page);
});

// 添加商品
bot.callbackQuery("admin_add_product", async (ctx) => {
    await ctx.answerCallbackQuery();
    await setState(ctx.from.id, "awaiting_product_keyword");
    
    const keyboard = new InlineKeyboard()
        .text("🔙 取消", "admin_products_1");
    
    await ctx.editMessageText(`
➕ **添加商品**

📝 请输入商品关键词（如：001）

━━━━━━━━━━━━━━━━━━━━

💡 输入 /c 可取消操作
`, { reply_markup: keyboard, parse_mode: "Markdown" });
});

// 删除商品确认
bot.callbackQuery(/^admin_del_ask_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const productId = ctx.match[1];
    
    const keyboard = new InlineKeyboard()
        .text("✅ 确认删除", `admin_del_confirm_${productId}`)
        .text("🔙 取消", "admin_products_1");
    
    await ctx.editMessageText(`
⚠️ **确认删除此商品吗？**

删除后不可恢复！
`, { reply_markup: keyboard, parse_mode: "Markdown" });
});

// 确认删除商品
bot.callbackQuery(/^admin_del_confirm_(\d+)$/, async (ctx) => {
    const productId = ctx.match[1];
    await pool.query("DELETE FROM products WHERE id = $1", [productId]);
    await ctx.answerCallbackQuery({ text: "🗑️ 删除成功" });
    await showProductsPage(ctx);
});

// 待处理主页面
bot.callbackQuery("admin_pending", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showPendingPage(ctx);
});

// 待处理列表分页
bot.callbackQuery(/^pending_(first|second|vip)_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const type = ctx.match[1];
    const page = parseInt(ctx.match[2]);
    await showPendingList(ctx, type, page);
});

// 查看待处理详情
bot.callbackQuery(/^review_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const reviewId = parseInt(ctx.match[1]);
    await showReviewDetail(ctx, reviewId);
});

// 审核通过
bot.callbackQuery(/^review_approve_(\d+)$/, async (ctx) => {
    const reviewId = parseInt(ctx.match[1]);
    
    const res = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [reviewId]);
    if (res.rows.length === 0) {
        await ctx.answerCallbackQuery({ text: "记录不存在", show_alert: true });
        return;
    }
    
    const review = res.rows[0];
    
    // 更新待处理状态
    await pool.query("UPDATE pending_reviews SET status = 'approved' WHERE id = $1", [reviewId]);
    
    // 根据类型更新用户状态
    if (review.review_type === 'first') {
        await pool.query(
            "UPDATE users SET needs_manual_review = FALSE WHERE telegram_id = $1",
            [review.user_id]
        );
    } else if (review.review_type === 'vip') {
        await pool.query(
            "UPDATE users SET is_vip = TRUE WHERE telegram_id = $1",
            [review.user_id]
        );
    }
    
    await ctx.answerCallbackQuery({ text: "✅ 已确认" });
    
    // 返回列表
    await showPendingList(ctx, review.review_type);
});

// 审核驳回
bot.callbackQuery(/^review_reject_(\d+)$/, async (ctx) => {
    const reviewId = parseInt(ctx.match[1]);
    
    const res = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [reviewId]);
    if (res.rows.length === 0) {
        await ctx.answerCallbackQuery({ text: "记录不存在", show_alert: true });
        return;
    }
    
    const review = res.rows[0];
    
    // 更新待处理状态
    await pool.query("UPDATE pending_reviews SET status = 'rejected' WHERE id = $1", [reviewId]);
    
    // 根据类型处理驳回逻辑
    if (review.review_type === 'first') {
        // 增加驳回次数
        await pool.query(
            "UPDATE users SET reject_count_first = reject_count_first + 1, first_verify_passed = FALSE WHERE telegram_id = $1",
            [review.user_id]
        );
        
        // 检查驳回次数
        const userRes = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [review.user_id]);
        const userData = userRes.rows[0];
        
        if (userData.reject_count_first >= 2) {
            // 需要手动审核
            await pool.query(
                "UPDATE users SET needs_manual_review = TRUE WHERE telegram_id = $1",
                [review.user_id]
            );
        }
        
        // 通知用户
        try {
            await bot.api.sendMessage(review.user_id, `
⚠️ **管理员驳回**

❌ 请上传包含以下内容的截图：
   • 📅 具体时间
   • ✅ 助力成功文字

⚠️ 注意：多次错误/作弊上传会被封禁！！！

请继续完成验证 👇

输入 /y 重新验证
`, { parse_mode: "Markdown" });
        } catch (e) {
            // 用户可能已屏蔽机器人
        }
    } else if (review.review_type === 'second') {
        // 二次验证驳回
        await pool.query(
            "UPDATE users SET reject_count_second = reject_count_second + 1, second_verify_passed = FALSE WHERE telegram_id = $1",
            [review.user_id]
        );
        
        // 通知用户
        try {
            await bot.api.sendMessage(review.user_id, `
⚠️ **二次验证驳回**

请不要作弊，防止封禁。

请继续完成验证 👇

输入 /yz 重新验证
`, { parse_mode: "Markdown" });
        } catch (e) {
            // 用户可能已屏蔽机器人
        }
    }
    
    await ctx.answerCallbackQuery({ text: "❌ 已驳回" });
    
    // 返回列表
    await showPendingList(ctx, review.review_type);
});

// 审核封禁
bot.callbackQuery(/^review_ban_(\d+)$/, async (ctx) => {
    const reviewId = parseInt(ctx.match[1]);
    
    const res = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [reviewId]);
    if (res.rows.length === 0) {
        await ctx.answerCallbackQuery({ text: "记录不存在", show_alert: true });
        return;
    }
    
    const review = res.rows[0];
    
    // 更新待处理状态
    await pool.query("UPDATE pending_reviews SET status = 'banned' WHERE id = $1", [reviewId]);
    
    // 封禁用户
    await pool.query(
        "UPDATE users SET is_banned = TRUE WHERE telegram_id = $1",
        [review.user_id]
    );
    
    // 通知用户
    try {
        const keyboard = new InlineKeyboard()
            .text("💎 加入会员（新春特价）", "go_to_v");
        
        await bot.api.sendMessage(review.user_id, `
🚫 **封禁通知**

您在本活动中多次作弊/上传错误
已被本活动【**永久封禁**】

━━━━━━━━━━━━━━━━━━━━

🎁 仍可加入永久会员（新春特价）👇
`, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
        // 用户可能已屏蔽机器人
    }
    
    await ctx.answerCallbackQuery({ text: "🚫 已封禁" });
    
    // 返回列表
    await showPendingList(ctx, review.review_type);
});
// ==================== 消息处理 ====================

bot.on("message", async (ctx) => {
    const userId = ctx.from.id;
    const userState = await getState(userId);
    const text = ctx.message.text || "";
    
    // ========== 管理员状态处理 ==========
    if (userId === ADMIN_ID) {
        
        // File ID 工具
        if (userState.state === "awaiting_file_id") {
            if (ctx.message.photo) {
                const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                await ctx.reply(`
📂 **File ID 获取成功**

\`${fileId}\`

请复制上方代码
`, { parse_mode: "Markdown" });
                await clearState(userId);
                await showAdminPage(ctx);
            } else {
                await ctx.reply("⚠️ 请发送图片，或输入 /c 取消");
            }
            return;
        }
        
        // 添加商品 - 输入关键词
        if (userState.state === "awaiting_product_keyword") {
            await setState(userId, "awaiting_product_content", text);
            await ctx.reply(`
✅ 关键词：**${text}**

📤 请上传商品内容：
• 可以发送文字、图片、视频、文件
• 可以转发频道消息
• 转发的内容会自动去除来源信息

━━━━━━━━━━━━━━━━━━━━

💡 输入 /c 可取消操作
`, { parse_mode: "Markdown" });
            return;
        }
        
        // 添加商品 - 上传内容
        if (userState.state === "awaiting_product_content") {
            const keyword = userState.temp_data;
            let contentType = 'text';
            let contentData = '';
            
            if (ctx.message.photo) {
                contentType = 'photo';
                contentData = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            } else if (ctx.message.video) {
                contentType = 'video';
                contentData = ctx.message.video.file_id;
            } else if (ctx.message.document) {
                contentType = 'document';
                contentData = ctx.message.document.file_id;
            } else if (ctx.message.text) {
                contentType = 'text';
                contentData = ctx.message.text;
            } else {
                await ctx.reply("⚠️ 不支持的内容类型，请重新发送");
                return;
            }
            
            // 保存商品
            try {
                await pool.query(
                    "INSERT INTO products (keyword, content_type, content_data) VALUES ($1, $2, $3)",
                    [keyword, contentType, contentData]
                );
                
                await ctx.reply(`
🎉 **商品上架成功！**

📦 关键词：${keyword}
📝 类型：${contentType}
`, { parse_mode: "Markdown" });
                
                await clearState(userId);
                await showProductsPage(ctx);
            } catch (e) {
                if (e.code === '23505') {
                    await ctx.reply("⚠️ 该关键词已存在，请使用其他关键词");
                } else {
                    await ctx.reply("⚠️ 保存失败：" + e.message);
                }
            }
            return;
        }
    }
    
    // ========== 用户状态处理 ==========
    
    // 首次验证
    if (userState.state === "awaiting_first_verify") {
        if (ctx.message.photo) {
            const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            const userData = await getOrInitUser(userId, ctx.from.username, ctx.from.first_name);
            
            // 检查是否需要手动审核
            if (userData.needs_manual_review) {
                await ctx.reply("⚠️ 您需要等待管理员手动审核，请耐心等待");
                return;
            }
            
            // 前端直接显示成功
            await ctx.reply(`
✅ **验证成功！**

管理员会进行二次验证
请返回兑换页面使用~
`, { parse_mode: "Markdown" });
            
            // 更新用户状态
            await pool.query(
                `UPDATE users SET 
                    first_verify_passed = TRUE,
                    first_verify_time = CURRENT_TIMESTAMP
                 WHERE telegram_id = $1`,
                [userId]
            );
            
            // 发送给管理员审核
            const timeStr = getBeijingTimeString();
            const adminMsg = await bot.api.sendPhoto(ADMIN_ID, fileId, {
                caption: `
📋 **【首次验证】待审核**

👤 用户：@${ctx.from.username || 'N/A'}
📛 昵称：${ctx.from.first_name || 'N/A'}
🆔 ID：\`${userId}\`
📅 时间：${timeStr}
`,
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard()
                    .text("✅ 确认", `quick_approve_first_${userId}`)
                    .text("❌ 驳回", `quick_reject_first_${userId}`)
                    .text("🚫 封禁", `quick_ban_${userId}`)
            });
            
            // 添加到待处理队列
            await addPendingReview(
                userId,
                ctx.from.username,
                ctx.from.first_name,
                'first',
                fileId,
                null,
                adminMsg.message_id
            );
            
            await clearState(userId);
            await showDhPage(ctx);
        } else {
            await ctx.reply("❌ 验证失败，请上传图片");
        }
        return;
    }
    
    // 二次验证
    if (userState.state === "awaiting_second_verify") {
        if (ctx.message.photo) {
            const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            
            // 前端直接显示成功
            await ctx.reply(`
✅ **二次验证成功！**

管理员会进行确认
现在可以无限制使用了~
`, { parse_mode: "Markdown" });
            
            // 更新用户状态
            await pool.query(
                "UPDATE users SET second_verify_passed = TRUE WHERE telegram_id = $1",
                [userId]
            );
            
            // 发送给管理员审核
            const timeStr = getBeijingTimeString();
            const adminMsg = await bot.api.sendPhoto(ADMIN_ID, fileId, {
                caption: `
📋 **【二次验证】待审核**

👤 用户：@${ctx.from.username || 'N/A'}
📛 昵称：${ctx.from.first_name || 'N/A'}
🆔 ID：\`${userId}\`（二次验证）
📅 时间：${timeStr}
`,
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard()
                    .text("✅ 确认", `quick_approve_second_${userId}`)
                    .text("❌ 驳回", `quick_reject_second_${userId}`)
                    .text("🚫 封禁", `quick_ban_${userId}`)
            });
            
            // 添加到待处理队列
            await addPendingReview(
                userId,
                ctx.from.username,
                ctx.from.first_name,
                'second',
                fileId,
                null,
                adminMsg.message_id
            );
            
            await clearState(userId);
            await showDhPage(ctx);
        } else {
            await ctx.reply("❌ 验证失败，请上传图片");
        }
        return;
    }
    
    // VIP订单号验证
    if (userState.state === "awaiting_order_number") {
        if (text.startsWith("20260")) {
            // 订单号格式正确
            await ctx.reply(`
🎉 **验证成功！**

欢迎加入VIP会员！
点击下方按钮加入会员群：
`, {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard()
                    .url("🎁 加入会员群", VIP_GROUP_LINK)
            });
            
            // 发送给管理员
            const timeStr = getBeijingTimeString();
            await bot.api.sendMessage(ADMIN_ID, `
💎 **【VIP订单】待确认**

👤 用户：@${ctx.from.username || 'N/A'}
📛 昵称：${ctx.from.first_name || 'N/A'}
🆔 ID：\`${userId}\`
🧾 订单号：\`${text}\`
📅 时间：${timeStr}
`, {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard()
                    .text("✅ 确认", `quick_approve_vip_${userId}`)
                    .text("❌ 驳回", `quick_reject_vip_${userId}`)
                    .text("🚫 封禁", `quick_ban_${userId}`)
            });
            
            // 添加到待处理队列
            await addPendingReview(
                userId,
                ctx.from.username,
                ctx.from.first_name,
                'vip',
                null,
                text,
                null
            );
            
            await clearState(userId);
        } else {
            await ctx.reply("❌ 订单号格式错误，请重新输入");
        }
        return;
    }
    
    // 其他情况显示首页
    await showStartPage(ctx);
});

// ==================== 快捷审核回调 ====================

// 快捷确认 - 首次验证
bot.callbackQuery(/^quick_approve_first_(\d+)$/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1]);
    
    await pool.query(
        "UPDATE users SET needs_manual_review = FALSE WHERE telegram_id = $1",
        [targetUserId]
    );
    await pool.query(
        "UPDATE pending_reviews SET status = 'approved' WHERE user_id = $1 AND review_type = 'first' AND status = 'pending'",
        [targetUserId]
    );
    
    await ctx.answerCallbackQuery({ text: "✅ 已确认" });
    await ctx.editMessageCaption({ caption: ctx.callbackQuery.message.caption + "\n\n✅ **已确认**", parse_mode: "Markdown" });
});

// 快捷确认 - 二次验证
bot.callbackQuery(/^quick_approve_second_(\d+)$/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1]);
    
    await pool.query(
        "UPDATE pending_reviews SET status = 'approved' WHERE user_id = $1 AND review_type = 'second' AND status = 'pending'",
        [targetUserId]
    );
    
    await ctx.answerCallbackQuery({ text: "✅ 已确认" });
    await ctx.editMessageCaption({ caption: ctx.callbackQuery.message.caption + "\n\n✅ **已确认**", parse_mode: "Markdown" });
});

// 快捷确认 - VIP
bot.callbackQuery(/^quick_approve_vip_(\d+)$/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1]);
    
    await pool.query(
        "UPDATE users SET is_vip = TRUE WHERE telegram_id = $1",
        [targetUserId]
    );
    await pool.query(
        "UPDATE pending_reviews SET status = 'approved' WHERE user_id = $1 AND review_type = 'vip' AND status = 'pending'",
        [targetUserId]
    );
    
    await ctx.answerCallbackQuery({ text: "✅ 已确认" });
    await ctx.editMessageText(ctx.callbackQuery.message.text + "\n\n✅ **已确认**", { parse_mode: "Markdown" });
});

// 快捷驳回 - 首次验证
bot.callbackQuery(/^quick_reject_first_(\d+)$/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1]);
    
    await pool.query(
        "UPDATE users SET reject_count_first = reject_count_first + 1, first_verify_passed = FALSE WHERE telegram_id = $1",
        [targetUserId]
    );
    
    const userRes = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [targetUserId]);
    if (userRes.rows[0].reject_count_first >= 2) {
        await pool.query(
            "UPDATE users SET needs_manual_review = TRUE WHERE telegram_id = $1",
            [targetUserId]
        );
    }
    
    await pool.query(
        "UPDATE pending_reviews SET status = 'rejected' WHERE user_id = $1 AND review_type = 'first' AND status = 'pending'",
        [targetUserId]
    );
    
    try {
        await bot.api.sendMessage(targetUserId, `
⚠️ **管理员驳回**

❌ 请上传包含以下内容的截图：
   • 📅 具体时间
   • ✅ 助力成功文字

⚠️ 注意：多次错误/作弊上传会被封禁！！！

请输入 /y 继续验证
`, { parse_mode: "Markdown" });
    } catch (e) {}
    
    await ctx.answerCallbackQuery({ text: "❌ 已驳回" });
    await ctx.editMessageCaption({ caption: ctx.callbackQuery.message.caption + "\n\n❌ **已驳回**", parse_mode: "Markdown" });
});

// 快捷驳回 - 二次验证
bot.callbackQuery(/^quick_reject_second_(\d+)$/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1]);
    
    await pool.query(
        "UPDATE users SET reject_count_second = reject_count_second + 1, second_verify_passed = FALSE WHERE telegram_id = $1",
        [targetUserId]
    );
    await pool.query(
        "UPDATE pending_reviews SET status = 'rejected' WHERE user_id = $1 AND review_type = 'second' AND status = 'pending'",
        [targetUserId]
    );
    
    try {
        await bot.api.sendMessage(targetUserId, `
⚠️ **二次验证驳回**

请不要作弊，防止封禁。

请输入 /yz 继续验证
`, { parse_mode: "Markdown" });
    } catch (e) {}
    
    await ctx.answerCallbackQuery({ text: "❌ 已驳回" });
    await ctx.editMessageCaption({ caption: ctx.callbackQuery.message.caption + "\n\n❌ **已驳回**", parse_mode: "Markdown" });
});

// 快捷驳回 - VIP
bot.callbackQuery(/^quick_reject_vip_(\d+)$/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1]);
    
    await pool.query(
        "UPDATE pending_reviews SET status = 'rejected' WHERE user_id = $1 AND review_type = 'vip' AND status = 'pending'",
        [targetUserId]
    );
    
    try {
        await bot.api.sendMessage(targetUserId, `
❌ **订单验证失败**

未找到该订单，请确认订单号是否正确。

如有疑问请联系客服。
`, { parse_mode: "Markdown" });
    } catch (e) {}
    
    await ctx.answerCallbackQuery({ text: "❌ 已驳回" });
    await ctx.editMessageText(ctx.callbackQuery.message.text + "\n\n❌ **已驳回**", { parse_mode: "Markdown" });
});

// 快捷封禁
bot.callbackQuery(/^quick_ban_(\d+)$/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1]);
    
    await pool.query(
        "UPDATE users SET is_banned = TRUE WHERE telegram_id = $1",
        [targetUserId]
    );
    await pool.query(
        "UPDATE pending_reviews SET status = 'banned' WHERE user_id = $1 AND status = 'pending'",
        [targetUserId]
    );
    
    try {
        await bot.api.sendMessage(targetUserId, `
🚫 **封禁通知**

您在本活动中多次作弊/上传错误
已被本活动【**永久封禁**】

━━━━━━━━━━━━━━━━━━━━

🎁 仍可加入永久会员（新春特价）

输入 /v 查看详情
`, { parse_mode: "Markdown" });
    } catch (e) {}
    
    await ctx.answerCallbackQuery({ text: "🚫 已封禁" });
    
    try {
        if (ctx.callbackQuery.message.photo) {
            await ctx.editMessageCaption({ caption: ctx.callbackQuery.message.caption + "\n\n🚫 **已封禁**", parse_mode: "Markdown" });
        } else {
            await ctx.editMessageText(ctx.callbackQuery.message.text + "\n\n🚫 **已封禁**", { parse_mode: "Markdown" });
        }
    } catch (e) {}
});

// ==================== 导出 ====================

module.exports = webhookCallback(bot, "http");
