// 运行: BOT_TOKEN=xxx VERCEL_URL=xxx node scripts/setup-webhook.js
const token = process.env.BOT_TOKEN;
const url = process.env.VERCEL_URL;

fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: `https://${url}/api/webhook`,
    allowed_updates: ["message", "callback_query"]
  })
}).then(r => r.json()).then(console.log).catch(console.error);
