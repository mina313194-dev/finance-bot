const db = require('./db');
const parser = require('./parser');
const { buildSuggestion } = require('./budget');

function fmt(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}NT$${Math.round(Math.abs(n)).toLocaleString()}`;
}

function monthKeyOf(dateStr) {
  return dateStr.slice(0, 7);
}

function nowISO() {
  return new Date().toISOString();
}

// ---------- transactions ----------

async function insertTransaction({ date, type, category, amount, note }) {
  await db.run(
    `INSERT INTO transactions (date, type, category, amount, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [date, type, category, amount, note || null, nowISO()]
  );
}

async function getMonthTransactions(monthKey) {
  return db.all(
    `SELECT * FROM transactions WHERE substr(date,1,7) = ? ORDER BY date DESC, id DESC`,
    [monthKey]
  );
}

async function getMonthSummary(monthKey) {
  const rows = await getMonthTransactions(monthKey);
  let income = 0;
  let expense = 0;
  const byCategory = {};
  for (const r of rows) {
    if (r.type === 'income') income += r.amount;
    else expense += r.amount;
    const key = `${r.type}:${r.category}`;
    byCategory[key] = (byCategory[key] || 0) + r.amount;
  }
  const byCategoryList = Object.entries(byCategory).map(([key, total]) => {
    const [type, category] = key.split(':');
    return { type, category, total };
  });
  return { month: monthKey, income, expense, net: income - expense, byCategory: byCategoryList };
}

async function getExpenseByCategory(monthKey) {
  const s = await getMonthSummary(monthKey);
  return s.byCategory.filter((r) => r.type === 'expense');
}

async function getTrend(months = 6) {
  const result = [];
  const d = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const s = await getMonthSummary(key);
    result.push({ month: key, income: s.income, expense: s.expense });
  }
  return result;
}

// ---------- budgets ----------

async function setBudget(category, limit) {
  await db.run(
    `INSERT INTO budgets (category, monthly_limit) VALUES (?, ?)
     ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit`,
    [category, limit]
  );
}

async function getBudgets() {
  return db.all(`SELECT * FROM budgets ORDER BY category`);
}

async function getBudgetStatus(monthKey) {
  const budgets = await getBudgets();
  const spent = await getExpenseByCategory(monthKey);
  const spentMap = Object.fromEntries(spent.map((r) => [r.category, r.total]));
  return budgets.map((b) => ({
    category: b.category,
    limit: b.monthly_limit,
    spent: spentMap[b.category] || 0,
    remaining: b.monthly_limit - (spentMap[b.category] || 0),
  }));
}

// ---------- goals ----------

async function setGoal(name, target, deadline) {
  const existing = await db.get(`SELECT * FROM goals WHERE name = ?`, [name]);
  if (existing) {
    await db.run(`UPDATE goals SET target_amount = ?, deadline = ? WHERE name = ?`, [
      target,
      deadline,
      name,
    ]);
  } else {
    await db.run(
      `INSERT INTO goals (name, target_amount, current_amount, deadline, created_at)
       VALUES (?, ?, 0, ?, ?)`,
      [name, target, deadline, nowISO()]
    );
  }
}

async function contributeGoal(name, amount) {
  let goal = await db.get(`SELECT * FROM goals WHERE name = ?`, [name]);
  if (!goal) goal = await db.get(`SELECT * FROM goals WHERE name LIKE ?`, [`%${name}%`]);
  if (!goal) return null;
  await db.run(`UPDATE goals SET current_amount = current_amount + ? WHERE id = ?`, [
    amount,
    goal.id,
  ]);
  return db.get(`SELECT * FROM goals WHERE id = ?`, [goal.id]);
}

async function getGoals() {
  return db.all(`SELECT * FROM goals ORDER BY created_at`);
}

// ---------- chat handling ----------

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function buildReportText(monthKey) {
  const s = await getMonthSummary(monthKey);
  if (s.income === 0 && s.expense === 0) {
    return `${monthKey} 目前還沒有任何記錄，開始記帳試試看，例如輸入「午餐 150」。`;
  }
  const lines = [
    `${monthKey} 月報`,
    `收入：${fmt(s.income)}　支出：${fmt(s.expense)}　結餘：${fmt(s.net)}`,
  ];
  const expenseCats = s.byCategory
    .filter((r) => r.type === 'expense')
    .sort((a, b) => b.total - a.total);
  if (expenseCats.length) {
    lines.push('支出分類：');
    for (const c of expenseCats) {
      lines.push(`　${c.category}：${fmt(c.total)}`);
    }
  }
  return lines.join('\n');
}

