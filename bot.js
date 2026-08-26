const { Bot, registerExpressWebhook } = require('node-telegram-bot-api');
const logic = require('./logic');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWED_CHAT_ID = process.env.TELEGRAM_ALLOWED_CHAT_ID || '';
const WEBHOOK_BASE_URL = process.env.TELEGRAM_WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const WEBHOOK_PATH = '/api/telegram/webhook';

async function handleText(ctx) {
  const chatId = ctx.chatId;
  const text = (ctx.message && ctx.message.text ? ctx.message.text : '').trim();
  if (!text || chatId == null) return;

  if (!ALLOWED_CHAT_ID) {
    await ctx.reply(
      `這個機器人還沒設定使用者白名單。\n你的 Chat ID 是：${chatId}\n請到伺服器的 .env 設定 TELEGRAM_ALLOWED_CHAT_ID=${chatId}，然後重新啟動伺服器。`
    );
    return;
  }

  if (String(chatId) !== String(ALLOWED_CHAT_ID)) {
    await ctx.reply('此機器人為私人使用，未授權存取。');
    return;
  }

  try {
    const result = await logic.handleMessage(text);
    await ctx.reply(result.reply);
  } catch (err) {
    console.error('Telegram handleMessage error:', err);
    await ctx.reply('處理時發生錯誤，請稍後再試一次。');
  }
}

let botInstance = null;

async function sendWeeklyReport() {
  if (!botInstance || !ALLOWED_CHAT_ID) return false;
  const text = await logic.buildWeeklyBudgetReportText();
  await botInstance.api.sendMessage({ chat_id: ALLOWED_CHAT_ID, text });
  return true;
}

function init(app) {
  if (!TOKEN) {
    console.log('TELEGRAM_BOT_TOKEN 未設定，略過 Telegram 機器人啟動。');
    return null;
  }

  const bot = new Bot(TOKEN);
  botInstance = bot;
  bot.command('start', (ctx) => ctx.reply('嗨！我是你的財務小幫手。輸入「說明」看看我能做什麼。'));
  bot.on('message', handleText);
  bot.catch((err) => console.error('Telegram bot 錯誤：', err));

  if (WEBHOOK_BASE_URL) {
    registerExpressWebhook(bot, app, { path: WEBHOOK_PATH, secretToken: WEBHOOK_SECRET });
    const fullUrl = `${WEBHOOK_BASE_URL.replace(/\/$/, '')}${WEBHOOK_PATH}`;
    bot.api
      .setWebhook({ url: fullUrl, secret_token: WEBHOOK_SECRET })
      .then(() => console.log(`Telegram webhook 已設定：${fullUrl}`))
      .catch((err) => console.error('設定 Telegram webhook 失敗：', err.message));
  } else {
    bot.startPolling().catch((err) => console.error('Telegram polling 錯誤：', err));
    console.log('Telegram 機器人已啟動（polling 模式）。');
  }

  return bot;
}

module.exports = { init, sendWeeklyReport };
