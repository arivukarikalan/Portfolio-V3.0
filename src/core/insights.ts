import type { AppSettings, AppState, Transaction } from './types';
import { consumeSellWithSameDayPriority } from './fifo';
import { sortTransactionsChronologically } from './txOrder';

export type InsightQualityBucket = {
  buys: number;
  sells: number;
  chaseBuys: number;
  weakDropBuys: number;
  overAllocBuys: number;
  panicSells: number;
};

export type InsightOverviewCard = {
  title: string;
  value: string;
  tone: 'good' | 'bad' | 'neutral';
};

export type InsightQualityRow = {
  month: string;
  score: number;
};

export type CapitalRow = {
  stock: string;
  invested: number;
  qty: number;
  daysHeld: number;
  referencePrice: number;
  unrealized: number;
  returnPct: number;
  capitalSharePct: number;
};

export type AllocationRow = {
  stock: string;
  invested: number;
  allocationPct: number;
  activeBuyCount: number;
  firstBuyDate: string;
  lastBuyDate: string;
  horizonLabel: string;
  horizonTone: 'good' | 'bad' | 'neutral';
  status: string;
  statusTone: 'good' | 'bad' | 'neutral';
};

export type AvgDownRow = {
  stock: string;
  horizonLabel: string;
  horizonTone: 'good' | 'bad' | 'neutral';
  l1Price: number;
  l2Price: number;
  l1Qty: number;
  l2Qty: number;
  projectedAvgL1?: number;
  projectedAvgL2?: number;
  maxStockBudget: number;
  remainingBudget: number;
  warning?: string;
};

export type AdvancedBuyRow = {
  index: number;
  date: string;
  qty: number;
  price: number;
  diff: number;
  diffPct: number;
  extraPerShare: number;
  extraTotal: number;
  tag: string;
  tagTone: 'good' | 'bad' | 'neutral';
  layerTag: string;
};

export type AdvancedRow = {
  stock: string;
  activeQty: number;
  invested: number;
  allocationRisk: string;
  allocationRiskTone: 'good' | 'bad' | 'neutral';
  l1Done: boolean;
  l2Done: boolean;
  suggestion: string;
  buys: AdvancedBuyRow[];
};

type InsightLot = {
  qty: number;
  price: number;
  brokeragePerUnit: number;
  date: string;
};

type InsightCycleBuy = {
  date: string;
  price: number;
  qty: number;
};

export type StockInsightState = {
  lots: InsightLot[];
  cycleFirstBuyPrice: number | null;
  cycleFirstBuyDate: string | null;
  cycleLastBuyDate: string | null;
  cycleLastBuyPrice: number | null;
  cycleLastTxnDate: string | null;
  cycleLastTxnPrice: number | null;
  cycleBuys: InsightCycleBuy[];
};

export type InsightsData = {
  stateByStock: Record<string, StockInsightState>;
  qualityByMonth: Record<string, InsightQualityBucket>;
  capitalRows: CapitalRow[];
  overviewCards: InsightOverviewCard[];
  qualityRows: InsightQualityRow[];
  allocationRows: AllocationRow[];
  avgDownRows: AvgDownRow[];
  advancedRows: AdvancedRow[];
  summary: {
    activeHoldings: number;
    activeInvested: number;
    unrealized: number;
    avgReturnPct: number;
    sharesPct: number;
    overAllocated: number;
  };
  tradingInsights: Array<{ title: string; detail: string; tone: 'good' | 'bad' | 'neutral' }>;
  topInsights: Array<{ stock: string; title: string; detail: string; tone: 'good' | 'bad' | 'neutral' }>;
  stockOptions: string[];
  transactions: Transaction[];
};

export type StockPerformance = {
  invested: number;
  net: number;
};

