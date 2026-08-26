// 50/30/20 法則：必要支出 50% / 想要支出 30% / 儲蓄與還債 20%

const NEEDS_CATEGORIES = ['住房', '餐飲', '交通', '醫療', '教育'];
const WANTS_CATEGORIES = ['娛樂', '購物', '其他支出'];

function groupOf(category) {
  if (NEEDS_CATEGORIES.includes(category)) return 'needs';
  if (WANTS_CATEGORIES.includes(category)) return 'wants';
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
    actual[g] += row.total;
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
