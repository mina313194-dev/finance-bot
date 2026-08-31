const {
  Bot,
  InlineKeyboardBuilder,
  ReplyKeyboardBuilder,
  registerExpressWebhook,
} = require('node-telegram-bot-api');
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

const INCOME_EMOJI = {
  薪資: '💼',
  獎金: '🎁',
  年終: '🧧',
  投資收益: '📈',
  其他收入: '💰',
};

function mainMenuKeyboard() {
  return new ReplyKeyboardBuilder()
    .text('記帳')
    .text('收入')
    .row()
    .text('查詢')
    .text('說明')
    .build({ resize_keyboard: true });
}

// per-chat guided-entry state (in-memory - fine for a single-user bot; a
// server restart mid-flow just means starting the flow over)
const flowState = new Map();

function chunk(arr, size) {
  const rows = [];
  for (let i = 0; i < arr.length; i += size) rows.push(arr.slice(i, i + size));
  return rows;
}

const FAVORITE_CATEGORIES = ['餐飲', '運動', '美容美髮', '服飾'];

function categoryKeyboard(showAll = false) {
  const all = Object.keys(parser.EXPENSE_CATEGORIES);
  const categories = showAll ? all.filter((c) => !FAVORITE_CATEGORIES.includes(c)) : FAVORITE_CATEGORIES;
  const builder = new InlineKeyboardBuilder();
  for (const row of chunk(categories, 3)) {
    for (const cat of row) builder.text(`${CATEGORY_EMOJI[cat] || '📦'} ${cat}`, `cat:${cat}`);
    builder.row();
  }
  if (!showAll) builder.text('▶️ 其他', 'cat:more').row();
  return builder.build();
}