export type ExitSimulationResult = {
  stock: string;
  sellQty: number;
  sellPrice: number;
  sellValueGross: number;
  sellFees: number;
  buyValueOfSold: number;
  netProfit: number;
  profitPct: number;
  totalQty: number;
  remainingQty: number;
  invested: number;
  remainingInvested: number;
  oldAvg: number;
  newAvgAfterSell: number;
  avgImprovement: number;
  allocBefore: number;
  allocAfter: number;
  myHistReturnPct: number;
  perf: Record<string, StockPerformance>;
  levels: { l1: number; l2: number };
};

export type ExitSuggestion = {
  upSuggestion: {
    nearestSafeLevel: number;
    confirmationCondition: string;
  };
  downSuggestion: {
    suggestedPrice: number;
    suggestedQty: number;
    newAvg: number;
    avgImprovementOnRebuy: number;
    details: string;
  };
  lvl1: number;
  lvl2: number;
  candidates: Array<{
    stock: string;
    histPct: number;
    activeReturnPct: number | null;
    capitalSharePct: number;
  }>;
};

function toDateValue(iso: string): number {
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : 0;
}

function normalizeStock(value: string): string {
  return String(value || '').trim().toUpperCase();
}

function dayDiff(fromIso: string | null, toIso: string): number {
  if (!fromIso) return 0;
  const a = toDateValue(fromIso);
  const b = toDateValue(toIso);
  if (!a || !b) return 0;
  return Math.max(0, Math.floor((b - a) / 86400000));
}

function monthFromDate(iso: string): string {
  const raw = String(iso || '');
  if (raw.length >= 7) return raw.slice(0, 7);
  return 'Unknown';
}

function getReferencePrice(stock: string, state: AppState, stockState: StockInsightState): number {
  const mapping = state.stockMappings.find(
    (row) => row.enabled !== false && normalizeStock(row.stock) === stock
  );
  const ticker = normalizeStock(mapping?.ticker || stock);
  const live = state.livePrices[ticker];
  if (live && Number.isFinite(live.price) && live.price > 0) {
    return Number(live.price);
  }
  return Number(stockState.cycleLastTxnPrice || stockState.cycleLastBuyPrice || 0);
}

function buildPerformance(transactions: Transaction[]): Record<string, StockPerformance> {
  const sorted = sortTransactionsChronologically(transactions, 'asc');

  const fifo: Record<string, InsightLot[]> = {};
  const perf: Record<string, StockPerformance> = {};

  for (const txn of sorted) {
    const stock = normalizeStock(txn.symbol);
    if (!stock) continue;
    fifo[stock] ??= [];
    perf[stock] ??= { invested: 0, net: 0 };

    if (txn.side === 'BUY') {
      const qty = Number(txn.quantity || 0);
      const fees = Number(txn.fees || 0);
      fifo[stock].push({
        qty,
        price: Number(txn.price || 0),
        brokeragePerUnit: qty > 0 ? fees / qty : 0,
        date: txn.tradeDate
      });
      continue;
    }

    const sellQty = Number(txn.quantity || 0);
    const sellPrice = Number(txn.price || 0);
    const sellFees = Number(txn.fees || 0);
    const consumedParts = consumeSellWithSameDayPriority(fifo[stock], sellQty, txn.tradeDate);
    for (const part of consumedParts.consumed) {
      const used = part.qty;
      const ratio = Number(txn.quantity || 0) > 0 ? used / Number(txn.quantity || 0) : 0;
      const invested = used * (part.lot.price + part.lot.brokeragePerUnit);
      const net = used * sellPrice - invested - sellFees * ratio;
      perf[stock].invested += invested;
      perf[stock].net += net;
    }
  }

  return perf;
}

