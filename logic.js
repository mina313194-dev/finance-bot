const db = require('./db');
const parser = require('./parser');
const { buildSuggestion, groupOf } = require('./budget');

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
// budgets are scoped per month: a category's cap only applies to the month it was set/allocated for

async function setBudget(category, limit, month) {
  await db.run(
    `INSERT INTO budgets (category, month, monthly_limit) VALUES (?, ?, ?)
     ON CONFLICT(category, month) DO UPDATE SET monthly_limit = excluded.monthly_limit`,
    [category, month, limit]
  );
}

async function getBudgets(month) {
  return db.all(`SELECT * FROM budgets WHERE month = ? ORDER BY category`, [month]);
}

async function getBudgetStatus(monthKey) {
  await ensureRecurringBudgetsApplied(monthKey);
  const budgets = await getBudgets(monthKey);
  const spent = await getExpenseByCategory(monthKey);
  const spentMap = Object.fromEntries(spent.map((r) => [r.category, r.total]));
  return budgets.map((b) => ({
    category: b.category,
    group: groupOf(b.category),
    limit: b.monthly_limit,
    spent: spentMap[b.category] || 0,
    remaining: b.monthly_limit - (spentMap[b.category] || 0),
  }));
}

// ---------- income allocation plan ----------
// when income is recorded, each rule's share (percent of that income) is added
// on top of the category's budget for that month, so multiple incomes in the
// same month (e.g. salary then a later bonus) stack instead of overwriting.

async function setAllocationRule(category, percent) {
  await db.run(
    `INSERT INTO allocation_rules (category, percent) VALUES (?, ?)
     ON CONFLICT(category) DO UPDATE SET percent = excluded.percent`,
    [category, percent]
  );
}

async function removeAllocationRule(category) {
  await db.run(`DELETE FROM allocation_rules WHERE category = ?`, [category]);
}

async function getAllocationRules() {
  return db.all(`SELECT * FROM allocation_rules ORDER BY category`);
}

async function applyIncomeAllocation(amount, month) {
  const rules = await getAllocationRules();
  const applied = [];
  for (const rule of rules) {
    const share = amount * (rule.percent / 100);
    if (share <= 0) continue;
    await db.run(
      `INSERT INTO budgets (category, month, monthly_limit) VALUES (?, ?, ?)
       ON CONFLICT(category, month) DO UPDATE SET monthly_limit = monthly_limit + excluded.monthly_limit`,
      [rule.category, month, share]
    );
    applied.push({ category: rule.category, percent: rule.percent, share });
  }
  return applied;
}

// ---------- recurring fixed budgets ----------
// for expenses with a known fixed schedule (installments, flat annual premiums
// smoothed monthly, etc.) rather than a percent-of-income share. A category can
// have multiple non-overlapping (start_month, end_month) phases, e.g. a higher
// amount while an installment plan runs, then a lower steady-state amount after.

async function setRecurringBudget(category, amount, startMonth, endMonth) {
  await db.run(
    `INSERT INTO recurring_budgets (category, amount, start_month, end_month) VALUES (?, ?, ?, ?)`,
    [category, amount, startMonth, endMonth || null]
  );
}

async function getRecurringBudgets() {
  return db.all(`SELECT * FROM recurring_budgets ORDER BY category, start_month`);
}

