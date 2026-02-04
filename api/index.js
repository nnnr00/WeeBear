// api/index.js
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const moment = require('moment-timezone');

// ==========================================
// 1. 数据库连接
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const query = async (text, params) => await pool.query(text, params);

// ==========================================
// 2. 初始化与配置
// ==========================================
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

// 🔴 🔴 🔴 请务必在部署后使用 /admin -> 获取 File ID 替换此处 🔴 🔴 🔴
// 如果 ID 填错，机器人发送图片时会报错导致无反应，代码已做防崩溃处理
const CONFIG = {
    // 首次验证 /y 图片 (2张)
    y_images: [
        'AgACAgUAAxkBAAIxxxx1', 
        'AgACAgUAAxkBAAIxxxx2'
    ],
    // 二次验证 /yz 图片 (3张)
    yz_images: [
        'AgACAgUAAxkBAAIxxxx3',
        'AgACAgUAAxkBAAIxxxx4',
        'AgACAgUAAxkBAAIxxxx5'
    ],
    // VIP 特权说明图片 (1张)
    vip_info_image: 'AgACAgUAAxkBAAIxxxx6', 
    // 查找订单号教程图片 (1张)
    order_tutorial_image: 'AgACAgUAAxkBAAIxxxx7',
    // 支付成功后的加群链接
    vip_group_link: 'https://t.me/+495j5rWmApsxYzg9' 
};

