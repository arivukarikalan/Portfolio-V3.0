import type { Transaction } from './types';
import { consumeSellWithSameDayPriority } from './fifo';
import { sortTransactionsChronologically } from './txOrder';

export type RealizedPnlRow = {
  stock: string;
  date: string;
  quantity: number;
  buyCost: number;
  buyFees: number;
  sellValue: number;
  sellFees: number;
  net: number;
  holdDays: number;
  returnPct: number;
};

type Lot = {
  qty: number;
  price: number;
  feesPerUnit: number;
  date: string;
};

function dateDiffDays(fromIso: string, toIso: string): number {
  const a = new Date(fromIso);
  const b = new Date(toIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86400000));
}

export function calculateRealizedPnlRows(transactions: Transaction[]): RealizedPnlRow[] {
  const sorted = sortTransactionsChronologically(transactions, 'asc');

  const fifo: Record<string, Lot[]> = {};
  const rows: RealizedPnlRow[] = [];

  for (const txn of sorted) {
    const stock = String(txn.symbol || '').trim().toUpperCase();
    if (!stock) continue;
    fifo[stock] ??= [];

    if (txn.side === 'BUY') {
      const qty = Math.max(0, Number(txn.quantity) || 0);
      const price = Math.max(0, Number(txn.price) || 0);
      const fees = Math.max(0, Number(txn.fees) || 0);
      if (qty <= 0 || price <= 0) continue;
      fifo[stock].push({
        qty,
        price,
        feesPerUnit: fees / qty,
        date: txn.tradeDate
      });
      continue;
    }

    const sellQty = Math.max(0, Number(txn.quantity) || 0);
    const sellPrice = Math.max(0, Number(txn.price) || 0);
    const sellFees = Math.max(0, Number(txn.fees) || 0);
    if (sellQty <= 0 || sellPrice <= 0) continue;

    let buyCost = 0;
    let buyFees = 0;
    let weightedDays = 0;
    let consumed = 0;

    const consumedParts = consumeSellWithSameDayPriority(fifo[stock], sellQty, txn.tradeDate);
    for (const part of consumedParts.consumed) {
      const used = part.qty;
      const lot = part.lot;
      buyCost += used * lot.price;
      buyFees += used * lot.feesPerUnit;
      weightedDays += used * dateDiffDays(lot.date, txn.tradeDate);
      consumed += used;
    }

    if (consumed <= 0) continue;

    const proportionalSellFees = sellFees * (consumed / sellQty);
    const sellValue = consumed * sellPrice;
    const invested = buyCost + buyFees;
    const net = sellValue - invested - proportionalSellFees;

    rows.push({
      stock,
      date: txn.tradeDate,
      quantity: consumed,
      buyCost,
      buyFees,
      sellValue,
      sellFees: proportionalSellFees,
      net,
      holdDays: weightedDays / consumed,
      returnPct: invested > 0 ? (net / invested) * 100 : 0
    });
  }

  return rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}