export function buildInsightsData(appState: AppState): InsightsData {
  const transactions = sortTransactionsChronologically(appState.transactions, 'asc');

  const stateByStock: Record<string, StockInsightState> = {};
  const qualityByMonth: Record<string, InsightQualityBucket> = {};
  const qualityFifo: Record<string, InsightLot[]> = {};
  const portfolioLots: Record<string, InsightLot[]> = {};

  const ensureMonth = (month: string): InsightQualityBucket => {
    qualityByMonth[month] ??= {
      buys: 0,
      sells: 0,
      chaseBuys: 0,
      weakDropBuys: 0,
      overAllocBuys: 0,
      panicSells: 0
    };
    return qualityByMonth[month];
  };

  for (const txn of transactions) {
    const stock = normalizeStock(txn.symbol);
    if (!stock) continue;

    stateByStock[stock] ??= {
      lots: [],
      cycleFirstBuyPrice: null,
      cycleFirstBuyDate: null,
      cycleLastBuyDate: null,
      cycleLastBuyPrice: null,
      cycleLastTxnDate: null,
      cycleLastTxnPrice: null,
      cycleBuys: []
    };

    qualityFifo[stock] ??= [];
    portfolioLots[stock] ??= [];

    const monthBucket = ensureMonth(monthFromDate(txn.tradeDate));
    const stockState = stateByStock[stock];
    stockState.cycleLastTxnDate = txn.tradeDate;
    stockState.cycleLastTxnPrice = Number(txn.price || 0);

    if (txn.side === 'BUY') {
      monthBucket.buys += 1;

      if (stockState.lots.length === 0) {
        stockState.cycleFirstBuyPrice = Number(txn.price || 0);
        stockState.cycleFirstBuyDate = txn.tradeDate;
        stockState.cycleBuys = [];
      }

      const qty = Number(txn.quantity || 0);
      const fees = Number(txn.fees || 0);
      const price = Number(txn.price || 0);
      const lot: InsightLot = {
        qty,
        price,
        brokeragePerUnit: qty > 0 ? fees / qty : 0,
        date: txn.tradeDate
      };

      const prevBuy =
        stockState.cycleBuys.length > 0
          ? stockState.cycleBuys[stockState.cycleBuys.length - 1]
          : null;

      if (prevBuy) {
        const prevPrice = Number(prevBuy.price || 0);
        if (price > prevPrice) {
          monthBucket.chaseBuys += 1;
        } else {
          const dropPct = prevPrice > 0 ? ((prevPrice - price) / prevPrice) * 100 : 0;
          if (dropPct < Number(appState.settings.l1DipPct || 0)) {
            monthBucket.weakDropBuys += 1;
          }
        }
      }

      qualityFifo[stock].push({ ...lot });
      portfolioLots[stock].push({ ...lot });
      stockState.lots.push({ ...lot });
      stockState.cycleLastBuyDate = txn.tradeDate;
      stockState.cycleLastBuyPrice = price;
      stockState.cycleBuys.push({ date: txn.tradeDate, price, qty });

      const totalAfterBuy = Object.values(portfolioLots).reduce((sum, rows) => {
        return sum + rows.reduce((acc, entry) => acc + entry.qty * (entry.price + entry.brokeragePerUnit), 0);
      }, 0);
      const stockAfterBuy = portfolioLots[stock].reduce(
        (sum, entry) => sum + entry.qty * (entry.price + entry.brokeragePerUnit),
        0
      );
      const allocAfterBuyPct = totalAfterBuy > 0 ? (stockAfterBuy / totalAfterBuy) * 100 : 0;
      if (allocAfterBuyPct > Number(appState.settings.allocationLimitPct || 0)) {
        monthBucket.overAllocBuys += 1;
      }

      continue;
    }

    monthBucket.sells += 1;

    const sellForQuality = Number(txn.quantity || 0);
    let buyCost = 0;
    let consumedQty = 0;
    let weightedHoldDays = 0;

    const qualityConsumed = consumeSellWithSameDayPriority(
      qualityFifo[stock],
      sellForQuality,
      txn.tradeDate
    );
    for (const part of qualityConsumed.consumed) {
      buyCost += part.qty * (part.lot.price + part.lot.brokeragePerUnit);
      consumedQty += part.qty;
      weightedHoldDays += part.qty * dayDiff(part.lot.date, txn.tradeDate);
    }

    consumeSellWithSameDayPriority(portfolioLots[stock], Number(txn.quantity || 0), txn.tradeDate);

    const net = Number(txn.quantity || 0) * Number(txn.price || 0) - buyCost - Number(txn.fees || 0);
    const avgHoldDays = consumedQty > 0 ? weightedHoldDays / consumedQty : 0;
    if (net < 0 && avgHoldDays <= 15) {
      monthBucket.panicSells += 1;
    }

    consumeSellWithSameDayPriority(stockState.lots, Number(txn.quantity || 0), txn.tradeDate);
  }

  const capitalBaseRows = Object.entries(stateByStock)
    .filter(([, stockState]) => stockState.lots.length > 0)
    .map(([stock, stockState]) => {
      const qty = stockState.lots.reduce((sum, lot) => sum + lot.qty, 0);
      const invested = stockState.lots.reduce(
        (sum, lot) => sum + lot.qty * (lot.price + lot.brokeragePerUnit),
        0
      );
      const referencePrice = getReferencePrice(stock, appState, stockState);
      const unrealized = qty * referencePrice - invested;
      const returnPct = invested > 0 ? (unrealized / invested) * 100 : 0;
      const daysHeld = dayDiff(stockState.cycleFirstBuyDate, new Date().toISOString());
      return {
        stock,
        invested,
        qty,
        daysHeld,
        referencePrice,
        unrealized,
        returnPct,
        capitalSharePct: 0
      } as CapitalRow;
    });

  const totalActiveInvested = capitalBaseRows.reduce((sum, row) => sum + row.invested, 0);
  const capitalRows = capitalBaseRows
    .map((row) => ({
      ...row,
      capitalSharePct: totalActiveInvested > 0 ? (row.invested / totalActiveInvested) * 100 : 0
    }))
    .sort((a, b) => b.invested - a.invested);

  const invested = capitalRows.reduce((sum, row) => sum + row.invested, 0);
  const unrealized = capitalRows.reduce((sum, row) => sum + row.unrealized, 0);
  const overAlloc = capitalRows.filter(
    (row) => row.capitalSharePct > Number(appState.settings.allocationLimitPct || 0)
  ).length;
  const avgReturn =
    capitalRows.length > 0
      ? capitalRows.reduce((sum, row) => sum + row.returnPct, 0) / capitalRows.length
      : 0;
  const topSharePct = capitalRows
    .slice(0, 5)
    .reduce((sum, row) => sum + Number(row.capitalSharePct || 0), 0);

  const overviewCards: InsightOverviewCard[] = [
    { title: 'Active Holdings', value: String(capitalRows.length), tone: 'neutral' },
    { title: 'Active Invested', value: invested.toFixed(2), tone: 'neutral' },
    { title: 'Unrealized', value: unrealized.toFixed(2), tone: unrealized >= 0 ? 'good' : 'bad' },
    { title: 'Avg Return', value: `${avgReturn.toFixed(2)}%`, tone: avgReturn >= 0 ? 'good' : 'bad' },
    { title: 'Over-Alloc Stocks', value: String(overAlloc), tone: overAlloc > 0 ? 'bad' : 'good' },
    {
      title: 'Max Allocation Rule',
      value: `${Number(appState.settings.allocationLimitPct || 0).toFixed(2)}%`,
      tone: 'neutral'
    }
  ];

  const tradingInsights: Array<{ title: string; detail: string; tone: 'good' | 'bad' | 'neutral' }> = [];
  const topOverAlloc = capitalRows.find(
    (row) => row.capitalSharePct > Number(appState.settings.allocationLimitPct || 0)
  );
  if (topOverAlloc) {
    tradingInsights.push({
      title: 'Over Allocation Detected',
      detail: `${topOverAlloc.stock} • ${topOverAlloc.capitalSharePct.toFixed(1)}%`,
      tone: 'bad'
    });
  }
  if (unrealized < 0) {
    tradingInsights.push({
      title: 'Portfolio Underwater',
      detail: `${unrealized.toFixed(0)} total unrealized`,
      tone: 'bad'
    });
  } else if (unrealized > 0) {
    tradingInsights.push({
      title: 'Unrealized Gains',
      detail: `${unrealized.toFixed(0)} total unrealized`,
      tone: 'good'
    });
  }
  if (avgReturn < 0) {
    tradingInsights.push({
      title: 'Refocus Allocation',
      detail: 'Avg return negative. Review weakest positions.',
      tone: 'neutral'
    });
  }
  if (!tradingInsights.length) {
    tradingInsights.push({
      title: 'Portfolio Stable',
      detail: 'No critical issues detected.',
      tone: 'good'
    });
  }

  const topWinner = capitalRows.find((row) => row.returnPct >= 0);
  const topLoser = [...capitalRows].reverse().find((row) => row.returnPct < 0);
  const topInsights: Array<{ stock: string; title: string; detail: string; tone: 'good' | 'bad' | 'neutral' }> = [];
  if (topWinner) {
    topInsights.push({
      stock: topWinner.stock,
      title: 'Overweight',
      detail: `${topWinner.returnPct.toFixed(1)}% return`,
      tone: 'good'
    });
  }
  if (topLoser) {
    topInsights.push({
      stock: topLoser.stock,
      title: 'Portfolio at Risk',
      detail: `${topLoser.returnPct.toFixed(1)}% return`,
      tone: 'bad'
    });
  }
  if (topOverAlloc && (!topInsights.length || topInsights[0].stock !== topOverAlloc.stock)) {
    topInsights.push({
      stock: topOverAlloc.stock,
      title: 'Over Allocation',
      detail: `${topOverAlloc.capitalSharePct.toFixed(1)}% share`,
      tone: 'neutral'
    });
  }

  const qualityRows = Object.keys(qualityByMonth)
    .sort()
    .map((month) => {
      const q = qualityByMonth[month];
      const bad = q.chaseBuys + q.weakDropBuys + q.overAllocBuys;
      const score = Math.max(0, Math.min(100, 100 - bad * 12 - q.panicSells * 10 + (q.buys > 0 ? 5 : 0)));
      return { month, score };
    });

  const allocationRows: AllocationRow[] = capitalRows.map((row) => {
    const stockState = stateByStock[row.stock];
    const daysHeld = row.daysHeld;
    const horizonLabel = daysHeld > 90 ? 'Long term hold' : daysHeld >= 30 ? 'Short term hold' : 'Just now';
    const horizonTone = daysHeld > 90 ? 'good' : daysHeld >= 30 ? 'neutral' : 'bad';

    let status = 'Balanced';
    let statusTone: 'good' | 'bad' | 'neutral' = 'good';
    if (row.capitalSharePct > Number(appState.settings.allocationLimitPct || 0)) {
      status = 'Over Alloc';
      statusTone = 'bad';
    } else if (row.capitalSharePct > Number(appState.settings.allocationLimitPct || 0) * 0.85) {
      status = 'Moderate';
      statusTone = 'neutral';
    }

    return {
      stock: row.stock,
      invested: row.invested,
      allocationPct: row.capitalSharePct,
      activeBuyCount: stockState.cycleBuys.length,
      firstBuyDate: stockState.cycleFirstBuyDate || '-',
      lastBuyDate: stockState.cycleLastBuyDate || '-',
      horizonLabel,
      horizonTone,
      status,
      statusTone
    };
  });

  const resolvedStockBudget =
    Number(appState.settings.stockBudget || 0) > 0
      ? Number(appState.settings.stockBudget || 0)
      : (Number(appState.settings.monthlyBudget || 0) * Number(appState.settings.allocationLimitPct || 0)) /
        100;

  const avgDownRows: AvgDownRow[] = capitalRows.map((row) => {
    const stockState = stateByStock[row.stock];
    const basePrice =
      Number(stockState.cycleLastBuyPrice || stockState.cycleFirstBuyPrice || row.referencePrice || row.invested / Math.max(1, row.qty));

    const l1Price = basePrice * (1 - Number(appState.settings.l1DipPct || 0) / 100);
    const l2Price = basePrice * (1 - Number(appState.settings.l2DipPct || 0) / 100);
    const remainingBudget = Math.max(0, resolvedStockBudget - row.invested);
    const perLevelBudget = remainingBudget / 2;
    const l1Qty = Math.max(0, Math.floor(perLevelBudget / Math.max(1e-9, l1Price)));
    const l2Qty = Math.max(0, Math.floor(perLevelBudget / Math.max(1e-9, l2Price)));

    const projectedAvgL1 =
      l1Qty > 0 ? (row.invested + l1Qty * l1Price) / (row.qty + l1Qty) : undefined;
    const projectedAvgL2 =
      l2Qty > 0 ? (row.invested + l2Qty * l2Price) / (row.qty + l2Qty) : undefined;

    const warning =
      l1Qty <= 0 && l2Qty <= 0
        ? `At/near max allocation limit (${Number(appState.settings.allocationLimitPct || 0).toFixed(2)}%)`
        : undefined;

    const horizonLabel = row.daysHeld > 90 ? 'Long term hold' : row.daysHeld >= 30 ? 'Short term hold' : 'Just now';
    const horizonTone = row.daysHeld > 90 ? 'good' : row.daysHeld >= 30 ? 'neutral' : 'bad';

    return {
      stock: row.stock,
      horizonLabel,
      horizonTone,
      l1Price,
      l2Price,
      l1Qty,
      l2Qty,
      projectedAvgL1,
      projectedAvgL2,
      maxStockBudget: resolvedStockBudget,
      remainingBudget,
      warning
    };
  });

  const advancedRows: AdvancedRow[] = capitalRows.map((row) => {
    const stockState = stateByStock[row.stock];
    const buys = stockState.cycleBuys;
    const l1Price = (stockState.cycleLastBuyPrice || row.referencePrice) *
      (1 - Number(appState.settings.l1DipPct || 0) / 100);
    const l2Price = (stockState.cycleLastBuyPrice || row.referencePrice) *
      (1 - Number(appState.settings.l2DipPct || 0) / 100);

    const l1Done = buys.some((entry) => Number(entry.price) <= l1Price);
    const l2Done = buys.some((entry) => Number(entry.price) <= l2Price);

    const suggestion = !l1Done
      ? `Wait for L1 zone near ${l1Price.toFixed(2)}. Avoid chasing above last buy price unless conviction is strong.`
      : !l2Done
        ? `L1 is done. Next disciplined buy zone is L2 near ${l2Price.toFixed(2)}.`
        : 'L1 and L2 completed. Pause averaging and focus on risk control/allocation discipline.';

    let allocationRisk = 'Allocation Healthy';
    let allocationRiskTone: 'good' | 'bad' | 'neutral' = 'good';
    if (row.capitalSharePct > Number(appState.settings.allocationLimitPct || 0)) {
      allocationRisk = 'Over Allocation';
      allocationRiskTone = 'bad';
    } else if (row.capitalSharePct > Number(appState.settings.allocationLimitPct || 0) * 0.85) {
      allocationRisk = 'Near Allocation Limit';
      allocationRiskTone = 'neutral';
    }

    const buyRows: AdvancedBuyRow[] = buys.map((buy, index) => {
      const prev = index > 0 ? buys[index - 1] : null;
      const diff = prev ? Number(buy.price) - Number(prev.price) : 0;
      const diffPct = prev && Number(prev.price) > 0 ? (diff / Number(prev.price)) * 100 : 0;
      const expectedPrice = prev
        ? Number(prev.price) * (1 - Number(appState.settings.l1DipPct || 0) / 100)
        : null;
      const extraPerShare = expectedPrice != null ? Number(buy.price) - expectedPrice : 0;
      const extraTotal = extraPerShare > 0 ? extraPerShare * Number(buy.qty || 0) : 0;

      let tag = 'Base buy';
      let tagTone: 'good' | 'bad' | 'neutral' = 'neutral';

      if (prev) {
        const dropPct = Number(prev.price) > 0
          ? ((Number(prev.price) - Number(buy.price)) / Number(prev.price)) * 100
          : 0;

        if (Number(buy.price) <= Number(prev.price)) {
          if (dropPct >= Number(appState.settings.l1DipPct || 0)) {
            tag = 'Good follow-up';
            tagTone = 'good';
          } else {
            tag = 'Bad buy (weak drop)';
            tagTone = 'bad';
          }
        } else if (diffPct <= 2) {
          tag = 'Slight chase';
          tagTone = 'neutral';
        } else {
          tag = 'High chase';
          tagTone = 'bad';
        }
      }

      const layerTag = Number(buy.price) <= l2Price ? 'L2 zone' : Number(buy.price) <= l1Price ? 'L1 zone' : 'Above zones';

      return {
        index,
        date: buy.date,
        qty: Number(buy.qty),
        price: Number(buy.price),
        diff,
        diffPct,
        extraPerShare,
        extraTotal,
        tag,
        tagTone,
        layerTag
      };
    });

    return {
      stock: row.stock,
      activeQty: row.qty,
      invested: row.invested,
      allocationRisk,
      allocationRiskTone,
      l1Done,
      l2Done,
      suggestion,
      buys: buyRows
    };
  });

  return {
    stateByStock,
    qualityByMonth,
    capitalRows,
    overviewCards,
    summary: {
      activeHoldings: capitalRows.length,
      activeInvested: invested,
      unrealized,
      avgReturnPct: avgReturn,
      sharesPct: topSharePct,
      overAllocated: overAlloc
    },
    tradingInsights,
    topInsights,
    qualityRows,
    allocationRows,
    avgDownRows,
    advancedRows,
    stockOptions: capitalRows.map((row) => row.stock),
    transactions
  };
}