// ==========================================
// 3. 全局中间件
// ==========================================
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();

    const chatId = ctx.from.id;
    const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');

    // 1. 获取或创建用户
    let res = await query('SELECT * FROM users WHERE chat_id = $1', [chatId]);
    let user = res.rows[0];

    if (!user) {
        await query(
            `INSERT INTO users (chat_id, username, first_name, last_verify_date) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [chatId, ctx.from.username, ctx.from.first_name, '']
        );
        res = await query('SELECT * FROM users WHERE chat_id = $1', [chatId]);
        user = res.rows[0];
    }

    // 2. 每日重置逻辑 (北京时间 00:00)
    if (user.last_verify_date !== today) {
        await query(
            `UPDATE users SET first_verify_status = $1, last_verify_date = $2, download_count = 0 WHERE chat_id = $3`,
            [false, today, chatId]
        );
        user.first_verify_status = false;
        user.last_verify_date = today;
    }

    // 3. 封禁检查
    if (user.is_banned) {
        const isVipAction = (ctx.message && ctx.message.text === '/v') || 
                            (ctx.callbackQuery && ['btn_vip', 'btn_paid_verify'].includes(ctx.callbackQuery.data));
        
        if (isVipAction) {
            ctx.user = user;
            return next();
        }
        
        try {
           await ctx.reply('⛔️ 你已被本活动封禁，请加入会员（特价版）', 
               Markup.inlineKeyboard([[Markup.button.callback('💎 加入会员（新春特价）', 'btn_vip')]])
           );
        } catch(e) {}
        return;
    }

    ctx.user = user;
    await next();
});

// ==========================================
// 4. 基础命令 (/start, /dh)
// ==========================================

// /start
bot.start(async (ctx) => {
    await query("UPDATE users SET state = 'IDLE' WHERE chat_id = $1", [ctx.user.chat_id]);

    const args = ctx.message.text.split(' ');
    // 深层链接 start=dh
    if (args.length > 1 && args[1] === 'dh') {
        return sendDhPage(ctx, 1);
    }

    const welcomeText = `🧨 <b>喜迎二月除夕，新春快乐！</b> 🧨\n\n` +
                        `本频道所有资源 <b>免费观看</b>！无套路！\n` +
                        `只需要打开兑换中心，点击相应按钮即可直接观看。\n\n` +
                        `👇 点击下方按钮开始 👇`;

    await ctx.replyWithHTML(welcomeText, Markup.inlineKeyboard([
        [Markup.button.callback('🧧 新春兑换中心', 'goto_dh')]
    ]));
});

// /dh 兑换中心
const sendDhPage = async (ctx, page = 1) => {
    const limit = 10;
    const offset = (page - 1) * limit;
    
    // 获取商品
    const pRes = await query('SELECT keyword FROM products ORDER BY keyword LIMIT $1 OFFSET $2', [limit, offset]);
    const products = pRes.rows;
    
    // 如果没有商品，防止没反应
    if (products.length === 0 && page === 1) {
        return ctx.reply('📭 暂无上架商品，请联系管理员。');
    }

    const cRes = await query('SELECT COUNT(*) FROM products');
    const total = parseInt(cRes.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    let buttons = [];
    let row = [];
    products.forEach((p) => {
        row.push(Markup.button.callback(p.keyword, `prod_${p.keyword}`));
        if (row.length === 2) {
            buttons.push(row);
            row = [];
        }
    });
    if (row.length > 0) buttons.push(row);

    // 翻页
    let navRow = [];
    if (page > 1) navRow.push(Markup.button.callback('⬅️ 上一页', `dh_page_${page - 1}`));
    navRow.push(Markup.button.callback(`${page}/${totalPages || 1}`, 'noop'));
    if (page < totalPages) navRow.push(Markup.button.callback('下一页 ➡️', `dh_page_${page + 1}`));
    buttons.push(navRow);

    // 底部按钮
    let verifyBtnText = '🛡 开始验证';
    let verifyAction = 'goto_verify_y';
    
    if (ctx.user.first_verify_status || ctx.user.is_vip) {
        verifyBtnText = '💎 加入会员（新春特价）';
        verifyAction = 'btn_vip';
    }

    buttons.push([Markup.button.callback(verifyBtnText, verifyAction)]);

    const text = `<b>📀 资源兑换中心</b>\n\n` +
                 `说明：点此对应的编号按钮，即可立马免费观看。\n` +
                 `当前页码：${page}`;

    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
        } else {
            await ctx.replyWithHTML(text, Markup.inlineKeyboard(buttons));
        }
    } catch (e) {
        await ctx.replyWithHTML(text, Markup.inlineKeyboard(buttons));
    }
};

bot.action(/dh_page_(\d+)/, async (ctx) => {
    await sendDhPage(ctx, parseInt(ctx.match[1]));
    await ctx.answerCbQuery();
});

bot.action('goto_dh', async (ctx) => {
    await sendDhPage(ctx, 1);
    await ctx.answerCbQuery();
});

// ==========================================
// 5. VIP 逻辑 (/v)
// ==========================================

bot.command('v', async (ctx) => showVipPage(ctx));
bot.action('btn_vip', async (ctx) => {
    await ctx.answerCbQuery();
    await showVipPage(ctx);
});

const showVipPage = async (ctx) => {
    const text = `<b>🧨 喜迎新春（特价）</b>\n\n` +
                 `💎 <b>VIP会员特权说明：</b>\n` +
                 `✅ 专属中转通道\n` +
                 `✅ 优先审核入群\n` +
                 `✅ 7x24小时客服支持\n` +
                 `✅ 定期福利活动`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ 我已付款，开始验证', 'btn_paid_verify')]
    ]);

    try {
        if (CONFIG.vip_info_image && CONFIG.vip_info_image.length > 5) {
            await ctx.replyWithPhoto(CONFIG.vip_info_image, {
                caption: text,
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            }).catch(() => ctx.replyWithHTML(text, keyboard)); // 图片报错降级发文字
        } else {
            await ctx.replyWithHTML(text, keyboard);
        }
    } catch(e) { console.error(e); }
};

bot.action('btn_paid_verify', async (ctx) => {
    await query("UPDATE users SET state = 'WAIT_PAYMENT_ORDER' WHERE chat_id = $1", [ctx.user.chat_id]);

    const tutorialText = `<b>🔎 查找订单号详细教程</b>\n\n` +
                         `1. 打开支付软件（支付宝/微信）\n` +
                         `2. 点击 <b>我的</b> -> <b>账单</b>\n` +
                         `3. 找到对应付款记录 -> <b>账单详情</b>\n` +
                         `4. 点击 <b>更多</b> -> 复制 <b>订单号</b>\n\n` +
                         `👇 <b>请在下方直接回复您的订单号：</b>\n` +
                         `（系统自动识别 20260 开头，支持粘贴）`;

    if (CONFIG.order_tutorial_image && CONFIG.order_tutorial_image.length > 5) {
        await ctx.replyWithPhoto(CONFIG.order_tutorial_image, { caption: tutorialText, parse_mode: 'HTML' })
            .catch(() => ctx.replyWithHTML(tutorialText));
    } else {
        await ctx.replyWithHTML(tutorialText);
    }
    await ctx.answerCbQuery();
});

// ==========================================
// 6. 验证流程逻辑 (/y, /yz)
// ==========================================

bot.action(/prod_(.+)/, async (ctx) => {
    const keyword = ctx.match[1];
    await ctx.editMessageText(`您选择了资源：<b>${keyword}</b>\n确认要兑换吗？`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[Markup.button.callback('❌ 取消', 'goto_dh'), Markup.button.callback('✅ 确认', `confirm_prod_${keyword}`)]] }
    });
    await ctx.answerCbQuery();
});

bot.action(/confirm_prod_(.+)/, async (ctx) => {
    const keyword = ctx.match[1];
    const user = ctx.user;

    // VIP 直接通过
    if (user.is_vip) return sendProduct(ctx, keyword);

    // 1. 首次验证
    if (!user.first_verify_status) return startFirstVerify(ctx);

    // 2. 二次验证 (1小时后 OR 5次下载后)
    if (!user.second_verify_done) {
        const oneHour = 3600000;
        const firstTime = user.first_verify_time ? new Date(user.first_verify_time).getTime() : 0;
        const now = new Date().getTime();
        
        if ((now - firstTime > oneHour) || user.download_count >= 5) {
            return startSecondVerify(ctx);
        }
    }

    return sendProduct(ctx, keyword);
});

// 发送资源
const sendProduct = async (ctx, keyword) => {
    const res = await query('SELECT content FROM products WHERE keyword = $1', [keyword]);
    if (res.rows.length === 0) return ctx.reply('⚠️ 资源不存在。');

    await query('UPDATE users SET download_count = download_count + 1 WHERE chat_id = $1', [ctx.user.chat_id]);
    await ctx.reply(`正在发送资源：${keyword} ...`);
    
    const contentList = res.rows[0].content;
    const mediaGroup = [];
    const sentMsgIds = [];

    for (const item of contentList) {
        if (item.type === 'text') {
            const m = await ctx.reply(item.text);
            sentMsgIds.push(m.message_id);
        } else {
            mediaGroup.push({ type: item.type, media: item.fileId });
        }
    }

    if (mediaGroup.length > 0) {
        const chunkSize = 10;
        for (let i = 0; i < mediaGroup.length; i += chunkSize) {
            const msgs = await ctx.replyWithMediaGroup(mediaGroup.slice(i, i + chunkSize));
            msgs.forEach(m => sentMsgIds.push(m.message_id));
        }
    }

    const deleteTime = moment().add(5, 'minutes').format('YYYY-MM-DD HH:mm:ss');
    for (const mid of sentMsgIds) {
        await query('INSERT INTO auto_delete (chat_id, message_id, delete_at) VALUES ($1, $2, $3)', [ctx.chat.id, mid, deleteTime]);
    }
    await ctx.reply('⏳ 消息将在 5 分钟后自动销毁。');
};

const startFirstVerify = async (ctx) => {
    await query("UPDATE users SET state = 'WAIT_Y_PHOTO' WHERE chat_id = $1", [ctx.user.chat_id]);
    const text = `<b>🔰 首次验证 (无套路 3秒自动审核)</b>\n\n` +
                 `教程：打开支付宝扫一扫，点击完成助力。\n` +
                 `<b>请上传截图</b>：截图需包含“你截图的时间”和“助力成功”文字。\n\n` +
                 `👇 请查看下方示例图片，并上传你的截图：`;
    
    // 安全发送图片，防止ID错误导致无反应
    const media = CONFIG.y_images.map(id => ({ type: 'photo', media: id }));
    if (media.length > 0) {
        try {
            await ctx.replyWithMediaGroup(media);
        } catch(e) {
            console.error("发送引导图失败:", e);
        }
    }
    
    await ctx.replyWithHTML(text);
    if (ctx.callbackQuery) await ctx.answerCbQuery();
};

const startSecondVerify = async (ctx) => {
    await query("UPDATE users SET state = 'WAIT_YZ_PHOTO' WHERE chat_id = $1", [ctx.user.chat_id]);
    const text = `<b>🛡 二次验证 (防作弊系统)</b>\n\n` +
                 `这是本活动<b>最后一次验证</b>！通过后永久免费，无限制浏览！\n` +
                 `教程：打开支付宝扫二维码 -> 点击 <b>“去凑分”</b> -> 页面截图。\n` +
                 `<b>截图要求</b>：需要出现 <b>芝麻分数字</b>。\n\n` +
                 `👇 请参照下方 3 张示例图上传：`;
                 
    const media = CONFIG.yz_images.map(id => ({ type: 'photo', media: id }));
    if (media.length > 0) {
        try {
            await ctx.replyWithMediaGroup(media);
        } catch(e) {
            console.error("发送引导图失败:", e);
        }
    }

    await ctx.replyWithHTML(text);
    if (ctx.callbackQuery) await ctx.answerCbQuery();
};

// ==========================================
// 7. 消息处理 (订单号 / 图片上传 / Admin)
// ==========================================

bot.on(['text', 'photo', 'document', 'video'], async (ctx, next) => {
    const user = ctx.user;
    const cid = ctx.from.id;
    const text = ctx.message.text;

    // --- Admin 获取 File ID ---
    if (cid === ADMIN_ID && user.admin_state === 'GET_FILE_ID') {
        if (text && text.startsWith('/')) return next();
        let fileId = '未识别';
        if (ctx.message.photo) fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        else if (ctx.message.document) fileId = ctx.message.document.file_id;
        else if (ctx.message.video) fileId = ctx.message.video.file_id;
        await ctx.replyWithHTML(`File ID:\n<code>${fileId}</code>`, Markup.inlineKeyboard([[Markup.button.callback('🔙 返回后台', 'back_to_admin')]]));
        return;
    }

    // --- Admin 上架内容 ---
    if (cid === ADMIN_ID && user.admin_state === 'WAIT_CONTENT') {
        if (text && text.startsWith('/')) return next();
        return handleAdminUpload(ctx);
    }

    // --- VIP 订单号 ---
    if (user.state === 'WAIT_PAYMENT_ORDER' && text) {
        if (text.trim().startsWith('20260')) {
            await query(`UPDATE users SET is_vip = TRUE, is_banned = FALSE, state = 'IDLE' WHERE chat_id = $1`, [cid]);
            
            await ctx.replyWithHTML(
                `🎉 <b>验证通过！</b>\n\n您已成为尊贵的 VIP 会员，享有所有特权。`,
                Markup.inlineKeyboard([
                    [Markup.button.url('🔗 点击加入会员群', CONFIG.vip_group_link)]
                ])
            );

            // 发送给管理
            const timeStr = moment().tz('Asia/Shanghai').format('YYYY.MM.DD HH:mm:ss');
            const caption = `<b>💰 VIP订单审核 (待处理)</b>\n\n` +
                            `用户：${user.first_name || '未设置'} (ID: <code>${cid}</code>)\n` +
                            `订单号：<code>${text}</code>\n` +
                            `时间：${timeStr}\n` +
                            `状态：系统已通过，请人工复核`;
            
            try {
                await bot.telegram.sendMessage(ADMIN_ID, caption, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [Markup.button.callback('✅ 确认 (无事发生)', `audit_pass_${cid}`)],
                            [Markup.button.callback('↩️ 驳回 (取消VIP)', `audit_reject_vip_${cid}`)],
                            [Markup.button.callback('🚫 封禁 (永久)', `audit_ban_${cid}`)]
                        ]
                    }
                });
            } catch(e) {}
            return;
        } else {
            await ctx.reply('❌ 验证失败，未查询到订单信息。\n请核对后重新输入：');
            return;
        }
    }

    // --- 验证图片上传 (/y, /yz) ---
    if (user.state === 'WAIT_Y_PHOTO' || user.state === 'WAIT_YZ_PHOTO') {
        if (!ctx.message.photo && !ctx.message.document) {
            if (text && text.startsWith('/')) return next();
            return ctx.reply('❌ 格式错误，请上传图片截图！');
        }

        const isSecond = user.state === 'WAIT_YZ_PHOTO';
        const photo = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1] : ctx.message.document;
        const fileId = photo.file_id;

        await ctx.reply('✅ 验证成功！系统正在后台二次核验...');

        // 更新状态
        if (isSecond) {
            await query("UPDATE users SET second_verify_done = $1, state = 'IDLE' WHERE chat_id = $2", [true, cid]);
        } else {
            const nowTime = moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
            await query("UPDATE users SET first_verify_status = $1, first_verify_time = $2, state = 'IDLE' WHERE chat_id = $3", [true, nowTime, cid]);
        }

        await sendDhPage(ctx, 1);

        // 发送工单给管理
        const verifyTypeStr = isSecond ? '(二次验证)' : '(首次验证)';
        const timeStr = moment().tz('Asia/Shanghai').format('YYYY.MM.DD HH:mm:ss');
        const caption = `<b>📝 待处理工单 ${verifyTypeStr}</b>\n\n` +
                        `用户：${user.first_name} (ID: <code>${cid}</code>)\n` +
                        `时间：${timeStr}\n` +
                        `状态：自动放行，等待复核`;

        await bot.telegram.sendPhoto(ADMIN_ID, fileId, {
            caption: caption,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.callback('✅ 通过 (无事发生)', `audit_pass_${cid}`)],
                    [Markup.button.callback('↩️ 驳回 (重置)', `audit_reject_${cid}_${isSecond ? '2' : '1'}`)],
                    [Markup.button.callback('🚫 封禁 (永久)', `audit_ban_${cid}`)]
                ]
            }
        });
        return;
    }

    next();
});

// ==========================================
// 8. 管理员后台 (/admin)
// ==========================================

bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await query("UPDATE users SET admin_state = 'IDLE', editing_keyword = '' WHERE chat_id = $1", [ADMIN_ID]);
    
    await ctx.reply('👮‍♂️ <b>管理员后台</b>', {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [Markup.button.callback('📂 获取 File ID', 'admin_get_fileid')],
                [Markup.button.callback('📤 频道转发库 (上架)', 'admin_add_product')],
                [Markup.button.callback('⏳ 待处理工单', 'admin_pending_info')], // 新增按钮
                [Markup.button.callback('🚫 退出后台', 'noop')]
            ]
        }
    });
});

// 新增：点击待处理工单按钮
bot.action('admin_pending_info', async (ctx) => {
    // 统计有多少用户处于上传图片状态（虽然通常是瞬时的，但这能满足后台有按钮的需求）
    // 由于我们采用的是“用户上传->直接推送到对话框”的模式，这里可以显示一个提示
    const res = await query(`SELECT COUNT(*) FROM users WHERE state IN ('WAIT_Y_PHOTO', 'WAIT_YZ_PHOTO')`);
    const count = res.rows[0].count;
    
    await ctx.editMessageText(
        `<b>⏳ 待处理工单系统</b>\n\n` +
        `当前正在上传中的用户数：${count}\n\n` +
        `ℹ️ <b>说明：</b>\n` +
        `当用户上传截图或提交订单号时，工单会<b>自动推送</b>到您的此对话框中，请直接在对话框中操作通过或驳回。\n` +
        `无需在此菜单中查找历史工单。`, 
        { 
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[Markup.button.callback('🔙 返回后台', 'back_to_admin')]]
            }
        }
    );
    await ctx.answerCbQuery();
});

bot.action('admin_get_fileid', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await query("UPDATE users SET admin_state = 'GET_FILE_ID' WHERE chat_id = $1", [ADMIN_ID]);
    await ctx.editMessageText('请发送图片/视频/文件，我将返回 file_id。\n\n⚠️ <b>任意格式均可。</b>', 
        Markup.inlineKeyboard([[Markup.button.callback('🔙 返回后台', 'back_to_admin')]])
    );
    await ctx.answerCbQuery();
});

bot.action('back_to_admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await query("UPDATE users SET admin_state = 'IDLE' WHERE chat_id = $1", [ADMIN_ID]);
    await ctx.editMessageText('👮‍♂️ <b>管理员后台</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[Markup.button.callback('📂 获取 File ID', 'admin_get_fileid')], [Markup.button.callback('📤 频道转发库 (上架)', 'admin_add_product')], [Markup.button.callback('⏳ 待处理工单', 'admin_pending_info')], [Markup.button.callback('🚫 退出后台', 'noop')]] } });
    await ctx.answerCbQuery();
});

// /c 广播
bot.command('c', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const content = ctx.message.text.split(' ').slice(1).join(' ');
    if (!content) return ctx.reply('用法：/c 内容');
    const res = await query('SELECT chat_id FROM users WHERE is_banned = FALSE');
    await ctx.reply(`正在广播给 ${res.rows.length} 人...`);
    for (const u of res.rows) { try { await bot.telegram.sendMessage(u.chat_id, content); } catch(e) {} }
    await ctx.reply(`✅ 广播完成。`);
});

// /q 免验证
bot.command('q', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await query("UPDATE users SET is_vip = TRUE, state = 'IDLE' WHERE chat_id = $1", [ADMIN_ID]);
    await ctx.reply('✅ 已开启 VIP 免验证模式。');
});

// /cz 重置 (管理员测试专用)
bot.command('cz', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    // 重置所有状态，方便测试完整流程
    await query(`UPDATE users SET first_verify_status = FALSE, second_verify_done = FALSE, is_vip = FALSE, download_count = 0, state = 'IDLE', reject_count = 0 WHERE chat_id = $1`, [ADMIN_ID]);
    await ctx.reply('🔄 状态已重置。\n现在您可以像新用户一样测试 /dh -> /y 流程，工单会自动发给您自己。');
});

// 上架
bot.action('admin_add_product', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await query("UPDATE users SET admin_state = 'WAIT_KEYWORD' WHERE chat_id = $1", [ADMIN_ID]);
    await ctx.reply('请发送 <b>关键词</b> (如 001)：', { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.on('text', async (ctx, next) => {
    const user = ctx.user;
    if (ctx.from.id === ADMIN_ID && user.admin_state === 'WAIT_KEYWORD') {
        const keyword = ctx.message.text;
        await query("UPDATE users SET editing_keyword = $1, admin_state = 'WAIT_CONTENT' WHERE chat_id = $2", [keyword, ADMIN_ID]);
        await ctx.reply(`关键词：<b>${keyword}</b>\n请发送内容，完成后 /admin_finish_upload`, { parse_mode: 'HTML' });
        return;
    }
    if (ctx.message.text === '/admin_finish_upload' && ctx.from.id === ADMIN_ID) {
        await query("UPDATE users SET admin_state = 'IDLE', editing_keyword = '' WHERE chat_id = $1", [ADMIN_ID]);
        await ctx.reply('✅ 录入完成。');
        return;
    }
    next();
});

const handleAdminUpload = async (ctx) => {
    const user = ctx.user;
    const keyword = user.editing_keyword;
    let contentItem = {};
    if (ctx.message.text) contentItem = { type: 'text', text: ctx.message.text };
    else if (ctx.message.photo) contentItem = { type: 'photo', fileId: ctx.message.photo[ctx.message.photo.length - 1].file_id };
    else if (ctx.message.video) contentItem = { type: 'video', fileId: ctx.message.video.file_id };
    else if (ctx.message.document) contentItem = { type: 'document', fileId: ctx.message.document.file_id };

    const res = await query('SELECT content FROM products WHERE keyword = $1', [keyword]);
    let currentContent = res.rows.length > 0 ? res.rows[0].content : [];
    currentContent.push(contentItem);
    await query(`INSERT INTO products (keyword, content) VALUES ($1, $2) ON CONFLICT (keyword) DO UPDATE SET content = $2`, [keyword, JSON.stringify(currentContent)]);
    await ctx.reply('✅ 已接收 1 条。');
};

// ==========================================
// 9. 审核回调
// ==========================================

bot.action(/audit_pass_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await ctx.editMessageCaption(`✅ 已通过 (ID: ${ctx.match[1]})`);
    await ctx.answerCbQuery();
});

bot.action(/audit_reject_(\d+)_(\d)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const targetId = ctx.match[1];
    const type = ctx.match[2]; 
    await query("UPDATE users SET reject_count = reject_count + 1 WHERE chat_id = $1", [targetId]);
    if (type === '1') await query("UPDATE users SET first_verify_status = FALSE WHERE chat_id = $1", [targetId]);
    if (type === '2') await query("UPDATE users SET second_verify_done = FALSE WHERE chat_id = $1", [targetId]);
    try { await bot.telegram.sendMessage(targetId, `❌ 您的验证被驳回，请重新上传。`); } catch(e) {}
    await ctx.editMessageCaption(`↩️ 已驳回 (ID: ${targetId})`);
    await ctx.answerCbQuery();
});

bot.action(/audit_reject_vip_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const targetId = ctx.match[1];
    await query("UPDATE users SET is_vip = FALSE WHERE chat_id = $1", [targetId]);
    try { await bot.telegram.sendMessage(targetId, `❌ 您的 VIP 订单审核未通过，权限已撤销。`); } catch(e) {}
    await ctx.editMessageCaption(`↩️ 已驳回 VIP (ID: ${targetId})`);
    await ctx.answerCbQuery();
});

bot.action(/audit_ban_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await query("UPDATE users SET is_banned = TRUE WHERE chat_id = $1", [ctx.match[1]]);
    try { await bot.telegram.sendMessage(ctx.match[1], '🚫 已被永久封禁。'); } catch(e) {}
    await ctx.editMessageCaption(`🚫 已封禁 (ID: ${ctx.match[1]})`);
    await ctx.answerCbQuery();
});

// ==========================================
// 10. Vercel Serverless
// ==========================================
module.exports = async (req, res) => {
    if (req.query.cron) {
        const now = moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
        const tasks = await query('SELECT * FROM auto_delete WHERE delete_at <= $1', [now]);
        for (const task of tasks.rows) { try { await bot.telegram.deleteMessage(task.chat_id, task.message_id); } catch(e) {} }
        if (tasks.rows.length > 0) { const ids = tasks.rows.map(t => t.id).join(','); await query(`DELETE FROM auto_delete WHERE id IN (${ids})`); }
        return res.status(200).send('Cron Done');
    }
    try {
        if (req.method === 'POST') await bot.handleUpdate(req.body);
        res.status(200).send('OK');
    } catch (e) { console.error(e); res.status(500).send('Error'); }
};