async function ensureRecurringBudgetsApplied(monthKey) {
  // idempotent + additive: each rule's amount is added to that category's budget
  // exactly once per month (tracked in recurring_budget_log), so it stacks with
  // whatever income-allocation has already added instead of overwriting it,
  // regardless of which one happens to run first in a given month. It also
  // auto-records an estimated transaction for the same amount, so "spent" is
  // already accurate before the real statement shows up — reconcile it later
  // by editing/removing the estimated transaction against the actual bill.
  const rules = await db.all(
    `SELECT * FROM recurring_budgets WHERE start_month <= ? AND (end_month IS NULL OR end_month >= ?)`,
    [monthKey, monthKey]
  );
  for (const r of rules) {
    const already = await db.get(
      `SELECT 1 FROM recurring_budget_log WHERE rule_id = ? AND month = ?`,
      [r.id, monthKey]
    );
    if (already) continue;
    await db.run(
      `INSERT INTO budgets (category, month, monthly_limit) VALUES (?, ?, ?)
       ON CONFLICT(category, month) DO UPDATE SET monthly_limit = monthly_limit + excluded.monthly_limit`,
      [r.category, monthKey, r.amount]
    );
    await insertTransaction({
      date: `${monthKey}-01`,
      type: 'expense',
      category: r.category,
      amount: r.amount,
      note: `固定預算自動入帳（待核對實際帳單）`,
    });
    await db.run(`INSERT INTO recurring_budget_log (rule_id, month) VALUES (?, ?)`, [
      r.id,
      monthKey,
    ]);
  }
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

function budgetStatusLines(status) {
  if (!status.length) {
    return ['這個月還沒有任何預算額度（尚未收到薪水或還沒設定固定預算）。'];
  }
  const lines = [];
  for (const b of status.sort((a, b2) => b2.spent - a.spent)) {
    const over = b.spent > b.limit;
    lines.push(
      `　${b.category}：花了 ${fmt(b.spent)} / 預算 ${fmt(b.limit)}，剩 ${fmt(b.remaining)}${
        over ? ' ⚠️超支' : ''
      }`
    );
  }
  return lines;
}

async function buildWeeklyBudgetReportText() {
  const monthKey = currentMonthKey();
  const s = await getMonthSummary(monthKey);
  const status = await getBudgetStatus(monthKey);

  const lines = [`${monthKey} 本週財務快報`, `本月支出：${fmt(s.expense)}　本月收入：${fmt(s.income)}`];

  if (status.length) {
    lines.push('', '各項目預算：', ...budgetStatusLines(status));
  } else {
    lines.push('', '這個月還沒有任何預算額度（尚未收到薪水或還沒設定固定預算）。');
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
    `必要支出（餐飲/交通/機車費/稅金/醫療保健/保險/孝親費）：建議 ${fmt(
      sug.recommended.needs
    )}，實際 ${fmt(sug.actual.needs)}${
      sug.diff.needs > 0 ? `（超支 ${fmt(sug.diff.needs)}）` : ''
    }`,
    `想要支出（服飾/運動/交際費/捐款等）：建議 ${fmt(sug.recommended.wants)}，實際 ${fmt(sug.actual.wants)}${
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

async function buildAllocationText() {
  const rules = await getAllocationRules();
  if (!rules.length) {
    return '目前沒有設定分配計畫。輸入「設定分配 交通 8%」來新增一條，之後薪水／獎金入帳時會自動照比例分配到當月預算。';
  }
  const lines = ['目前的分配計畫（收入入帳時自動套用）：'];
  for (const r of rules) {
    lines.push(`　${r.category}：${r.percent}%`);
  }
  return lines.join('\n');
}

async function buildRecurringBudgetText() {
  const rules = await getRecurringBudgets();
  if (!rules.length) {
    return '目前沒有設定固定預算。輸入「設定固定預算 保險 2537 2026-03 2027-02」來新增一條。';
  }
  const lines = ['目前的固定預算排程：'];
  for (const r of rules) {
    lines.push(`　${r.category}：${fmt(r.amount)}/月，${r.start_month} 起${
      r.end_month ? `到 ${r.end_month} 止` : '（無結束日期）'
    }`);
  }
  return lines.join('\n');
}

// only these income categories trigger automatic budget top-ups; investment
// income, refunds, etc. are just recorded without touching allocation plans
const ALLOCATION_TRIGGER_CATEGORIES = ['薪資', '獎金', '年終'];

const HELP_TEXT = [
  '你可以這樣跟我說：',
  '記帳：「午餐 150」「薪水 45000」「昨天 加油 800」',
  '設定預算：「設定預算 餐飲 5000」（只套用在這個月）',
  '設定分配計畫：「設定分配 交通 8%」，之後收入入帳會自動照比例加進當月預算',
  '取消分配：「取消分配 交通」',
  '設定固定預算：「設定固定預算 保險 2537 2026-03 2027-02」（不用等收入，每月自動套用）',
  '設定目標：「設定目標 出國基金 50000 2026-12-31」',
  '存錢到目標：「存 3000 到 出國基金」',
  '查詢：「這個月報告」「預算建議」「目標進度」「分配計畫」「固定預算」',
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
      } else if (ALLOCATION_TRIGGER_CATEGORIES.includes(intent.category)) {
        const applied = await applyIncomeAllocation(intent.amount, monthKeyOf(intent.date));
        if (applied.length) {
          reply += '\n已依分配計畫加進當月預算：';
          for (const a of applied) {
            reply += `\n　${a.category} +${fmt(a.share)}（${a.percent}%）`;
          }
        }
      }
      return { reply, refresh: true };
    }

    case 'set_budget':
      await setBudget(intent.category, intent.limit, monthKey);
      return {
        reply: `已設定「${intent.category}」本月預算為 ${fmt(intent.limit)}`,
        refresh: true,
      };

    case 'set_allocation':
      await setAllocationRule(intent.category, intent.percent);
      return {
        reply: `已設定分配計畫：「${intent.category}」佔收入的 ${intent.percent}%，之後薪水／獎金入帳會自動加進當月預算`,
        refresh: true,
      };

    case 'remove_allocation':
      await removeAllocationRule(intent.category);
      return { reply: `已取消「${intent.category}」的分配計畫`, refresh: true };

    case 'query_allocation':
      return { reply: await buildAllocationText(), refresh: false };

    case 'set_recurring_budget':
      await setRecurringBudget(intent.category, intent.amount, intent.startMonth, intent.endMonth);
      return {
        reply: `已設定「${intent.category}」固定預算 ${fmt(intent.amount)}/月，從 ${
          intent.startMonth
        } 開始${intent.endMonth ? `到 ${intent.endMonth} 結束` : '（無結束日期，持續套用）'}`,
        refresh: true,
      };

    case 'query_recurring_budget':
      return { reply: await buildRecurringBudgetText(), refresh: false };

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
  getAllocationRules,
  getRecurringBudgets,
  setRecurringBudget,
  buildWeeklyBudgetReportText,
  currentMonthKey,
  fmt,
};
