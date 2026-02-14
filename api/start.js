const { Telegraf } = require('telegraf');
const { formatBeijingTime } = require('../lib/utils'); // 时间格式化工具

module.exports = (bot) => {
  bot.start((ctx) => {
    const message = `
🐎 喜迎马年新春！资源免费领取中...

💎 *VIP会员特权说明*：
✅ 专属中转通道
✅ 优先审核入群
✅ 7x24小时客服支持
✅ 定期福利活动

${getInviteButton()} // 动态生成邀请链接按钮
    `.trim();
    
    ctx.replyWithMarkdownV2(message, {
      parse_mode: 'Markdown',
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: "💎 加入会员（新春特价）", callback_data: "/v" }],
          [{ text: "🎫 兑换资源", callback_data: "/dh" }]
        ]
      })
    });
  });

  // 动态生成邀请链接（避免硬编码）
  function getInviteButton() {
    return `[点击加入VIP群](${process.env.INVITE_LINK})`;
  }
};
