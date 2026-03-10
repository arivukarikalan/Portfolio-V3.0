import type { DebtRow } from './types';

export type DebtSummary = {
  borrowed: number;
  repaid: number;
  outstanding: number;
  byPerson: Array<{ person: string; net: number }>;
};

export function summarizeDebt(rows: DebtRow[]): DebtSummary {
  let borrowed = 0;
  let repaid = 0;
  const personMap: Record<string, number> = {};

  for (const row of rows) {
    const amount = Math.max(0, Number(row.amount) || 0);
    const person = String(row.person || 'Unknown').trim() || 'Unknown';

    if (row.type === 'BORROW') {
      borrowed += amount;
      personMap[person] = (personMap[person] || 0) + amount;
    } else {
      repaid += amount;
      personMap[person] = (personMap[person] || 0) - amount;
    }
  }

  return {
    borrowed,
    repaid,
    outstanding: borrowed - repaid,
    byPerson: Object.entries(personMap)
      .map(([person, net]) => ({ person, net }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
  };
}