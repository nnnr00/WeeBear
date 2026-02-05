const { Bot, webhookCallback, InlineKeyboard } = require("grammy");
const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

const FILE_ID_PAYMENT = "YOUR_PAYMENT_QR_FILE_ID";
const FILE_ID_ORDER = "YOUR_ORDER_TUTORIAL_FILE_ID";
const FILE_ID_Y_1 = "YOUR_Y_TUTORIAL_1_FILE_ID";
const FILE_ID_Y_2 = "YOUR_Y_TUTORIAL_2_FILE_ID";
const FILE_ID_YZ_1 = "YOUR_YZ_TUTORIAL_1_FILE_ID";
const FILE_ID_YZ_2 = "YOUR_YZ_TUTORIAL_2_FILE_ID";
const FILE_ID_YZ_3 = "YOUR_YZ_TUTORIAL_3_FILE_ID";
const VIP_GROUP_LINK = "https://t.me/+495j5rWmApsxYzg9";

function getBeijingTime() {
    return new Date(new Date().getTime() + 8 * 60 * 60 * 1000);
}

function getBeijingDateString() {
    return getBeijingTime().toISOString().split('T')[0];
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

async function setState(userId, state, tempData) {
    const dataStr = tempData !== undefined && tempData !== null ? JSON.stringify(tempData) : null;
    await pool.query(
        `INSERT INTO user_states (user_id, state, temp_data, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET state = $2, temp_data = $3, updated_at = CURRENT_TIMESTAMP`,
        [userId, state, dataStr]
    );
}

async function getState(userId) {
    const res = await pool.query("SELECT * FROM user_states WHERE user_id = $1", [userId]);
    if (res.rows.length === 0) return { state: "idle", temp_data: null };
    const row = res.rows[0];
    let tempData = null;
    if (row.temp_data) {
        try { tempData = JSON.parse(row.temp_data); } catch (e) { tempData = row.temp_data; }
    }
    return { state: row.state, temp_data: tempData };
}

async function clearState(userId) {
    await pool.query("DELETE FROM user_states WHERE user_id = $1", [userId]);
}

async function incrementClickCount(userId) {
    await pool.query("UPDATE users SET click_count = click_count + 1 WHERE telegram_id = $1", [userId]);
    const res = await pool.query("SELECT click_count FROM users WHERE telegram_id = $1", [userId]);
    return res.rows[0]?.click_count || 0;
}

async function checkNeedSecondVerify(userId) {
    const res = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [userId]);
    if (res.rows.length === 0) return false;
    const user = res.rows[0];
    if (user.second_verify_passed) return false;
    if (!user.first_verify_passed) return false;
    if (user.click_count >= 5) return true;
    if (user.first_verify_time) {
        const verifyTime = new Date(user.first_verify_time);
        const now = new Date();
        if ((now - verifyTime) / (1000 * 60 * 60) >= 1) return true;
    }
    return false;
}

function createPaginationKeyboard(currentPage, totalCount, prefix) {
    const totalPages = Math.ceil(totalCount / 10) || 1;
    const buttons = [];
    if (currentPage > 1) buttons.push({ text: "◀️", callback_data: `${prefix}_page_${currentPage - 1}` });
    buttons.push({ text: `${currentPage}/${totalPages}`, callback_data: "noop" });
    if (currentPage < totalPages) buttons.push({ text: "▶️", callback_data: `${prefix}_page_${currentPage + 1}` });
    return buttons;
}

function scheduleDelete(chatId, messageId) {
    setTimeout(async () => {
        try { await bot.api.deleteMessage(chatId, messageId); } catch (e) {}
    }, 300000);
}
async function sendToAdmin(userId, username, firstName, reviewType, fileId, orderNumber) {
    const timeStr = getBeijingTimeString();
    const typeLabels = { 'first': '🔐 首次验证', 'second': '🔒 二次验证', 'vip': '💎 VIP订单' };
    
    let caption = `📋 **【${typeLabels[reviewType]}】待审核**\n\n👤 用户：@${username || '无'}\n📛 昵称：${firstName || '无'}\n🆔 ID：\`${userId}\`\n📅 时间：${timeStr}`;
    
    if (reviewType === 'second') {
        caption = `📋 **【${typeLabels[reviewType]}】待审核**\n\n👤 用户：@${username || '无'}\n📛 昵称：${firstName || '无'}\n🆔 ID：\`${userId}\`（二次验证）\n📅 时间：${timeStr}`;
    }
    if (reviewType === 'vip' && orderNumber) {
        caption += `\n🧾 订单号：\`${orderNumber}\``;
    }
    
    try {
        const keyboard = new InlineKeyboard()
            .text("✅", `qa_${reviewType}_${userId}`)
            .text("❌", `qr_${reviewType}_${userId}`)
            .text("🚫", `qb_${userId}`)
            .text("🗑️", `qd_${reviewType}_${userId}`);
        
        let adminMsg;
        if (fileId && reviewType !== 'vip') {
            adminMsg = await bot.api.sendPhoto(ADMIN_ID, fileId, { caption: caption, parse_mode: "Markdown", reply_markup: keyboard });
        } else {
            adminMsg = await bot.api.sendMessage(ADMIN_ID, caption, { parse_mode: "Markdown", reply_markup: keyboard });
        }
        
        await pool.query(
            `INSERT INTO pending_reviews (user_id, username, first_name, review_type, file_id, order_number, submitted_at, message_id, status)
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7, 'pending')`,
            [userId, username, firstName, reviewType, fileId, orderNumber, adminMsg.message_id]
        );
        console.log(`[工单] 已发送给管理员: ${reviewType} - ${userId}`);
        return true;
    } catch (error) {
        console.error("[工单] 发送失败:", error);
        return false;
    }
}

