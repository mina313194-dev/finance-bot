const { Bot, InlineKeyboardBuilder, registerExpressWebhook } = require('node-telegram-bot-api');
const logic = require('./logic');
const parser = require('./parser');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWED_CHAT_ID = process.env.TELEGRAM_ALLOWED_CHAT_ID || '';
const WEBHOOK_BASE_URL = process.env.TELEGRAM_WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const WEBHOOK_PATH = '/api/telegram/webhook';

const CATEGORY_EMOJI = {
  餐飲: '🍔',
  交通: '🚗',
  服飾: '👕',
  運動: '🏃',
  孝親費: '👪',
  機車費: '🏍️',
  投資: '📈',
  交際費: '🍻',
  稅金: '🧾',
  醫療保健: '🏥',
  捐款: '💝',
  保險: '🛡️',
  美容美髮: '💇',
  訂閱: '🔁',
  電信: '📱',
  教育: '📚',
};

const CARD_EMOJI = {
  永豐: '🟡',
  台新: '🔴',
  聯邦: '🔷',
  玉山: '🟢',
  華南: '🌾',
  國泰: '🟩',
  連線: '💚',
  土地: '🟫',
  現金: '💵',
};

// per-chat guided-entry state (in-memory - fine for a single-user bot; a
// server restart mid-flow just means starting the flow over)
const flowState = new Map();

function chunk(arr, size) {
  const rows = [];
  for (let i = 0; i < arr.length; i += size) rows.push(arr.slice(i, i + size));
  return rows;
}

function categoryKeyboard() {
  const categories = Object.keys(parser.EXPENSE_CATEGORIES);
  const builder = new InlineKeyboardBuilder();
  for (const row of chunk(categories, 3)) {
    for (const cat of row) builder.text(`${CATEGORY_EMOJI[cat] || '📦'} ${cat}`, `cat:${cat}`);
    builder.row();
  }
  return builder.build();
}

function cardKeyboard() {
  const builder = new InlineKeyboardBuilder();
  for (const row of chunk(parser.KNOWN_CARDS, 3)) {
    for (const card of row) builder.text(`${CARD_EMOJI[card] || '💳'} ${card}`, `card:${card}`);
    builder.row();
  }
  return builder.build();
}

function dashboardLinkText() {
  return WEBHOOK_BASE_URL
    ? `網頁儀表板：${WEBHOOK_BASE_URL.replace(/\/$/, '')}`
    : '網頁版還沒有正式的公開網址（尚未部署或還在本機測試），部署完成後再問我一次就有連結了。';
}

function isAuthorized(chatId) {
  return Boolean(ALLOWED_CHAT_ID) && String(chatId) === String(ALLOWED_CHAT_ID);
}

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

  if (!isAuthorized(chatId)) {
    await ctx.reply('此機器人為私人使用，未授權存取。');
    return;
  }

  const flow = flowState.get(chatId);
  if (flow && flow.step === 'amount') {
    if (text === '取消') {
      flowState.delete(chatId);
      await ctx.reply('已取消記帳。');
      return;
    }
    const amount = parseFloat(text.replace(/[,，元塊]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.reply('請直接輸入金額數字（例如 150），或輸入「取消」放棄這筆記帳。');
      return;
    }
    flowState.delete(chatId);
    try {
      const reply = await logic.recordTransaction({
        date: new Date().toISOString().slice(0, 10),
        type: 'expense',
        category: flow.category,
        amount,
        card: flow.card,
        note: `${flow.card} ${flow.category} ${amount}`,
      });
      await ctx.reply(reply);
    } catch (err) {
      console.error('guided entry record error:', err);
      await ctx.reply('記帳時發生錯誤，請稍後再試一次。');
    }
    return;
  }

  if (text === '記帳') {
    flowState.set(chatId, { step: 'category' });
    await ctx.reply('選擇消費類別：', { reply_markup: categoryKeyboard() });
    return;
  }

  if (/^(網頁|儀表板|報表連結|dashboard)$/i.test(text)) {
    await ctx.reply(dashboardLinkText());
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

async function handleCallbackQuery(ctx) {
  const chatId = ctx.chatId;
  const data = ctx.callbackQuery && ctx.callbackQuery.data;
  if (chatId == null || !data) return;

  if (!isAuthorized(chatId)) {
    await ctx.answerCallbackQuery({ text: '未授權' });
    return;
  }

  if (data.startsWith('cat:')) {
    const category = data.slice(4);
    flowState.set(chatId, { step: 'card', category });
    await ctx.answerCallbackQuery({});
    await ctx.api.editMessageText({
      chat_id: chatId,
      message_id: ctx.callbackQuery.message.message_id,
      text: `類別：${category}\n選擇付款方式：`,
      reply_markup: cardKeyboard(),
    });
    return;
  }

  if (data.startsWith('card:')) {
    const card = data.slice(5);
    const flow = flowState.get(chatId);
    if (!flow || flow.step !== 'card') {
      await ctx.answerCallbackQuery({ text: '請重新輸入「記帳」開始' });
      return;
    }
    flowState.set(chatId, { step: 'amount', category: flow.category, card });
    await ctx.answerCallbackQuery({});
    await ctx.api.editMessageText({
      chat_id: chatId,
      message_id: ctx.callbackQuery.message.message_id,
      text: `類別：${flow.category}　付款：${card}\n請輸入金額（例如 150），或輸入「取消」放棄`,
    });
    return;
  }

  await ctx.answerCallbackQuery({});
}

let botInstance = null;

async function sendWeeklyReport() {
  if (!botInstance || !ALLOWED_CHAT_ID) return false;
  const text = await logic.buildWeeklyBudgetReportText();
  await botInstance.api.sendMessage({ chat_id: ALLOWED_CHAT_ID, text });
  return true;
}

async function sendMonthlySurplusReminder() {
  if (!botInstance || !ALLOWED_CHAT_ID) return false;
  const text = await logic.buildMonthlySurplusReminderText();
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
  bot.command('start', (ctx) =>
    ctx.reply(
      `嗨！我是你的財務小幫手。輸入「說明」看看我能做什麼，或輸入「記帳」用按鈕記一筆消費。\n${dashboardLinkText()}`
    )
  );
  bot.on('message', handleText);
  bot.on('callback_query', handleCallbackQuery);
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

module.exports = { init, sendWeeklyReport, sendMonthlySurplusReminder };