export function getHoldDays(insights: InsightsData, stockInput: string): number | null {
  const stock = normalizeStock(stockInput);
  if (!stock) return null;
  const row = insights.stateByStock[stock];
  if (!row) return null;
  const firstBuyDate = row.cycleFirstBuyDate || (row.cycleBuys[0] ? row.cycleBuys[0].date : null);
  if (!firstBuyDate) return null;
  return Math.max(0, dayDiff(firstBuyDate, new Date().toISOString()));
}

export function simulatePartialExit(
  insights: InsightsData,
  stockInput: string,
  sellQty: number,
  sellPrice: number,
  settings: AppSettings
): ExitSimulationResult | { error: string } {
  const stock = normalizeStock(stockInput);
  if (!stock) return { error: 'Select a stock' };

  const row = insights.stateByStock[stock];
  if (!row) return { error: 'Stock not found in active holdings' };

  const lots = row.lots.map((lot) => ({ ...lot }));
  const totalQty = lots.reduce((sum, lot) => sum + lot.qty, 0);
  const invested = lots.reduce((sum, lot) => sum + lot.qty * (lot.price + lot.brokeragePerUnit), 0);

  if (!Number.isFinite(sellQty) || sellQty <= 0 || sellQty > totalQty) {
    return { error: 'Invalid sell quantity' };
  }
  if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
    return { error: 'Invalid sell price' };
  }

  let remainingToSell = sellQty;
  let buyValueOfSold = 0;
  for (let i = lots.length - 1; i >= 0 && remainingToSell > 0; i -= 1) {
    const lot = lots[i];
    const used = Math.min(lot.qty, remainingToSell);
    buyValueOfSold += used * (lot.price + lot.brokeragePerUnit);
    remainingToSell -= used;
  }

  const sellFees = 0;
  const sellValueGross = sellQty * sellPrice;
  const netProfit = sellValueGross - buyValueOfSold - sellFees;
  const profitPct = buyValueOfSold > 0 ? (netProfit / buyValueOfSold) * 100 : 0;
  const remainingQty = totalQty - sellQty;
  const remainingInvested = invested - buyValueOfSold;
  const oldAvg = totalQty > 0 ? invested / totalQty : 0;
  const newAvgAfterSell = remainingQty > 0 ? remainingInvested / remainingQty : 0;
  const avgImprovement = oldAvg - newAvgAfterSell;

  const totalPortfolioInvested = insights.capitalRows.reduce((sum, item) => sum + item.invested, 0);
  const allocBefore = totalPortfolioInvested > 0 ? (invested / totalPortfolioInvested) * 100 : 0;
  const allocAfterBase = Math.max(1, totalPortfolioInvested - buyValueOfSold);
  const allocAfter = remainingInvested > 0 ? (remainingInvested / allocAfterBase) * 100 : 0;

  const perf = buildPerformance(insights.transactions);
  const myPerf = perf[stock] || { invested: 0, net: 0 };
  const myHistReturnPct = myPerf.invested > 0 ? (myPerf.net / myPerf.invested) * 100 : 0;

  const base = Number(row.cycleLastBuyPrice || row.cycleFirstBuyPrice || oldAvg || 0);
  const l1 = base * (1 - Number(settings.l1DipPct || 0) / 100);
  const l2 = base * (1 - Number(settings.l2DipPct || 0) / 100);

  return {
    stock,
    sellQty,
    sellPrice,
    sellValueGross,
    sellFees,
    buyValueOfSold,
    netProfit,
    profitPct,
    totalQty,
    remainingQty,
    invested,
    remainingInvested,
    oldAvg,
    newAvgAfterSell,
    avgImprovement,
    allocBefore,
    allocAfter,
    myHistReturnPct,
    perf,
    levels: { l1, l2 }
  };
}