async function showStartPage(ctx) {
    const userId = ctx.from.id;
    await getOrInitUser(userId, ctx.from.username, ctx.from.first_name);
    await clearState(userId);
    
    const keyboard = new InlineKeyboard().text("🎁 兑换", "go_dh");
    const text = `🎊✨ **喜迎二月除夕** ✨🎊\n\n🎁 所有资源都【**免费观看**】！\n\n📦 只需打开兑换，点击相应按钮\n     即可直接免费观看~\n\n🧧 **新春快乐，万事如意！**`;
    
    try {
        if (ctx.callbackQuery) { try { await ctx.deleteMessage(); } catch(e){} }
        await ctx.reply(text, { reply_markup: keyboard, parse_mode: "Markdown" });
    } catch (e) { console.error("showStartPage:", e); }
}

async function showDhPage(ctx, page) {
    if (!page) page = 1;
    const userId = ctx.from.id;
    const userData = await getOrInitUser(userId, ctx.from.username, ctx.from.first_name);
    await clearState(userId);
    
    if (userData.is_banned) {
        const kb = new InlineKeyboard().text("💎 加入会员（特价版）", "go_v");
        try {
            if (ctx.callbackQuery) { try { await ctx.deleteMessage(); } catch(e){} }
            await ctx.reply(`🚫 **你已被本活动封禁**\n\n请加入会员（特价版）👇`, { reply_markup: kb, parse_mode: "Markdown" });
        } catch(e){}
        return;
    }
    
    if (userData.first_verify_passed && !userData.second_verify_passed) {
        const needSecond = await checkNeedSecondVerify(userId);
        if (needSecond) {
            if (ctx.callbackQuery) { try { await ctx.deleteMessage(); } catch(e){} }
            await showYzPage(ctx);
            return;
        }
    }
    
    const offset = (page - 1) * 10;
    const countRes = await pool.query("SELECT COUNT(*) FROM products");
    const totalCount = parseInt(countRes.rows[0].count);
    const productsRes = await pool.query("SELECT id, keyword FROM products ORDER BY id ASC LIMIT 10 OFFSET $1", [offset]);
    
    const keyboard = new InlineKeyboard();
    const products = productsRes.rows;
    for (let i = 0; i < products.length; i += 2) {
        if (i + 1 < products.length) {
            keyboard.text(`📦 ${products[i].keyword}`, `p_${products[i].id}`).text(`📦 ${products[i + 1].keyword}`, `p_${products[i + 1].id}`).row();
        } else {
            keyboard.text(`📦 ${products[i].keyword}`, `p_${products[i].id}`).row();
        }
    }
    
    if (totalCount > 10) {
        const nav = createPaginationKeyboard(page, totalCount, "dh");
        nav.forEach(b => keyboard.text(b.text, b.callback_data));
        keyboard.row();
    }
    
    if (userData.first_verify_passed) {
        keyboard.text("💎 加入会员（新春特价）", "go_v").row();
    }
    keyboard.text("🔙 返回首页", "go_start");
    
    let text;
    if (userData.first_verify_passed) {
        text = `📦 **兑换中心** ✨\n\n🎉 验证已通过，**无限畅享**！\n📥 点击编号即可免费观看\n\n━━━━━━━━━━━━━━━━━━━━`;
    } else {
        text = `📦 **兑换中心**\n\n🎉 点击对应编号按钮\n✨ 即可立马**免费观看**\n\n━━━━━━━━━━━━━━━━━━━━`;
    }
    if (products.length === 0) text += `\n\n🌑 暂无商品`;
    
    try {
        if (ctx.callbackQuery) { try { await ctx.deleteMessage(); } catch(e){} }
        await ctx.reply(text, { reply_markup: keyboard, parse_mode: "Markdown" });
    } catch (e) { console.error("showDhPage:", e); }
}
async function showAdminPage(ctx) {
    await clearState(ctx.from.id);
    const kb = new InlineKeyboard()
        .text("📂 File ID 工具", "admin_fid").row()
        .text("🛍️ 频道转发库", "admin_p_1").row()
        .text("📋 待处理", "admin_pending");
    
    try {
        if (ctx.callbackQuery) { try { await ctx.deleteMessage(); } catch(e){} }
        await ctx.reply(`🔧 **后台管理面板**\n\n━━━━━━━━━━━━━━━━━━━━\n\n💡 输入 /c 可取消操作`, { reply_markup: kb, parse_mode: "Markdown" });
    } catch (e) {}
}

