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

const { CATEGORY_EMOJI, INCOME_EMOJI } = parser;

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

function mainMenuKeyboard() {
  return new ReplyKeyboardBuilder()
    .text('記帳')
    .text('查詢')
    .row()
    .text('說明')
    .text('報表')
    .build({ resize_keyboard: true });
}

function recordSubmenuKeyboard() {
  return new InlineKeyboardBuilder()
    .text('💸 支出', 'sub:expense')
    .text('💰 收入', 'sub:income')
    .row()
    .text('❌ 取消', 'flow:cancel')
    .build();
}

// per-chat guided-entry state (in-memory - fine for a single-user bot; a
// server restart mid-flow just means starting the flow over)
const flowState = new Map();

function chunk(arr, size) {
  const rows = [];
  for (let i = 0; i < arr.length; i += size) rows.push(arr.slice(i, i + size));
  return rows;
}

// appends the trailing row(s): "其他" + "取消" side by side when there's a
// "more" option to expand, otherwise just "取消" alone
function addMoreAndCancel(builder, moreCallbackData) {
  if (moreCallbackData) builder.text('▶️ 其他', moreCallbackData);
  builder.text('❌ 取消', 'flow:cancel').row();
}

const FAVORITE_CATEGORIES = ['餐飲', '儀容', '交通'];

function categoryKeyboard(showAll = false) {
  const all = Object.keys(parser.EXPENSE_CATEGORIES);
  const categories = showAll ? all.filter((c) => !FAVORITE_CATEGORIES.includes(c)) : FAVORITE_CATEGORIES;
  const builder = new InlineKeyboardBuilder();
  for (const row of chunk(categories, 3)) {
    for (const cat of row) builder.text(`${CATEGORY_EMOJI[cat] || '📦'} ${cat}`, `cat:${cat}`);
    builder.row();
  }
  addMoreAndCancel(builder, !showAll && 'cat:more');
  return builder.build();
}

const FAVORITE_CARDS = ['永豐', '玉山'];

