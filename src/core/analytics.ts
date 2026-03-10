import type { DashboardSnapshot, Transaction } from './types';
import type { AppState } from './types';
import { calculateHoldings } from './holdings';
import { calculateRealizedPnlRows } from './pnl';

export function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2
  }).format(value);
}

export function dashboardFromTransactions(transactions: Transaction[]): DashboardSnapshot {
  let invested = 0;
  let realized = 0;
  let fees = 0;
  let wins = 0;

  for (const txn of transactions) {
    const gross = txn.quantity * txn.price;
    fees += txn.fees;
    if (txn.side === 'BUY') {
      invested += gross + txn.fees;
    } else {
      realized += gross - txn.fees;
      if (gross > 0) wins += 1;
    }
  }

  const sells = transactions.filter((item) => item.side === 'SELL').length;
  return {
    invested,
    realized,
    fees,
    tradeCount: transactions.length,
    winRate: sells === 0 ? 0 : (wins / sells) * 100
  };
}

export function dashboardFromState(state: AppState): DashboardSnapshot {
  const holdings = calculateHoldings(state.transactions, state.stockMappings, state.livePrices);
  const pnlRows = calculateRealizedPnlRows(state.transactions);
  const invested = holdings.reduce((sum, row) => sum + Number(row.invested || 0), 0);
  const realized = pnlRows.reduce((sum, row) => sum + Number(row.net || 0), 0);
  const fees = state.transactions.reduce((sum, txn) => sum + Number(txn.fees || 0), 0);
  const wins = pnlRows.filter((row) => Number(row.net || 0) >= 0).length;

  return {
    invested,
    realized,
    fees,
    tradeCount: state.transactions.length,
    winRate: pnlRows.length ? (wins / pnlRows.length) * 100 : 0
  };
}