async function showProductsPage(ctx, page) {
    if (!page) page = 1;
    const offset = (page - 1) * 10;
    const countRes = await pool.query("SELECT COUNT(*) FROM products");
    const totalCount = parseInt(countRes.rows[0].count);
    const productsRes = await pool.query("SELECT id, keyword FROM products ORDER BY id ASC LIMIT 10 OFFSET $1", [offset]);
    
    const kb = new InlineKeyboard().text("➕ 添加商品", "admin_add_p").row();
    productsRes.rows.forEach(p => { kb.text(`❌ [${p.id}] ${p.keyword}`, `admin_del_${p.id}`).row(); });
    
    if (totalCount > 10) {
        const nav = createPaginationKeyboard(page, totalCount, "admin_p");
        nav.forEach(b => kb.text(b.text, b.callback_data));
        kb.row();
    }
    kb.text("🔙 返回", "admin_back");
    
    try {
        if (ctx.callbackQuery) { try { await ctx.deleteMessage(); } catch(e){} }
        await ctx.reply(`🛍️ **频道转发库**\n\n📦 商品数量：**${totalCount}**\n📄 第 **${page}** 页`, { reply_markup: kb, parse_mode: "Markdown" });
    } catch (e) {}
}

async function showPendingPage(ctx) {
    const f = await pool.query("SELECT COUNT(*) FROM pending_reviews WHERE review_type = 'first' AND status = 'pending'");
    const s = await pool.query("SELECT COUNT(*) FROM pending_reviews WHERE review_type = 'second' AND status = 'pending'");
    const v = await pool.query("SELECT COUNT(*) FROM pending_reviews WHERE review_type = 'vip' AND status = 'pending'");
    
    const kb = new InlineKeyboard()
        .text(`🔐 首次验证 (${f.rows[0].count})`, "pend_first_1").row()
        .text(`🔒 二次验证 (${s.rows[0].count})`, "pend_second_1").row()
        .text(`💎 VIP验证 (${v.rows[0].count})`, "pend_vip_1").row()
        .text("🔙 返回", "admin_back");
    
    try {
        if (ctx.callbackQuery) { try { await ctx.deleteMessage(); } catch(e){} }
        await ctx.reply(`📋 **待处理中心**\n\n━━━━━━━━━━━━━━━━━━━━`, { reply_markup: kb, parse_mode: "Markdown" });
    } catch (e) {}
}

async function showPendingList(ctx, type, page) {
    if (!page) page = 1;
    const offset = (page - 1) * 10;
    const countRes = await pool.query("SELECT COUNT(*) FROM pending_reviews WHERE review_type = $1 AND status = 'pending'", [type]);
    const totalCount = parseInt(countRes.rows[0].count);
    const pendingRes = await pool.query("SELECT * FROM pending_reviews WHERE review_type = $1 AND status = 'pending' ORDER BY submitted_at ASC LIMIT 10 OFFSET $2", [type, offset]);
    
    const typeNames = { 'first': '🔐 首次验证', 'second': '🔒 二次验证', 'vip': '💎 VIP验证' };
    const kb = new InlineKeyboard();
    
    pendingRes.rows.forEach(item => {
        const name = item.first_name || item.username || 'Unknown';
        kb.text(`📌 ${name}`, `rev_${item.id}`).row();
    });
    
    if (totalCount > 10) {
        const nav = createPaginationKeyboard(page, totalCount, `pend_${type}`);
        nav.forEach(b => kb.text(b.text, b.callback_data));
        kb.row();
    }
    kb.text("🔙 返回", "admin_pending");
    
    try {
        if (ctx.callbackQuery) { try { await ctx.deleteMessage(); } catch(e){} }
        await ctx.reply(`${typeNames[type]} **待处理**\n\n📊 共 **${totalCount}** 条`, { reply_markup: kb, parse_mode: "Markdown" });
    } catch (e) {}
}

