// scripts/setup-webhook.js
const fetch = require('node-fetch');

const BOT_TOKEN = process.env.YOUR_BOT_TOKEN;
const VERCEL_URL = process.env.VERCEL_URL;

async function setupWebhook() {
  const webhookUrl = `https://${VERCEL_URL}/api/webhook`;
  const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${webhookUrl}`;
  
  try {
    const response = await fetch(apiUrl);
    const data = await response.json();
    console.log('Webhook setup result:', data);
  } catch (error) {
    console.error('Error setting webhook:', error);
  }
}

setupWebhook();
