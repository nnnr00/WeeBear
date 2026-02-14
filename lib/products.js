bot.command('p', (ctx) => {
  if (!isAdmin(ctx)) return;
  
  ctx.reply("🔑 请输入商品关键词（例如：1）", {
    reply_markup: JSON.stringify({
      inline_keyboard: [[{ text: "⏮️ 返回", callback_data: "/start" }]]
    })
  });
  ctx.session.pStep = 'waiting_keyword';
});

// 等待关键词输入
bot.on('text', async (ctx) => {
  if (ctx.session.pStep === 'waiting_keyword') {
    ctx.session.productKeyword = ctx.message.text.trim();
    ctx.reply("📝 请逐条输入商品内容（发送 '✅ 完成上架' 结束）", {
      parse_mode: 'Markdown'
    });
    ctx.session.pStep = 'waiting_content';
  }
});

// 处理商品内容
bot.on('text', async (ctx) => {
  if (ctx.session.pStep !== 'waiting_content' || !ctx.session.productKeyword) return;
  
  // 保存内容到临时缓冲区
  ctx.session.pContents = ctx.session.pContents || [];
  ctx.session.pContents.push({
    type: 'text',
    value: ctx.message.text
  });
  
  ctx.reply("➕ 继续添加内容 或 发送 '✅ 完成上架'");
});

// 处理图片上传
bot.on('photo', async (ctx) => {
  if (ctx.session.pStep !== 'waiting_content' || !ctx.session.productKeyword) return;
  
  const fileId = ctx.message.photo[0].file_id;
  ctx.session.pContents.push({
    type: 'photo',
    value: fileId
  });
  ctx.reply("🖼️ 图片已添加！继续添加 或 发送 '✅ 完成上架'");
});

// 完成上架
bot.on('text', async (ctx) => {
  if (ctx.session.pStep === 'waiting_content' && ctx.message.text === '✅ 完成上架') {
    await saveProductToDB(ctx);
    ctx.reply("✅ 商品上架成功！", {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: "🛒 查看商品", callback_data: "view_products" }],
          [{ text: "⏮️ 返回", callback_data: "/start" }]
        ]
      })
    });
    ctx.session = null; // 重置状态
  }
});

// 保存到数据库
async function saveProductToDB(ctx) {
  await db.query(
    `INSERT INTO products (keyword, contents)
     VALUES ($1, $2)
     ON CONFLICT (keyword) DO UPDATE SET contents = $2`,
    [ctx.session.productKeyword, JSON.stringify(ctx.session.pContents)]
  );
}
