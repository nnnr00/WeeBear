// api/index.js
// 引入依赖
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const moment = require('moment-timezone');

// ==========================================
// 1. 数据库连接 (Neon PostgreSQL)
// ==========================================
// 必须配置环境变量 DATABASE_URL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Neon 数据库必须开启 SSL
});

// 辅助查询函数
const query = async (text, params) => await pool.query(text, params);

// ==========================================
// 2. 初始化 Bot 与 配置
// ==========================================
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID); // 你的管理员 ID

// 🔴 🔴 🔴 配置区：部署后请用 /admin 获取真实 File ID 并替换此处 🔴 🔴 🔴
// 为了防止初始部署因 ID 错误导致死机，目前先设为空。为空时机器人会自动降级为“只发文字”。
const CONFIG = {
    // 首次验证 /y 图片 (2张)
    y_images: [
        // 'AgACAgUAAxkBAAIxxxx1', 
        // 'AgACAgUAAxkBAAIxxxx2'
    ],
    
    // 二次验证 /yz 图片 (3张)
    yz_images: [
        // 'AgACAgUAAxkBAAIxxxx3',
        // 'AgACAgUAAxkBAAIxxxx4',
        // 'AgACAgUAAxkBAAIxxxx5'
    ],
    
    // VIP 特权说明图片 (1张)
    vip_info_image: '', // 例: 'AgACAgUAAxkBAAIxxxx6'
    
    // 查找订单号教程图片 (1张)
    order_tutorial_image: '', // 例: 'AgACAgUAAxkBAAIxxxx7'
    
    // 支付成功后的加群链接
    vip_group_link: 'https://t.me/+495j5rWmApsxYzg9' 
};