async function showReviewDetail(ctx, reviewId) {
    const res = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [reviewId]);
    if (res.rows.length === 0) { await ctx.answerCallbackQuery({ text: "不存在", show_alert: true }); return; }
    
    const r = res.rows[0];
    const typeNames = { 'first': '首次验证', 'second': '二次验证', 'vip': 'VIP验证' };
    
    const kb = new InlineKeyboard()
        .text("✅ 确认", `ra_${reviewId}`).text("❌ 驳回", `rr_${reviewId}`).row()
        .text("🚫 封禁", `rb_${reviewId}`).text("🗑️ 删除", `rd_${reviewId}`).row()
        .text("🔙 返回", `pend_${r.review_type}_1`);
    
    const time = new Date(r.submitted_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    let text = `📋 **【${typeNames[r.review_type]}】**\n\n👤 @${r.username || 'N/A'}\n📛 ${r.first_name || 'N/A'}\n🆔 \`${r.user_id}\`\n📅 ${time}`;
    if (r.review_type === 'vip' && r.order_number) text += `\n🧾 \`${r.order_number}\``;
    
    try {
        if (ctx.callbackQuery) { try { await ctx.deleteMessage(); } catch(e){} }
        if (r.file_id && r.review_type !== 'vip') {
            await ctx.replyWithPhoto(r.file_id, { caption: text, reply_markup: kb, parse_mode: "Markdown" });
        } else {
            await ctx.reply(text, { reply_markup: kb, parse_mode: "Markdown" });
        }
    } catch (e) {}
}
bot.command("start", async (ctx) => {
    try {
        const payload = ctx.match;
        if (payload === "dh") { await showDhPage(ctx, 1); }
        else { await showStartPage(ctx); }
    } catch (e) { console.error("start:", e); }
});

bot.command("dh", async (ctx) => { try { await showDhPage(ctx, 1); } catch (e) {} });
bot.command("y", async (ctx) => { try { await showYPage(ctx); } catch (e) {} });
bot.command("yz", async (ctx) => { try { await showYzPage(ctx); } catch (e) {} });
bot.command("v", async (ctx) => { try { await showVPage(ctx); } catch (e) {} });

bot.command("admin", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await showAdminPage(ctx);
});

bot.command("c", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await clearState(ctx.from.id);
    await ctx.reply("🚫 **已取消**", { parse_mode: "Markdown" });
    await showAdminPage(ctx);
});

bot.command("cz", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await pool.query(
        `UPDATE users SET is_vip = FALSE, is_banned = FALSE, first_verify_passed = FALSE, second_verify_passed = FALSE,
         first_verify_date = $1, first_verify_time = NULL, click_count = 0, reject_count_first = 0, reject_count_second = 0, needs_manual_review = FALSE
         WHERE telegram_id = $2`,
        [getBeijingDateString(), ADMIN_ID]
    );
    await clearState(ADMIN_ID);
    await ctx.reply(`✅ **测试模式**\n\n状态已重置为普通用户\n\n💡 输入 /c 恢复`, { parse_mode: "Markdown" });
    await showStartPage(ctx);
});

bot.callbackQuery("noop", async (ctx) => { await ctx.answerCallbackQuery(); });
bot.callbackQuery("go_start", async (ctx) => { await ctx.answerCallbackQuery(); await showStartPage(ctx); });
bot.callbackQuery("go_dh", async (ctx) => { await ctx.answerCallbackQuery(); await showDhPage(ctx, 1); });
bot.callbackQuery("force_dh", async (ctx) => { await ctx.answerCallbackQuery(); await clearState(ctx.from.id); await showDhPage(ctx, 1); });
bot.callbackQuery("go_v", async (ctx) => { await ctx.answerCallbackQuery(); await showVPage(ctx); });
bot.callbackQuery("go_y", async (ctx) => { await ctx.answerCallbackQuery(); await showYPage(ctx); });
bot.callbackQuery("refresh_y", async (ctx) => { await ctx.answerCallbackQuery({ text: "刷新中..." }); await showYPage(ctx); });
bot.callbackQuery("vip_paid", async (ctx) => { await ctx.answerCallbackQuery(); await showVipOrderPage(ctx, 0); });

bot.callbackQuery(/^dh_page_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDhPage(ctx, parseInt(ctx.match[1]));
});

