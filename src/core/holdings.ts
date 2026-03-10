import type { HoldingRow, LivePrice, StockMapping, Transaction } from './types';
import { consumeSellWithSameDayPriority } from './fifo';
import { sortTransactionsChronologically } from './txOrder';

type Lot = {
  quantity: number;
  buyPrice: number;
  buyFeesPerUnit: number;
  date: string;
};

function normalizeStock(value: string): string {
  return String(value || '').trim().toUpperCase();
}

function mappingIndex(mappings: StockMapping[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of mappings) {
    if (row.enabled === false) continue;
    const stock = normalizeStock(row.stock);
    const ticker = normalizeStock(row.ticker);
    if (!stock || !ticker) continue;
    out[stock] = ticker;
  }
  return out;
}

export function calculateHoldings(
  transactions: Transaction[],
  mappings: StockMapping[],
  livePrices: Record<string, LivePrice>
): HoldingRow[] {
  const sorted = sortTransactionsChronologically(transactions, 'asc');

  const lotsByStock: Record<string, Lot[]> = {};

  for (const txn of sorted) {
    const stock = normalizeStock(txn.symbol);
    if (!stock) continue;
    lotsByStock[stock] ??= [];

    if (txn.side === 'BUY') {
      const qty = Math.max(0, Number(txn.quantity) || 0);
      const price = Math.max(0, Number(txn.price) || 0);
      const fees = Math.max(0, Number(txn.fees) || 0);
      if (qty <= 0 || price <= 0) continue;

      lotsByStock[stock].push({
        quantity: qty,
        buyPrice: price,
        buyFeesPerUnit: fees / qty,
        date: txn.tradeDate
      });
      continue;
    }

    const sellQty = Math.max(0, Number(txn.quantity) || 0);
    const lots = lotsByStock[stock].map((lot) => ({
      ...lot,
      qty: lot.quantity
    }));
    consumeSellWithSameDayPriority(lots, sellQty, txn.tradeDate);
    lotsByStock[stock] = lots.map((lot) => ({
      quantity: lot.qty,
      buyPrice: lot.buyPrice,
      buyFeesPerUnit: lot.buyFeesPerUnit,
      date: lot.date
    }));
  }

  const stockToTicker = mappingIndex(mappings);
  const rows: HoldingRow[] = [];

  Object.entries(lotsByStock).forEach(([stock, lots]) => {
    const active = lots.filter((lot) => lot.quantity > 0);
    if (!active.length) return;

    const quantity = active.reduce((sum, lot) => sum + lot.quantity, 0);
    const invested = active.reduce(
      (sum, lot) => sum + lot.quantity * (lot.buyPrice + lot.buyFeesPerUnit),
      0
    );
    const avgCost = quantity > 0 ? invested / quantity : 0;
    const ticker = stockToTicker[stock] || stock;
    const live = livePrices[ticker];

    let marketValue: number | undefined;
    let unrealized: number | undefined;
    let unrealizedPct: number | undefined;

    if (live && Number.isFinite(live.price) && live.price > 0) {
      marketValue = quantity * live.price;
      unrealized = marketValue - invested;
      unrealizedPct = invested > 0 ? (unrealized / invested) * 100 : 0;
    }

    rows.push({
      stock,
      ticker,
      quantity,
      invested,
      avgCost,
      ltp: live?.price,
      marketValue,
      unrealized,
      unrealizedPct
    });
  });

  return rows.sort((a, b) => b.invested - a.invested);
}