function cardKeyboard(showAll = false) {
  const rest = parser.KNOWN_CARDS.filter((c) => !FAVORITE_CARDS.includes(c) && c !== '現金');
  const cards = showAll ? ['現金', ...rest] : FAVORITE_CARDS;
  const builder = new InlineKeyboardBuilder();
  for (const row of chunk(cards, 3)) {
    for (const card of row) builder.text(`${CARD_EMOJI[card] || '💳'} ${card}`, `card:${card}`);
    builder.row();
  }
  addMoreAndCancel(builder, !showAll && 'card:more');
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

function mmddToDate(mmdd) {
  const year = new Date().getFullYear();
  return `${year}-${mmdd.slice(0, 2)}-${mmdd.slice(2, 4)}`;
}

// accepts "MMDD-MMDD" (range) or a single "MMDD" (that one day), current year assumed
function parseQueryDateInput(text) {
  const toDate = mmddToDate;
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

function todayMMDD() {
  const now = new Date();
  return `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

function buildExpenseTemplateText() {
  return [
    '請直接複製修改後回傳：',
    '若不記帳請輸入「取消」',
    '',
    '📂 類別：餐飲 / 交通 / 購物 / 娛樂 / 其他',
    '💳 付款：現金 / 永豐 / 玉山 / 台新 / 國泰 / 聯邦 / 華南',
    '',
    `日期：${todayMMDD()}`,
    '類別：',
    '金額：',
    '付款：',
    '備註：',
  ].join('\n');
}

function buildIncomeTemplateText() {
  return [
    '請直接複製修改後回傳：',
    '若不記帳請輸入「取消」',
    '',
    '📂 類別：薪資 / 獎金 / 年終 / 投資收益 / 其他',
    '💳 存入：連線 / 現金 / 永豐 / 玉山 / 台新 / 國泰 / 聯邦 / 華南 / 土地',
    '',
    `日期：${todayMMDD()}`,
    '類別：',
    '金額：',
    '付款：',
    '備註：',
  ].join('\n');
}

// parses the filled-in template back: lines like "欄位：值"
function parseTemplateFill(text) {
  const fields = {};
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(日期|類別|金額|付款|備註)[：:]\s*(.*)$/);
    if (m) fields[m[1]] = m[2].trim();
  }
  return fields;
}

// recognizes a pasted fill-in-template message even when the flow state that
// normally tracks "user is mid-template" has been lost - e.g. Render's free
// tier restarts the process on idle, which wipes the in-memory flowState Map.
// Without this, a returning template paste fell through to the old free-text
// parser and got silently misparsed (category read from the instruction line,
// amount read from the date field) instead of being handled correctly.
function looksLikeTemplateFill(text) {
  const fields = parseTemplateFill(text);
  return Object.keys(fields).length >= 3;
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

  // "取消" works at every step, not just the text-input ones (amount /
  // query_date) - category/card steps wait on a button tap, so without this
  // typing 取消 there just fell through to "看不懂" and left the flow stuck
  if (flow && text === '取消') {
    flowState.delete(chatId);
    await ctx.reply('已取消。', { reply_markup: mainMenuKeyboard() });
    return;
  }

  // "刪除" also works at every step, same reasoning as 取消 above - otherwise
  // a leftover flow (e.g. mid 記帳/查詢, or stuck after a Render restart) would
  // swallow the delete command as an invalid answer to whatever step it's on,
  // instead of actually deleting anything
  if (/^刪除/.test(text)) {
    if (flow) flowState.delete(chatId);
    try {
      const result = await logic.handleMessage(text);
      await ctx.reply(result.reply, { reply_markup: mainMenuKeyboard() });
    } catch (err) {
      console.error('Telegram 刪除 error:', err);
      await ctx.reply('刪除時發生錯誤，請稍後再試一次。');
    }
    return;
  }

  if (flow && flow.step === 'amount') {
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
    const range = parseQueryDateInput(text);
    if (!range) {
      await ctx.reply('❌ 格式錯誤！請依格式輸入，例如：0501-0519 或單日 0519');
      return;
    }
    flowState.set(chatId, { step: 'query_type', ...range });
    await ctx.reply(`期間：${range.label}\n請選擇查詢方式`, { reply_markup: queryTypeKeyboard() });
    return;
  }

  const isTemplateFillFlow = flow && flow.step === 'template_fill';
  const isBareTemplateFill = !isTemplateFillFlow && !flow && looksLikeTemplateFill(text);

  if (isTemplateFillFlow || isBareTemplateFill) {
    const fields = parseTemplateFill(text);
    const errors = [];

    const dateStr = fields['日期'] || todayMMDD();
    if (!/^\d{4}$/.test(dateStr)) errors.push('日期要是 4 碼數字，例如 0908');

    const amount = parseFloat((fields['金額'] || '').replace(/[,，元塊]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) errors.push('金額要填正確的數字');

    if (!fields['類別']) errors.push('類別不能空白');

    // flow.type is authoritative when a flow is tracked; for a bare paste
    // (flow state lost), fall back to resolving the category text itself,
    // then default to expense since that's the more common entry
    const resolved = fields['類別'] ? parser.resolveCategory(fields['類別']) : null;
    const type = isTemplateFillFlow ? flow.type : resolved ? resolved.type : 'expense';

    if (errors.length) {
      const template = type === 'income' ? buildIncomeTemplateText() : buildExpenseTemplateText();
      await ctx.reply(`❌ 格式有誤：\n${errors.join('\n')}\n\n請重新複製範本填寫，或輸入「取消」放棄。\n\n${template}`);
      return;
    }

    const category =
      type === 'income' ? parser.matchIncomeCategory(fields['類別']) : parser.matchExpenseCategory(fields['類別']);
    const card = parser.KNOWN_CARDS.includes(fields['付款']) ? fields['付款'] : null;
    flowState.delete(chatId);
    try {
      const reply = await logic.recordTransaction({
        date: mmddToDate(dateStr),
        type,
        category,
        amount,
        card,
        note: fields['備註'] || `${fields['類別']} ${amount}`,
        displayNote: fields['備註'] || undefined,
      });
      await ctx.reply(reply, { reply_markup: mainMenuKeyboard() });
    } catch (err) {
      console.error('template fill record error:', err);
      await ctx.reply('記帳時發生錯誤，請稍後再試一次。');
    }
    return;
  }

  if (text === '記帳') {
    await ctx.reply('要記支出還是收入？', { reply_markup: recordSubmenuKeyboard() });
    return;
  }

  if (text === '查詢') {
    flowState.set(chatId, { step: 'query_date' });
    await ctx.reply(defaultQueryRangeHint());
    return;
  }

  if (text === '報表') {
    try {
      const result = await logic.handleMessage('這個月報告');
      await ctx.reply(result.reply);
    } catch (err) {
      console.error('Telegram 報表 error:', err);
      await ctx.reply('產生報表時發生錯誤，請稍後再試一次。');
    }
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

  if (data === 'sub:expense') {
    flowState.set(chatId, { step: 'template_fill', type: 'expense' });
    await ctx.answerCallbackQuery({});
    await ctx.api.editMessageText({
      chat_id: chatId,
      message_id: ctx.callbackQuery.message.message_id,
      text: buildExpenseTemplateText(),
    });
    return;
  }

  if (data === 'sub:income') {
    flowState.set(chatId, { step: 'template_fill', type: 'income' });
    await ctx.answerCallbackQuery({});
    await ctx.api.editMessageText({
      chat_id: chatId,
      message_id: ctx.callbackQuery.message.message_id,
      text: buildIncomeTemplateText(),
    });
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

  if (data === 'card:more') {
    const flow = flowState.get(chatId);
    if (!flow || flow.step !== 'card') {
      await ctx.answerCallbackQuery({ text: '請重新輸入「記帳」開始' });
      return;
    }
    await ctx.answerCallbackQuery({});
    await ctx.api.editMessageText({
      chat_id: chatId,
      message_id: ctx.callbackQuery.message.message_id,
      text: `類別：${flow.category}\n選擇付款方式：`,
      reply_markup: cardKeyboard(true),
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

  if (data === 'flow:cancel') {
    flowState.delete(chatId);
    await ctx.answerCallbackQuery({});
    await ctx.api.editMessageText({
      chat_id: chatId,
      message_id: ctx.callbackQuery.message.message_id,
      text: '已取消。',
    });
    return;
  }

  if (data.startsWith('follow:')) {
    const action = data.slice(7);
    await ctx.answerCallbackQuery({});
    if (action === 'record') {
      await ctx.reply('要記支出還是收入？', { reply_markup: recordSubmenuKeyboard() });
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

async function sendPaydayTransferReminder() {
  if (!botInstance || !ALLOWED_CHAT_ID) return false;
  const text = await logic.buildPaydayTransferReminderText();
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
      `嗨！我是你的財務小幫手。輸入「說明」看看我能做什麼，或用下面的按鈕記帳（支出/收入）、查詢、看報表。\n${dashboardLinkText()}`,
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

module.exports = { init, sendWeeklyReport, sendMonthlySurplusReminder, sendPaydayTransferReminder };
