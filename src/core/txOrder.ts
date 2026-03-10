import type { Transaction } from './types';

function parseMillis(value: string): number {
  const ts = Date.parse(String(value || '').trim());
  return Number.isFinite(ts) ? ts : 0;
}

function toDayMillis(isoDate: string): number {
  const clean = String(isoDate || '').trim();
  const ts = Date.parse(clean.length === 10 ? `${clean}T00:00:00` : clean);
  return Number.isFinite(ts) ? ts : 0;
}

function txnTime(txn: Transaction): number {
  const dt = parseMillis(String(txn.tradeDateTime || ''));
  if (dt > 0) return dt;
  return toDayMillis(txn.tradeDate);
}

export function sortTransactionsChronologically(
  transactions: Transaction[],
  direction: 'asc' | 'desc' = 'asc'
): Transaction[] {
  const factor = direction === 'asc' ? 1 : -1;
  return transactions.slice().sort((a, b) => {
    const t = txnTime(a) - txnTime(b);
    if (t !== 0) return t * factor;

    const i = parseMillis(a.importedAt) - parseMillis(b.importedAt);
    if (i !== 0) return i * factor;

    return String(a.id || '').localeCompare(String(b.id || '')) * factor;
  });
}