// ==========================================
// 3. 全局中间件 (核心守门员)
// ==========================================
bot.use(async (ctx, next) => {
    // 忽略非用户消息
    if (!ctx.from) return next();

    const chatId = ctx.from.id;
    // 获取当前北京时间日期
    const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');

    // 1. 获取或创建用户
    let res = await query('SELECT * FROM users WHERE chat_id = $1', [chatId]);
    let user = res.rows[0];

    if (!user) {
        // 新用户入库
        await query(
            `INSERT INTO users (chat_id, username, first_name, last_verify_date) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [chatId, ctx.from.username, ctx.from.first_name, '']
        );
        res = await query('SELECT * FROM users WHERE chat_id = $1', [chatId]);
        user = res.rows[0];
    }

    // 2. 每日重置逻辑 (北京时间 00:00 生效)
    // 如果数据库里的日期不是今天，说明跨天了，重置首次验证状态
    if (user.last_verify_date !== today) {
        await query(
            `UPDATE users SET first_verify_status = $1, last_verify_date = $2, download_count = 0 WHERE chat_id = $3`,
            [false, today, chatId]
        );
        // 更新内存中的用户对象，确保后续逻辑使用最新状态
        user.first_verify_status = false;
        user.last_verify_date = today;
        user.download_count = 0;
    }

    // 3. 封禁检查
    if (user.is_banned) {
        // 允许 VIP 页面交互以便用户自助解封
        // 判断是否是 VIP 相关的命令或按钮
        const isVipAction = (ctx.message && ctx.message.text === '/v') || 
                            (ctx.callbackQuery && ['btn_vip', 'btn_paid_verify'].includes(ctx.callbackQuery.data));
        
        if (isVipAction) {
            ctx.user = user;
            return next();
        }
        
        // 如果是其他操作，直接拦截并提示
        try {
           await ctx.reply('⛔️ 你已被本活动封禁，请加入会员（特价版）', 
               Markup.inlineKeyboard([[Markup.button.callback('💎 加入会员（新春特价）', 'btn_vip')]])
           );
        } catch(e) {}
        return; // 阻止后续中间件执行
    }

    // 将最新的 user 对象挂载到 ctx，供后续使用
    ctx.user = user;
    await next();
});

// ==========================================
// 4. 基础命令 (/start, /dh)
// ==========================================

// /start 命令
bot.start(async (ctx) => {
    // 每次回首页，重置用户状态为 IDLE，防止卡在输入订单号等状态
    await query("UPDATE users SET state = 'IDLE' WHERE chat_id = $1", [ctx.user.chat_id]);

    const args = ctx.message.text.split(' ');
    // 场景 B: 深层链接 start=dh
    if (args.length > 1 && args[1] === 'dh') {
        return sendDhPage(ctx, 1);
    }

    // 场景 A: 普通进入
    const welcomeText = `🧨 <b>喜迎二月除夕，新春快乐！</b> 🧨\n\n` +
                        `本频道所有资源 <b>免费观看</b>！无套路！\n` +
                        `只需要打开兑换中心，点击相应按钮即可直接观看。\n\n` +
                        `👇 点击下方按钮开始 👇`;

    await ctx.replyWithHTML(welcomeText, Markup.inlineKeyboard([
        [Markup.button.callback('🧧 新春兑换中心', 'goto_dh')]
    ]));
});

// /dh 兑换中心 (核心展示页)
const sendDhPage = async (ctx, page = 1) => {
    const limit = 10;
    const offset = (page - 1) * limit;
    
    // 获取商品列表
    const pRes = await query('SELECT keyword FROM products ORDER BY keyword LIMIT $1 OFFSET $2', [limit, offset]);
    const products = pRes.rows;
    
    // 边界情况：如果数据库是空的
    if (products.length === 0 && page === 1) {
        return ctx.reply('📭 暂无上架商品，请先在后台上架。');
    }

    // 获取总数计算翻页
    const cRes = await query('SELECT COUNT(*) FROM products');
    const total = parseInt(cRes.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    // 构建商品按钮网格
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

    // 构建翻页按钮
    let navRow = [];
    if (page > 1) navRow.push(Markup.button.callback('⬅️ 上一页', `dh_page_${page - 1}`));
    navRow.push(Markup.button.callback(`${page}/${totalPages || 1}`, 'noop'));
    if (page < totalPages) navRow.push(Markup.button.callback('下一页 ➡️', `dh_page_${page + 1}`));
    buttons.push(navRow);

    // 构建底部状态按钮 (根据验证状态动态变化)
    let verifyBtnText = '🛡 开始验证';
    let verifyAction = 'goto_verify_y';
    
    // 如果已通过首次验证，或者已经是 VIP
    if (ctx.user.first_verify_status || ctx.user.is_vip) {
        verifyBtnText = '💎 加入会员（新春特价）';
        verifyAction = 'btn_vip';
    }

    buttons.push([Markup.button.callback(verifyBtnText, verifyAction)]);

    const text = `<b>📀 资源兑换中心</b>\n\n` +
                 `说明：点此对应的编号按钮，即可立马免费观看。\n` +
                 `当前页码：${page}`;

    // 发送或编辑消息
    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
        } else {
            await ctx.replyWithHTML(text, Markup.inlineKeyboard(buttons));
        }
    } catch (e) {
        // 如果 editMessage 失败（内容无变化），降级为发新消息
        await ctx.replyWithHTML(text, Markup.inlineKeyboard(buttons));
    }
};

// 监听翻页动作
bot.action(/dh_page_(\d+)/, async (ctx) => {
    await sendDhPage(ctx, parseInt(ctx.match[1]));
    await ctx.answerCbQuery();
});

// 监听返回首页动作
bot.action('goto_dh', async (ctx) => {
    await sendDhPage(ctx, 1);
    await ctx.answerCbQuery();
});

// ==========================================
// 5. VIP 会员流程 (/v)
// ==========================================

// 命令入口
bot.command('v', async (ctx) => showVipPage(ctx));
// 按钮入口
bot.action('btn_vip', async (ctx) => {
    await ctx.answerCbQuery();
    await showVipPage(ctx);
});

// 界面 1: 特权说明页
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

    // 如果配置了图片，发图文；否则发纯文字
    if (CONFIG.vip_info_image && CONFIG.vip_info_image.length > 5) {
        await ctx.replyWithPhoto(CONFIG.vip_info_image, {
            caption: text,
            parse_mode: 'HTML',
            reply_markup: keyboard.reply_markup
        }).catch(() => ctx.replyWithHTML(text, keyboard)); // 图片发送失败降级
    } else {
        await ctx.replyWithHTML(text, keyboard);
    }
};

// 界面 2: 查单教程与等待输入
bot.action('btn_paid_verify', async (ctx) => {
    // 锁定用户状态，等待输入订单号
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
// 6. 验证漏斗逻辑 (点击商品 -> 确认)
// ==========================================

// 点击商品 -> 弹出确认框
bot.action(/prod_(.+)/, async (ctx) => {
    const keyword = ctx.match[1];
    await ctx.editMessageText(`您选择了资源：<b>${keyword}</b>\n确认要兑换吗？`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[Markup.button.callback('❌ 取消', 'goto_dh'), Markup.button.callback('✅ 确认', `confirm_prod_${keyword}`)]] }
    });
    await ctx.answerCbQuery();
});

// 点击确认 -> 漏斗判定
bot.action(/confirm_prod_(.+)/, async (ctx) => {
    const keyword = ctx.match[1];
    const user = ctx.user;

    // 1. VIP 检查：是 VIP 直接发货
    if (user.is_vip) return sendProduct(ctx, keyword);

    // 2. 首次验证检查：未通过则进入 /y
    if (!user.first_verify_status) return startFirstVerify(ctx);

    // 3. 二次验证检查
    if (!user.second_verify_done) {
        const oneHour = 3600000; // 1小时毫秒数
        const firstTime = user.first_verify_time ? new Date(user.first_verify_time).getTime() : 0;
        const now = new Date().getTime();
        
        // 条件：距离首次验证 > 1小时 OR 下载次数 >= 5
        if ((now - firstTime > oneHour) || user.download_count >= 5) {
            return startSecondVerify(ctx);
        }
    }

    // 4. 全部通过 -> 发货
    return sendProduct(ctx, keyword);
});

// 核心功能：发送资源
const sendProduct = async (ctx, keyword) => {
    const res = await query('SELECT content FROM products WHERE keyword = $1', [keyword]);
    if (res.rows.length === 0) return ctx.reply('⚠️ 资源不存在或已下架。');

    // 增加下载计数
    await query('UPDATE users SET download_count = download_count + 1 WHERE chat_id = $1', [ctx.user.chat_id]);
    await ctx.reply(`正在发送资源：${keyword} ...`);
    
    const contentList = res.rows[0].content;
    const mediaGroup = [];
    const sentMsgIds = [];

    // 处理内容
    for (const item of contentList) {
        if (item.type === 'text') {
            const m = await ctx.reply(item.text);
            sentMsgIds.push(m.message_id);
        } else {
            mediaGroup.push({ type: item.type, media: item.fileId });
        }
    }

    // 发送媒体组 (最多10张一组)
    if (mediaGroup.length > 0) {
        const chunkSize = 10;
        for (let i = 0; i < mediaGroup.length; i += chunkSize) {
            const msgs = await ctx.replyWithMediaGroup(mediaGroup.slice(i, i + chunkSize));
            msgs.forEach(m => sentMsgIds.push(m.message_id));
        }
    }

    // 加入自动删除队列 (5分钟)
    const deleteTime = moment().add(5, 'minutes').format('YYYY-MM-DD HH:mm:ss');
    for (const mid of sentMsgIds) {
        await query('INSERT INTO auto_delete (chat_id, message_id, delete_at) VALUES ($1, $2, $3)', [ctx.chat.id, mid, deleteTime]);
    }
    await ctx.reply('⏳ 消息将在 5 分钟后自动销毁，请尽快保存！');
};

// 启动首次验证流程
const startFirstVerify = async (ctx) => {
    // 改变状态
    await query("UPDATE users SET state = 'WAIT_Y_PHOTO' WHERE chat_id = $1", [ctx.user.chat_id]);
    const text = `<b>🔰 首次验证 (无套路 3秒自动审核)</b>\n\n` +
                 `教程：打开支付宝扫一扫，点击完成助力。\n` +
                 `<b>请上传截图</b>：截图需包含“你截图的时间”和“助力成功”文字。\n\n` +
                 `👇 请查看下方示例图片，并上传你的截图：`;
    
    // 逻辑：如果 CONFIG 里没填图片ID，就不发图，只发文字。防止 ID 错误导致死机。
    if (CONFIG.y_images.length > 0) {
        const media = CONFIG.y_images.map(id => ({ type: 'photo', media: id }));
        await ctx.replyWithMediaGroup(media).catch(() => ctx.replyWithHTML(text));
    } else {
        await ctx.replyWithHTML(text);
    }
    
    if (ctx.callbackQuery) await ctx.answerCbQuery();
};

// 启动二次验证流程
const startSecondVerify = async (ctx) => {
    // 改变状态
    await query("UPDATE users SET state = 'WAIT_YZ_PHOTO' WHERE chat_id = $1", [ctx.user.chat_id]);
    const text = `<b>🛡 二次验证 (防作弊系统)</b>\n\n` +
                 `这是本活动<b>最后一次验证</b>！通过后永久免费，无限制浏览！\n` +
                 `教程：打开支付宝扫二维码 -> 点击 <b>“去凑分”</b> -> 页面截图。\n` +
                 `<b>截图要求</b>：需要出现 <b>芝麻分数字</b>。\n\n` +
                 `👇 请参照下方 3 张示例图上传：`;
                 
    if (CONFIG.yz_images.length > 0) {
        const media = CONFIG.yz_images.map(id => ({ type: 'photo', media: id }));
        await ctx.replyWithMediaGroup(media).catch(() => ctx.replyWithHTML(text));
    } else {
        await ctx.replyWithHTML(text);
    }

    if (ctx.callbackQuery) await ctx.answerCbQuery();
};

// ==========================================
// 7. 消息处理 (VIP验证 / 图片上传 / Admin录入)
// ==========================================

bot.on(['text', 'photo', 'document', 'video'], async (ctx, next) => {
    const user = ctx.user;
    const cid = ctx.from.id;
    const text = ctx.message.text;

    // --- 1. 管理员：获取 File ID ---
    if (cid === ADMIN_ID && user.admin_state === 'GET_FILE_ID') {
        if (text && text.startsWith('/')) return next(); // 如果输入命令则跳过
        
        let fileId = '未识别到文件';
        if (ctx.message.photo) fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        else if (ctx.message.document) fileId = ctx.message.document.file_id;
        else if (ctx.message.video) fileId = ctx.message.video.file_id;
        
        await ctx.replyWithHTML(`File ID:\n<code>${fileId}</code>`, Markup.inlineKeyboard([[Markup.button.callback('🔙 返回后台', 'back_to_admin')]]));
        return;
    }

    // --- 2. 管理员：上架内容录入 ---
    if (cid === ADMIN_ID && user.admin_state === 'WAIT_CONTENT') {
        if (text && text.startsWith('/')) return next();
        return handleAdminUpload(ctx);
    }

    // --- 3. 用户：VIP 订单号验证 ---
    if (user.state === 'WAIT_PAYMENT_ORDER' && text) {
        // 判断：是否以 20260 开头
        if (text.trim().startsWith('20260')) {
            // 成功：设为VIP，解封，状态回 IDLE
            await query(`UPDATE users SET is_vip = TRUE, is_banned = FALSE, state = 'IDLE' WHERE chat_id = $1`, [cid]);
            
            await ctx.replyWithHTML(
                `🎉 <b>验证通过！</b>\n\n您已成为尊贵的 VIP 会员，享有所有特权。`,
                Markup.inlineKeyboard([
                    [Markup.button.url('🔗 点击加入会员群', CONFIG.vip_group_link)]
                ])
            );

            // 给管理员发 VIP 审核工单
            const timeStr = moment().tz('Asia/Shanghai').format('YYYY.MM.DD HH:mm:ss');
            const caption = `<b>💰 VIP订单审核 (待处理)</b>\n\n` +
                            `用户：${user.first_name || '无'} (ID: <code>${cid}</code>)\n` +
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
            // 失败：无限重试
            await ctx.reply('❌ 验证失败，未查询到订单信息。\n请核对后重新输入：');
            return;
        }
    }

    // --- 4. 用户：验证图片上传 (/y, /yz) ---
    if (user.state === 'WAIT_Y_PHOTO' || user.state === 'WAIT_YZ_PHOTO') {
        // 格式检查
        if (!ctx.message.photo && !ctx.message.document) {
            if (text && text.startsWith('/')) return next();
            return ctx.reply('❌ 格式错误，请上传图片截图！');
        }

        const isSecond = user.state === 'WAIT_YZ_PHOTO';
        const photo = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1] : ctx.message.document;
        const fileId = photo.file_id;

        // 反馈用户
        await ctx.reply('✅ 验证成功！系统正在后台二次核验...');

        // 更新数据库状态：直接放行
        if (isSecond) {
            await query("UPDATE users SET second_verify_done = $1, state = 'IDLE' WHERE chat_id = $2", [true, cid]);
        } else {
            const nowTime = moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
            await query("UPDATE users SET first_verify_status = $1, first_verify_time = $2, state = 'IDLE' WHERE chat_id = $3", [true, nowTime, cid]);
        }

        // 刷新页面
        await sendDhPage(ctx, 1);

        // 发送工单给管理员
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
// 8. 管理员后台 & 特殊指令
// ==========================================

// /admin 后台主菜单
bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await query("UPDATE users SET admin_state = 'IDLE', editing_keyword = '' WHERE chat_id = $1", [ADMIN_ID]);
    await ctx.reply('👮‍♂️ <b>管理员后台</b>', {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [Markup.button.callback('📂 获取 File ID', 'admin_get_fileid')],
                [Markup.button.callback('📤 频道转发库 (上架)', 'admin_add_product')],
                [Markup.button.callback('⏳ 待处理工单', 'admin_pending_info')],
                [Markup.button.callback('🚫 退出后台', 'noop')]
            ]
        }
    });
});

// 待处理工单统计
bot.action('admin_pending_info', async (ctx) => {
    const res = await query(`SELECT COUNT(*) FROM users WHERE state IN ('WAIT_Y_PHOTO', 'WAIT_YZ_PHOTO')`);
    const count = res.rows[0].count;
    await ctx.editMessageText(
        `<b>⏳ 待处理工单</b>\n\n当前正在上传中的用户数：${count}\n\nℹ️ <b>说明：</b>工单会<b>自动推送</b>到此对话框，请留意。`, 
        { 
            parse_mode: 'HTML', 
            reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 返回后台', 'back_to_admin')]] } 
        }
    );
    await ctx.answerCbQuery();
});

// 获取 File ID 模式
bot.action('admin_get_fileid', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await query("UPDATE users SET admin_state = 'GET_FILE_ID' WHERE chat_id = $1", [ADMIN_ID]);
    await ctx.editMessageText('请发送图片/视频/文件，我将返回 file_id。\n\n⚠️ <b>任意格式均可。</b>', 
        Markup.inlineKeyboard([[Markup.button.callback('🔙 返回后台', 'back_to_admin')]])
    );
    await ctx.answerCbQuery();
});

// 返回后台
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
    if (!content) return ctx.reply('用法：/c 广播内容');
    
    const res = await query('SELECT chat_id FROM users WHERE is_banned = FALSE');
    await ctx.reply(`正在广播给 ${res.rows.length} 人...`);
    
    // 简单的批量发送
    for (const u of res.rows) { 
        try { await bot.telegram.sendMessage(u.chat_id, content); } catch(e) {} 
    }
    await ctx.reply(`✅ 广播完成。`);
});

// /q 免验证模式 (设为普通用户但已通过验证)
bot.command('q', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    // 将管理员的验证状态设为 TRUE
    await query("UPDATE users SET first_verify_status = TRUE, second_verify_done = TRUE, state = 'IDLE' WHERE chat_id = $1", [ADMIN_ID]);
    await ctx.reply('✅ 已开启免验证模式。（您现在是已通过验证的普通用户）');
});

// /cz 重置测试模式 (完全重置为新用户)
bot.command('cz', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    // 重置所有状态，包括下载次数和VIP
    await query(`UPDATE users SET 
        first_verify_status = FALSE, 
        second_verify_done = FALSE, 
        is_vip = FALSE, 
        download_count = 0, 
        state = 'IDLE', 
        reject_count = 0 
        WHERE chat_id = $1`, [ADMIN_ID]);
    await ctx.reply('🔄 状态已重置。\n现在您可以像新用户一样测试 /dh -> /y 流程，上传图片的工单会自动发给您自己。');
});

// 上架流程：输入关键词
bot.action('admin_add_product', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await query("UPDATE users SET admin_state = 'WAIT_KEYWORD' WHERE chat_id = $1", [ADMIN_ID]);
    await ctx.reply('请发送 <b>关键词</b> (如 001)：', { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

// 上架流程：处理关键词
bot.on('text', async (ctx, next) => {
    const user = ctx.user;
    // 如果是输入关键词状态
    if (ctx.from.id === ADMIN_ID && user.admin_state === 'WAIT_KEYWORD') {
        const keyword = ctx.message.text;
        await query("UPDATE users SET editing_keyword = $1, admin_state = 'WAIT_CONTENT' WHERE chat_id = $2", [keyword, ADMIN_ID]);
        await ctx.reply(`关键词：<b>${keyword}</b>\n请发送内容 (文字/图片/视频/文件)，\n发送完成后点击 /admin_finish_upload 结束录入。`, { parse_mode: 'HTML' });
        return;
    }
    // 如果是结束录入命令
    if (ctx.message.text === '/admin_finish_upload' && ctx.from.id === ADMIN_ID) {
        await query("UPDATE users SET admin_state = 'IDLE', editing_keyword = '' WHERE chat_id = $1", [ADMIN_ID]);
        await ctx.reply('✅ 商品录入完成。');
        return;
    }
    next();
});

// 上架流程：处理内容上传
const handleAdminUpload = async (ctx) => {
    const user = ctx.user;
    const keyword = user.editing_keyword;
    let contentItem = {};

    if (ctx.message.text) {
        contentItem = { type: 'text', text: ctx.message.text };
    } else if (ctx.message.photo) {
        contentItem = { type: 'photo', fileId: ctx.message.photo[ctx.message.photo.length - 1].file_id };
    } else if (ctx.message.video) {
        contentItem = { type: 'video', fileId: ctx.message.video.file_id };
    } else if (ctx.message.document) {
        contentItem = { type: 'document', fileId: ctx.message.document.file_id };
    }

    // 更新 JSONB 字段
    const res = await query('SELECT content FROM products WHERE keyword = $1', [keyword]);
    let currentContent = res.rows.length > 0 ? res.rows[0].content : [];
    currentContent.push(contentItem);
    
    // Upsert (插入或更新)
    await query(
        `INSERT INTO products (keyword, content) VALUES ($1, $2) 
         ON CONFLICT (keyword) DO UPDATE SET content = $2`,
        [keyword, JSON.stringify(currentContent)]
    );

    await ctx.reply('✅ 已接收 1 条内容。继续发送或 /admin_finish_upload');
};

// ==========================================
// 9. 审核回调处理 (点击工单按钮)
// ==========================================

// 审核通过
bot.action(/audit_pass_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await ctx.editMessageCaption(`✅ 已通过 (无事发生)`);
    await ctx.answerCbQuery();
});

// 验证驳回 (重置验证状态)
bot.action(/audit_reject_(\d+)_(\d)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const targetId = ctx.match[1];
    const type = ctx.match[2]; // 1=首次, 2=二次
    
    // 增加驳回计数
    await query("UPDATE users SET reject_count = reject_count + 1 WHERE chat_id = $1", [targetId]);
    
    // 根据类型重置状态
    if (type === '1') await query("UPDATE users SET first_verify_status = FALSE WHERE chat_id = $1", [targetId]);
    if (type === '2') await query("UPDATE users SET second_verify_done = FALSE WHERE chat_id = $1", [targetId]);

    // 通知用户
    try { await bot.telegram.sendMessage(targetId, `❌ 您的验证被驳回，请重新上传截图。`); } catch(e) {}
    
    await ctx.editMessageCaption(`↩️ 已驳回`);
    await ctx.answerCbQuery();
});

// VIP 驳回 (取消VIP)
bot.action(/audit_reject_vip_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const targetId = ctx.match[1];
    
    await query("UPDATE users SET is_vip = FALSE WHERE chat_id = $1", [targetId]);
    try { await bot.telegram.sendMessage(targetId, `❌ 您的 VIP 订单审核未通过，VIP 权限已撤销。`); } catch(e) {}
    
    await ctx.editMessageCaption(`↩️ 已驳回 VIP`);
    await ctx.answerCbQuery();
});

// 封禁用户
bot.action(/audit_ban_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const targetId = ctx.match[1];
    
    await query("UPDATE users SET is_banned = TRUE WHERE chat_id = $1", [targetId]);
    try { await bot.telegram.sendMessage(targetId, '🚫 检测到多次作弊，已被永久封禁。'); } catch(e) {}
    
    await ctx.editMessageCaption(`🚫 已封禁`);
    await ctx.answerCbQuery();
});

// ==========================================
// 10. Vercel Serverless 入口
// ==========================================
module.exports = async (req, res) => {
    // 定时任务：每分钟检查过期消息
    if (req.query.cron) {
        const now = moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
        const tasks = await query('SELECT * FROM auto_delete WHERE delete_at <= $1', [now]);
        
        for (const task of tasks.rows) { 
            try { await bot.telegram.deleteMessage(task.chat_id, task.message_id); } catch(e) {} 
        }
        
        if (tasks.rows.length > 0) { 
            const ids = tasks.rows.map(t => t.id).join(','); 
            await query(`DELETE FROM auto_delete WHERE id IN (${ids})`); 
        }
        return res.status(200).send('Cron Done');
    }

    // 处理 Webhook 请求
    try {
        if (req.method === 'POST') await bot.handleUpdate(req.body);
        res.status(200).send('OK');
    } catch (e) { 
        console.error(e); 
        res.status(500).send('Error'); 
    }
};
