// 規則式（非 AI）中文訊息解析器：把使用者輸入的自然語句轉成結構化意圖

const INCOME_CATEGORIES = {
  '薪資': ['薪水', '薪資', '發薪', '月薪'],
  '年終': ['年終', '年終獎金', '尾牙'],
  '獎金': ['獎金', '紅利', '分紅'],
  '投資收益': ['股息', '利息', '配息', '投資收益', '股利'],
  '其他收入': ['退款', '退費', '收入'],
};

const EXPENSE_CATEGORIES = {
  '餐飲': ['早餐', '午餐', '晚餐', '消夜', '宵夜', '飲料', '咖啡', '吃飯', '餐廳', '便當', '奶茶', '吃'],
  '交通': ['捷運', '計程車', '加油', '加油錢', '停車', '公車', 'uber', '油錢', '高鐵', '火車', '機票'],
  '服飾': ['衣服', '褲子', '外套', '鞋子', '洋裝', '裙子', '襪子'],
  '運動': ['瑜珈', '皮拉提斯', '健身', '游泳', '路跑', '重訓', '運動'],
  '孝親費': ['孝親費', '孝親', '給爸媽', '給父母'],
  '機車費': ['齒輪油', '煞車', '皮帶', '機車', '摩托車', '換機油', '機車保養'],
  '投資': ['投資', '買股', '定期定額', '基金', '買基金'],
  '交際費': ['應酬', '交際', '請客', '聚餐', '聚會', '飯局'],
  '稅金': ['稅金', '報稅', '罰單', '牌照稅', '燃料稅'],
  '醫療保健': ['看病', '看醫生', '掛號', '掛號費', '中藥', '按摩', '醫院', '診所', '藥局', '西藥'],
  '捐款': ['捐款', '捐', '樂捐', '公益'],
  '保險': ['保險', '保費', '壽險', '車險'],
  '美容美髮': ['美髮', '剪髮', '燙髮', '染髮', '美容', '做臉', '美甲', 'spa'],
  '訂閱': ['訂閱', '月租費', 'apple.com', 'icloud', 'netflix', 'spotify', 'youtube', 'app store'],
  '電信': ['電信', '手機費', '通話費', '門號', '台新電信', 'sim卡'],
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

function normalizeMonth(monthStr) {
  const [y, m] = monthStr.split('-');
  return `${y}-${m.padStart(2, '0')}`;
}

function extractAmount(text) {
  // strip an explicit YYYY-MM-DD date first so its digits aren't mistaken for the amount
  const stripped = text.replace(/\d{4}-\d{1,2}-\d{1,2}/, '');
  let m = stripped.match(/(\d+(?:\.\d+)?)\s*(?:元|塊|圓)/);
  if (m) return parseFloat(m[1]);
  m = stripped.match(/(\d+(?:\.\d+)?)/);
  if (m) return parseFloat(m[1]);
  return null;
}

function matchCategory(text, dict) {
  for (const [category, keywords] of Object.entries(dict)) {
    if (text.includes(category)) return category;
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

  m = text.match(/^設定分配\s*(\S+?)\s*(\d+(?:\.\d+)?)\s*%/);
  if (m) {
    return { intent: 'set_allocation', category: m[1], percent: parseFloat(m[2]) };
  }

  m = text.match(/^取消分配\s*(\S+)/);
  if (m) {
    return { intent: 'remove_allocation', category: m[1] };
  }

  if (/分配計畫|查看分配/.test(text)) {
    return { intent: 'query_allocation' };
  }

  m = text.match(
    /^設定固定預算\s*(\S+?)\s*(\d+(?:\.\d+)?)\s*(\d{4}-\d{1,2})(?:\s*[至到]?\s*(\d{4}-\d{1,2}))?/
  );
  if (m) {
    return {
      intent: 'set_recurring_budget',
      category: m[1],
      amount: parseFloat(m[2]),
      startMonth: normalizeMonth(m[3]),
      endMonth: m[4] ? normalizeMonth(m[4]) : null,
    };
  }

  if (/固定預算/.test(text)) {
    return { intent: 'query_recurring_budget' };
  }

  if (/預算執行狀況|預算狀況|各項目預算/.test(text)) {
    return { intent: 'query_budget_status' };
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