function incomeCategoryKeyboard() {
  const categories = Object.keys(parser.INCOME_CATEGORIES);
  const builder = new InlineKeyboardBuilder();
  for (const row of chunk(categories, 3)) {
    for (const cat of row) builder.text(`${INCOME_EMOJI[cat] || '💰'} ${cat}`, `inc:${cat}`);
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

function queryTypeKeyboard() {
  return new InlineKeyboardBuilder()
    .text('💰 查金額', 'qtype:amount')
    .text('📋 消費明細', 'qtype:detail')
    .row()
    .text('❌ 取消', 'qtype:cancel')
    .build();
}

function queryFollowUpKeyboard(showDetailButton) {
  const builder = new InlineKeyboardBuilder();
  if (showDetailButton) builder.text('📋 查明細', 'qtype:detail');
  builder
    .text('➕ 繼續記帳', 'follow:record')
    .row()
    .text('🔍 再查詢', 'follow:query')
    .text('✅ 結束', 'follow:end');
  return builder.build();
}

// accepts "MMDD-MMDD" (range) or a single "MMDD" (that one day), current year assumed
function parseQueryDateInput(text) {
  const year = new Date().getFullYear();
  const toDate = (mmdd) => `${year}-${mmdd.slice(0, 2)}-${mmdd.slice(2, 4)}`;
  const toLabel = (mmdd) => `${parseInt(mmdd.slice(0, 2), 10)}/${mmdd.slice(2, 4)}`;

  let m = text.match(/(\d{4})-(\d{4})/);
  if (m) {
    const [, s, e] = m;
    return {
      start: toDate(s),
      end: toDate(e),
      label: s === e ? toLabel(s) : `${toLabel(s)}-${toLabel(e)}`,
    };
  }
  m = text.match(/(?<!\d)(\d{4})(?!\d)/);
  if (m) {
    const d = m[1];
    return { start: toDate(d), end: toDate(d), label: toLabel(d) };
  }
  return null;
}

function defaultQueryRangeHint() {
  const now = new Date();
  const monthStart = `${String(now.getMonth() + 1).padStart(2, '0')}01`;
  const today = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `請輸入查詢區間：\n\n區間：${monthStart}-${today}\n單日請輸入四碼，例如：${today}`;
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
      await ctx.reply(flow.type === 'income' ? '已取消記錄收入。' : '已取消記帳。');
      return;
    }
    const amount = parseFloat(text.replace(/[,，元塊]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.reply('請直接輸入金額數字（例如 150），或輸入「取消」放棄。');
      return;
    }
    flowState.delete(chatId);
    try {
      const cardPart = flow.card ? `${flow.card} ` : '';
      const reply = await logic.recordTransaction({
        date: new Date().toISOString().slice(0, 10),
        type: flow.type,
        category: flow.category,
        amount,
        card: flow.card || null,
        note: `${cardPart}${flow.category} ${amount}`,
      });
      await ctx.reply(reply, { reply_markup: mainMenuKeyboard() });
    } catch (err) {
      console.error('guided entry record error:', err);
      await ctx.reply('記帳時發生錯誤，請稍後再試一次。');
    }
    return;
  }

  if (flow && flow.step === 'query_date') {
    if (text === '取消') {
      flowState.delete(chatId);
      await ctx.reply('已取消查詢。');
      return;
    }
    const range = parseQueryDateInput(text);
    if (!range) {
      await ctx.reply('❌ 格式錯誤！請依格式輸入，例如：0501-0519 或單日 0519');
      return;
    }
    flowState.set(chatId, { step: 'query_type', ...range });
    await ctx.reply(`期間：${range.label}\n請選擇查詢方式`, { reply_markup: queryTypeKeyboard() });
    return;
  }

  if (text === '記帳') {
    flowState.set(chatId, { step: 'category', type: 'expense' });
    await ctx.reply('選擇消費類別：', { reply_markup: categoryKeyboard() });
    return;
  }

  if (text === '收入') {
    flowState.set(chatId, { step: 'category', type: 'income' });
    await ctx.reply('選擇收入類別：', { reply_markup: incomeCategoryKeyboard() });
    return;
  }

  if (text === '查詢') {
    flowState.set(chatId, { step: 'query_date' });
    await ctx.reply(defaultQueryRangeHint());
    return;
  }

  if (/^(網頁|儀表板|報表連結|dashboard)$/i.test(text)) {
    await ctx.reply(dashboardLinkText());
    return;
  }

  try {
    const result = await logic.handleMessage(text);
    const showMenu = text === '說明';
    await ctx.reply(result.reply, showMenu ? { reply_markup: mainMenuKeyboard() } : undefined);
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

  if (data === 'cat:more') {
    await ctx.answerCallbackQuery({});
    await ctx.api.editMessageText({
      chat_id: chatId,
      message_id: ctx.callbackQuery.message.message_id,
      text: '選擇消費類別：',
      reply_markup: categoryKeyboard(true),
    });
    return;
  }

  if (data.startsWith('cat:')) {
    const category = data.slice(4);
    flowState.set(chatId, { step: 'card', type: 'expense', category });
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
    flowState.set(chatId, { step: 'amount', type: 'expense', category: flow.category, card });
    await ctx.answerCallbackQuery({});
    await ctx.api.editMessageText({
      chat_id: chatId,
      message_id: ctx.callbackQuery.message.message_id,
      text: `類別：${flow.category}　付款：${card}\n請輸入金額（例如 150），或輸入「取消」放棄`,
    });
    return;
  }

  if (data.startsWith('inc:')) {
    const category = data.slice(4);
    flowState.set(chatId, { step: 'amount', type: 'income', category });
    await ctx.answerCallbackQuery({});
    await ctx.api.editMessageText({
      chat_id: chatId,
      message_id: ctx.callbackQuery.message.message_id,
      text: `收入類別：${category}\n請輸入金額（例如 45000），或輸入「取消」放棄`,
    });
    return;
  }

  if (data.startsWith('qtype:')) {
    const queryType = data.slice(6);
    const flow = flowState.get(chatId);

    if (queryType === 'cancel') {
      flowState.delete(chatId);
      await ctx.answerCallbackQuery({});
      await ctx.api.editMessageText({
        chat_id: chatId,
        message_id: ctx.callbackQuery.message.message_id,
        text: '已取消查詢。',
      });
      return;
    }

    if (!flow || !flow.start) {
      await ctx.answerCallbackQuery({ text: '請重新輸入「查詢」開始' });
      return;
    }

    await ctx.answerCallbackQuery({});
    const text =
      queryType === 'detail'
        ? await logic.buildRangeDetailText(flow.start, flow.end, flow.label)
        : await logic.buildRangeAmountText(flow.start, flow.end, flow.label);
    // keep the range around so "🔍再查詢" restarts and "📋查明細" can reuse it
    flowState.set(chatId, { step: 'query_type', start: flow.start, end: flow.end, label: flow.label });
    await ctx.reply(text, { reply_markup: queryFollowUpKeyboard(queryType !== 'detail') });
    return;
  }

  if (data.startsWith('follow:')) {
    const action = data.slice(7);
    await ctx.answerCallbackQuery({});
    if (action === 'record') {
      flowState.set(chatId, { step: 'category', type: 'expense' });
      await ctx.reply('選擇消費類別：', { reply_markup: categoryKeyboard() });
    } else if (action === 'query') {
      flowState.set(chatId, { step: 'query_date' });
      await ctx.reply(defaultQueryRangeHint());
    } else {
      flowState.delete(chatId);
      await ctx.reply('好的，查詢結束 👋', { reply_markup: mainMenuKeyboard() });
    }
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
      `嗨！我是你的財務小幫手。輸入「說明」看看我能做什麼，或用下面的按鈕記帳、查收入、查詢。\n${dashboardLinkText()}`,
      { reply_markup: mainMenuKeyboard() }
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
