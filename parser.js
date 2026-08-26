// 規則式（非 AI）中文訊息解析器：把使用者輸入的自然語句轉成結構化意圖

const INCOME_CATEGORIES = {
  '薪資': ['薪水', '薪資', '發薪', '月薪'],
  '獎金': ['獎金', '紅利', '分紅'],
  '投資收益': ['股息', '利息', '配息', '投資收益', '股利'],
  '其他收入': ['退款', '退費', '收入'],
};

const EXPENSE_CATEGORIES = {
  '餐飲': ['早餐', '午餐', '晚餐', '消夜', '宵夜', '飲料', '咖啡', '吃飯', '餐廳', '便當', '奶茶', '吃'],
  '交通': ['加油', '停車', '捷運', '公車', '計程車', 'uber', '油錢', '高鐵', '火車', '機票'],
  '住房': ['房租', '房貸', '水電', '瓦斯', '管理費', '電費', '水費', '網路費'],
  '娛樂': ['電影', '遊戲', '唱歌', 'ktv', '旅遊', '訂閱', 'netflix', '門票'],
  '購物': ['衣服', '鞋子', '3c', '網購', '購物', '買'],
  '醫療': ['看病', '藥', '醫院', '診所', '掛號'],
  '教育': ['書', '課程', '學費', '補習'],
};

const ALL_CATEGORIES = [
  ...Object.keys(INCOME_CATEGORIES),
  ...Object.keys(EXPENSE_CATEGORIES),
  '其他支出',
];

function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function extractDate(text) {
  if (text.includes('前天')) return todayISO(-2);
  if (text.includes('昨天')) return todayISO(-1);
  const m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return todayISO(0);
}

function extractAmount(text) {
  let m = text.match(/(\d+(?:\.\d+)?)\s*(?:元|塊|圓)/);
  if (m) return parseFloat(m[1]);
  m = text.match(/(\d+(?:\.\d+)?)/);
  if (m) return parseFloat(m[1]);
  return null;
}

function matchCategory(text, dict) {
  for (const [category, keywords] of Object.entries(dict)) {
    for (const kw of keywords) {
      if (text.includes(kw)) return category;
    }
  }
  return null;
}

function parseTransaction(text) {
  const amount = extractAmount(text);
  if (amount === null) return null;

  let type = null;
  let category = null;

  if (text.includes('收入') && !text.includes('支出')) type = 'income';
  if (text.includes('支出') || text.includes('花費') || text.includes('花了')) type = 'expense';

  const incomeCat = matchCategory(text, INCOME_CATEGORIES);
  const expenseCat = matchCategory(text, EXPENSE_CATEGORIES);

  if (!type) {
    if (incomeCat) type = 'income';
    else type = 'expense';
  }

  if (type === 'income') {
    category = incomeCat || '其他收入';
  } else {
    category = expenseCat || '其他支出';
  }

  return {
    intent: 'record_transaction',
    type,
    category,
    amount,
    date: extractDate(text),
    note: text,
  };
}

function parse(rawText) {
  const text = rawText.trim();
  const lower = text.toLowerCase();

  if (/^(說明|幫助|help|指令)$/i.test(text)) {
    return { intent: 'help' };
  }

  let m = text.match(/^設定預算\s*(\S+?)\s*(\d+(?:\.\d+)?)/);
  if (m) {
    return { intent: 'set_budget', category: m[1], limit: parseFloat(m[2]) };
  }

  m = text.match(/^設定目標\s*(\S+?)\s*(\d+(?:\.\d+)?)\s*(\d{4}-\d{1,2}-\d{1,2})?/);
  if (m) {
    return {
      intent: 'set_goal',
      name: m[1],
      target: parseFloat(m[2]),
      deadline: m[3] || null,
    };
  }

  m = text.match(/^存\s*(\d+(?:\.\d+)?)\s*(?:元|塊)?\s*(?:到|給|進)?\s*(\S+)/);
  if (m) {
    return { intent: 'contribute_goal', amount: parseFloat(m[1]), name: m[2] };
  }

  if (/目標進度|查看目標|我的目標/.test(text)) {
    return { intent: 'query_goals' };
  }

  if (/預算建議|該怎麼分配|怎麼分配|理財建議/.test(text)) {
    return { intent: 'query_budget_suggestion' };
  }

  if (/月報|報告|報表|總結|花費統計|這個月/.test(text) && !extractAmount(text)) {
    return { intent: 'query_report' };
  }

  const tx = parseTransaction(text);
  if (tx) return tx;

  return { intent: 'unknown' };
}

module.exports = {
  parse,
  INCOME_CATEGORIES,
  EXPENSE_CATEGORIES,
  ALL_CATEGORIES,
};