bot.callbackQuery(/^p_(\d+)$/, async (ctx) => {
    try {
        const productId = parseInt(ctx.match[1]);
        const userId = ctx.from.id;
        const userData = await getOrInitUser(userId, ctx.from.username, ctx.from.first_name);
        
        if (userData.is_banned) { await ctx.answerCallbackQuery({ text: "已被封禁", show_alert: true }); return; }
        
        if (userData.first_verify_passed && !userData.second_verify_passed) {
            const newCount = await incrementClickCount(userId);
            if (newCount >= 5 || await checkNeedSecondVerify(userId)) {
                await ctx.answerCallbackQuery();
                await showYzPage(ctx);
                return;
            }
        }
        
        if (!userData.first_verify_passed) {
            await ctx.answerCallbackQuery();
            const kb = new InlineKeyboard().text("❌ 取消", "go_dh").text("✅ 确认", "go_y");
            try { await ctx.deleteMessage(); } catch(e){}
            await ctx.reply(`📦 **是否兑换？**\n\n确认后完成首次验证\n即可免费观看所有资源~`, { reply_markup: kb, parse_mode: "Markdown" });
            return;
        }
        
        await ctx.answerCallbackQuery({ text: "🎉 获取中..." });
        if (!userData.second_verify_passed) { await incrementClickCount(userId); }
        
        const productRes = await pool.query("SELECT * FROM products WHERE id = $1", [productId]);
        if (productRes.rows.length === 0) { await ctx.reply("⚠️ 商品不存在"); return; }
        
        const product = productRes.rows[0];
        const chatId = ctx.chat.id;
        
        const tipText = `🎉 **获取成功！**\n\n📦 商品：${product.keyword}\n⏰ 内容将在 **5分钟后** 自动删除\n\n━━━━━━━━━━━━━━━━━━━━\n\n${userData.is_vip ? '👑 **VIP会员** - 无限畅享' : '🎁 验证已通过 - 无限畅享'}`;
        const tipMsg = await ctx.reply(tipText, { parse_mode: "Markdown" });
        scheduleDelete(chatId, tipMsg.message_id);
        
        try {
            if (product.content_type === 'text') {
                const m = await ctx.reply(product.content_data);
                scheduleDelete(chatId, m.message_id);
            } else if (product.content_type === 'photo') {
                const m = await ctx.replyWithPhoto(product.content_data);
                scheduleDelete(chatId, m.message_id);
            } else if (product.content_type === 'video') {
                const m = await ctx.replyWithVideo(product.content_data);
                scheduleDelete(chatId, m.message_id);
            } else if (product.content_type === 'document') {
                const m = await ctx.replyWithDocument(product.content_data);
                scheduleDelete(chatId, m.message_id);
            } else if (product.content_type === 'media_group') {
                const contents = JSON.parse(product.content_data);
                for (const item of contents) {
                    let m;
                    if (item.type === 'photo') m = await ctx.replyWithPhoto(item.data);
                    else if (item.type === 'video') m = await ctx.replyWithVideo(item.data);
                    else if (item.type === 'document') m = await ctx.replyWithDocument(item.data);
                    else m = await ctx.reply(item.data);
                    scheduleDelete(chatId, m.message_id);
                }
            } else {
                const m = await ctx.reply(product.content_data);
                scheduleDelete(chatId, m.message_id);
            }
        } catch (e) { console.error("发送商品:", e); await ctx.reply("⚠️ 发送失败"); }
    } catch (e) { console.error("product:", e); }
});
bot.callbackQuery("admin_back", async (ctx) => { await ctx.answerCallbackQuery(); await showAdminPage(ctx); });
bot.callbackQuery("admin_fid", async (ctx) => {
    await ctx.answerCallbackQuery();
    await setState(ctx.from.id, "await_fid", null);
    const kb = new InlineKeyboard().text("🔙 取消", "admin_back");
    try { await ctx.deleteMessage(); } catch(e){}
    await ctx.reply(`📂 **File ID 工具**\n\n📸 请发送图片`, { reply_markup: kb, parse_mode: "Markdown" });
});

bot.callbackQuery(/^admin_p_(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showProductsPage(ctx, parseInt(ctx.match[1])); });

bot.callbackQuery("admin_add_p", async (ctx) => {
    await ctx.answerCallbackQuery();
    await setState(ctx.from.id, "await_keyword", null);
    const kb = new InlineKeyboard().text("🔙 取消", "admin_p_1");
    try { await ctx.deleteMessage(); } catch(e){}
    await ctx.reply(`➕ **添加商品**\n\n📝 请输入关键词（如：001）`, { reply_markup: kb, parse_mode: "Markdown" });
});

bot.callbackQuery("admin_confirm_p", async (ctx) => {
    await ctx.answerCallbackQuery();
    const state = await getState(ctx.from.id);
    if (!state.temp_data || !state.temp_data.keyword) { await ctx.reply("⚠️ 无商品"); await showAdminPage(ctx); return; }
    
    const { keyword, contents } = state.temp_data;
    if (!contents || contents.length === 0) { await ctx.reply("⚠️ 请上传内容"); return; }
    
    let contentType, contentData;
    if (contents.length === 1) { contentType = contents[0].type; contentData = contents[0].data; }
    else { contentType = 'media_group'; contentData = JSON.stringify(contents); }
    
    try {
        await pool.query("INSERT INTO products (keyword, content_type, content_data) VALUES ($1, $2, $3)", [keyword, contentType, contentData]);
        await ctx.reply(`🎉 **上架成功！**\n\n📦 关键词：${keyword}\n📝 内容：${contents.length} 条`, { parse_mode: "Markdown" });
        await clearState(ctx.from.id);
        await showProductsPage(ctx, 1);
    } catch (e) {
        if (e.code === '23505') await ctx.reply("⚠️ 关键词已存在");
        else await ctx.reply("⚠️ 保存失败");
    }
});