async function buildBudgetAdviceText(monthKey) {
  const s = await getMonthSummary(monthKey);
  if (s.income === 0) {
    return '這個月還沒有收入記錄，先記一筆收入（例如「薪水 45000」），我才能幫你算建議分配。';
  }
  const expenseCats = s.byCategory.filter((r) => r.type === 'expense');
  const sug = buildSuggestion(s.income, expenseCats);
  const lines = [
    `依 50/30/20 法則，本月收入 ${fmt(sug.monthlyIncome)} 的建議分配：`,
    `必要支出（住房/餐飲/交通/醫療/教育）：建議 ${fmt(sug.recommended.needs)}，實際 ${fmt(
      sug.actual.needs
    )}${sug.diff.needs > 0 ? `（超支 ${fmt(sug.diff.needs)}）` : ''}`,
    `想要支出（娛樂/購物等）：建議 ${fmt(sug.recommended.wants)}，實際 ${fmt(sug.actual.wants)}${
      sug.diff.wants > 0 ? `（超支 ${fmt(sug.diff.wants)}）` : ''
    }`,
    `儲蓄／投資：建議 ${fmt(sug.recommended.savings)}，目前結餘 ${fmt(sug.actual.savings)}${
      sug.diff.savings < 0 ? `（比建議少存 ${fmt(-sug.diff.savings)}）` : ''
    }`,
  ];
  return lines.join('\n');
}

async function buildGoalsText() {
  const goals = await getGoals();
  if (!goals.length) {
    return '目前沒有設定任何目標。輸入「設定目標 出國基金 50000」來新增一個。';
  }
  return goals
    .map((g) => {
      const pct = g.target_amount > 0 ? Math.min(100, (g.current_amount / g.target_amount) * 100) : 0;
      const deadlinePart = g.deadline ? `，期限 ${g.deadline}` : '';
      return `${g.name}：${fmt(g.current_amount)} / ${fmt(g.target_amount)}（${pct.toFixed(
        1
      )}%）${deadlinePart}`;
    })
    .join('\n');
}

const HELP_TEXT = [
  '你可以這樣跟我說：',
  '記帳：「午餐 150」「薪水 45000」「昨天 加油 800」',
  '設定預算：「設定預算 餐飲 5000」',
  '設定目標：「設定目標 出國基金 50000 2026-12-31」',
  '存錢到目標：「存 3000 到 出國基金」',
  '查詢：「這個月報告」「預算建議」「目標進度」',
].join('\n');

async function handleMessage(text) {
  const intent = parser.parse(text);
  const monthKey = currentMonthKey();

  switch (intent.intent) {
    case 'help':
      return { reply: HELP_TEXT, refresh: false };

    case 'record_transaction': {
      await insertTransaction(intent);
      let reply = `已記錄${intent.type === 'income' ? '收入' : '支出'}：${intent.category} ${fmt(
        intent.amount
      )}`;
      if (intent.type === 'expense') {
        const statusList = await getBudgetStatus(monthKeyOf(intent.date));
        const status = statusList.find((b) => b.category === intent.category);
        if (status && status.spent > status.limit) {
          reply += `\n⚠️ 本月「${intent.category}」已超出預算 ${fmt(status.limit)}，目前花費 ${fmt(
            status.spent
          )}`;
        } else if (status) {
          reply += `\n本月「${intent.category}」預算剩餘 ${fmt(status.remaining)}`;
        }
      }
      return { reply, refresh: true };
    }

    case 'set_budget':
      await setBudget(intent.category, intent.limit);
      return {
        reply: `已設定「${intent.category}」每月預算為 ${fmt(intent.limit)}`,
        refresh: true,
      };

    case 'set_goal':
      await setGoal(intent.name, intent.target, intent.deadline);
      return {
        reply: `已設定目標「${intent.name}」，目標金額 ${fmt(intent.target)}${
          intent.deadline ? `，期限 ${intent.deadline}` : ''
        }`,
        refresh: true,
      };

    case 'contribute_goal': {
      const goal = await contributeGoal(intent.name, intent.amount);
      if (!goal) {
        return {
          reply: `找不到名為「${intent.name}」的目標，請先用「設定目標 ${intent.name} 金額」建立。`,
          refresh: false,
        };
      }
      const pct = goal.target_amount > 0 ? (goal.current_amount / goal.target_amount) * 100 : 0;
      return {
        reply: `已存入 ${fmt(intent.amount)} 到「${goal.name}」，目前進度 ${fmt(
          goal.current_amount
        )} / ${fmt(goal.target_amount)}（${pct.toFixed(1)}%）`,
        refresh: true,
      };
    }

    case 'query_goals':
      return { reply: await buildGoalsText(), refresh: false };

    case 'query_budget_suggestion':
      return { reply: await buildBudgetAdviceText(monthKey), refresh: false };

    case 'query_report':
      return { reply: await buildReportText(monthKey), refresh: false };

    default:
      return {
        reply:
          '我沒看懂這句話。可以直接說「項目 金額」來記帳，或輸入「說明」查看所有可用指令。',
        refresh: false,
      };
  }
}

module.exports = {
  handleMessage,
  getMonthSummary,
  getExpenseByCategory,
  getTrend,
  getBudgets,
  getBudgetStatus,
  getGoals,
  currentMonthKey,
  fmt,
};
