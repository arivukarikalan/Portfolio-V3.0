import type { ExpenseRow } from './types';

export type ExpenseSummary = {
  total: number;
  thisMonth: number;
  today: number;
  byCategory: Array<{ category: string; amount: number }>;
};

function monthKey(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function summarizeExpenses(rows: ExpenseRow[]): ExpenseSummary {
  const today = todayIso();
  const month = monthKey(today);
  let total = 0;
  let thisMonth = 0;
  let todayTotal = 0;
  const categoryMap: Record<string, number> = {};

  for (const row of rows) {
    const amount = Math.max(0, Number(row.amount) || 0);
    total += amount;
    if (monthKey(row.date) === month) thisMonth += amount;
    if (String(row.date).slice(0, 10) === today) todayTotal += amount;

    const category = String(row.category || 'Other').trim() || 'Other';
    categoryMap[category] = (categoryMap[category] || 0) + amount;
  }

  const byCategory = Object.entries(categoryMap)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  return {
    total,
    thisMonth,
    today: todayTotal,
    byCategory
  };
}