bot.callbackQuery("admin_cancel_p", async (ctx) => { await ctx.answerCallbackQuery(); await clearState(ctx.from.id); await ctx.reply("🚫 已取消"); await showProductsPage(ctx, 1); });

bot.callbackQuery(/^admin_del_(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[1];
    const kb = new InlineKeyboard().text("✅ 确认", `admin_delc_${id}`).text("🔙 取消", "admin_p_1");
    try { await ctx.deleteMessage(); } catch(e){}
    await ctx.reply(`⚠️ **确认删除？**`, { reply_markup: kb, parse_mode: "Markdown" });
});

bot.callbackQuery(/^admin_delc_(\d+)$/, async (ctx) => {
    await pool.query("DELETE FROM products WHERE id = $1", [ctx.match[1]]);
    await ctx.answerCallbackQuery({ text: "🗑️ 已删除" });
    await showProductsPage(ctx, 1);
});

bot.callbackQuery("admin_pending", async (ctx) => { await ctx.answerCallbackQuery(); await showPendingPage(ctx); });
bot.callbackQuery(/^pend_(first|second|vip)_(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showPendingList(ctx, ctx.match[1], parseInt(ctx.match[2])); });
bot.callbackQuery(/^rev_(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showReviewDetail(ctx, parseInt(ctx.match[1])); });

bot.callbackQuery(/^ra_(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1]);
    const res = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [id]);
    if (res.rows.length === 0) return ctx.answerCallbackQuery({ text: "不存在", show_alert: true });
    const r = res.rows[0];
    await pool.query("UPDATE pending_reviews SET status = 'approved' WHERE id = $1", [id]);
    if (r.review_type === 'first') await pool.query("UPDATE users SET first_verify_passed = TRUE, needs_manual_review = FALSE WHERE telegram_id = $1", [r.user_id]);
    else if (r.review_type === 'vip') await pool.query("UPDATE users SET is_vip = TRUE WHERE telegram_id = $1", [r.user_id]);
    await ctx.answerCallbackQuery({ text: "✅ 已确认" });
    await showPendingList(ctx, r.review_type, 1);
});

bot.callbackQuery(/^rr_(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1]);
    const res = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [id]);
    if (res.rows.length === 0) return ctx.answerCallbackQuery({ text: "不存在", show_alert: true });
    const r = res.rows[0];
    await pool.query("UPDATE pending_reviews SET status = 'rejected' WHERE id = $1", [id]);
    
    if (r.review_type === 'first') {
        const uRes = await pool.query("SELECT reject_count_first FROM users WHERE telegram_id = $1", [r.user_id]);
        const newCount = (uRes.rows[0]?.reject_count_first || 0) + 1;
        if (newCount >= 2) {
            await pool.query("UPDATE users SET reject_count_first = $1, first_verify_passed = FALSE, needs_manual_review = TRUE WHERE telegram_id = $2", [newCount, r.user_id]);
            try { await bot.api.sendMessage(r.user_id, `⚠️ **验证被驳回**\n\n已驳回 ${newCount} 次，需等待管理员审核。\n每日凌晨00:00重置。\n\n请上传正确截图！`, { parse_mode: "Markdown" }); } catch(e){}
        } else {
            await pool.query("UPDATE users SET reject_count_first = $1, first_verify_passed = FALSE WHERE telegram_id = $2", [newCount, r.user_id]);
            try { await bot.api.sendMessage(r.user_id, `⚠️ **验证被驳回**\n\n请上传包含【时间】和【助力成功】的截图！\n\n输入 /y 继续`, { parse_mode: "Markdown" }); } catch(e){}
        }
    } else if (r.review_type === 'second') {
        await pool.query("UPDATE users SET second_verify_passed = FALSE WHERE telegram_id = $1", [r.user_id]);
        try { await bot.api.sendMessage(r.user_id, `⚠️ **二次验证被驳回**\n\n请不要作弊！输入 /yz 继续`, { parse_mode: "Markdown" }); } catch(e){}
    }
    await ctx.answerCallbackQuery({ text: "❌ 已驳回" });
    await showPendingList(ctx, r.review_type, 1);
});

bot.callbackQuery(/^rb_(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1]);
    const res = await pool.query("SELECT * FROM pending_reviews WHERE id = $1", [id]);
    if (res.rows.length === 0) return ctx.answerCallbackQuery({ text: "不存在", show_alert: true });
    const r = res.rows[0];
    await pool.query("UPDATE pending_reviews SET status = 'banned' WHERE id = $1", [id]);
    await pool.query("UPDATE users SET is_banned = TRUE WHERE telegram_id = $1", [r.user_id]);
    try { await bot.api.sendMessage(r.user_id, `🚫 **您已被封禁**\n\n多次作弊已被永久封禁。\n\n输入 /v 购买会员`, { parse_mode: "Markdown" }); } catch(e){}
    await ctx.answerCallbackQuery({ text: "🚫 已封禁" });
    await showPendingList(ctx, r.review_type, 1);
});

