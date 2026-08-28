let categoryChart = null;
let trendChart = null;

const loginScreen = document.getElementById('loginScreen');
const dashboard = document.getElementById('dashboard');
const userBox = document.getElementById('userBox');
const userEmail = document.getElementById('userEmail');
const notConfiguredHint = document.getElementById('notConfiguredHint');
const googleBtnContainer = document.getElementById('googleBtnContainer');
const loginHint = document.getElementById('loginHint');

function fmt(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}NT$${Math.round(Math.abs(n)).toLocaleString()}`;
}

function showLogin() {
  loginScreen.hidden = false;
  dashboard.hidden = true;
  userBox.hidden = true;
}

function showDashboard(user) {
  loginScreen.hidden = true;
  dashboard.hidden = false;
  userBox.hidden = false;
  userEmail.textContent = user.email;
  loadDashboard();
}

async function handleCredentialResponse(response) {
  loginHint.textContent = '登入中…';
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential }),
    });
    const data = await res.json();
    if (!res.ok) {
      loginHint.textContent = data.error || '登入失敗，請再試一次。';
      return;
    }
    showDashboard(data);
  } catch (err) {
    loginHint.textContent = '登入失敗，請確認網路連線後再試一次。';
  }
}
window.handleCredentialResponse = handleCredentialResponse;

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
});

async function init() {
  const config = await fetch('/api/config').then((r) => r.json());

  if (!config.configured) {
    notConfiguredHint.hidden = false;
    loginHint.hidden = true;
  } else if (window.google) {
    google.accounts.id.initialize({
      client_id: config.googleClientId,
      callback: handleCredentialResponse,
    });
    google.accounts.id.renderButton(googleBtnContainer, { theme: 'outline', size: 'large' });
  }

  const me = await fetch('/api/auth/me');
  if (me.ok) {
    const user = await me.json();
    showDashboard(user);
  } else {
    showLogin();
  }
}

async function loadDashboard() {
  const [summaryRes, trendRes, budgetsRes, goalsRes, cardsRes] = await Promise.all([
    fetch('/api/summary'),
    fetch('/api/trend'),
    fetch('/api/budgets'),
    fetch('/api/goals'),
    fetch('/api/cards'),
  ]);

  if (summaryRes.status === 401) {
    showLogin();
    return;
  }

  const summary = await summaryRes.json();
  const trend = await trendRes.json();
  const budgets = await budgetsRes.json();
  const goals = await goalsRes.json();
  const cards = await cardsRes.json();

  document.getElementById('cardIncome').textContent = fmt(summary.income);
  document.getElementById('cardExpense').textContent = fmt(summary.expense);
  document.getElementById('cardNet').textContent = fmt(summary.net);

  renderCategoryChart(summary.byCategory.filter((c) => c.type === 'expense'));
  renderTrendChart(trend);
  renderBudgets(budgets);
  renderGoals(goals);
  renderCardSummary(cards);
}

const BASE_PALETTE = [
  '#4f8cff', '#ff6767', '#ffb648', '#34c77b', '#a97fff', '#3ad4d4', '#ff8ac2',
  '#ffe066', '#6f42c1', '#20c997', '#fd7e14', '#e83e8c', '#17a2b8', '#84cc16',
  '#f06595', '#748ffc',
];

function paletteFor(count) {
  if (count <= BASE_PALETTE.length) return BASE_PALETTE.slice(0, count);
  // beyond the curated set, generate additional distinct hues so colors never repeat
  const colors = [...BASE_PALETTE];
  for (let i = BASE_PALETTE.length; i < count; i++) {
    const hue = (i * 137.508) % 360; // golden-angle spacing keeps neighbors distinct
    colors.push(`hsl(${hue.toFixed(0)}, 65%, 60%)`);
  }
  return colors;
}

function renderCategoryChart(expenseCats) {
  const ctx = document.getElementById('categoryChart');
  const hint = document.getElementById('categoryEmptyHint');
  if (!expenseCats.length) {
    hint.style.display = 'block';
    ctx.style.display = 'none';
    return;
  }
  hint.style.display = 'none';
  ctx.style.display = 'block';

  const labels = expenseCats.map((c) => c.category);
  const values = expenseCats.map((c) => c.total);
  const colors = paletteFor(expenseCats.length);

  if (categoryChart) categoryChart.destroy();
  categoryChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }],
    },
    options: {
      plugins: { legend: { position: 'bottom', labels: { color: '#e8edf2' } } },
    },
  });
}

function renderTrendChart(trend) {
  const ctx = document.getElementById('trendChart');
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: trend.map((t) => t.month),
      datasets: [
        { label: '收入', data: trend.map((t) => t.income), backgroundColor: '#34c77b' },
        { label: '支出', data: trend.map((t) => t.expense), backgroundColor: '#ff6767' },
      ],
    },
    options: {
      plugins: { legend: { labels: { color: '#e8edf2' } } },
      scales: {
        x: { ticks: { color: '#93a2b1' }, grid: { color: '#2a3846' } },
        y: { ticks: { color: '#93a2b1' }, grid: { color: '#2a3846' } },
      },
    },
  });
}

const BUDGET_GROUP_ORDER = ['needs', 'wants', 'savings'];
const BUDGET_GROUP_LABEL = { needs: '🏠 必要支出', wants: '🎨 想要支出', savings: '💰 儲蓄投資' };

function accountCard(b) {
  const pct = b.limit > 0 ? Math.min(100, (b.spent / b.limit) * 100) : 0;
  const over = b.spent > b.limit;
  return `
    <div class="account-card${over ? ' over' : ''}">
      <div class="account-card-name">${b.category}</div>
      <div class="account-card-balance">剩 ${fmt(b.remaining)}</div>
      <div class="bar-track">
        <div class="bar-fill${over ? ' over' : ''}" style="width:${pct}%"></div>
      </div>
      <div class="account-card-detail">花 ${fmt(b.spent)} / 預算 ${fmt(b.limit)}</div>
    </div>`;
}

function renderBudgets(budgets) {
  const container = document.getElementById('budgetList');
  if (!budgets.length) {
    container.innerHTML =
      '<p class="empty-hint">還沒有設定預算，到 Telegram 跟機器人說「設定預算 餐飲 5000」試試看</p>';
    return;
  }

  container.innerHTML = BUDGET_GROUP_ORDER.map((group) => {
    const items = budgets.filter((b) => b.group === group).sort((a, b) => b.limit - a.limit);
    if (!items.length) return '';

    const groupSpent = items.reduce((sum, b) => sum + b.spent, 0);
    const groupLimit = items.reduce((sum, b) => sum + b.limit, 0);
    const groupPct = groupLimit > 0 ? Math.min(100, (groupSpent / groupLimit) * 100) : 0;
    const groupOver = groupSpent > groupLimit;

    return `
      <div class="budget-group">
        <div class="budget-group-header">
          <span class="budget-group-title">${BUDGET_GROUP_LABEL[group]}</span>
          <span class="budget-group-total">花 ${fmt(groupSpent)} / 預算 ${fmt(groupLimit)}</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill${groupOver ? ' over' : ''}" style="width:${groupPct}%"></div>
        </div>
        <div class="account-grid">
          ${items.map(accountCard).join('')}
        </div>
      </div>`;
  }).join('');
}

function renderGoals(goals) {
  const container = document.getElementById('goalList');
  if (!goals.length) {
    container.innerHTML =
      '<p class="empty-hint">還沒有設定目標，到 Telegram 跟機器人說「設定目標 出國基金 50000」試試看</p>';
    return;
  }
  container.innerHTML = goals
    .map((g) => {
      const pct = g.target_amount > 0 ? Math.min(100, (g.current_amount / g.target_amount) * 100) : 0;
      return `
        <div class="bar-row">
          <div class="bar-label">
            <span>${g.name}${g.deadline ? `（期限 ${g.deadline}）` : ''}</span>
            <span>${fmt(g.current_amount)} / ${fmt(g.target_amount)}</span>
          </div>
          <div class="bar-track">
            <div class="bar-fill goal" style="width:${pct}%"></div>
          </div>
        </div>`;
    })
    .join('');
}

function renderCardSummary(cards) {
  const container = document.getElementById('cardList');
  if (!cards.length) {
    container.innerHTML = '<p class="empty-hint">這個月還沒有標記卡別的支出紀錄</p>';
    return;
  }
  container.innerHTML = cards
    .map((c) => {
      const due =
        c.daysUntil == null
          ? ''
          : c.daysUntil === 0
          ? '今天要繳！'
          : `繳款日 ${c.dueDay} 號・還有 ${c.daysUntil} 天`;
      return `
      <div class="card-summary-row">
        <div>
          <span class="card-summary-name">${c.card}</span>
          ${due ? `<div class="card-summary-due${c.daysUntil <= 3 ? ' soon' : ''}">${due}</div>` : ''}
        </div>
        <span class="card-summary-amount">${fmt(c.total)}</span>
      </div>`;
    })
    .join('');
}

init();
