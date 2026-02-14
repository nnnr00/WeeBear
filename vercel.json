{
  "version": 2,
  "builds": [
    {
      "src": "api/webhook.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/api/webhook",
      "dest": "/api/webhook.js"
    }
  ],
  "env": {
    "BOT_TOKEN": "@bot_token",
    "ADMIN_ID": "@admin_id",
    "WEBHOOK_URL": "@webhook_url"
  }
}