bot.callbackQuery(/^rd_(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1]);
    const res = await pool.query("SELECT review_type FROM pending_reviews WHERE id = $1", [id]);
    const type = res.rows[0]?.review_type || 'first';
    await pool.query("DELETE FROM pending_reviews WHERE id = $1", [id]);
    await ctx.answerCallbackQuery({ text: "🗑️ 已删除" });
    await showPendingList(ctx, type, 1);
});
bot.callbackQuery(/^qa_(first|second|vip)_(\d+)$/, async (ctx) => {
    const type = ctx.match[1];
    const userId = parseInt(ctx.match[2]);
    if (type === 'first') await pool.query("UPDATE users SET first_verify_passed = TRUE, needs_manual_review = FALSE WHERE telegram_id = $1", [userId]);
    else if (type === 'vip') await pool.query("UPDATE users SET is_vip = TRUE WHERE telegram_id = $1", [userId]);
    await pool.query("UPDATE pending_reviews SET status = 'approved' WHERE user_id = $1 AND review_type = $2 AND status = 'pending'", [userId, type]);
    await ctx.answerCallbackQuery({ text: "✅ 已确认" });
    try { const msg = ctx.callbackQuery.message; if (msg.photo) await ctx.editMessageCaption({ caption: (msg.caption || '') + "\n\n✅ **已确认**", parse_mode: "Markdown" }); else await ctx.editMessageText((msg.text || '') + "\n\n✅ **已确认**", { parse_mode: "Markdown" }); } catch(e){}
});

bot.callbackQuery(/^qr_(first|second|vip)_(\d+)$/, async (ctx) => {
    const type = ctx.match[1];
    const userId = parseInt(ctx.match[2]);
    if (type === 'first') {
        const uRes = await pool.query("SELECT reject_count_first FROM users WHERE telegram_id = $1", [userId]);
        const newCount = (uRes.rows[0]?.reject_count_first || 0) + 1;
        if (newCount >= 2) await pool.query("UPDATE users SET reject_count_first = $1, first_verify_passed = FALSE, needs_manual_review = TRUE WHERE telegram_id = $2", [newCount, userId]);
        else await pool.query("UPDATE users SET reject_count_first = $1, first_verify_passed = FALSE WHERE telegram_id = $2", [newCount, userId]);
        try { await bot.api.sendMessage(userId, "⚠️ 验证被驳回，请输入 /y 重新验证"); } catch(e){}
    } else if (type === 'second') {
        await pool.query("UPDATE users SET second_verify_passed = FALSE WHERE telegram_id = $1", [userId]);
        try { await bot.api.sendMessage(userId, "⚠️ 二次验证被驳回，请输入 /yz 重新验证"); } catch(e){}
    }
    await pool.query("UPDATE pending_reviews SET status = 'rejected' WHERE user_id = $1 AND review_type = $2 AND status = 'pending'", [userId, type]);
    await ctx.answerCallbackQuery({ text: "❌ 已驳回" });
    try { const msg = ctx.callbackQuery.message; if (msg.photo) await ctx.editMessageCaption({ caption: (msg.caption || '') + "\n\n❌ **已驳回**", parse_mode: "Markdown" }); else await ctx.editMessageText((msg.text || '') + "\n\n❌ **已驳回**", { parse_mode: "Markdown" }); } catch(e){}
});

bot.callbackQuery(/^qb_(\d+)$/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    await pool.query("UPDATE users SET is_banned = TRUE WHERE telegram_id = $1", [userId]);
    await pool.query("UPDATE pending_reviews SET status = 'banned' WHERE user_id = $1 AND status = 'pending'", [userId]);
    try { await bot.api.sendMessage(userId, "🚫 您已被封禁"); } catch(e){}
    await ctx.answerCallbackQuery({ text: "🚫 已封禁" });
    try { const msg = ctx.callbackQuery.message; if (msg.photo) await ctx.editMessageCaption({ caption: (msg.caption || '') + "\n\n🚫 **已封禁**", parse_mode: "Markdown" }); else await ctx.editMessageText((msg.text || '') + "\n\n🚫 **已封禁**", { parse_mode: "Markdown" }); } catch(e){}
});

bot.callbackQuery(/^qd_(first|second|vip)_(\d+)$/, async (ctx) => {
    const type = ctx.match[1];
    const userId = parseInt(ctx.match[2]);
    await pool.query("DELETE FROM pending_reviews WHERE user_id = $1 AND review_type = $2 AND status = 'pending'", [userId, type]);
    await ctx.answerCallbackQuery({ text: "🗑️ 已删除" });
    try { await ctx.deleteMessage(); } catch(e){}
});

