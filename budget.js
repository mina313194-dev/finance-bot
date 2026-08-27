// 50/30/20 法則：必要支出 50% / 想要支出 30% / 儲蓄與還債 20%

const NEEDS_CATEGORIES = ['餐飲', '交通', '機車費', '稅金', '醫療保健', '保險', '孝親費', '電信'];
const WANTS_CATEGORIES = ['服飾', '運動', '交際費', '捐款', '美容美髮', '訂閱', '教育', '其他支出'];
// 投資 is money moved into savings/investment, not spending — it's excluded from
// both buckets so it naturally flows into the "savings" figure below instead.
const SAVINGS_CATEGORIES = ['投資'];

function groupOf(category) {
  if (NEEDS_CATEGORIES.includes(category)) return 'needs';
  if (WANTS_CATEGORIES.includes(category)) return 'wants';
  if (SAVINGS_CATEGORIES.includes(category)) return 'savings';
  return 'wants';
}

function buildSuggestion(monthlyIncome, spentByCategory) {
  const recommended = {
    needs: monthlyIncome * 0.5,
    wants: monthlyIncome * 0.3,
    savings: monthlyIncome * 0.2,
  };

  const actual = { needs: 0, wants: 0 };
  for (const row of spentByCategory) {
    const g = groupOf(row.category);
    if (g === 'needs' || g === 'wants') actual[g] += row.total;
  }
  const totalSpent = actual.needs + actual.wants;
  const actualSavings = monthlyIncome - totalSpent;

  return {
    monthlyIncome,
    recommended,
    actual: { ...actual, savings: actualSavings },
    diff: {
      needs: actual.needs - recommended.needs,
      wants: actual.wants - recommended.wants,
      savings: actualSavings - recommended.savings,
    },
  };
}

module.exports = { buildSuggestion, groupOf, NEEDS_CATEGORIES, WANTS_CATEGORIES };