export function suggestReentry(
  simulation: ExitSimulationResult,
  insights: InsightsData
): ExitSuggestion {
  const lvl1 = Number(simulation.levels.l1.toFixed(2));
  const lvl2 = Number(simulation.levels.l2.toFixed(2));
  const discountPct = 5;
  const discountedPrice = Number((simulation.sellPrice * (1 - discountPct / 100)).toFixed(2));
  const suggestedPrice = Math.max(lvl2, Math.min(lvl1, discountedPrice));
  const suggestedQty = simulation.sellQty;
  const newTotalQty = simulation.remainingQty + suggestedQty;
  const newTotalInvested = simulation.remainingInvested + suggestedQty * suggestedPrice;
  const newAvg = newTotalQty > 0 ? newTotalInvested / newTotalQty : 0;
  const avgImprovementOnRebuy = simulation.oldAvg - newAvg;

  const currentStocks = new Set(insights.capitalRows.map((row) => row.stock));
  const tradedStocks = Object.keys(simulation.perf);
  const universe = Array.from(new Set([...currentStocks, ...tradedStocks])).filter(
    (stock) => stock && stock !== simulation.stock
  );

  const candidates = universe
    .map((stock) => {
      const p = simulation.perf[stock] || { invested: 0, net: 0 };
      const histPct = p.invested > 0 ? (p.net / p.invested) * 100 : 0;
      const active = insights.capitalRows.find((row) => row.stock === stock);
      return {
        stock,
        histPct,
        activeReturnPct: active ? Number(active.returnPct || 0) : null,
        capitalSharePct: active ? Number(active.capitalSharePct || 0) : 0
      };
    })
    .sort((a, b) => (b.histPct - a.histPct) || ((b.activeReturnPct || -999) - (a.activeReturnPct || -999)))
    .slice(0, 5);

  return {
    upSuggestion: {
      nearestSafeLevel: lvl1,
      confirmationCondition: `Look for pullback into L1 (${lvl1.toFixed(2)}) or L2 (${lvl2.toFixed(2)}). Avoid chasing above L1.`
    },
    downSuggestion: {
      suggestedPrice: Number(suggestedPrice.toFixed(2)),
      suggestedQty,
      newAvg: Number(newAvg.toFixed(2)),
      avgImprovementOnRebuy: Number(avgImprovementOnRebuy.toFixed(2)),
      details: `Based on L1: ${lvl1.toFixed(2)}, L2: ${lvl2.toFixed(2)} and ${discountPct}% discount heuristic.`
    },
    lvl1,
    lvl2,
    candidates
  };
}