bot.on("message", async (ctx) => {
    try {
        const userId = ctx.from.id;
        const state = await getState(userId);
        const text = ctx.message.text || "";
        
        if (userId === ADMIN_ID) {
            if (state.state === "await_fid") {
                if (ctx.message.photo) {
                    const fid = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                    await ctx.reply(`📂 **File ID：**\n\n\`${fid}\``, { parse_mode: "Markdown" });
                    await clearState(userId);
                    await showAdminPage(ctx);
                } else { await ctx.reply("⚠️ 请发送图片"); }
                return;
            }
            if (state.state === "await_keyword") {
                const keyword = text.trim();
                if (!keyword) { await ctx.reply("⚠️ 关键词不能为空"); return; }
                const exist = await pool.query("SELECT id FROM products WHERE keyword = $1", [keyword]);
                if (exist.rows.length > 0) { await ctx.reply("⚠️ 关键词已存在"); return; }
                await setState(userId, "collect_content", { keyword: keyword, contents: [] });
                const kb = new InlineKeyboard().text("✅ 完成上架", "admin_confirm_p").text("❌ 取消", "admin_cancel_p");
                await ctx.reply(`✅ 关键词：**${keyword}**\n\n📤 请上传内容（图片/视频/文件/文字）\n发送完毕点击【完成上架】`, { reply_markup: kb, parse_mode: "Markdown" });
                return;
            }
            if (state.state === "collect_content") {
                const tempData = state.temp_data || { keyword: "", contents: [] };
                let item = null;
                if (ctx.message.photo) item = { type: 'photo', data: ctx.message.photo[ctx.message.photo.length - 1].file_id };
                else if (ctx.message.video) item = { type: 'video', data: ctx.message.video.file_id };
                else if (ctx.message.document) item = { type: 'document', data: ctx.message.document.file_id };
                else if (text && !text.startsWith('/')) item = { type: 'text', data: text };
                if (item) {
                    tempData.contents.push(item);
                    await setState(userId, "collect_content", tempData);
                    const kb = new InlineKeyboard().text("✅ 完成上架", "admin_confirm_p").text("❌ 取消", "admin_cancel_p");
                    await ctx.reply(`📥 已收到第 **${tempData.contents.length}** 条\n\n继续发送或点击【完成上架】`, { reply_markup: kb, parse_mode: "Markdown" });
                }
                return;
            }
        }
        
        if (state.state === "await_y") {
            if (ctx.message.photo) {
                const fid = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                await pool.query("UPDATE users SET first_verify_passed = TRUE, first_verify_time = CURRENT_TIMESTAMP WHERE telegram_id = $1", [userId]);
                await sendToAdmin(userId, ctx.from.username, ctx.from.first_name, 'first', fid, null);
                await ctx.reply(`✅ **验证成功！**\n\n🎉 现在可以**无限畅享**所有资源啦~`, { parse_mode: "Markdown" });
                await clearState(userId);
                await showDhPage(ctx, 1);
            } else { await ctx.reply("❌ 请上传**图片**！", { parse_mode: "Markdown" }); }
            return;
        }
        
        if (state.state === "await_yz") {
            if (ctx.message.photo) {
                const fid = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                await pool.query("UPDATE users SET second_verify_passed = TRUE WHERE telegram_id = $1", [userId]);
                await sendToAdmin(userId, ctx.from.username, ctx.from.first_name, 'second', fid, null);
                await ctx.reply(`✅ **二次验证成功！**\n\n🎉 永久免验证，无限畅享！`, { parse_mode: "Markdown" });
                await clearState(userId);
                await showDhPage(ctx, 1);
            } else { await ctx.reply("❌ 请上传**图片**！", { parse_mode: "Markdown" }); }
            return;
        }
        
        if (state.state === "await_order") {
            const attempts = state.temp_data?.attempts || 0;
            if (text.startsWith("20260")) {
                const kb = new InlineKeyboard().url("🎁 加入会员群", VIP_GROUP_LINK);
                await ctx.reply(`🎉 **验证成功！**\n\n欢迎加入VIP！`, { parse_mode: "Markdown", reply_markup: kb });
                await sendToAdmin(userId, ctx.from.username, ctx.from.first_name, 'vip', null, text);
                await clearState(userId);
            } else {
                const newAttempts = attempts + 1;
                if (newAttempts >= 2) {
                    await ctx.reply("❌ 订单号错误次数过多");
                    await clearState(userId);
                    await showDhPage(ctx, 1);
                } else { await showVipOrderPage(ctx, newAttempts); }
            }
            return;
        }
        
        if (text && !text.startsWith('/')) { await showStartPage(ctx); }
    } catch (e) { console.error("message:", e); }
});

bot.catch((err) => { console.error("Bot error:", err); });

module.exports = webhookCallback(bot, "http");
