import type { LivePrice, StockMapping } from './types';
import { APPS_SCRIPT_URL } from './constants';

function normalizeTicker(value: string): string {
  return String(value || '').trim().toUpperCase();
}

function toYahooSymbol(ticker: string): string {
  const normalized = normalizeTicker(ticker);
  if (!normalized) return '';
  if (normalized.includes(':')) {
    const [exchange, symbol] = normalized.split(':', 2);
    if (exchange === 'NSE') return `${symbol}.NS`;
    return symbol;
  }
  if (normalized.includes('.')) return normalized;
  return `${normalized}.NS`;
}

function fromYahooSymbol(symbol: string): string {
  const text = String(symbol || '').trim().toUpperCase();
  if (!text) return '';
  if (text.endsWith('.NS')) return text.slice(0, -3);
  return text;
}

export type LiveSyncResult = {
  prices: Record<string, LivePrice>;
  success: number;
  failedTickers: string[];
  failureReasons?: Record<string, string>;
};

export type PriceHistoryPoint = {
  date: string;
  close: number;
};

export async function syncLivePrices(mappings: StockMapping[]): Promise<LiveSyncResult> {
  const enabled = mappings.filter((m) => m.enabled !== false);
  const tickers = Array.from(new Set(enabled.map((m) => normalizeTicker(m.ticker)).filter(Boolean)));
  if (!tickers.length) return { prices: {}, success: 0, failedTickers: [], failureReasons: {} };

  const yahooToTicker: Record<string, string> = {};
  for (const ticker of tickers) {
    const yahoo = toYahooSymbol(ticker);
    if (!yahoo) continue;
    yahooToTicker[yahoo] = ticker;
  }

  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      mode: 'live_prices',
      tickers: Object.keys(yahooToTicker).map((yahoo) => yahooToTicker[yahoo])
    })
  });
  if (!response.ok) {
    throw new Error(`Live sync failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    ok?: boolean;
    message?: string;
    data?: LiveSyncResult;
  };

  if (!payload.ok) {
    throw new Error(payload.message || 'Live sync failed');
  }

  const data = payload.data || { prices: {}, success: 0, failedTickers: [], failureReasons: {} };
  return {
    prices: data.prices || {},
    success: Number(data.success || 0),
    failedTickers: Array.isArray(data.failedTickers) ? data.failedTickers : [],
    failureReasons: data.failureReasons || {}
  };
}

export async function fetchPriceHistory(
  ticker: string,
  days = 7,
  from?: string,
  to?: string
): Promise<{ ticker: string; points: PriceHistoryPoint[]; latest: number }> {
  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      mode: 'price_history',
      ticker: normalizeTicker(ticker),
      days,
      from,
      to
    })
  });
  if (!response.ok) {
    throw new Error(`History fetch failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    ok?: boolean;
    message?: string;
    data?: { ticker?: string; points?: PriceHistoryPoint[]; latest?: number };
  };
  if (!payload.ok) {
    throw new Error(payload.message || 'Price history fetch failed');
  }
  const data = payload.data || {};
  return {
    ticker: String(data.ticker || normalizeTicker(ticker)),
    points: Array.isArray(data.points) ? data.points : [],
    latest: Number(data.latest || 0)
  };
}

export { fromYahooSymbol };
