import { APP_NAME } from '../core/constants';
import { dashboardFromState, formatCurrency } from '../core/analytics';
import {
  getSession,
  listPendingRequests,
  loginWithSheet,
  logout,
  listAdminUsers,
  updateAdminUser,
  getAdminConfig,
  setAdminConfig,
  requestUserAccess,
  reviewPendingRequest,
  type PendingRequest,
  type AdminUserRow
} from '../core/auth';
import { summarizeDebt } from '../core/debt';
import { summarizeExpenses } from '../core/expenses';
import { consumeSellWithSameDayPriority } from '../core/fifo';
import { calculateHoldings } from '../core/holdings';
import {
  buildInsightsData,
  getHoldDays,
  simulatePartialExit,
  suggestReentry,
  type ExitSimulationResult,
  type ExitSuggestion
} from '../core/insights';
import { importBrokerageFile } from '../core/importer';
import { fetchPriceHistory, syncLivePrices } from '../core/livePrices';
import { calculateRealizedPnlRows, type RealizedPnlRow } from '../core/pnl';
import { sortTransactionsChronologically } from '../core/txOrder';
import {
  approveTickerRequestRemote,
  fetchTickerRegistry,
  fetchTickerRequests,
  fetchNseMaster,
  replaceNseMaster,
  submitTickerRequests,
  rejectTickerRequestRemote
} from '../core/tickers';
import {
  appendTransactions,
  clearTransactions,
  deleteTransaction,
  deleteCreditItem,
  deleteDebtItem,
  deleteExpense,
  readState,
  upsertCreditItem,
  upsertDebtItem,
  upsertExpense,
  upsertTransaction,
  writeState
} from '../core/storage';
import { pullFromCloud, pushToCloud, trimSnapshots } from '../core/sync';
import type {
  AppState,
  HoldingRow,
  NseMasterItem,
  StockMapping,
  TickerRegistryItem,
  UserRole,
  UserSession
} from '../core/types';

export type AppView =
  | 'dashboard'
  | 'transactions'
  | 'holdings'
  | 'pnl'
  | 'expenses'
  | 'debt'
  | 'insights'
  | 'cloud'
  | 'settings'
  | 'admin'
  | 'target';
const VIEW_KEY = 'fds_active_view';
const DASH_TREND_RANGE_KEY = 'fds_dash_trend_range';
const PNL_FILTER_KEY = 'fds_pnl_filters';
const PNL_VIEW_KEY = 'fds_pnl_view';
const INSIGHTS_SEARCH_KEY = 'fds_insights_search';
const EXPENSE_CATEGORY_KEY = 'fds_expense_categories';
const DEBT_CATEGORY_KEY = 'fds_debt_categories';
const CREDIT_CATEGORY_KEY = 'fds_credit_categories';
const ACTIVITY_LOG_KEY = 'fds_activity_log';
const CLOUD_AUTOSYNC_KEY = 'fds_cloud_autosync';
const CLOUD_AUTOSYNC_INTERVAL_KEY = 'fds_cloud_autosync_interval';
const UI_PREFS_KEY = 'fds_ui_prefs';
const LIVE_SYNC_ATTEMPT_KEY = 'fds_live_sync_attempt';
const TARGET_FILTER_KEY = 'fds_target_filter';
const TARGET_SORT_KEY = 'fds_target_sort';
const GLOBAL_SEARCH_HELP =
  'Commands: dashboard, tx <symbol>, holding <symbol>, pnl, expenses, debt, insights, cloud, settings, admin, target, sync';
type TrendRange = '7D' | '14D' | '1M';
type TargetFilter = 'ALL' | 'APPROACHING' | 'MET';
type TargetSort = 'PROGRESS' | 'PROFIT';
type PnlFilterMode = 'ALL' | 'WINNERS' | 'LOSERS';
type PnlView = 'REALIZED' | 'UNREALIZED';
type PnlFilterState = {
  from: string;
  to: string;
  mode: PnlFilterMode;
  search: string;
};

const DASH_COLORS = ['#3f7bff', '#42b883', '#f3a347', '#2d9cdb', '#b07cc6', '#c8d2e3'];

function esc(value: string): string {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toCompactSigned(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${formatCompactNumber(Math.abs(value))}`;
}

function formatCompactNumber(value: number): string {
  const n = Number(value || 0);
  if (n >= 10000000) return `${(n / 10000000).toFixed(2)}Cr`;
  if (n >= 100000) return `${(n / 100000).toFixed(2)}L`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(0);
}

function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toIsoDateTimeLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

function parseDateTimeLocal(value: string): Date | null {
  const raw = String(value || '').trim();
  if (!raw.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)) return null;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function isValidIsoDate(value: string): boolean {
  const raw = String(value || '').trim();
  if (!raw.match(/^\d{4}-\d{2}-\d{2}$/)) return false;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return false;
  return toIsoDate(dt) === raw;
}

function startOfMonthIso(date: Date): string {
  const dt = new Date(date.getFullYear(), date.getMonth(), 1);
  return toIsoDate(dt);
}

function buildPnlRangeLabel(filters: PnlFilterState, allRows: RealizedPnlRow[]): string {
  if (!isValidIsoDate(filters.from) || !isValidIsoDate(filters.to)) return 'All time';
  const from = new Date(filters.from);
  const to = new Date(filters.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 'All time';
  const diffDays = Math.round((to.getTime() - from.getTime()) / 86400000);
  const today = new Date();
  const isThisMonth = filters.from === startOfMonthIso(today) && filters.to === toIsoDate(today);
  if (isThisMonth) return 'This month';
  if (diffDays >= 27 && diffDays <= 31) return 'Last 30 days';
  const defaults = getPnlFilterDefaults(allRows);
  if (filters.from === defaults.from && filters.to === defaults.to) return 'All time';
  return `${formatDateCompact(filters.from)} - ${formatDateCompact(filters.to)}`;
}

function getPnlFilterDefaults(rows: RealizedPnlRow[]): PnlFilterState {
  const today = toIsoDate(new Date());
  if (!rows.length) {
    return { from: today, to: today, mode: 'ALL', search: '' };
  }
  const dates = rows
    .map((row) => String(row.date || '').trim())
    .filter((d) => isValidIsoDate(d))
    .sort();
  const from = dates[0] || today;
  const to = dates[dates.length - 1] || today;
  return { from, to, mode: 'ALL', search: '' };
}

function loadPnlFilters(rows: RealizedPnlRow[]): PnlFilterState {
  const defaults = getPnlFilterDefaults(rows);
  const raw = String(localStorage.getItem(PNL_FILTER_KEY) || '').trim();
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<PnlFilterState>;
    const from = parsed.from && isValidIsoDate(parsed.from) ? parsed.from : defaults.from;
    const to = parsed.to && isValidIsoDate(parsed.to) ? parsed.to : defaults.to;
    const modeRaw = String(parsed.mode || '').toUpperCase();
    const mode: PnlFilterMode =
      modeRaw === 'WINNERS' ? 'WINNERS' : modeRaw === 'LOSERS' ? 'LOSERS' : 'ALL';
    const search = String(parsed.search || '').trim();
    return { from, to, mode, search };
  } catch {
    return defaults;
  }
}

function savePnlFilters(filters: PnlFilterState): void {
  localStorage.setItem(PNL_FILTER_KEY, JSON.stringify(filters));
}

function clearPnlFilters(): void {
  localStorage.removeItem(PNL_FILTER_KEY);
}

function getPnlView(): PnlView {
  const raw = String(localStorage.getItem(PNL_VIEW_KEY) || '').trim().toUpperCase();
  return raw === 'UNREALIZED' ? 'UNREALIZED' : 'REALIZED';
}

function setPnlView(view: PnlView): void {
  localStorage.setItem(PNL_VIEW_KEY, view);
}

function getInsightsSearch(): string {
  return String(localStorage.getItem(INSIGHTS_SEARCH_KEY) || '').trim().toUpperCase();
}

function setInsightsSearch(value: string): void {
  localStorage.setItem(INSIGHTS_SEARCH_KEY, String(value || '').trim().toUpperCase());
}

type ActivityLogEntry = {
  ts: string;
  type: string;
  detail: string;
};

function getActivityLogs(): ActivityLogEntry[] {
  const raw = String(localStorage.getItem(ACTIVITY_LOG_KEY) || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ActivityLogEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addActivityLog(type: string, detail: string): void {
  const next: ActivityLogEntry[] = [
    { ts: new Date().toISOString(), type, detail },
    ...getActivityLogs()
  ].slice(0, 300);
  localStorage.setItem(ACTIVITY_LOG_KEY, JSON.stringify(next));
}

function getCloudAutoSyncEnabled(): boolean {
  return String(localStorage.getItem(CLOUD_AUTOSYNC_KEY) || 'true') !== 'false';
}

function setCloudAutoSyncEnabled(value: boolean): void {
  localStorage.setItem(CLOUD_AUTOSYNC_KEY, value ? 'true' : 'false');
}

function getCloudAutoSyncInterval(): number {
  const raw = Number(localStorage.getItem(CLOUD_AUTOSYNC_INTERVAL_KEY) || 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}

function setCloudAutoSyncInterval(value: number): void {
  const v = Number.isFinite(value) && value > 0 ? Math.floor(value) : 10;
  localStorage.setItem(CLOUD_AUTOSYNC_INTERVAL_KEY, String(v));
}

function getDefaultExpenseCategories(): string[] {
  return ['Food', 'Snack', 'Travel', 'Shopping', 'Bills', 'Other'];
}

function getDefaultDebtCategories(): string[] {
  return ['Borrow', 'Repay', 'Lent', 'EMI'];
}

function getDefaultCreditCategories(): string[] {
  return ['Salary', 'Interest', 'Bonus', 'Cashback', 'Refund'];
}

function getCategoriesFor(type: 'expense' | 'debt' | 'credit'): string[] {
  const key =
    type === 'expense'
      ? EXPENSE_CATEGORY_KEY
      : type === 'debt'
        ? DEBT_CATEGORY_KEY
        : CREDIT_CATEGORY_KEY;
  const fallback =
    type === 'expense'
      ? getDefaultExpenseCategories()
      : type === 'debt'
        ? getDefaultDebtCategories()
        : getDefaultCreditCategories();
  const raw = String(localStorage.getItem(key) || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as string[];
    const cleaned = Array.isArray(parsed)
      ? parsed.map((c) => String(c || '').trim()).filter((c) => c)
      : [];
    return cleaned.length ? Array.from(new Set(cleaned)) : fallback;
  } catch {
    return fallback;
  }
}

function saveCategoriesFor(type: 'expense' | 'debt' | 'credit', categories: string[]): void {
  const key =
    type === 'expense'
      ? EXPENSE_CATEGORY_KEY
      : type === 'debt'
        ? DEBT_CATEGORY_KEY
        : CREDIT_CATEGORY_KEY;
  const cleaned = categories.map((c) => String(c || '').trim()).filter((c) => c);
  localStorage.setItem(key, JSON.stringify(Array.from(new Set(cleaned))));
}

function getExpenseCategories(): string[] {
  return getCategoriesFor('expense');
}

function getDebtCategories(): string[] {
  return getCategoriesFor('debt');
}

function getCreditCategories(): string[] {
  return getCategoriesFor('credit');
}

function applyPnlFilters(rows: RealizedPnlRow[], filters: PnlFilterState): RealizedPnlRow[] {
  const fromTs = isValidIsoDate(filters.from) ? new Date(filters.from).getTime() : Number.NEGATIVE_INFINITY;
  const toTs = isValidIsoDate(filters.to) ? new Date(filters.to).getTime() : Number.POSITIVE_INFINITY;
  const query = String(filters.search || '').trim().toUpperCase();

  return rows.filter((row) => {
    const rowTs = new Date(row.date).getTime();
    if (Number.isFinite(fromTs) && Number.isFinite(rowTs) && rowTs < fromTs) return false;
    if (Number.isFinite(toTs) && Number.isFinite(rowTs) && rowTs > toTs) return false;
    if (filters.mode === 'WINNERS' && row.net < 0) return false;
    if (filters.mode === 'LOSERS' && row.net >= 0) return false;
    if (query && !String(row.stock || '').toUpperCase().includes(query)) return false;
    return true;
  });
}

function resolveTicker(state: AppState, stock: string): string {
  const symbol = String(stock || '').trim().toUpperCase();
  if (!symbol) return '';
  const mapping = getExpandedMappings(state).find(
    (row) => row.enabled && String(row.stock || '').trim().toUpperCase() === symbol
  );
  return String(mapping?.ticker || symbol).trim().toUpperCase();
}

function getExpandedMappings(state: AppState): StockMapping[] {
  const registry = Array.isArray(state.tickerRegistry) ? state.tickerRegistry : [];
  if (!registry.length) return state.stockMappings;
  const expanded: StockMapping[] = [];
  registry.forEach((item) => {
    const ticker = String(item.ticker || '').trim().toUpperCase();
    if (!ticker) return;
    const synonyms = Array.isArray(item.synonyms) ? item.synonyms : [];
    const aliases = Array.from(
      new Set([ticker, ...synonyms.map((syn) => String(syn || '').trim().toUpperCase())].filter(Boolean))
    );
    aliases.forEach((alias) => {
      expanded.push({
        stock: alias,
        ticker,
        enabled: true,
        updatedAt: item.updatedAt || new Date().toISOString()
      });
    });
  });
  return expanded;
}

function getCanonicalMappings(state: AppState): StockMapping[] {
  const registry = Array.isArray(state.tickerRegistry) ? state.tickerRegistry : [];
  if (registry.length) {
    return registry
      .map((item) => ({
        stock: String(item.ticker || '').trim().toUpperCase(),
        ticker: String(item.ticker || '').trim().toUpperCase(),
        enabled: true,
        updatedAt: item.updatedAt || new Date().toISOString()
      }))
      .filter((row) => row.stock);
  }
  const unique = new Map<string, StockMapping>();
  state.stockMappings.forEach((row) => {
    const ticker = String(row.ticker || '').trim().toUpperCase();
    if (!ticker) return;
    if (!unique.has(ticker)) {
      unique.set(ticker, { stock: ticker, ticker, enabled: row.enabled, updatedAt: row.updatedAt });
    }
  });
  return Array.from(unique.values());
}

function stripOrderIdFromNote(text: string): string {
  const raw = String(text || '').trim();
  if (!raw) return '';
  return raw
    .replace(/\border\s*[:#-]?\s*[a-z0-9-]{6,}\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeSearchQuery(raw: string): string {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map((item) => String(item || '').trim());
}

function isValidTickerFormat(value: string): boolean {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return false;
  if (/\s/.test(text)) return false;
  return /^[A-Z0-9.:_-]+$/.test(text);
}

const COMPANY_STOPWORDS = new Set([
  'LIMITED',
  'LTD',
  'LTD.',
  'CORPORATION',
  'CORP',
  'COMPANY',
  'CO',
  'CO.',
  'PVT',
  'PRIVATE',
  'PLC',
  'INC',
  'INDIA',
  'INDUSTRIES',
  'INDUSTRY',
  'HOLDINGS',
  'HOLDING',
  'SERVICES',
  'SERVICE',
  'THE',
  'OF',
  'AND'
]);

function normalizeCompanyText(value: string): string {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token && !COMPANY_STOPWORDS.has(token))
    .join(' ');
}

function tokenizeCompanyText(value: string): string[] {
  return normalizeCompanyText(value).split(' ').filter(Boolean);
}

function buildAcronym(value: string): string {
  const tokens = tokenizeCompanyText(value);
  if (!tokens.length) return '';
  return tokens.map((token) => token[0]).join('');
}

function scoreTokenOverlap(aTokens: string[], bTokens: string[]): number {
  if (!aTokens.length || !bTokens.length) return 0;
  const aSet = new Set(aTokens);
  let overlap = 0;
  bTokens.forEach((token) => {
    if (aSet.has(token)) overlap += 1;
  });
  return overlap / Math.max(aTokens.length, bTokens.length);
}

function resolveTickerFromRegistry(
  state: AppState,
  symbol: string
): { ticker: string; score: number; matchedBy: string } | null {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  const registry: TickerRegistryItem[] = Array.isArray(state.tickerRegistry) ? state.tickerRegistry : [];
  if (!registry.length) {
    const mapping = state.stockMappings.find((row) => String(row.stock || '').trim().toUpperCase() === raw);
    if (mapping) {
      return { ticker: String(mapping.ticker || '').trim().toUpperCase(), score: 0.9, matchedBy: 'mapping' };
    }
    return null;
  }

  const rawTokens = tokenizeCompanyText(raw);
  const rawAcronym = buildAcronym(raw);
  let best: { ticker: string; score: number; matchedBy: string } | null = null;

  registry.forEach((item) => {
    const ticker = String(item.ticker || '').trim().toUpperCase();
    if (!ticker) return;
    if (raw === ticker) {
      best = { ticker, score: 1, matchedBy: 'exact' };
      return;
    }
    const synonyms = Array.isArray(item.synonyms) ? item.synonyms : [];
    for (const syn of synonyms) {
      const synText = String(syn || '').trim().toUpperCase();
      if (!synText) continue;
      if (synText === raw) {
        if (!best || best.score < 0.98) best = { ticker, score: 0.98, matchedBy: 'synonym' };
        return;
      }
    }
    const tickerTokens = tokenizeCompanyText(ticker);
    const synTokens = synonyms.flatMap((syn) => tokenizeCompanyText(syn));
    const combinedTokens = Array.from(new Set([...tickerTokens, ...synTokens]));
    const tokenScore = scoreTokenOverlap(rawTokens, combinedTokens);
    if (tokenScore > 0.74 && (!best || tokenScore > (best?.score ?? -1))) {
      best = { ticker, score: tokenScore, matchedBy: 'partial' };
    }
    if (rawAcronym && rawAcronym === ticker && (!best || (best?.score ?? -1) < 0.8)) {
      best = { ticker, score: 0.8, matchedBy: 'acronym' };
    }
    if (raw.includes(ticker) && ticker.length <= 6 && (!best || (best?.score ?? -1) < 0.76)) {
      best = { ticker, score: 0.76, matchedBy: 'contains' };
    }
  });

  return best && best.score >= 0.75 ? best : null;
}

function resolveTickerFromNseMaster(
  state: AppState,
  symbol: string
): { ticker: string; score: number; matchedBy: string } | null {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  const nseMaster: NseMasterItem[] = Array.isArray(state.nseMaster) ? state.nseMaster : [];
  if (!nseMaster.length) return null;
  const rawTokens = tokenizeCompanyText(raw);
  const rawCompact = normalizeCompanyText(raw).replaceAll(' ', '');
  const rawNormalized = normalizeCompanyText(raw);
  let best: { ticker: string; score: number; matchedBy: string } | null = null;

  nseMaster.forEach((row) => {
    const symbolKey = String(row.symbol || '').trim().toUpperCase();
    const nameKey = String(row.name || '').trim().toUpperCase();
    const isinKey = String(row.isin || '').trim().toUpperCase();
    if (!symbolKey) return;
    if (raw === symbolKey) {
      best = { ticker: symbolKey, score: 1, matchedBy: 'nse_symbol' };
      return;
    }
    if (isinKey && raw === isinKey) {
      best = { ticker: symbolKey, score: 0.99, matchedBy: 'nse_isin' };
      return;
    }
    if (nameKey && raw === nameKey) {
      best = { ticker: symbolKey, score: 0.98, matchedBy: 'nse_name' };
      return;
    }
    const nameNormalized = normalizeCompanyText(nameKey);
    if (rawNormalized && nameNormalized && rawNormalized === nameNormalized) {
      best = { ticker: symbolKey, score: 0.97, matchedBy: 'nse_name_normalized' };
      return;
    }
    const nameTokens = tokenizeCompanyText(nameKey);
    const score = scoreTokenOverlap(rawTokens, nameTokens);
    if (score > 0.55 && (!best || score > (best?.score ?? -1))) {
      best = { ticker: symbolKey, score, matchedBy: 'nse_partial' };
    }
    const nameCompact = normalizeCompanyText(nameKey).replaceAll(' ', '');
    if (rawCompact && nameCompact && nameCompact.includes(rawCompact) && (!best || (best?.score ?? -1) < 0.7)) {
      best = { ticker: symbolKey, score: 0.7, matchedBy: 'nse_contains' };
    }
  });

  return best;
}

async function refreshTickerData(session: UserSession, state: AppState): Promise<AppState> {
  try {
    const [registry, requests, nseMaster] = await Promise.all([
      fetchTickerRegistry(),
      fetchTickerRequests(session),
      fetchNseMaster()
    ]);
    const next: AppState = ensureDefaultMappings({
      ...state,
      tickerRegistry: registry,
      tickerRequests: requests,
      nseMaster
    });
    writeState(session, next);
    return next;
  } catch (error) {
    return state;
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  const tag = String(el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

function resolveGlobalSearch(raw: string): { view?: AppView; store?: string; toast?: string } {
  const cleaned = normalizeSearchQuery(raw);
  if (!cleaned) return {};
  const query = cleaned.toLowerCase();
  if (query === '?' || query === 'help') {
    return { toast: GLOBAL_SEARCH_HELP };
  }

  const [command, ...rest] = query.split(' ');
  const restText = rest.join(' ').trim();

  if (command === 'tx' || command === 'txn' || command === 'trades' || command === 'transactions') {
    if (restText) {
      return { view: 'transactions', store: `tx ${restText.toUpperCase()}` };
    }
    return { view: 'transactions' };
  }
  if (command === 'holding' || command === 'holdings') {
    if (restText) {
      return { view: 'holdings', store: `holding ${restText.toUpperCase()}` };
    }
    return { view: 'holdings' };
  }

  if (command === 'dashboard' || command === 'dash' || command === 'home') return { view: 'dashboard' };
  if (command === 'pnl' || command === 'profit' || command === 'loss') return { view: 'pnl' };
  if (command === 'expense' || command === 'expenses') return { view: 'expenses' };
  if (command === 'debt' || command === 'debts' || command === 'ed') return { view: 'debt' };
  if (command === 'insights' || command === 'insight') return { view: 'insights' };
  if (command === 'cloud') return { view: 'cloud' };
  if (command === 'settings') return { view: 'settings' };
  if (command === 'admin') return { view: 'admin' };
  if (command === 'target' || command === 'targets') return { view: 'target' };
  if (command === 'sync') return { view: 'transactions' };
  if (query.includes('insight')) return { view: 'insights' };
  if (query.includes('cloud')) return { view: 'cloud' };
  return { toast: GLOBAL_SEARCH_HELP };
}

function getTrendRange(): TrendRange {
  const raw = String(localStorage.getItem(DASH_TREND_RANGE_KEY) || '').trim().toUpperCase();
  if (raw === '7D' || raw === '14D' || raw === '1M') return raw;
  return '1M';
}

function setTrendRange(value: TrendRange): void {
  localStorage.setItem(DASH_TREND_RANGE_KEY, value);
}

function getTargetFilter(): TargetFilter {
  const raw = String(localStorage.getItem(TARGET_FILTER_KEY) || '').trim().toUpperCase();
  if (raw === 'APPROACHING') return 'APPROACHING';
  if (raw === 'MET') return 'MET';
  return 'ALL';
}

function setTargetFilter(value: TargetFilter): void {
  localStorage.setItem(TARGET_FILTER_KEY, value);
}

function getTargetSort(): TargetSort {
  const raw = String(localStorage.getItem(TARGET_SORT_KEY) || '').trim().toUpperCase();
  return raw === 'PROFIT' ? 'PROFIT' : 'PROGRESS';
}

function setTargetSort(value: TargetSort): void {
  localStorage.setItem(TARGET_SORT_KEY, value);
}

function buildSparkline(values: number[]): {
  linePath: string;
  areaPath: string;
  points: Array<{ x: number; y: number; value: number; idx: number }>;
  width: number;
  height: number;
} {
  const width = 800;
  const height = 320;
  const pad = 12;
  const series = values.length ? values : [0];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;

  const points = series.map((v, idx) => {
    const x = pad + (idx * (width - pad * 2)) / Math.max(1, series.length - 1);
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return { x, y, value: v, idx };
  });

  const linePath = points
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  const areaPath = `${linePath} L ${last.x.toFixed(2)} ${(height - pad).toFixed(2)} L ${first.x.toFixed(2)} ${(height - pad).toFixed(2)} Z`;
  return { linePath, areaPath, points, width, height };
}

function buildHistorySparkline(values: number[]): {
  linePath: string;
  areaPath: string;
  points: Array<{ x: number; y: number; value: number; idx: number }>;
  width: number;
  height: number;
} {
  const width = 920;
  const height = 360;
  const padX = 26;
  const padY = 28;
  const series = values.length ? values : [0];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;

  const points = series.map((v, idx) => {
    const x = padX + (idx * (width - padX * 2)) / Math.max(1, series.length - 1);
    const y = height - padY - ((v - min) / range) * (height - padY * 2);
    return { x, y, value: v, idx };
  });

  const linePath = points
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  const areaPath = `${linePath} L ${last.x.toFixed(2)} ${(height - padY).toFixed(2)} L ${first.x.toFixed(2)} ${(height - padY).toFixed(2)} Z`;
  return { linePath, areaPath, points, width, height };
}

function buildHistoryChartMarkup(
  points: Array<{ date: string; close: number }>,
  currency: string
): string {
  if (!points.length) {
    return '<div class="muted">No trading-day price history available.</div>';
  }
  const spark = buildHistorySparkline(points.map((p) => Number(p.close || 0)));
  const first = points[0];
  const last = points[points.length - 1];
  const change = Number(last.close || 0) - Number(first.close || 0);
  const base = Number(first.close || 0);
  const pct = base > 0 ? (change / base) * 100 : 0;
  const lows = points.map((p) => Number(p.close || 0));
  const low = Math.min(...lows);
  const high = Math.max(...lows);
  const avg = lows.reduce((sum, n) => sum + n, 0) / Math.max(1, lows.length);
  const trendText =
    pct <= -5
      ? 'Suggestion: Sharp pullback week. Prefer phased entries near support zones.'
      : pct < 0
        ? 'Suggestion: Mild decline. Track recovery above short-term average before adding.'
        : pct >= 5
          ? 'Suggestion: Strong up week. Avoid chasing; add on dips near your allocation plan.'
          : 'Suggestion: Sideways to mild uptrend. Continue disciplined, staggered entries.';
  return `
    <div class="history-hero">
      <div class="history-hero-left">
        <div class="history-return-badge ${pct >= 0 ? 'profit-soft' : 'loss-soft'}">7D trading return</div>
        <div class="history-return-big ${pct >= 0 ? 'profit' : 'loss'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</div>
        <div class="history-return-amt ${pct >= 0 ? 'profit' : 'loss'}">${change >= 0 ? '+' : ''}${formatCurrency(change, currency)}</div>
      </div>
      <div class="history-hero-right">
        <div class="history-range">
          <span>From</span>
          <strong>${esc(formatDateReadable(first.date))}</strong>
          <span class="history-range-arrow">-></span>
          <strong>${esc(formatDateReadable(last.date))}</strong>
        </div>
        <div class="tiny-label">Last 7 trading sessions only</div>
      </div>
    </div>
    <div class="history-chart-shell">
      <div id="history-tooltip" class="history-tooltip hidden"></div>
      <svg viewBox="0 0 ${spark.width} ${spark.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Last 7 trading days price chart">
        ${[0.2, 0.4, 0.6, 0.8].map((g) => `<line class="history-gridline" x1="12" y1="${(spark.height - 12 - (spark.height - 24) * g).toFixed(2)}" x2="${(spark.width - 12).toFixed(2)}" y2="${(spark.height - 12 - (spark.height - 24) * g).toFixed(2)}"></line>`).join('')}
        <path class="perf-area" d="${spark.areaPath}"></path>
        <path class="perf-line" d="${spark.linePath}"></path>
        ${spark.points
          .map((pt) => {
            const row = points[pt.idx];
            if (!row) return '';
            return `<circle
              cx="${pt.x.toFixed(2)}"
              cy="${pt.y.toFixed(2)}"
              r="6"
              class="history-point"
              data-date="${esc(row.date)}"
              data-close="${Number(row.close || 0)}"
            ></circle>`;
          })
          .join('')}
      </svg>
    </div>
    <div class="history-axis" style="--history-cols:${points.length}">
      ${points
        .map((p) => `<span>${esc(formatDateCompact(p.date))}</span>`)
        .join('')}
    </div>
    <div class="history-stats-row">
      <div class="history-stat"><span>Change</span><strong class="${change >= 0 ? 'profit' : 'loss'}">${change >= 0 ? '+' : ''}${formatCurrency(change, currency)}</strong></div>
      <div class="history-stat"><span>Low</span><strong>${formatCurrency(low, currency)}</strong></div>
      <div class="history-stat"><span>High</span><strong>${formatCurrency(high, currency)}</strong></div>
      <div class="history-stat"><span>Avg</span><strong>${formatCurrency(avg, currency)}</strong></div>
    </div>
    <div class="history-suggestion tiny-label">${esc(trendText)}</div>
  `;
}

function bindHistoryChartTooltip(container: HTMLElement, currency: string): void {
  const tooltip = container.querySelector<HTMLElement>('#history-tooltip');
  const shell = container.querySelector<HTMLElement>('.history-chart-shell');
  const points = container.querySelectorAll<SVGCircleElement>('.history-point');
  if (!tooltip || !shell || !points.length) return;

  const show = (point: SVGCircleElement): void => {
    const date = String(point.dataset.date || '').trim();
    const close = Number(point.dataset.close || 0);
    tooltip.innerHTML = `
      <strong>${esc(formatDateReadable(date))}</strong>
      <span>${formatCurrency(close, currency)}</span>
    `;
    const shellBox = shell.getBoundingClientRect();
    const pointBox = point.getBoundingClientRect();
    const shellWidth = shell.clientWidth || 1;
    const left = Math.max(
      8,
      Math.min(shellWidth - 176, pointBox.left - shellBox.left - 72 + pointBox.width / 2)
    );
    const top = Math.max(8, pointBox.top - shellBox.top - 62);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.classList.remove('hidden');
  };

  points.forEach((point) => {
    point.addEventListener('mouseenter', () => show(point));
    point.addEventListener('mousemove', () => show(point));
    point.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  });
}

function formatDateReadable(isoDate: string): string {
  const dt = new Date(isoDate);
  if (Number.isNaN(dt.getTime())) return isoDate;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(dt.getDate()).padStart(2, '0')} ${months[dt.getMonth()]} ${dt.getFullYear()}`;
}

function formatDateCompact(isoDate: string): string {
  const dt = new Date(isoDate);
  if (Number.isNaN(dt.getTime())) return isoDate;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(dt.getDate()).padStart(2, '0')} ${months[dt.getMonth()]}`;
}

function renderDashboardHome(state: AppState): string {
  const trendRange = getTrendRange();
  const trendLabel = trendRange;
  const trendButtons = ['7D', '14D', '1M']
    .map(
      (item) =>
        `<button type="button" class="mini ${trendRange === item ? '' : 'ghost'}" data-trend-range="${item}">${item}</button>`
    )
    .join('');
  const mobileTrendButtons = `<button type="button" class="mini" data-mobile-trend="7D">7D</button>`;
  const snapshot = dashboardFromState(state);
  const holdings = calculateHoldings(state.transactions, getExpandedMappings(state), state.livePrices);
  const invested = holdings.reduce((sum, h) => sum + Number(h.invested || 0), 0);
  const portfolioValue = holdings.reduce((sum, h) => sum + Number(h.marketValue || h.invested || 0), 0);
  const unrealized = holdings.reduce((sum, h) => sum + Number(h.unrealized || 0), 0);
  const totalPL = snapshot.realized + unrealized;
  const todayPL = holdings.reduce((sum, h) => {
    const live = state.livePrices[String(h.ticker || '').trim().toUpperCase()];
    if (!live || !Number.isFinite(live.price) || !Number.isFinite(Number(live.previousClose || 0))) return sum;
    return sum + h.quantity * (Number(live.price) - Number(live.previousClose || 0));
  }, 0);
  const yesterdayValue = portfolioValue - todayPL;
  const todayPct = yesterdayValue > 0 ? (todayPL / yesterdayValue) * 100 : 0;

  const allocationRows = holdings
    .map((h) => {
      const share = invested > 0 ? (h.invested / invested) * 100 : 0;
      return { stock: h.stock, share, invested: h.invested };
    })
    .sort((a, b) => b.share - a.share);
  const topAlloc = allocationRows.slice(0, 5);
  const otherPct = Math.max(0, 100 - topAlloc.reduce((sum, r) => sum + r.share, 0));

  let offset = 0;
  const donutStops = [...topAlloc, ...(otherPct > 0.01 ? [{ stock: 'Other', share: otherPct, invested: 0 }] : [])]
    .map((row, idx) => {
      const start = offset;
      offset += row.share;
      const color = DASH_COLORS[idx % DASH_COLORS.length];
      return `${color} ${start.toFixed(2)}% ${offset.toFixed(2)}%`;
    })
    .join(', ');
  const maxAllocRaw = Number(state.settings.allocationLimitPct);
  const maxAlloc = Number.isFinite(maxAllocRaw) ? maxAllocRaw : 0;
  const overAlloc = allocationRows.filter((r) => r.share > maxAlloc);
  const lossThreshold = 20000;
  const activeLoss = Math.abs(Math.min(0, unrealized));
  const recentTrades = state.transactions.filter((t) => {
    const dt = new Date(t.tradeDate).getTime();
    return Number.isFinite(dt) && Date.now() - dt <= 30 * 24 * 60 * 60 * 1000;
  }).length;
  const alerts: string[] = [];
  if (overAlloc.length) alerts.push(`${overAlloc[0].stock} exposure at ${overAlloc[0].share.toFixed(1)}% (limit ${maxAlloc.toFixed(1)}%)`);
  if (activeLoss >= lossThreshold) alerts.push(`Unrealized loss exceeds ${formatCurrency(lossThreshold, state.settings.currency)}`);
  if (recentTrades >= 40) alerts.push(`High trading activity in past 30 days (${recentTrades} trades)`);
  if (!alerts.length) alerts.push('No critical alerts. Portfolio risk is within configured limits.');

  return `
    <section class="dashboard-home">
      <section class="kpi-grid">
        <article class="kpi-card">
          <p>Portfolio Value</p>
          <h3>${formatCurrency(portfolioValue, state.settings.currency)}</h3>
          <span class="${totalPL >= 0 ? 'profit' : 'loss'}">${toCompactSigned(totalPL)} (${invested > 0 ? ((totalPL / invested) * 100).toFixed(2) : '0.00'}%)</span>
        </article>
        <article class="kpi-card">
          <p>Total Profit / Loss</p>
          <h3 class="${totalPL >= 0 ? 'profit' : 'loss'}">${toCompactSigned(totalPL)}</h3>
          <span>${formatCurrency(snapshot.realized, state.settings.currency)} realized</span>
        </article>
        <article class="kpi-card">
          <p>Unrealized P/L</p>
          <h3 class="${unrealized >= 0 ? 'profit' : 'loss'}">${toCompactSigned(unrealized)}</h3>
          <span>${invested > 0 ? `${(unrealized / invested * 100).toFixed(2)}% of invested` : '0.00% of invested'}</span>
        </article>
        <article class="kpi-card">
          <p>Invested Capital</p>
          <h3>${formatCurrency(invested, state.settings.currency)}</h3>
          <span>${holdings.length} active holdings</span>
        </article>
        <article class="kpi-card">
          <p>Today's P/L</p>
          <h3 class="${todayPL >= 0 ? 'profit' : 'loss'}">${toCompactSigned(todayPL)}</h3>
          <span class="${todayPL >= 0 ? 'profit' : 'loss'}">${todayPct >= 0 ? '+' : ''}${todayPct.toFixed(2)}%</span>
        </article>
        <article class="kpi-card">
          <p>Win Rate</p>
          <h3>${snapshot.winRate.toFixed(0)}%</h3>
          <span>${snapshot.tradeCount} trades</span>
        </article>
      </section>

      <section class="dashboard-main-grid">
        <section class="panel perf-panel">
          <div class="insight-section-head">
            <h2>Daily P/L (${trendLabel})</h2>
            <div class="dash-range trend-range desktop-only">
              ${trendButtons}
            </div>
            <div class="dash-range trend-range mobile-only">
              ${mobileTrendButtons}
            </div>
          </div>
          <div class="perf-chart" id="daily-pnl-chart">
            <div class="muted">Loading daily P/L chart...</div>
          </div>
          <p class="muted">Based on recent trading-day prices for top holdings.</p>
        </section>

        <section class="panel pnl-trend-panel desktop-only">
          <div class="insight-section-head">
            <h2>Realized vs Unrealized (${trendLabel})</h2>
            <div class="dash-range trend-range">
              ${trendButtons}
            </div>
          </div>
          <div class="perf-chart" id="pnl-split-chart">
            <div class="muted">Loading realized/unrealized trend...</div>
          </div>
          <p class="muted">Realized = cumulative closed-trade P/L. Unrealized = market value - invested cost (top holdings).</p>
        </section>

        <section class="panel allocation-panel">
          <div class="insight-section-head">
            <h2>Capital Allocation</h2>
          </div>
          <div class="allocation-layout">
            <div class="donut" style="background: conic-gradient(${donutStops || '#d8e3f1 0% 100%'});">
              <span>${topAlloc[0] ? `${topAlloc[0].share.toFixed(1)}%` : '0%'}</span>
            </div>
            <div class="alloc-legend">
              ${
                [...topAlloc, ...(otherPct > 0.01 ? [{ stock: 'Other', share: otherPct, invested: 0 }] : [])]
                  .map(
                    (row, idx) => `
                    <div class="alloc-item">
                      <i style="background:${DASH_COLORS[idx % DASH_COLORS.length]}"></i>
                      <span>${esc(row.stock)}</span>
                      <strong>${row.share.toFixed(1)}%</strong>
                    </div>`
                  )
                  .join('') || '<p class="muted">No holdings available.</p>'
              }
            </div>
          </div>
          <div class="allocation-mobile">
            ${
              topAlloc.length
                ? topAlloc
                    .map(
                      (row, idx) => `
                  <div class="allocation-mobile-row">
                    <div class="allocation-mobile-head">
                      <span>${esc(row.stock)}</span>
                      <strong>${row.share.toFixed(1)}%</strong>
                    </div>
                    <div class="allocation-mobile-bar">
                      <i style="width:${Math.max(6, row.share).toFixed(2)}%; background:${DASH_COLORS[idx % DASH_COLORS.length]}"></i>
                    </div>
                  </div>
                `
                    )
                    .join('')
                : '<p class="muted">No holdings available.</p>'
            }
          </div>
        </section>

        <section class="panel top-holdings-panel">
          <h2>Top Holdings</h2>
          <div class="top-holdings-list">
            ${
              topAlloc.length
                ? topAlloc
                    .map(
                      (row, idx) => `
                  <div class="holding-bar-item">
                    <span>${esc(row.stock)}</span>
                    <div class="holding-bar-track"><i style="width:${Math.max(3, row.share).toFixed(2)}%; background:${DASH_COLORS[idx % DASH_COLORS.length]}"></i></div>
                    <strong>${row.share.toFixed(1)}%</strong>
                  </div>`
                    )
                    .join('')
                : '<p class="muted">No holdings yet.</p>'
            }
          </div>
        </section>

        <section class="panel trading-insights-panel">
          <h2>Trading Insights</h2>
          <div class="dash-kv"><span>Trades</span><strong>${snapshot.tradeCount}</strong></div>
          <div class="dash-kv"><span>Win Rate</span><strong>${snapshot.winRate.toFixed(0)}%</strong></div>
          <div class="dash-kv"><span>Fees</span><strong>${formatCurrency(snapshot.fees, state.settings.currency)}</strong></div>
          <div class="dash-kv"><span>Realized P/L</span><strong class="${snapshot.realized >= 0 ? 'profit' : 'loss'}">${formatCurrency(snapshot.realized, state.settings.currency)}</strong></div>
        </section>

        <section class="panel alerts-panel">
          <h2>Alerts</h2>
          <div class="alerts-list">
            ${alerts
              .map(
                (a) => `
                <div class="alert-item">
                  <span>!</span>
                  <p>${esc(a)}</p>
                </div>`
              )
              .join('')}
          </div>
        </section>
      </section>
    </section>
  `;
}

function ensureToastHost(): HTMLElement {
  let host = document.getElementById('fds-toast-host');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'fds-toast-host';
  host.className = 'fds-toast-host';
  document.body.appendChild(host);
  return host;
}

type ToastType = 'success' | 'error' | 'info' | 'warn' | 'edit' | 'export' | 'import';

function showToast(message: string, type: ToastType = 'success'): void {
  const text = String(message || '').trim();
  if (!text) return;
  const host = ensureToastHost();
  const toast = document.createElement('div');
  toast.className = `fds-toast ${type}`;
  toast.textContent = text;
  host.appendChild(toast);
  toast.addEventListener('click', () => {
    toast.classList.add('hide');
    window.setTimeout(() => toast.remove(), 220);
  });
  while (host.children.length > 4) {
    host.removeChild(host.firstChild as Node);
  }
  window.setTimeout(() => {
    toast.classList.add('hide');
    window.setTimeout(() => toast.remove(), 220);
  }, 2600);
}

function bindDailyPnlTooltip(container: HTMLElement, currency: string): void {
  const tooltip = container.querySelector<HTMLElement>('.daily-pnl-tooltip');
  const points = container.querySelectorAll<SVGCircleElement>('.chart-point');
  if (!tooltip || !points.length) return;

  const show = (point: SVGCircleElement): void => {
    const date = String(point.dataset.date || '').trim();
    const value = Number(point.dataset.value || 0);
    tooltip.innerHTML = `<strong>${esc(formatDateReadable(date))}</strong><span>${formatCurrency(value, currency)}</span>`;
    tooltip.classList.remove('hidden');
    const rect = point.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const halfWidth = tooltipRect.width / 2;
    const minX = containerRect.left + halfWidth + 8;
    const maxX = containerRect.right - halfWidth - 8;
    const clampedX = Math.min(maxX, Math.max(minX, midX));
    const minTop = containerRect.top + tooltipRect.height + 8;
    const top = Math.max(minTop, rect.top - 12);
    tooltip.style.left = `${clampedX}px`;
    tooltip.style.top = `${top}px`;
  };

  const hide = (): void => {
    tooltip.classList.add('hidden');
  };

  points.forEach((point) => {
    point.addEventListener('mouseenter', () => show(point));
    point.addEventListener('mouseleave', hide);
  });
}

function bindPnlSplitTooltip(container: HTMLElement, currency: string): void {
  const tooltip = container.querySelector<HTMLElement>('.daily-pnl-tooltip');
  const points = container.querySelectorAll<SVGCircleElement>('.chart-point');
  if (!tooltip || !points.length) return;

  const show = (point: SVGCircleElement): void => {
    const date = String(point.dataset.date || '').trim();
    const realized = Number(point.dataset.realized || 0);
    const unrealized = Number(point.dataset.unrealized || 0);
    tooltip.innerHTML = `
      <strong>${esc(formatDateReadable(date))}</strong>
      <span>Realized: ${formatCurrency(realized, currency)}</span>
      <span>Unrealized: ${formatCurrency(unrealized, currency)}</span>
    `;
    tooltip.classList.remove('hidden');
    const rect = point.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const halfWidth = tooltipRect.width / 2;
    const minX = containerRect.left + halfWidth + 8;
    const maxX = containerRect.right - halfWidth - 8;
    const clampedX = Math.min(maxX, Math.max(minX, midX));
    const minTop = containerRect.top + tooltipRect.height + 8;
    const top = Math.max(minTop, rect.top - 12);
    tooltip.style.left = `${clampedX}px`;
    tooltip.style.top = `${top}px`;
  };

  const hide = (): void => {
    tooltip.classList.add('hidden');
  };

  points.forEach((point) => {
    point.addEventListener('mouseenter', () => show(point));
    point.addEventListener('mouseleave', hide);
  });
}

function messageTone(message: string): ToastType {
  const text = String(message || '').toLowerCase();
  if (!text) return 'info';
  if (
    text.includes('failed') ||
    text.includes('invalid') ||
    text.includes('required') ||
    text.includes('error') ||
    text.includes('not found')
  ) {
    return 'error';
  }
  if (text.includes('deleted') || text.includes('delete')) return 'warn';
  if (text.includes('edited') || text.includes('updated') || text.includes('saved')) return 'edit';
  if (text.includes('export')) return 'export';
  if (text.includes('import') || text.includes('restore')) return 'import';
  return 'success';
}

function buildLinePath(values: number[], width = 900, height = 300, pad = 18): {
  linePath: string;
  points: Array<{ x: number; y: number; value: number; idx: number }>;
} {
  const series = values.length ? values : [0];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;

  const points = series.map((v, idx) => {
    const x = pad + (idx * (width - pad * 2)) / Math.max(1, series.length - 1);
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return { x, y, value: v, idx };
  });

  const linePath = points
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');

  return { linePath, points };
}

function buildDailyPnlChartMarkup(
  dates: string[],
  values: number[],
  currency: string
): string {
  if (!values.length) {
    return '<div class="muted">No price history available yet.</div>';
  }
  const spark = buildSparkline(values);
  const last = values[values.length - 1] || 0;
  const avg = values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
  const best = Math.max(...values);
  const worst = Math.min(...values);
  const trendCls = last >= 0 ? 'profit' : 'loss';
  const tickCount = 6;
  const tickIdx = Array.from({ length: tickCount }, (_, i) =>
    Math.round((i * (values.length - 1)) / Math.max(1, tickCount - 1))
  );
  const max = Math.max(...values);
  const min = Math.min(...values);
  const yTicks = [min, min + (max - min) * 0.5, max];
  return `
    <div class="daily-pnl-summary">
      <div><span>Latest Day</span><strong class="${trendCls}">${formatCurrency(last, currency)}</strong></div>
      <div><span>Avg Daily</span><strong>${formatCurrency(avg, currency)}</strong></div>
      <div><span>Best</span><strong class="profit">${formatCurrency(best, currency)}</strong></div>
      <div><span>Worst</span><strong class="loss">${formatCurrency(worst, currency)}</strong></div>
    </div>
    <div class="daily-pnl-chart" data-chart="daily">
      <div class="daily-pnl-tooltip hidden"></div>
      <svg viewBox="0 0 ${spark.width} ${spark.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Daily P/L trend">
        ${[0.25, 0.5, 0.75].map((g) => `<line class="chart-grid" x1="12" y1="${(spark.height - 12 - (spark.height - 24) * g).toFixed(2)}" x2="${(spark.width - 12).toFixed(2)}" y2="${(spark.height - 12 - (spark.height - 24) * g).toFixed(2)}"></line>`).join('')}
        <path class="pnl-trend-area" d="${spark.areaPath}"></path>
        <path class="pnl-trend-line" d="${spark.linePath}"></path>
        ${spark.points
          .map((pt) => {
            const d = dates[pt.idx];
            const v = values[pt.idx];
            if (!d) return '';
            return `<circle class="chart-point" cx="${pt.x.toFixed(2)}" cy="${pt.y.toFixed(2)}" r="5" data-date="${esc(d)}" data-value="${v}"></circle>`;
          })
          .join('')}
      </svg>
    </div>
    <div class="chart-axis chart-axis-y">
      ${yTicks.map((v) => `<span>${formatCurrency(v, currency)}</span>`).join('')}
    </div>
    <div class="chart-axis chart-axis-x" style="--history-cols:${tickIdx.length}">
      ${tickIdx.map((idx) => `<span>${esc(formatDateCompact(dates[idx]))}</span>`).join('')}
    </div>
  `;
}

function buildRealizedUnrealizedChartMarkup(
  dates: string[],
  realizedSeries: number[],
  unrealizedSeries: number[],
  currency: string
): string {
  if (!dates.length) {
    return '<div class="muted">No realized/unrealized trend available.</div>';
  }
  const width = 900;
  const height = 320;
  const realizedPath = buildLinePath(realizedSeries, width, height);
  const unrealizedPath = buildLinePath(unrealizedSeries, width, height);
  const realizedLast = realizedSeries[realizedSeries.length - 1] || 0;
  const unrealizedLast = unrealizedSeries[unrealizedSeries.length - 1] || 0;
  const tickCount = 6;
  const tickIdx = Array.from({ length: tickCount }, (_, i) =>
    Math.round((i * (dates.length - 1)) / Math.max(1, tickCount - 1))
  );
  const min = Math.min(...realizedSeries, ...unrealizedSeries);
  const max = Math.max(...realizedSeries, ...unrealizedSeries);
  const yTicks = [min, min + (max - min) * 0.5, max];
  return `
    <div class="daily-pnl-summary">
      <div><span>Realized</span><strong class="${realizedLast >= 0 ? 'profit' : 'loss'}">${formatCurrency(realizedLast, currency)}</strong></div>
      <div><span>Unrealized</span><strong class="${unrealizedLast >= 0 ? 'profit' : 'loss'}">${formatCurrency(unrealizedLast, currency)}</strong></div>
    </div>
    <div class="chart-legend">
      <span class="legend-item"><i class="legend-dot realized"></i>Realized</span>
      <span class="legend-item"><i class="legend-dot unrealized"></i>Unrealized</span>
    </div>
    <div class="daily-pnl-chart dual" data-chart="pnl-split">
      <div class="daily-pnl-tooltip hidden"></div>
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Realized vs Unrealized trend">
        ${[0.25, 0.5, 0.75].map((g) => `<line class="chart-grid" x1="12" y1="${(height - 12 - (height - 24) * g).toFixed(2)}" x2="${(width - 12).toFixed(2)}" y2="${(height - 12 - (height - 24) * g).toFixed(2)}"></line>`).join('')}
        <path class="pnl-trend-line realized" d="${realizedPath.linePath}"></path>
        <path class="pnl-trend-line unrealized" d="${unrealizedPath.linePath}"></path>
        ${realizedPath.points
          .map((pt) => {
            const d = dates[pt.idx];
            const r = realizedSeries[pt.idx];
            const u = unrealizedSeries[pt.idx];
            if (!d) return '';
            return `<circle class="chart-point" cx="${pt.x.toFixed(2)}" cy="${pt.y.toFixed(2)}" r="4" data-date="${esc(d)}" data-realized="${r}" data-unrealized="${u}"></circle>`;
          })
          .join('')}
      </svg>
    </div>
    <div class="chart-axis chart-axis-y">
      ${yTicks.map((v) => `<span>${formatCurrency(v, currency)}</span>`).join('')}
    </div>
    <div class="chart-axis chart-axis-x" style="--history-cols:${tickIdx.length}">
      ${tickIdx.map((idx) => `<span>${esc(formatDateCompact(dates[idx]))}</span>`).join('')}
    </div>
  `;
}

let loadingCount = 0;
let liveSyncCountdownTimer: number | undefined;
let liveSyncAutoTimer: number | undefined;
let liveSyncInFlight = false;
let cloudSyncCountdownTimer: number | undefined;
let cloudSyncAutoTimer: number | undefined;
let cloudSyncInFlight = false;
let cloudSyncVersion = 0;

function ensureLoadingHost(): HTMLElement {
  let host = document.getElementById('fds-loading-host');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'fds-loading-host';
  host.className = 'fds-loading-overlay';
  host.innerHTML = `
    <div class="fds-loading-card" role="status" aria-live="polite">
      <div class="fds-spinner" aria-hidden="true"></div>
      <div class="fds-loading-text">Working...</div>
    </div>
  `;
  document.body.appendChild(host);
  return host;
}

function showBlockingLoader(message = 'Working...'): void {
  loadingCount += 1;
  const host = ensureLoadingHost();
  const label = host.querySelector<HTMLElement>('.fds-loading-text');
  if (label) label.textContent = message;
  host.classList.add('open');
  document.body.classList.add('is-loading');
}

function hideBlockingLoader(): void {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount > 0) return;
  const host = document.getElementById('fds-loading-host');
  host?.classList.remove('open');
  document.body.classList.remove('is-loading');
}

function setupLiveSyncStatus(
  root: HTMLElement,
  state: AppState,
  runLiveSync: () => Promise<void>
): void {
  if (liveSyncCountdownTimer) {
    window.clearInterval(liveSyncCountdownTimer);
    liveSyncCountdownTimer = undefined;
  }
  if (liveSyncAutoTimer) {
    window.clearTimeout(liveSyncAutoTimer);
    liveSyncAutoTimer = undefined;
  }

  const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-live-sync-countdown]'));
  if (!targets.length) return;
  const refreshSec = Math.max(0, Number(state.settings.livePriceRefreshSec || 0));
  if (!refreshSec) {
    targets.forEach((el) => {
      el.textContent = 'Off';
    });
    return;
  }

  const getNextSyncMs = (): number => {
    const lastSync = state.lastLiveSyncAt ? new Date(state.lastLiveSyncAt).getTime() : 0;
    const lastAttemptRaw = Number(localStorage.getItem(LIVE_SYNC_ATTEMPT_KEY) || 0);
    const lastAttempt = Number.isFinite(lastAttemptRaw) ? lastAttemptRaw : 0;
    const base = Math.max(lastSync, lastAttempt);
    const anchor = base > 0 ? base : Date.now();
    return anchor + refreshSec * 1000;
  };
  let nextSyncAt = getNextSyncMs();

  const renderCountdown = (): void => {
    const now = Date.now();
    if (now >= nextSyncAt) {
      targets.forEach((el) => {
        el.textContent = 'Syncing...';
      });
      return;
    }
    const remaining = Math.max(0, nextSyncAt - now);
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    targets.forEach((el) => {
      el.textContent = `${minutes}m ${seconds}s`;
    });
  };

  renderCountdown();
  liveSyncCountdownTimer = window.setInterval(renderCountdown, 1000);

  const scheduleAuto = (): void => {
    const now = Date.now();
    const delay = Math.max(0, nextSyncAt - now);
    liveSyncAutoTimer = window.setTimeout(async () => {
      await runLiveSync();
      nextSyncAt = getNextSyncMs();
      scheduleAuto();
    }, delay);
  };

  scheduleAuto();
}

function setupCloudSyncStatus(
  root: HTMLElement,
  state: AppState,
  runCloudSync: () => Promise<void>
): void {
  cloudSyncVersion += 1;
  const localVersion = cloudSyncVersion;
  if (cloudSyncCountdownTimer) {
    window.clearInterval(cloudSyncCountdownTimer);
    cloudSyncCountdownTimer = undefined;
  }
  if (cloudSyncAutoTimer) {
    window.clearTimeout(cloudSyncAutoTimer);
    cloudSyncAutoTimer = undefined;
  }

  const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-cloud-sync-countdown]'));
  if (!targets.length) return;
  const autoEnabled = getCloudAutoSyncEnabled();
  const intervalMin = Math.max(1, Number(getCloudAutoSyncInterval() || 10));

  if (!autoEnabled) {
    targets.forEach((el) => {
      el.textContent = 'Off';
      el.classList.remove('countdown-pulse');
    });
    return;
  }

  const getNextSyncMs = (): number => {
    const lastSync = state.lastSyncedAt ? new Date(state.lastSyncedAt).getTime() : 0;
    const anchor = lastSync > 0 ? lastSync : Date.now();
    return anchor + intervalMin * 60 * 1000;
  };

  let nextSyncAt = getNextSyncMs();

  const renderCountdown = (): void => {
    const now = Date.now();
    if (now >= nextSyncAt) {
      targets.forEach((el) => {
        el.textContent = 'Syncing...';
        el.classList.add('countdown-pulse');
      });
      return;
    }
    const remaining = Math.max(0, nextSyncAt - now);
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    targets.forEach((el) => {
      el.textContent = `${minutes}m ${seconds}s`;
      el.classList.add('countdown-pulse');
    });
  };

  renderCountdown();
  cloudSyncCountdownTimer = window.setInterval(renderCountdown, 1000);

  const scheduleAuto = (): void => {
    const now = Date.now();
    const delay = Math.max(0, nextSyncAt - now);
    cloudSyncAutoTimer = window.setTimeout(async () => {
      if (localVersion !== cloudSyncVersion) return;
      await runCloudSync();
      if (localVersion !== cloudSyncVersion) return;
      nextSyncAt = getNextSyncMs();
      scheduleAuto();
    }, delay);
  };

  scheduleAuto();
}

type UiPrefs = {
  fontScale: number;
  compact: boolean;
  reduceMotion: boolean;
  softBackground: boolean;
  theme: 'light' | 'dark';
};

function loadUiPrefs(): UiPrefs {
  const raw = String(localStorage.getItem(UI_PREFS_KEY) || '').trim();
  if (!raw) {
    return { fontScale: 1, compact: true, reduceMotion: false, softBackground: true, theme: 'light' };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    const fontScale = Number(parsed.fontScale);
    return {
      fontScale: Number.isFinite(fontScale) ? Math.min(1.2, Math.max(0.9, fontScale)) : 1,
      compact: Boolean(parsed.compact),
      reduceMotion: Boolean(parsed.reduceMotion),
      softBackground: parsed.softBackground !== false,
      theme: parsed.theme === 'dark' ? 'dark' : 'light'
    };
  } catch {
    return { fontScale: 1, compact: true, reduceMotion: false, softBackground: true, theme: 'light' };
  }
}

function applyUiPrefs(prefs: UiPrefs): void {
  document.documentElement.style.setProperty('--ui-font-scale', String(prefs.fontScale));
  document.body.classList.toggle('ui-compact', prefs.compact);
  document.body.classList.toggle('reduce-motion', prefs.reduceMotion);
  document.body.classList.toggle('no-gradient', !prefs.softBackground);
  document.body.classList.toggle('theme-dark', prefs.theme === 'dark');
  localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
}

function bindGlobalShortcuts(root: HTMLElement): void {
  if (root.dataset.shortcutsBound === 'true') return;
  root.dataset.shortcutsBound = 'true';

  let chord: string | null = null;
  let chordTimer: number | undefined;
  const clearChord = (): void => {
    chord = null;
    if (chordTimer) {
      window.clearTimeout(chordTimer);
      chordTimer = undefined;
    }
  };

  document.addEventListener(
    'click',
    (event) => {
      const menu = document.getElementById('profile-menu');
      const button = document.getElementById('profile-menu-btn');
      if (!menu || !button) return;
      const target = event.target as Node | null;
      if (menu.classList.contains('open') && target && !menu.contains(target) && !button.contains(target)) {
        menu.classList.remove('open');
      }
    },
    true
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (isEditableTarget(event.target)) {
        if (event.key === 'Escape') {
          document.getElementById('profile-menu')?.classList.remove('open');
        }
        return;
      }

      const key = event.key.toLowerCase();
      if (key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const input = document.getElementById('global-search-input') as HTMLInputElement | null;
        if (input) {
          event.preventDefault();
          input.focus();
          input.select();
        }
        return;
      }

      if (key === 'g' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        chord = 'g';
        if (chordTimer) window.clearTimeout(chordTimer);
        chordTimer = window.setTimeout(() => clearChord(), 800);
        return;
      }

      if (chord === 'g') {
        const viewMap: Record<string, AppView> = {
          d: 'dashboard',
          t: 'transactions',
          h: 'holdings',
          p: 'pnl',
          e: 'expenses',
          b: 'debt',
          i: 'insights',
          c: 'cloud',
          s: 'settings'
        };
        const targetView = viewMap[key];
        if (targetView) {
          event.preventDefault();
          window.location.href = pagePath(targetView);
        }
        clearChord();
        return;
      }

      if (key === 'escape') {
        document.getElementById('profile-menu')?.classList.remove('open');
        document.getElementById('ui-settings-modal')?.classList.remove('open');
        document.getElementById('ui-settings-modal')?.setAttribute('aria-hidden', 'true');
        clearChord();
      }
    },
    true
  );
}

function confirmPopup(message: string, title = 'Confirm'): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'fds-confirm-backdrop';
    backdrop.innerHTML = `
      <div class="fds-confirm-card" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h3>${esc(title)}</h3>
        <p>${esc(message)}</p>
        <div class="fds-confirm-actions">
          <button type="button" class="ghost" data-confirm-cancel>Cancel</button>
          <button type="button" data-confirm-ok>Confirm</button>
        </div>
      </div>
    `;

    const cleanup = (result: boolean): void => {
      backdrop.remove();
      resolve(result);
    };

    backdrop.querySelector<HTMLButtonElement>('[data-confirm-cancel]')?.addEventListener('click', () => {
      cleanup(false);
    });
    backdrop.querySelector<HTMLButtonElement>('[data-confirm-ok]')?.addEventListener('click', () => {
      cleanup(true);
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) cleanup(false);
    });

    document.body.appendChild(backdrop);
    backdrop.querySelector<HTMLButtonElement>('[data-confirm-ok]')?.focus();
  });
}

function saveView(view: AppView): void {
  localStorage.setItem(VIEW_KEY, view);
}

function getInitialView(): AppView {
  const raw = String(localStorage.getItem(VIEW_KEY) || '').trim();
  if (
    raw === 'dashboard' ||
    raw === 'transactions' ||
    raw === 'holdings' ||
    raw === 'pnl' ||
    raw === 'expenses' ||
    raw === 'debt' ||
    raw === 'insights' ||
    raw === 'cloud' ||
    raw === 'settings' ||
    raw === 'admin'
  ) {
    return raw;
  }
  return 'dashboard';
}

function ensureDefaultMappings(state: AppState): AppState {
  const normalizedCreditItems = Array.isArray(state.creditItems) ? state.creditItems : [];
  const registry = Array.isArray(state.tickerRegistry) ? state.tickerRegistry : [];
  if (!registry.length) {
    return { ...state, creditItems: normalizedCreditItems };
  }
  const stockMappings: StockMapping[] = [];
  registry.forEach((item) => {
    const ticker = String(item.ticker || '').trim().toUpperCase();
    if (!ticker) return;
    const synonyms = Array.isArray(item.synonyms) ? item.synonyms : [];
    const aliases = Array.from(
      new Set([ticker, ...synonyms.map((syn) => String(syn || '').trim().toUpperCase())].filter(Boolean))
    );
    aliases.forEach((alias) => {
      stockMappings.push({
        stock: alias,
        ticker,
        enabled: true,
        updatedAt: item.updatedAt || new Date().toISOString()
      });
    });
  });
  stockMappings.sort((a, b) => a.stock.localeCompare(b.stock));
  return {
    ...state,
    stockMappings,
    creditItems: normalizedCreditItems
  };
}

function renderAuth(root: HTMLElement, mode: 'login' | 'register', message = '', isError = false): void {
  const loginForm = `
    <form id="login-form" class="stack">
      <input name="loginId" type="text" placeholder="User ID or Login ID" required />
      <input name="password" type="password" placeholder="Password" required />
      <button type="submit">Sign In</button>
    </form>
  `;

  const registerForm = `
    <form id="register-form" class="stack">
      <input name="name" type="text" placeholder="Full name" required />
      <input name="loginId" type="text" placeholder="Login ID (unique)" required />
      <input name="password" type="password" placeholder="Password" required />
      <input name="email" type="email" placeholder="Email (optional)" />
      <button type="submit">Request Access</button>
    </form>
  `;

  root.innerHTML = `
    <main class="screen login-screen">
      <section class="login-panel">
        <h1>${APP_NAME}</h1>
        <p>Single shared cloud sheet. Admin approval is required for all new users.</p>
        <div class="actions-row">
          <button id="show-login" class="${mode === 'login' ? '' : 'ghost'}">Login</button>
          <button id="show-register" class="${mode === 'register' ? '' : 'ghost'}">Register</button>
        </div>
        ${mode === 'login' ? loginForm : registerForm}
        <p class="muted">Only one admin exists. All user requests go to pending approval.</p>
        ${message ? `<p class="status ${isError ? 'status-error' : ''}">${esc(message)}</p>` : ''}
      </section>
    </main>
  `;

  if (message) {
    showToast(message, messageTone(message));
  }

  root.querySelector<HTMLButtonElement>('#show-login')?.addEventListener('click', () => {
    renderAuth(root, 'login');
  });

  root.querySelector<HTMLButtonElement>('#show-register')?.addEventListener('click', () => {
    renderAuth(root, 'register');
  });

  root.querySelector<HTMLFormElement>('#login-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const loginId = String(data.get('loginId') || '');
    const password = String(data.get('password') || '');

    if (!loginId.trim() || !password.trim()) {
      renderAuth(root, 'login', 'Login ID and password are required', true);
      return;
    }

    showBlockingLoader('Signing in...');
    try {
      await loginWithSheet(loginId, password);
      addActivityLog('auth', `Login: ${loginId}`);
      showToast('Login successful', 'success');
      bootstrapApp(root);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Login failed';
      renderAuth(root, 'login', messageText, true);
    } finally {
      hideBlockingLoader();
    }
  });

  root.querySelector<HTMLFormElement>('#register-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);

    const name = String(data.get('name') || '');
    const loginId = String(data.get('loginId') || '');
    const password = String(data.get('password') || '');
    const email = String(data.get('email') || '');

    if (!name.trim() || !loginId.trim() || !password.trim()) {
      renderAuth(root, 'register', 'Name, Login ID, and password are required', true);
      return;
    }

    showBlockingLoader('Requesting access...');
    try {
      const msg = await requestUserAccess({ name, loginId, password, email });
      addActivityLog('auth', `Request access: ${loginId}`);
      renderAuth(root, 'login', msg, false);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Request failed';
      renderAuth(root, 'register', messageText, true);
    } finally {
      hideBlockingLoader();
    }
  });
}

function transactionCards(state: AppState, currency: string): string {
  const rows = sortTransactionsChronologically(state.transactions, 'desc').slice(0, 300);
  if (!rows.length) {
    return '<article class="txn-empty">No transactions imported yet.</article>';
  }

  return rows
    .map((txn) => {
      const gross = Number(txn.quantity || 0) * Number(txn.price || 0);
      const isoDate = String(txn.tradeDate || '').trim();
      const noteText = stripOrderIdFromNote(String(txn.note || '').trim()) || '-';
      return `
        <article class="txn-card" data-side="${esc(txn.side)}" data-symbol="${esc(String(txn.symbol || '').toUpperCase())}" data-date="${esc(isoDate)}">
          <div class="txn-card-top">
            <div class="txn-head-left">
              <span class="txn-badge ${txn.side === 'BUY' ? 'buy' : 'sell'}">${esc(txn.side)}</span>
              <h3>${esc(txn.symbol)}</h3>
            </div>
            <div class="txn-actions">
              <button type="button" class="mini ghost" data-edit-txn="${esc(txn.id)}">Edit</button>
              <button type="button" class="mini ghost" data-del-txn="${esc(txn.id)}">Delete</button>
            </div>
          </div>
          <div class="txn-meta">Qty ${txn.quantity} @ ${formatCurrency(txn.price, currency)}</div>
          <div class="txn-divider"></div>
          <div class="txn-footer">
            <span>${txn.side === 'BUY' ? 'Cost' : 'Value'} ${formatCurrency(gross, currency)}</span>
            <span>${esc(noteText)}</span>
            <span>${esc(formatDateFromISOToDDMM(isoDate))}</span>
          </div>
        </article>
      `;
    })
    .join('');
}

function holdDaysForStock(state: AppState, stock: string): number {
  const symbol = String(stock || '').trim().toUpperCase();
  if (!symbol) return 0;
  const buys = state.transactions
    .filter((txn) => txn.side === 'BUY' && String(txn.symbol || '').trim().toUpperCase() === symbol)
    .map((txn) => new Date(txn.tradeDate).getTime())
    .filter((ts) => Number.isFinite(ts));
  if (!buys.length) return 0;
  const firstBuy = Math.min(...buys);
  const diff = Date.now() - firstBuy;
  if (!Number.isFinite(diff) || diff < 0) return 0;
  return Math.max(0, Math.floor(diff / (24 * 60 * 60 * 1000)));
}

function currentCycleStartDateForStock(state: AppState, stock: string): string {
  const symbol = String(stock || '').trim().toUpperCase();
  if (!symbol) return '';
  const rows = sortTransactionsChronologically(
    state.transactions.filter((txn) => String(txn.symbol || '').trim().toUpperCase() === symbol),
    'asc'
  );
  let qty = 0;
  let cycleStart = '';
  for (const txn of rows) {
    const side = String(txn.side || '').trim().toUpperCase();
    const q = Math.max(0, Number(txn.quantity || 0));
    if (side === 'BUY') {
      if (qty <= 0) cycleStart = String(txn.tradeDate || '').trim();
      qty += q;
      continue;
    }
    if (side === 'SELL') {
      qty = Math.max(0, qty - q);
      if (qty <= 0) cycleStart = '';
    }
  }
  return qty > 0 ? cycleStart : '';
}

function renderHoldingsHome(state: AppState, holdings: HoldingRow[]): string {
  const currency = state.settings.currency;
  const investedTotal = holdings.reduce((sum, row) => sum + Number(row.invested || 0), 0);
  const holdingTickers = Array.from(
    new Set(holdings.map((row) => String(row.ticker || '').trim().toUpperCase()).filter(Boolean))
  );
  const allocationRows = holdings
    .map((row) => ({
      ...row,
      sharePct: investedTotal > 0 ? (row.invested / investedTotal) * 100 : 0
    }))
    .sort((a, b) => b.sharePct - a.sharePct);
  const topAlloc = allocationRows.slice(0, 5);
  const topStockPct = topAlloc[0]?.sharePct || 0;
  const top3Pct = topAlloc.slice(0, 3).reduce((sum, row) => sum + row.sharePct, 0);
  const allocLimitRaw = Number(state.settings.allocationLimitPct);
  const allocLimit = Number.isFinite(allocLimitRaw) ? allocLimitRaw : 0;
  const portfolioRisk = Math.max(0, topStockPct - allocLimit);

  let offset = 0;
  const otherPct = Math.max(0, 100 - topAlloc.reduce((sum, row) => sum + row.sharePct, 0));
  const donutStops = [...topAlloc, ...(otherPct > 0.01 ? [{ stock: 'Other', sharePct: otherPct } as any] : [])]
    .map((row, idx) => {
      const start = offset;
      offset += Number(row.sharePct || 0);
      return `${DASH_COLORS[idx % DASH_COLORS.length]} ${start.toFixed(2)}% ${offset.toFixed(2)}%`;
    })
    .join(', ');

  const performanceRows = allocationRows
    .slice()
    .sort((a, b) => Number(a.unrealized || 0) - Number(b.unrealized || 0))
    .slice(0, 6);
  const maxAbsUnrealized = Math.max(1, ...performanceRows.map((row) => Math.abs(Number(row.unrealized || 0))));
  const holdingTickerRows = holdingTickers.map((ticker) => {
    const live = state.livePrices[String(ticker || '').trim().toUpperCase()];
    const ltp = Number(live?.price || 0);
    const changePctRaw = Number(live?.changePct || 0);
    const changePct = Number.isFinite(changePctRaw) ? changePctRaw : 0;
    const statusClass = ltp > 0 ? 'ok' : 'warn';
    const changeClass = changePct >= 0 ? 'profit' : 'loss';
    return `
      <div class="ticker-row" data-ticker="${esc(ticker)}" data-ltp="${ltp}" data-change="${changePct}">
        <strong>${esc(ticker)}</strong>
        <span class="status-pill ${statusClass}">${ltp > 0 ? 'Live' : 'No Live'}</span>
        <span>${ltp > 0 ? formatCurrency(ltp, currency) : '-'}</span>
        <span class="${changeClass}">${ltp > 0 ? `${changePct.toFixed(2)}%` : '-'}</span>
      </div>
    `;
  });

  return `
    <section class="holdings-home">
      <section class="holdings-top-grid">
        <section class="panel holdings-overview-card">
          <div class="insight-section-head"><h2>Holdings Overview</h2></div>
          <div class="holdings-overview-layout">
            <div class="donut" style="background: conic-gradient(${donutStops || '#d8e3f1 0% 100%'});">
              <span>${topStockPct.toFixed(1)}%</span>
            </div>
            <div class="alloc-legend">
              ${
                topAlloc.length
                  ? topAlloc
                      .map(
                        (row, idx) => `
                      <div class="alloc-item">
                        <i style="background:${DASH_COLORS[idx % DASH_COLORS.length]}"></i>
                        <span>${esc(row.stock)}</span>
                        <strong>${row.sharePct.toFixed(1)}%</strong>
                      </div>`
                      )
                      .join('')
                  : '<p class="muted">No holdings yet.</p>'
              }
            </div>
          </div>
          <div class="holdings-risk-row">
            <div><span class="tiny-label">Top Stock</span><strong>${topStockPct.toFixed(1)}%</strong></div>
            <div><span class="tiny-label">Top 3 Stocks</span><strong>${top3Pct.toFixed(1)}%</strong></div>
            <div><span class="tiny-label">Portfolio Risk</span><strong class="${portfolioRisk > 0 ? 'loss' : 'profit'}">${portfolioRisk.toFixed(1)}%</strong></div>
          </div>
        </section>

        <section class="panel holdings-performance-card">
          <div class="insight-section-head">
            <h2>Holdings Performance</h2>
            <span class="tiny-label">Sorted: High Loss</span>
          </div>
          <div class="holdings-performance-list">
            ${
              performanceRows.length
                ? performanceRows
                    .map((row) => {
                      const upnl = Number(row.unrealized || 0);
                      const tone = upnl >= 0 ? 'profit' : 'loss';
                      const width = ((Math.abs(upnl) / maxAbsUnrealized) * 100).toFixed(1);
                      return `
                        <div class="holdings-perf-item">
                          <div class="holdings-perf-head"><span>${esc(row.stock)}</span><strong class="${tone}">${formatCurrency(upnl, currency)}</strong></div>
                          <div class="holding-bar-track"><i class="${upnl >= 0 ? 'bar-good' : 'bar-bad'}" style="width:${width}%"></i></div>
                        </div>
                      `;
                    })
                    .join('')
                : '<p class="muted">No holdings performance available.</p>'
            }
          </div>
        </section>
      </section>

      <section class="panel holdings-ticker-panel">
        <div class="insight-section-head">
          <h2>Holding Tickers</h2>
          <span class="tiny-label">Read-only list</span>
        </div>
        <div class="holdings-ticker-controls">
          <input id="holding-ticker-search" type="text" placeholder="Search tickers..." />
          <select id="holding-ticker-sort">
            <option value="az">A-Z</option>
            <option value="za">Z-A</option>
            <option value="ltp">Highest LTP</option>
            <option value="change">Highest Change %</option>
          </select>
        </div>
        <div class="holdings-ticker-table" id="holding-ticker-table">
          <div class="ticker-row header">
            <span>Ticker</span>
            <span>Status</span>
            <span>LTP</span>
            <span>Change</span>
          </div>
          ${
            holdingTickerRows.length
              ? holdingTickerRows.join('')
              : '<p class="muted">No holdings yet.</p>'
          }
        </div>
      </section>

      <section class="panel">
        <div class="insight-section-head">
          <h2>Current Holdings <span class="tiny-label">(${allocationRows.length})</span></h2>
          <div class="actions-row">
            <select id="hold-sort">
              <option value="loss">High Loss</option>
              <option value="gain">High Gain</option>
              <option value="alloc">High Allocation</option>
              <option value="name">Name</option>
            </select>
          </div>
        </div>
        <div class="holdings-filter-row">
          <div class="holdings-filter-tabs">
            <button type="button" class="mini" data-hold-filter="ALL">ALL</button>
            <button type="button" class="mini ghost" data-hold-filter="PROFIT">Profit</button>
            <button type="button" class="mini ghost" data-hold-filter="LOSS">Loss</button>
          </div>
          <input id="hold-search" type="text" placeholder="Search stock..." />
          <button id="sync-live-btn" type="button" class="ghost">Sync Live</button>
        </div>

        <div id="holdings-cards-grid" class="holdings-cards-grid">
          ${
            allocationRows.length
              ? allocationRows
                  .map((row) => {
                    const upnl = Number(row.unrealized || 0);
                    const value = Number(row.marketValue || row.invested || 0);
                    const tone = upnl >= 0 ? 'profit' : 'loss';
                    const days = holdDaysForStock(state, row.stock);
                    const progress = Math.max(3, Math.min(100, row.sharePct));
                    return `
                      <article class="hold-card" data-stock="${esc(row.stock)}" data-ticker="${esc(row.ticker)}" data-upnl="${upnl}" data-alloc="${row.sharePct.toFixed(4)}">
                        <div class="hold-card-head">
                          <h3>${esc(row.stock)}</h3>
                          <strong class="${tone}">${formatCurrency(upnl, currency)} (${(row.unrealizedPct || 0).toFixed(2)}%)</strong>
                        </div>
                        <div class="tiny-label">Qty ${row.quantity.toFixed(2)} | Avg ${formatCurrency(row.avgCost, currency)} | Days ${days}</div>
                        <div class="holdings-values">
                          <div><span class="tiny-label">Invested</span><strong>${formatCurrency(row.invested, currency)}</strong></div>
                          <div><span class="tiny-label">Current Value</span><strong>${formatCurrency(value, currency)}</strong></div>
                          <div><span class="tiny-label">LTP</span><strong>${row.ltp ? formatCurrency(row.ltp, currency) : '-'}</strong></div>
                        </div>
                        <div class="holding-bar-track"><i class="${upnl >= 0 ? 'bar-good' : 'bar-bad'}" style="width:${progress.toFixed(1)}%"></i></div>
                        <div class="hold-card-actions">
                          <button type="button" class="mini ghost" data-hold-showtx="${esc(row.stock)}">Show Transactions</button>
                          <button type="button" class="mini ghost" data-hold-details="${esc(row.stock)}">View Details</button>
                        </div>
                      </article>
                    `;
                  })
                  .join('')
              : '<article class="txn-empty">No active holdings.</article>'
          }
        </div>
      </section>

      <div id="hold-detail-modal" class="trade-modal" aria-hidden="true">
        <div class="trade-modal-card">
          <div class="trade-modal-head">
            <h2 id="hold-detail-title">Holding Details</h2>
            <button id="close-hold-detail-btn" type="button" class="ghost mini">Close</button>
          </div>
          <p class="muted">Last 7 trading days only (weekends/market holidays are naturally excluded).</p>
          <div id="hold-detail-chart-wrap" class="hold-detail-chart-wrap"></div>
        </div>
      </div>
    </section>
  `;
}

function availableQtyForStock(transactions: AppState['transactions'], stock: string): number {
  const symbol = String(stock || '').trim().toUpperCase();
  if (!symbol) return 0;
  let qty = 0;
  const sorted = sortTransactionsChronologically(transactions, 'asc');
  for (const txn of sorted) {
    if (String(txn.symbol || '').trim().toUpperCase() !== symbol) continue;
    if (txn.side === 'BUY') qty += Number(txn.quantity || 0);
    if (txn.side === 'SELL') qty -= Number(txn.quantity || 0);
  }
  return Math.max(0, qty);
}

function filterImportImpossibleSells(
  existing: AppState['transactions'],
  incoming: AppState['transactions']
): { accepted: AppState['transactions']; skippedImpossible: number } {
  const accepted: AppState['transactions'] = [];
  const running = new Map<string, number>();

  const seed = sortTransactionsChronologically(existing, 'asc');
  for (const txn of seed) {
    const stock = String(txn.symbol || '').trim().toUpperCase();
    const prev = Number(running.get(stock) || 0);
    running.set(stock, txn.side === 'BUY' ? prev + Number(txn.quantity || 0) : prev - Number(txn.quantity || 0));
  }

  let skippedImpossible = 0;
  const sortedIncoming = sortTransactionsChronologically(incoming, 'asc');
  for (const txn of sortedIncoming) {
    const stock = String(txn.symbol || '').trim().toUpperCase();
    const prev = Number(running.get(stock) || 0);
    const qty = Number(txn.quantity || 0);
    if (txn.side === 'SELL' && qty > Math.max(0, prev)) {
      skippedImpossible += 1;
      continue;
    }
    running.set(stock, txn.side === 'BUY' ? prev + qty : prev - qty);
    accepted.push(txn);
  }

  return { accepted, skippedImpossible };
}

function txnIdentity(txn: AppState['transactions'][number]): string {
  const tradeDateTime = String(txn.tradeDateTime || '').trim();
  return [
    String(txn.tradeDate || '').trim(),
    tradeDateTime,
    String(txn.symbol || '').trim().toUpperCase(),
    String(txn.side || '').trim().toUpperCase(),
    Number(txn.quantity || 0).toFixed(6),
    Number(txn.price || 0).toFixed(6)
  ].join('|');
}

function dedupeImportedTransactions(
  existing: AppState['transactions'],
  incoming: AppState['transactions']
): { accepted: AppState['transactions']; duplicatesSkipped: number } {
  const counts = new Map<string, number>();
  for (const txn of existing) {
    const key = txnIdentity(txn);
    counts.set(key, Number(counts.get(key) || 0) + 1);
  }

  const accepted: AppState['transactions'] = [];
  let duplicatesSkipped = 0;
  for (const txn of incoming) {
    const key = txnIdentity(txn);
    const have = Number(counts.get(key) || 0);
    if (have > 0) {
      duplicatesSkipped += 1;
      counts.set(key, have - 1);
      continue;
    }
    accepted.push(txn);
  }
  return { accepted, duplicatesSkipped };
}

function computeTxnFees(
  side: 'BUY' | 'SELL',
  quantity: number,
  price: number,
  settings: AppState['settings']
): number {
  const tradeValue = Math.max(0, Number(quantity || 0) * Number(price || 0));
  if (tradeValue <= 0) return 0;
  if (side === 'BUY') {
    return (Number(settings.brokerageBuyPct || 0) / 100) * tradeValue;
  }
  return (
    (Number(settings.brokerageSellPct || 0) / 100) * tradeValue +
    Number(settings.dpCharge || 0)
  );
}

function pnlRows(rows: RealizedPnlRow[], currency: string, emptyMessage = 'No realized SELL trades yet.'): string {
  if (!rows.length) return `<tr class="pnl-empty-row"><td colspan="9">${esc(emptyMessage)}</td></tr>`;

  return rows
    .slice(0, 200)
    .map((row) => {
      const cls = row.net >= 0 ? 'profit' : 'loss';
      return `
        <tr>
          <td data-label="Date">${formatDateFromISOToDDMM(row.date)}</td>
          <td data-label="Stock">${esc(row.stock)}</td>
          <td data-label="Qty">${row.quantity.toFixed(2)}</td>
          <td data-label="Invested">${formatCurrency(row.buyCost + row.buyFees, currency)}</td>
          <td data-label="Sell Value">${formatCurrency(row.sellValue, currency)}</td>
          <td data-label="Sell Fees">${formatCurrency(row.sellFees, currency)}</td>
          <td data-label="Net" class="${cls}">${formatCurrency(row.net, currency)}</td>
          <td data-label="Hold">${row.holdDays.toFixed(0)}d</td>
          <td data-label="Return" class="${cls}">${row.returnPct.toFixed(2)}%</td>
        </tr>
      `;
    })
    .join('');
}

type PnlStockRow = {
  stock: string;
  trades: number;
  qty: number;
  buyCost: number;
  sellValue: number;
  fees: number;
  net: number;
  avgHoldDays: number;
  avgReturnPct: number;
};

type UnrealizedRow = {
  stock: string;
  ticker: string;
  qty: number;
  invested: number;
  currentValue: number;
  unrealized: number;
  unrealizedPct: number;
  holdDays: number;
};

function buildPnlStockRows(rows: RealizedPnlRow[]): PnlStockRow[] {
  const byStock = new Map<
    string,
    {
      stock: string;
      trades: number;
      qty: number;
      buyCost: number;
      sellValue: number;
      fees: number;
      net: number;
      holdDaysWeighted: number;
      returnTotal: number;
    }
  >();

  rows.forEach((row) => {
    const stock = String(row.stock || '').trim().toUpperCase();
    if (!stock) return;
    const prev = byStock.get(stock) || {
      stock,
      trades: 0,
      qty: 0,
      buyCost: 0,
      sellValue: 0,
      fees: 0,
      net: 0,
      holdDaysWeighted: 0,
      returnTotal: 0
    };
    prev.trades += 1;
    prev.qty += Number(row.quantity || 0);
    prev.buyCost += Number(row.buyCost || 0) + Number(row.buyFees || 0);
    prev.sellValue += Number(row.sellValue || 0);
    prev.fees += Number(row.sellFees || 0);
    prev.net += Number(row.net || 0);
    prev.holdDaysWeighted += Number(row.holdDays || 0) * Number(row.quantity || 0);
    prev.returnTotal += Number(row.returnPct || 0);
    byStock.set(stock, prev);
  });

  return Array.from(byStock.values()).map((row) => ({
    stock: row.stock,
    trades: row.trades,
    qty: row.qty,
    buyCost: row.buyCost,
    sellValue: row.sellValue,
    fees: row.fees,
    net: row.net,
    avgHoldDays: row.qty > 0 ? row.holdDaysWeighted / row.qty : 0,
    avgReturnPct: row.trades > 0 ? row.returnTotal / row.trades : 0
  }));
}

function buildUnrealizedRows(state: AppState): UnrealizedRow[] {
  const holdings = calculateHoldings(state.transactions, getExpandedMappings(state), state.livePrices);
  return holdings
    .filter((row) => Number(row.quantity || 0) > 0)
    .map((row) => {
      const invested = Number(row.invested || 0);
      const currentValue = Number(row.marketValue || row.invested || 0);
      const unrealized = Number(row.unrealized || 0);
      const unrealizedPct = Number(row.unrealizedPct || 0);
      return {
        stock: String(row.stock || '').trim().toUpperCase(),
        ticker: String(row.ticker || row.stock || '').trim().toUpperCase(),
        qty: Number(row.quantity || 0),
        invested,
        currentValue,
        unrealized,
        unrealizedPct,
        holdDays: holdDaysForStock(state, String(row.stock || ''))
      };
    });
}

function formatMonthShort(isoMonth: string): string {
  const raw = String(isoMonth || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})$/);
  if (!m) return raw;
  const y = Number(m[1]);
  const mm = Number(m[2]) - 1;
  const dt = new Date(y, mm, 1);
  if (Number.isNaN(dt.getTime())) return raw;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[dt.getMonth()]} ${dt.getFullYear()}`;
}

function buildPnlStudio(state: AppState): string {
  const currency = state.settings.currency;
  const rows = calculateRealizedPnlRows(state.transactions);
  const viewMode = getPnlView();
  if (!rows.length && viewMode === 'REALIZED') {
    return `
      <section class="panel">
        <div class="txn-empty">No realized SELL trades yet. Add/import sells to unlock P/L analytics.</div>
      </section>
    `;
  }

  const filters = loadPnlFilters(rows);
  const filteredRows = applyPnlFilters(rows, filters);
  const rangeLabel = viewMode === 'UNREALIZED' ? 'Snapshot' : buildPnlRangeLabel(filters, rows);
  const allRange = getPnlFilterDefaults(rows);

  const unrealizedRows = buildUnrealizedRows(state);
  const unrealizedFiltered = unrealizedRows.filter((row) => {
    const query = String(filters.search || '').trim().toUpperCase();
    if (query && !row.stock.includes(query)) return false;
    if (filters.mode === 'WINNERS' && row.unrealized < 0) return false;
    if (filters.mode === 'LOSERS' && row.unrealized >= 0) return false;
    return true;
  });

  const realizedNet = (viewMode === 'REALIZED' ? filteredRows : unrealizedFiltered).reduce(
    (sum, row) => sum + Number(viewMode === 'REALIZED' ? (row as RealizedPnlRow).net : (row as UnrealizedRow).unrealized || 0),
    0
  );
  const wins = (viewMode === 'REALIZED' ? filteredRows : unrealizedFiltered).filter((row) =>
    viewMode === 'REALIZED'
      ? Number((row as RealizedPnlRow).net || 0) >= 0
      : Number((row as UnrealizedRow).unrealized || 0) >= 0
  ).length;
  const losses = (viewMode === 'REALIZED' ? filteredRows : unrealizedFiltered).length - wins;
  const avgReturn =
    (viewMode === 'REALIZED'
      ? filteredRows.reduce((sum, row) => sum + Number(row.returnPct || 0), 0) / Math.max(1, filteredRows.length)
      : unrealizedFiltered.reduce((sum, row) => sum + Number(row.unrealizedPct || 0), 0) / Math.max(1, unrealizedFiltered.length));
  const avgHold =
    viewMode === 'REALIZED'
      ? filteredRows.reduce((sum, row) => sum + Number(row.holdDays || 0), 0) / Math.max(1, filteredRows.length)
      : unrealizedFiltered.reduce((sum, row) => sum + Number(row.holdDays || 0), 0) / Math.max(1, unrealizedFiltered.length);
  const winPct =
    (wins / Math.max(1, (viewMode === 'REALIZED' ? filteredRows.length : unrealizedFiltered.length))) * 100;

  const byMonth = new Map<string, number>();
  if (viewMode === 'REALIZED') {
    filteredRows.forEach((row) => {
      const monthKey = String(row.date || '').slice(0, 7);
      if (!monthKey) return;
      byMonth.set(monthKey, Number(byMonth.get(monthKey) || 0) + Number(row.net || 0));
    });
  }
  const monthly = Array.from(byMonth.entries())
    .map(([month, net]) => ({ month, net }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const monthSpark = buildSparkline(monthly.map((m) => Number(m.net || 0)));

  const stockRows =
    viewMode === 'REALIZED'
      ? buildPnlStockRows(filteredRows)
      : unrealizedFiltered.map((row) => ({
          stock: row.stock,
          trades: 0,
          qty: row.qty,
          buyCost: row.invested,
          sellValue: row.currentValue,
          fees: 0,
          net: row.unrealized,
          avgHoldDays: row.holdDays,
          avgReturnPct: row.unrealizedPct
        }));
  const filteredStockRows = stockRows;

  const topProfit = [...stockRows].sort((a, b) => b.net - a.net).slice(0, 4);
  const topAbs = [...stockRows].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 4);
  const maxStockAbs = Math.max(1, ...stockRows.map((r) => Math.abs(r.net)));
  const consistencyPct =
    monthly.length > 0 ? (monthly.filter((m) => m.net >= 0).length / monthly.length) * 100 : 0;

  return `
    <section class="panel pnl-studio">
      <section class="pnl-main-grid pnl-filter-top">
        <article class="panel pnl-filter-shell" data-min-date="${allRange.from}" data-max-date="${allRange.to}">
          <div class="pnl-filter-toprow">
            <div>
              <h3>P/L Filters</h3>
              <span class="tiny-label">${rangeLabel}</span>
            </div>
            <div class="pnl-filter-chips">
              <button type="button" class="ghost mini" data-pnl-range="MONTH">This Month</button>
              <button type="button" class="ghost mini" data-pnl-range="30D">Last 30 Days</button>
              <button type="button" class="ghost mini" data-pnl-range="ALL">All Time</button>
            </div>
            <div class="pnl-filter-actions">
              <button id="pnl-filter-apply" type="button">Apply</button>
              <button id="pnl-filter-reset" type="button" class="ghost">Reset</button>
            </div>
          </div>
          <div class="pnl-filter-row">
            <div class="pnl-filter-range">
              <input id="pnl-filter-from" type="date" value="${filters.from}" />
              <span>~</span>
              <input id="pnl-filter-to" type="date" value="${filters.to}" />
            </div>
            <select id="pnl-filter-mode">
              <option value="ALL" ${filters.mode === 'ALL' ? 'selected' : ''}>All Stocks</option>
              <option value="WINNERS" ${filters.mode === 'WINNERS' ? 'selected' : ''}>Winners</option>
              <option value="LOSERS" ${filters.mode === 'LOSERS' ? 'selected' : ''}>Losers</option>
            </select>
            <div class="pnl-filter-toggle">
              <button type="button" class="mini ${viewMode === 'REALIZED' ? 'active' : 'ghost'}" data-pnl-view="REALIZED">Realized</button>
              <button type="button" class="mini ${viewMode === 'UNREALIZED' ? 'active' : 'ghost'}" data-pnl-view="UNREALIZED">Unrealized</button>
            </div>
          </div>
          <div class="pnl-filter-search">
            <input id="pnl-filter-search" type="text" placeholder="Search stock name..." value="${esc(filters.search)}" />
            <span class="tiny-label">Filters apply to all sections below.</span>
          </div>
        </article>
      </section>

      <section class="pnl-kpi">
        <div class="pnl-kpi-summary">
          <div class="pnl-row-head">
            <h3>Performance Summary</h3>
            <span class="tiny-label">${rangeLabel}</span>
          </div>
          <div class="pnl-kpi-grid">
            <article>
              <span>${viewMode === 'REALIZED' ? 'Realized Net' : 'Unrealized Net'}</span>
              <strong class="${realizedNet >= 0 ? 'profit' : 'loss'}">${formatCurrency(realizedNet, currency)}</strong>
              <em>${rangeLabel}</em>
            </article>
            <article>
              <span>Win Rate</span>
              <strong>${winPct.toFixed(0)}%</strong>
              <em>${rangeLabel}</em>
            </article>
            <article>
              <span>Avg Return</span>
              <strong class="${avgReturn >= 0 ? 'profit' : 'loss'}">${avgReturn.toFixed(2)}%</strong>
              <em>${rangeLabel}</em>
            </article>
            <article>
              <span>Avg Hold Period</span>
              <strong>${avgHold.toFixed(0)} days</strong>
              <em>${rangeLabel}</em>
            </article>
          </div>
        </div>
        <div class="pnl-kpi-donut">
          <div class="pnl-row-head">
            <h3>Win / Loss Analytics</h3>
            <span class="tiny-label">${rangeLabel}</span>
          </div>
          <div class="pnl-donut-wrap">
            <div class="pnl-donut-ring" style="--p:${winPct.toFixed(2)};"></div>
            <div class="pnl-donut-center">${winPct.toFixed(0)}%</div>
          </div>
          <div class="pnl-donut-meta">
            <div><span>Wins</span><strong>${wins}</strong></div>
            <div><span>Losses</span><strong>${losses}</strong></div>
          </div>
          <div class="tiny-label">Trading consistency ${consistencyPct.toFixed(0)}%</div>
          <div class="bar"><i style="width:${consistencyPct.toFixed(2)}%"></i></div>
        </div>
      </section>

      <section class="pnl-main-grid">
        ${
          viewMode === 'REALIZED'
            ? `
        <article class="panel pnl-trend-card">
          <div class="pnl-row-head">
            <h3>Monthly Profit Trend</h3>
            <span class="tiny-label">${monthly.length} months</span>
          </div>
          <div class="pnl-trend-chart">
            <svg viewBox="0 0 ${monthSpark.width} ${monthSpark.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Monthly profit trend">
              <path class="pnl-trend-area" d="${monthSpark.areaPath}"></path>
              <path class="pnl-trend-line" d="${monthSpark.linePath}"></path>
              ${monthSpark.points
                .map((pt) => {
                  const row = monthly[pt.idx];
                  if (!row) return '';
                  return `<circle cx="${pt.x.toFixed(2)}" cy="${pt.y.toFixed(2)}" r="6" class="pnl-trend-point ${row.net >= 0 ? 'profit-dot' : 'loss-dot'}">
                      <title>${esc(formatMonthShort(row.month))}: ${formatCurrency(row.net, currency)}</title>
                    </circle>`;
                })
                .join('')}
            </svg>
          </div>
          <div class="pnl-axis">
            ${monthly.map((m) => `<span>${esc(formatMonthShort(m.month))}</span>`).join('')}
          </div>
        </article>
        `
            : `
        <article class="panel pnl-trend-card">
          <div class="pnl-row-head">
            <h3>Unrealized Snapshot</h3>
            <span class="tiny-label">No historical trend</span>
          </div>
          <div class="txn-empty">Unrealized view shows current position performance only.</div>
        </article>
        `
        }

        <article class="panel">
          <div class="pnl-row-head">
            <h3>${viewMode === 'REALIZED' ? 'Profit Distribution' : 'Unrealized Distribution'}</h3>
            <span class="tiny-label">Top stocks</span>
          </div>
          <div class="pnl-bars">
            ${
              topProfit.length
                ? topProfit
                    .map((row) => {
                      const width = (Math.abs(row.net) / maxStockAbs) * 100;
                      return `<div class="pnl-bar-row">
                        <span>${esc(row.stock)}</span>
                        <div class="insight-bar-track"><i class="${row.net >= 0 ? 'bar-good' : 'bar-bad'}" style="width:${Math.max(4, width).toFixed(1)}%"></i></div>
                        <strong class="${row.net >= 0 ? 'profit' : 'loss'}">${formatCurrency(row.net, currency)}</strong>
                      </div>`;
                    })
                    .join('')
                : '<p class="muted">No distribution data</p>'
            }
          </div>
        </article>
      </section>

      <section class="pnl-main-grid">
        <article class="panel">
          <div class="pnl-row-head">
            <h3>${viewMode === 'REALIZED' ? 'Monthly Winners / Losers' : 'Top Winners / Losers'}</h3>
            <span class="tiny-label">Net by stock</span>
          </div>
          <div class="pnl-bars">
            ${topAbs
              .map((row) => {
                const width = (Math.abs(row.net) / maxStockAbs) * 100;
                return `<div class="pnl-bar-row">
                  <span>${esc(row.stock)}</span>
                  <div class="insight-bar-track"><i class="${row.net >= 0 ? 'bar-good' : 'bar-bad'}" style="width:${Math.max(4, width).toFixed(1)}%"></i></div>
                  <strong class="${row.net >= 0 ? 'profit' : 'loss'}">${formatCurrency(row.net, currency)}</strong>
                </div>`;
              })
              .join('')}
          </div>
        </article>
      </section>

      <section class="pnl-cards-grid">
        ${
          filteredStockRows.length
            ? filteredStockRows
                .sort((a, b) => b.net - a.net)
                .map(
                  (row) =>
                    viewMode === 'REALIZED'
                      ? `<article class="pnl-card">
                          <div class="pnl-card-head">
                            <h3>${esc(row.stock)}</h3>
                            <strong class="${row.net >= 0 ? 'profit' : 'loss'}">${formatCurrency(row.net, currency)}</strong>
                          </div>
                          <div class="tiny-label">Realized Trades: ${row.trades} | Avg Hold: ${row.avgHoldDays.toFixed(0)} days | Return: ${row.avgReturnPct.toFixed(2)}%</div>
                          <div class="pnl-kv-grid">
                            <div><span class="tiny-label">Buy Cost</span><strong>${formatCurrency(row.buyCost, currency)}</strong></div>
                            <div><span class="tiny-label">Sell Value</span><strong>${formatCurrency(row.sellValue, currency)}</strong></div>
                            <div><span class="tiny-label">Fees</span><strong>${formatCurrency(row.fees, currency)}</strong></div>
                          </div>
                          <div class="hold-card-actions">
                            <button type="button" class="mini ghost" data-pnl-showtx="${esc(row.stock)}">Show Transactions</button>
                            <button type="button" class="mini ghost" data-pnl-detail="${esc(row.stock)}">View Details</button>
                          </div>
                        </article>`
                      : `<article class="pnl-card">
                          <div class="pnl-card-head">
                            <h3>${esc(row.stock)}</h3>
                            <strong class="${row.net >= 0 ? 'profit' : 'loss'}">${formatCurrency(row.net, currency)} (${row.avgReturnPct.toFixed(2)}%)</strong>
                          </div>
                          <div class="tiny-label">Qty ${row.qty.toFixed(2)} | Avg Hold: ${row.avgHoldDays.toFixed(0)} days | Return: ${row.avgReturnPct.toFixed(2)}%</div>
                          <div class="pnl-kv-grid">
                            <div><span class="tiny-label">Invested</span><strong>${formatCurrency(row.buyCost, currency)}</strong></div>
                            <div><span class="tiny-label">Current Value</span><strong>${formatCurrency(row.sellValue, currency)}</strong></div>
                            <div><span class="tiny-label">Unrealized</span><strong class="${row.net >= 0 ? 'profit' : 'loss'}">${formatCurrency(row.net, currency)}</strong></div>
                          </div>
                          <div class="hold-card-actions">
                            <button type="button" class="mini ghost" data-pnl-showtx="${esc(row.stock)}">Show Transactions</button>
                            <button type="button" class="mini ghost" data-pnl-detail="${esc(row.stock)}">View Details</button>
                          </div>
                        </article>`
                )
                .join('')
            : '<article class="txn-empty">No P/L cards match your filters.</article>'
        }
      </section>

      <section class="panel">
        <div class="table-wrap">
          ${
            viewMode === 'REALIZED'
              ? `
          <table class="pnl-table">
            <thead>
              <tr><th>Date</th><th>Stock</th><th>Qty</th><th>Invested</th><th>Sell Value</th><th>Sell Fees</th><th>Net</th><th>Hold Days</th><th>Return</th></tr>
            </thead>
            <tbody>${pnlRows(filteredRows, currency, 'No trades match your filters.')}</tbody>
          </table>
          `
              : `
          <table>
            <thead>
              <tr><th>Stock</th><th>Qty</th><th>Invested</th><th>Current Value</th><th>Unrealized</th><th>Hold Days</th><th>Return</th></tr>
            </thead>
            <tbody>
              ${
                unrealizedFiltered.length
                  ? unrealizedFiltered
                      .map((row) => {
                        const cls = row.unrealized >= 0 ? 'profit' : 'loss';
                        return `
                    <tr>
                      <td>${esc(row.stock)}</td>
                      <td>${row.qty.toFixed(2)}</td>
                      <td>${formatCurrency(row.invested, currency)}</td>
                      <td>${formatCurrency(row.currentValue, currency)}</td>
                      <td class="${cls}">${formatCurrency(row.unrealized, currency)}</td>
                      <td>${row.holdDays}d</td>
                      <td class="${cls}">${row.unrealizedPct.toFixed(2)}%</td>
                    </tr>
                  `;
                      })
                      .join('')
                  : `<tr><td colspan="7">${esc('No holdings match your filters.')}</td></tr>`
              }
            </tbody>
          </table>
          `
          }
        </div>
      </section>

      <div id="pnl-detail-modal" class="trade-modal" aria-hidden="true">
        <div class="trade-modal-card pnl-detail-card">
          <div class="trade-modal-head">
            <h2 id="pnl-detail-title">P/L Details</h2>
            <button id="close-pnl-detail-btn" type="button" class="ghost mini">Close</button>
          </div>
          <div id="pnl-detail-summary" class="pnl-detail-summary"></div>
          <div class="pnl-detail-grid">
            <section>
              <p class="muted">Selected date range (weekends/market holidays are naturally excluded).</p>
              <div id="pnl-detail-chart-wrap" class="hold-detail-chart-wrap"></div>
            </section>
          </div>
          <section class="pnl-detail-table-section">
            <div class="table-wrap pnl-detail-table">
              <table>
                <thead id="pnl-detail-thead">
                  <tr><th>Date</th><th>Qty</th><th>Invested</th><th>Sell Value</th><th>Fees</th><th>Net</th><th>Hold</th><th>Return</th></tr>
                </thead>
                <tbody id="pnl-detail-tbody"></tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </section>
  `;
}

function renderTickerRequests(state: AppState, session: UserSession, mode: 'admin' | 'user'): string {
  const requests = Array.isArray(state.tickerRequests) ? state.tickerRequests : [];
  const filtered =
    mode === 'admin'
      ? requests
      : requests.filter((req) => req.userId === session.userId);
  if (!filtered.length) {
    return '<div class="muted">No ticker requests yet.</div>';
  }
  const order: Record<string, number> = { PENDING: 0, APPROVED: 1, REJECTED: 2 };
  const sorted = filtered
    .slice()
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  if (mode === 'user') {
    return `
      <div class="ticker-request-cards">
        ${sorted
          .map((req) => {
            const statusClass =
              req.status === 'APPROVED' ? 'ok' : req.status === 'REJECTED' ? 'warn' : 'pending';
            return `
              <article class="ticker-request-card" data-request-id="${esc(req.id)}">
                <div class="ticker-request-head">
                  <div>
                    <h3>${esc(req.rawSymbol)}</h3>
                    <div class="tiny-label">Requested ${formatDateCompact(req.requestedAt)}</div>
                  </div>
                  <span class="status-pill ${statusClass}">${esc(req.status)}</span>
                </div>
                <div class="ticker-request-meta">
                  <div><span class="tiny-label">Resolved</span><strong>${esc(req.resolvedTicker || '-')}</strong></div>
                  <div><span class="tiny-label">Request ID</span><strong>${esc(req.id)}</strong></div>
                </div>
              </article>
            `;
          })
          .join('')}
      </div>
    `;
  }

  return `
    <div class="ticker-request-cards admin">
      ${sorted
        .map((req) => {
          const statusClass =
            req.status === 'APPROVED' ? 'ok' : req.status === 'REJECTED' ? 'warn' : 'pending';
          const suggested =
            (resolveTickerFromRegistry(state, req.rawSymbol) || resolveTickerFromNseMaster(state, req.rawSymbol))
              ?.ticker || '';
          return `
            <article class="ticker-request-card" data-request-id="${esc(req.id)}">
              <div class="ticker-request-head">
                <div>
                  <h3>${esc(req.rawSymbol)}</h3>
                  <div class="tiny-label">Requested by ${esc(req.userName || req.userId)} · ${formatDateCompact(req.requestedAt)}</div>
                </div>
                <span class="status-pill ${statusClass}">${esc(req.status)}</span>
              </div>
              <div class="ticker-request-meta">
                <div><span class="tiny-label">Suggested</span><strong>${esc(suggested || '-')}</strong></div>
                <div><span class="tiny-label">Resolved</span><strong>${esc(req.resolvedTicker || '-')}</strong></div>
              </div>
              <div class="ticker-request-actions">
                ${
                  req.status === 'PENDING'
                    ? `
                      <button type="button" class="mini" data-request-approve="${esc(req.id)}">Approve</button>
                      <button type="button" class="mini ghost" data-request-reject="${esc(req.id)}">Reject</button>
                    `
                    : '<span class="tiny-label">Resolved</span>'
                }
              </div>
            </article>
          `;
        })
        .join('')}
    </div>
  `;
}

function renderTickerRequestModal(state: AppState): string {
  return `
    <div id="ticker-approve-modal" class="trade-modal" aria-hidden="true">
      <div class="trade-modal-card ticker-approve-card">
        <div class="trade-modal-head">
          <h2>Resolve Ticker Request</h2>
          <button id="close-ticker-approve-btn" type="button" class="ghost mini">Close</button>
        </div>
        <form id="ticker-approve-form" class="stack compact">
          <input name="requestId" type="hidden" />
          <div class="ticker-approve-grid">
            <label class="ticker-approve-field">
              <span class="tiny-label">Requested Symbol</span>
              <input name="rawSymbol" type="text" disabled />
            </label>
            <label class="ticker-approve-field">
              <span class="tiny-label">Suggested</span>
              <input name="suggestedSymbol" type="text" disabled />
            </label>
          </div>
          <label class="ticker-approve-field">
            <span class="tiny-label">Resolved Ticker</span>
            <input name="resolvedSymbol" type="text" list="ticker-master-options" placeholder="e.g. BERGEPAINT" />
          </label>
          <datalist id="ticker-master-options">
            ${buildTickerOptions(state)}
          </datalist>
          <label class="ticker-approve-field">
            <span class="tiny-label">Reject Note (optional)</span>
            <input name="rejectNote" type="text" placeholder="Reason for rejection" />
          </label>
          <div class="actions-row">
            <button type="submit">Approve</button>
            <button id="ticker-reject-btn" type="button" class="ghost">Reject</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function buildTickerOptions(state: AppState): string {
  const options = new Map<string, string>();
  const registry = Array.isArray(state.tickerRegistry) ? state.tickerRegistry : [];
  const nseMaster = Array.isArray(state.nseMaster) ? state.nseMaster : [];
  registry.forEach((row) => {
    const ticker = String(row.ticker || '').trim().toUpperCase();
    if (!ticker) return;
    if (!options.has(ticker)) options.set(ticker, ticker);
  });
  nseMaster.forEach((row) => {
    const ticker = String(row.symbol || '').trim().toUpperCase();
    const name = String(row.name || '').trim();
    if (!ticker) return;
    if (!options.has(ticker)) options.set(ticker, name || ticker);
  });
  return Array.from(options.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ticker, name]) => `<option value="${esc(ticker)}">${esc(name || ticker)}</option>`)
    .join('');
}

// Ticker registry UI removed; NSE master + requests drive canonical matching.

const normalizeStockKey = (value: string): string => String(value || '').trim().toUpperCase();

const buildActiveLotsForStock = (
  transactions: AppState['transactions'],
  stock: string
): Array<{ qty: number; price: number; date: string }> => {
  const key = normalizeStockKey(stock);
  if (!key) return [];
  const sorted = sortTransactionsChronologically(transactions, 'asc');
  const lots: Array<{ qty: number; price: number; date: string }> = [];

  for (const txn of sorted) {
    const symbol = normalizeStockKey(txn.symbol);
    if (symbol !== key) continue;
    if (txn.side === 'BUY') {
      const qty = Math.max(0, Number(txn.quantity || 0));
      const price = Math.max(0, Number(txn.price || 0));
      if (qty <= 0 || price <= 0) continue;
      lots.push({ qty, price, date: String(txn.tradeDate || '') });
      continue;
    }
    if (txn.side === 'SELL') {
      const sellQty = Math.max(0, Number(txn.quantity || 0));
      if (sellQty <= 0) continue;
      consumeSellWithSameDayPriority(lots, sellQty, String(txn.tradeDate || ''));
    }
  }

  return lots.filter((lot) => lot.qty > 0);
};

const renderTargetBreakdownTable = (state: AppState, stock: string): string => {
  const currency = state.settings.currency;
  const targetPct = Number(state.settings.sellTargetPct || 0);
  const lots = buildActiveLotsForStock(state.transactions, stock);
  if (!lots.length) {
    return `<div class="muted">No active buy lots found for ${esc(stock)}.</div>`;
  }
  const rows = lots.map((lot, idx) => {
    const targetPrice = lot.price * (1 + targetPct / 100);
    const expectedProfit = (targetPrice - lot.price) * lot.qty;
    return `
      <tr>
        <td>${idx + 1}</td>
        <td>${lot.qty}</td>
        <td>${formatCurrency(lot.price, currency)}</td>
        <td>${formatCurrency(targetPrice, currency)}</td>
        <td class="${expectedProfit >= 0 ? 'profit' : 'loss'}">${formatCurrency(expectedProfit, currency)}</td>
      </tr>
    `;
  });
  const totalQty = lots.reduce((sum, lot) => sum + lot.qty, 0);
  const totalProfit = lots.reduce((sum, lot) => {
    const targetPrice = lot.price * (1 + targetPct / 100);
    return sum + (targetPrice - lot.price) * lot.qty;
  }, 0);
  return `
    <table class="target-breakdown-table">
      <thead>
        <tr>
          <th>Lot</th>
          <th>Qty</th>
          <th>Buy Price</th>
          <th>Target Price</th>
          <th>Expected Profit</th>
        </tr>
      </thead>
      <tbody>${rows.join('')}</tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td>${totalQty}</td>
          <td>-</td>
          <td>-</td>
          <td class="${totalProfit >= 0 ? 'profit' : 'loss'}">${formatCurrency(totalProfit, currency)}</td>
        </tr>
      </tfoot>
    </table>
  `;
};

function renderTargetPlanner(state: AppState): string {
  const currency = state.settings.currency;
  const targetPct = Number(state.settings.sellTargetPct || 0);

  const holdings = calculateHoldings(state.transactions, getExpandedMappings(state), state.livePrices)
    .filter((row) => Number(row.quantity || 0) > 0)
    .filter((row) => {
      const live = state.livePrices[String(row.ticker || '').trim().toUpperCase()];
      return live && Number.isFinite(live.price);
    });

  const rows = holdings.map((row) => {
    const live = state.livePrices[String(row.ticker || '').trim().toUpperCase()];
    const livePrice = Number(live?.price || 0);
    const avg = Number(row.avgCost || 0);
    const qty = Number(row.quantity || 0);
    const targetPrice = avg * (1 + targetPct / 100);
    const expectedProfit = (targetPrice - avg) * qty;
    const returnPct = targetPct;
    const progressRaw = (livePrice - avg) / Math.max(1e-6, targetPrice - avg);
    const progress = Math.max(0, Math.min(1, progressRaw));
    const status = progress >= 1 ? 'Target Met' : progress >= 0.8 ? 'Approaching' : 'Far From Target';
    const statusClass = progress >= 1 ? 'ok' : progress >= 0.8 ? 'warn' : 'risk';
    const statusKey: TargetFilter = progress >= 1 ? 'MET' : progress >= 0.8 ? 'APPROACHING' : 'ALL';
    return {
      stock: row.stock,
      qty,
      avg,
      ltp: livePrice,
      targetPrice,
      expectedProfit,
      returnPct,
      progress,
      status,
      statusClass,
      statusKey
    };
  });

  const activeFilter = getTargetFilter();
  const activeSort = getTargetSort();
  const filteredRows = rows.filter((row) => {
    if (activeFilter === 'ALL') return true;
    return row.statusKey === activeFilter;
  });
  const sortedRows = filteredRows.slice().sort((a, b) => {
    if (activeSort === 'PROFIT') return b.expectedProfit - a.expectedProfit;
    return b.progress - a.progress;
  });

  const totalInvested = rows.reduce((sum, r) => sum + r.avg * r.qty, 0);
  const targetValue = rows.reduce((sum, r) => sum + r.targetPrice * r.qty, 0);
  const expectedProfit = rows.reduce((sum, r) => sum + r.expectedProfit, 0);
  const expectedReturnPct = totalInvested > 0 ? (expectedProfit / totalInvested) * 100 : 0;
  const liveUnrealized = holdings.reduce((sum, row) => {
    const live = state.livePrices[String(row.ticker || '').trim().toUpperCase()];
    const livePrice = Number(live?.price || 0);
    return sum + (livePrice - Number(row.avgCost || 0)) * Number(row.quantity || 0);
  }, 0);

  const buyAgg = new Map<string, { qty: number; cost: number }>();
  state.transactions.forEach((txn) => {
    if (txn.side !== 'BUY') return;
    const key = normalizeStockKey(txn.symbol);
    const qty = Math.max(0, Number(txn.quantity || 0));
    const price = Math.max(0, Number(txn.price || 0));
    if (!key || qty <= 0 || price <= 0) return;
    const prev = buyAgg.get(key) || { qty: 0, cost: 0 };
    prev.qty += qty;
    prev.cost += qty * price;
    buyAgg.set(key, prev);
  });

  const activeHoldingKeys = new Set(rows.map((row) => normalizeStockKey(row.stock)));
  const completedMap = new Map<
    string,
    { stock: string; qty: number; profit: number; lastDate: string; targetPrice: number; avgPrice: number }
  >();
  state.transactions.forEach((txn) => {
    if (txn.side !== 'SELL') return;
    const key = normalizeStockKey(txn.symbol);
    if (!activeHoldingKeys.has(key)) return;
    if (!key) return;
    const avgBuy = buyAgg.get(key);
    if (!avgBuy || avgBuy.qty <= 0) return;
    const avgPrice = avgBuy.cost / avgBuy.qty;
    const targetPrice = avgPrice * (1 + targetPct / 100);
    const sellPrice = Number(txn.price || 0);
    const sellQty = Number(txn.quantity || 0);
    if (!(sellPrice > 0) || !(sellQty > 0)) return;
    if (sellPrice < targetPrice) return;

    const prev = completedMap.get(key) || { stock: key, qty: 0, profit: 0, lastDate: '', targetPrice, avgPrice };
    prev.qty += sellQty;
    prev.profit += (sellPrice - avgPrice) * sellQty;
    const date = String(txn.tradeDate || '').trim();
    if (date && date > prev.lastDate) prev.lastDate = date;
    prev.targetPrice = targetPrice;
    prev.avgPrice = avgPrice;
    completedMap.set(key, prev);
  });

  const completedRows = Array.from(completedMap.values());
  const targetsCompleted = completedRows.length;
  const targetTotal = rows.length;

  return `
    <section class="target-planner">
      <section class="target-kpi-grid">
        <article class="panel target-kpi-card">
          <span>Total Invested</span>
          <strong>${formatCurrency(totalInvested, currency)}</strong>
        </article>
        <article class="panel target-kpi-card">
          <span>Target Value</span>
          <strong>${formatCurrency(targetValue, currency)}</strong>
        </article>
        <article class="panel target-kpi-card">
          <span>Expected Profit</span>
          <strong class="${expectedProfit >= 0 ? 'profit' : 'loss'}">${formatCurrency(expectedProfit, currency)}</strong>
        </article>
        <article class="panel target-kpi-card">
          <span>Expected Return %</span>
          <strong>${expectedReturnPct.toFixed(2)}%</strong>
        </article>
        <article class="panel target-kpi-card">
          <span>Live Unrealized Profit</span>
          <strong class="${liveUnrealized >= 0 ? 'profit' : 'loss'}">${formatCurrency(liveUnrealized, currency)}</strong>
        </article>
        <article class="panel target-kpi-card">
          <span>Targets Completed</span>
          <strong>${targetsCompleted} / ${targetTotal}</strong>
        </article>
      </section>

      <section class="panel target-table-panel">
        <div class="insight-section-head">
          <h2>Target Bucket</h2>
          <div class="target-table-actions">
            <div class="target-filter-bar">
              <button type="button" class="mini ${activeFilter === 'ALL' ? 'active' : 'ghost'}" data-target-filter="ALL">All</button>
              <button type="button" class="mini ${activeFilter === 'APPROACHING' ? 'active' : 'ghost'}" data-target-filter="APPROACHING">Approaching</button>
              <button type="button" class="mini ${activeFilter === 'MET' ? 'active' : 'ghost'}" data-target-filter="MET">Target Met</button>
            </div>
            <div class="target-sort-bar">
              <span class="tiny-label">Sort:</span>
              <button type="button" class="mini ${activeSort === 'PROGRESS' ? 'active' : 'ghost'}" data-target-sort="PROGRESS">Progress</button>
              <button type="button" class="mini ${activeSort === 'PROFIT' ? 'active' : 'ghost'}" data-target-sort="PROFIT">Expected Profit</button>
            </div>
            <span class="tiny-label">Target %: ${targetPct.toFixed(1)}%</span>
          </div>
        </div>
        <div class="table-wrap">
          <table class="target-table">
            <thead>
              <tr>
                <th>Stock</th>
                <th>Qty</th>
                <th>Avg Price</th>
                <th>Current LTP</th>
                <th>Target Price</th>
                <th>Expected Profit</th>
                <th>Return %</th>
                <th>Progress</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${
                sortedRows.length
                  ? sortedRows
                      .map(
                        (row) => `
                        <tr>
                          <td data-label="Stock">${esc(row.stock)}</td>
                          <td data-label="Qty">${row.qty}</td>
                          <td data-label="Avg Price">${formatCurrency(row.avg, currency)}</td>
                          <td data-label="Current LTP">${formatCurrency(row.ltp, currency)}</td>
                          <td data-label="Target Price">${formatCurrency(row.targetPrice, currency)}</td>
                          <td data-label="Expected Profit" class="${row.expectedProfit >= 0 ? 'profit' : 'loss'}">${formatCurrency(row.expectedProfit, currency)}</td>
                          <td data-label="Return %">${row.returnPct.toFixed(2)}%</td>
                          <td data-label="Progress">
                            <div class="target-progress">
                              <div class="target-progress-bar" style="width:${(row.progress * 100).toFixed(1)}%"></div>
                            </div>
                            <span class="tiny-label">${(row.progress * 100).toFixed(1)}%</span>
                          </td>
                          <td data-label="Status"><span class="status-pill ${row.statusClass}">${row.status}</span></td>
                          <td data-label="Action"><button class="mini ghost" data-target-breakdown="${esc(row.stock)}">View Breakdown</button></td>
                        </tr>
                      `
                      )
                      .join('')
                  : `<tr class="target-empty-row"><td colspan="10">No active holdings with live prices.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel target-completed-panel">
        <div class="insight-section-head">
          <h2>Completed Targets</h2>
          <span class="tiny-label">Completed when sell price hits target.</span>
        </div>
        <div class="table-wrap">
          <table class="target-table">
            <thead>
              <tr>
                <th>Stock</th>
                <th>Qty Sold</th>
                <th>Profit</th>
                <th>Completion Date</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${
                completedRows.length
                  ? completedRows
                      .map(
                        (row) => `
                        <tr>
                          <td data-label="Stock">${esc(row.stock)}</td>
                          <td data-label="Qty Sold">${row.qty}</td>
                          <td data-label="Profit" class="${row.profit >= 0 ? 'profit' : 'loss'}">${formatCurrency(row.profit, currency)}</td>
                          <td data-label="Completion Date">${row.lastDate ? esc(formatDateFromISOToDDMM(row.lastDate)) : '-'}</td>
                          <td data-label="Status">
                            <span class="status-pill ok" title="Avg Buy ${formatCurrency(row.avgPrice, currency)} | Target ${formatCurrency(row.targetPrice, currency)}">
                              Completed
                            </span>
                          </td>
                        </tr>
                      `
                      )
                      .join('')
                  : `<tr class="target-empty-row"><td colspan="5">No completed targets yet.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </section>

      <div id="target-breakdown-modal" class="trade-modal" aria-hidden="true">
        <div class="trade-modal-card target-breakdown-card">
          <div class="trade-modal-head">
            <h2 id="target-breakdown-title">Target Breakdown</h2>
            <button id="close-target-breakdown" type="button" class="ghost mini">Close</button>
          </div>
          <div id="target-breakdown-body" class="table-wrap"></div>
        </div>
      </div>
    </section>
  `;
}

type ChecklistResult = {
  passed: boolean;
  score: number;
  total: number;
  reasons: string[];
};

type PreBuySummary = {
  stock: string;
  qty: number;
  price: number;
  buyCost: number;
  currentAvg: number;
  projectedAvg: number;
  l1: number;
  l2: number;
  lastBuyPrice?: number;
  dropFromLastBuyPct?: number;
  stockBudget: number;
  remainingBudget: number;
  allocationPct: number;
  suggestion: string;
};

function formatDateDDMMYYYY(date: Date): string {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = String(date.getFullYear()).padStart(4, '0');
  return `${d}-${m}-${y}`;
}

function formatDateFromISOToDDMM(isoDate: string): string {
  const dt = new Date(isoDate);
  if (Number.isNaN(dt.getTime())) return isoDate;
  return formatDateDDMMYYYY(dt);
}

function buildPreBuySummary(
  state: AppState,
  stock: string,
  qty: number,
  price: number,
  fees: number
): PreBuySummary {
  const symbol = String(stock || '').trim().toUpperCase();
  const rows = state.transactions
    .filter((txn) => String(txn.symbol || '').trim().toUpperCase() === symbol)
    .sort((a, b) => new Date(a.tradeDate).getTime() - new Date(b.tradeDate).getTime());

  let currentQty = 0;
  let currentInvested = 0;
  let lastBuyPrice: number | undefined;

  for (const txn of rows) {
    if (txn.side === 'BUY') {
      const q = Number(txn.quantity) || 0;
      const p = Number(txn.price) || 0;
      const f = Number(txn.fees) || 0;
      currentQty += q;
      currentInvested += q * p + f;
      if (q > 0 && p > 0) lastBuyPrice = p;
      continue;
    }
    if (txn.side === 'SELL') {
      const q = Math.min(currentQty, Number(txn.quantity) || 0);
      if (q <= 0 || currentQty <= 0) continue;
      const avg = currentInvested / currentQty;
      currentQty -= q;
      currentInvested -= avg * q;
    }
  }

  const buyCost = qty * price + Math.max(0, fees);
  const currentAvg = currentQty > 0 ? currentInvested / currentQty : price;
  const projectedQty = currentQty + qty;
  const projectedAvg = projectedQty > 0 ? (currentInvested + buyCost) / projectedQty : price;
  const derivedBudget = Math.max(0, state.settings.monthlyBudget * (state.settings.allocationLimitPct / 100));
  const stockBudget = state.settings.stockBudget > 0 ? state.settings.stockBudget : derivedBudget;
  const investedAfter = currentInvested + buyCost;
  const remainingBudget = stockBudget - investedAfter;
  const allocationPct = state.settings.monthlyBudget > 0 ? (investedAfter / state.settings.monthlyBudget) * 100 : 0;
  const l1 = currentAvg * (1 - state.settings.l1DipPct / 100);
  const l2 = currentAvg * (1 - state.settings.l2DipPct / 100);
  const dropFromLastBuyPct =
    lastBuyPrice && lastBuyPrice > 0 ? ((price - lastBuyPrice) / lastBuyPrice) * 100 : undefined;

  let suggestion = 'Setup looks acceptable.';
  if (price > l1) suggestion = 'Buy is early. Better to wait for stronger dip or lower zone.';
  if (price <= l2) suggestion = 'Strong discount zone (L2). Consider staggered buying.';
  if (allocationPct > state.settings.allocationLimitPct) suggestion = 'Over allocation limit. Reduce quantity or skip this order.';

  return {
    stock: symbol,
    qty,
    price,
    buyCost,
    currentAvg,
    projectedAvg,
    l1,
    l2,
    lastBuyPrice,
    dropFromLastBuyPct,
    stockBudget,
    remainingBudget,
    allocationPct,
    suggestion
  };
}

function runPreBuyChecklist(summary: PreBuySummary, state: AppState): ChecklistResult {
  const checks = [
    { ok: summary.price <= summary.l1, label: 'Price near/below L1 zone' },
    { ok: summary.allocationPct <= state.settings.allocationLimitPct, label: `Within allocation limit (${state.settings.allocationLimitPct}%)` },
    { ok: summary.projectedAvg <= summary.currentAvg * 1.03, label: 'Projected avg controlled' }
  ];

  let score = 0;
  const reasons: string[] = [];
  for (const check of checks) {
    if (check.ok) score += 1;
    else reasons.push(check.label);
  }

  const total = checks.length;
  return {
    passed: score >= 2,
    score,
    total,
    reasons
  };
}

function toneClass(tone: 'good' | 'bad' | 'neutral'): string {
  if (tone === 'good') return 'profit';
  if (tone === 'bad') return 'loss';
  return '';
}

function money(value: number, currency: string): string {
  return formatCurrency(Number(value || 0), currency);
}

function mergeExpenseDebtRows(state: AppState): Array<{
  type: 'EXPENSE' | 'DEBT' | 'CREDIT';
  date: string;
  label: string;
  amount: number;
  meta: string;
  note: string;
  payment: string;
  category: string;
  id: string;
}> {
  const rows: Array<{
    type: 'EXPENSE' | 'DEBT' | 'CREDIT';
    date: string;
    label: string;
    amount: number;
    meta: string;
    note: string;
    payment: string;
    category: string;
    id: string;
  }> = [];

  state.expenses.forEach((row) => {
    rows.push({
      type: 'EXPENSE',
      date: row.date,
      label: row.category,
      amount: row.amount,
      meta: row.paymentMode,
      note: row.note || '',
      payment: row.paymentMode || '',
      category: row.category,
      id: row.id
    });
  });

  state.debtItems.forEach((row) => {
    rows.push({
      type: 'DEBT',
      date: row.date,
      label: row.person,
      amount: row.amount,
      meta: row.type,
      note: row.note || '',
      payment: row.type,
      category: row.category || row.person,
      id: row.id
    });
  });

  state.creditItems.forEach((row) => {
    rows.push({
      type: 'CREDIT',
      date: row.date,
      label: row.category,
      amount: row.amount,
      meta: 'CREDIT',
      note: row.note || '',
      payment: '-',
      category: row.category,
      id: row.id
    });
  });

  return rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function buildExpenseDebtMonthly(state: AppState): {
  monthSeries: Array<{ month: string; expense: number; debt: number; credit: number }>;
  maxMonth: number;
} {
  const monthMap = new Map<string, { expense: number; debt: number; credit: number }>();
  const pushMonth = (month: string, type: 'expense' | 'debt' | 'credit', amount: number): void => {
    if (!month) return;
    const current = monthMap.get(month) || { expense: 0, debt: 0, credit: 0 };
    current[type] += amount;
    monthMap.set(month, current);
  };

  state.expenses.forEach((row) => {
    const key = String(row.date || '').slice(0, 7);
    pushMonth(key, 'expense', Number(row.amount || 0));
  });
  state.debtItems.forEach((row) => {
    const key = String(row.date || '').slice(0, 7);
    const amount = Number(row.amount || 0);
    pushMonth(key, 'debt', amount);
  });
  state.creditItems.forEach((row) => {
    const key = String(row.date || '').slice(0, 7);
    const amount = Number(row.amount || 0);
    pushMonth(key, 'credit', amount);
  });

  const monthSeries = Array.from(monthMap.entries())
    .map(([month, totals]) => ({ month, ...totals }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6);
  const maxMonth = Math.max(1, ...monthSeries.flatMap((m) => [m.expense, m.debt, m.credit]));

  return { monthSeries, maxMonth };
}

function renderExpenseDebtTransactions(state: AppState): string {
  const expenseSummary = summarizeExpenses(state.expenses);
  const debtSummary = summarizeDebt(state.debtItems);
  const summaryRows = mergeExpenseDebtRows(state);
  const creditTotal = state.creditItems.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const netDebt = debtSummary.outstanding;
  const todayIso = toIsoDate(new Date());
  const monthStartIso = startOfMonthIso(new Date());

  return `
    <section class="txned-layout">
      <section class="txned-kpis">
        <article class="txned-kpi-card">
          <span>Expenses</span>
          <strong>${money(expenseSummary.total, state.settings.currency)}</strong>
          <em>Monthly spend</em>
        </article>
        <article class="txned-kpi-card">
          <span>Debts</span>
          <strong>${money(debtSummary.borrowed, state.settings.currency)}</strong>
          <em>Borrowed total</em>
        </article>
        <article class="txned-kpi-card">
          <span>Credit</span>
          <strong>${money(creditTotal, state.settings.currency)}</strong>
          <em>Credit total</em>
        </article>
        <article class="txned-kpi-card">
          <span>Net Debt</span>
          <strong>${money(netDebt, state.settings.currency)}</strong>
          <em>Outstanding</em>
        </article>
      </section>

      <section class="txned-main-grid">
        <section class="panel txned-form-card">
          <div class="txned-form-head">
            <h3>Add Transaction</h3>
            <p class="muted">Daily debts, expenses, investments & credits</p>
          </div>
          <div class="txned-tabs">
            <button type="button" class="mini active" data-txned-tab="expense">Expense</button>
            <button type="button" class="mini ghost" data-txned-tab="debt">Debt</button>
            <button type="button" class="mini ghost" data-txned-tab="credit">Credit</button>
          </div>

          <div class="txned-pane" data-txned-panel="expense">
            <form id="expense-form" class="stack compact">
              <input name="id" type="hidden" />
              <input name="date" type="date" value="${todayIso}" required />
              <select name="category" required>
                <option value="" disabled selected>Select category</option>
                ${getExpenseCategories().map((cat) => `<option value="${esc(cat)}">${esc(cat)}</option>`).join('')}
              </select>
              <input name="amount" type="number" min="0.01" step="0.01" placeholder="Amount (INR)" required />
              <select name="paymentMode" required>
                <option value="" disabled selected>Select payment</option>
                <option value="UPI">UPI</option>
                <option value="CASH">CASH</option>
                <option value="NETBANKING">NetBanking</option>
              </select>
              <input name="note" type="text" placeholder="Note (optional)" />
              <button type="submit">Add Transaction</button>
            </form>
          </div>

          <div class="txned-pane hidden" data-txned-panel="debt">
            <form id="debt-form" class="stack compact txned-debt-form">
              <input name="id" type="hidden" />
              <input name="date" type="date" value="${todayIso}" required />
              <input name="person" type="text" placeholder="Person name" required />
              <select id="txned-debt-category" name="debtCategory" required>
                <option value="" disabled selected>Select category</option>
                ${getDebtCategories().map((cat) => `<option value="${esc(cat)}">${esc(cat)}</option>`).join('')}
              </select>
              <select id="txned-credit-category" name="creditCategory" class="hidden" required>
                <option value="" disabled selected>Select category</option>
                ${getCreditCategories().map((cat) => `<option value="${esc(cat)}">${esc(cat)}</option>`).join('')}
              </select>
              <input name="amount" type="number" min="0.01" step="0.01" placeholder="Amount (INR)" required />
              <input name="note" type="text" placeholder="Note (optional)" />
              <button type="submit">Add Transaction</button>
            </form>
          </div>
        </section>

        <section class="panel txned-categories-card">
          <div class="txned-history-head">
            <h3>Categories</h3>
          </div>
          <div class="txned-category-tabs">
            <button type="button" class="mini active" data-cat-tab="expense">Expense</button>
            <button type="button" class="mini ghost" data-cat-tab="debt">Debt</button>
            <button type="button" class="mini ghost" data-cat-tab="credit">Credit</button>
          </div>
          <form id="txned-category-form" class="txned-category-form">
            <input id="txned-category-input" type="text" placeholder="Add category" />
            <button type="submit">Add</button>
          </form>
          <div class="txned-category-list" data-cat-panel="expense">
            ${
              getExpenseCategories().length
                ? getExpenseCategories()
                    .map(
                      (cat) => `
                      <div class="txned-category-item">
                        <span>${esc(cat)}</span>
                        <div class="txned-category-actions">
                          <button type="button" class="mini" data-cat-type="expense" data-edit-category="${esc(cat)}">Edit</button>
                          <button type="button" class="mini ghost" data-cat-type="expense" data-del-category="${esc(cat)}">Delete</button>
                        </div>
                      </div>
                    `
                    )
                    .join('')
                : '<div class="muted">No categories yet.</div>'
            }
          </div>
          <div class="txned-category-list hidden" data-cat-panel="debt">
            ${
              getDebtCategories().length
                ? getDebtCategories()
                    .map(
                      (cat) => `
                      <div class="txned-category-item">
                        <span>${esc(cat)}</span>
                        <div class="txned-category-actions">
                          <button type="button" class="mini" data-cat-type="debt" data-edit-category="${esc(cat)}">Edit</button>
                          <button type="button" class="mini ghost" data-cat-type="debt" data-del-category="${esc(cat)}">Delete</button>
                        </div>
                      </div>
                    `
                    )
                    .join('')
                : '<div class="muted">No categories yet.</div>'
            }
          </div>
          <div class="txned-category-list hidden" data-cat-panel="credit">
            ${
              getCreditCategories().length
                ? getCreditCategories()
                    .map(
                      (cat) => `
                      <div class="txned-category-item">
                        <span>${esc(cat)}</span>
                        <div class="txned-category-actions">
                          <button type="button" class="mini" data-cat-type="credit" data-edit-category="${esc(cat)}">Edit</button>
                          <button type="button" class="mini ghost" data-cat-type="credit" data-del-category="${esc(cat)}">Delete</button>
                        </div>
                      </div>
                    `
                    )
                    .join('')
                : '<div class="muted">No categories yet.</div>'
            }
          </div>
        </section>
      </section>

      <section class="panel txned-table-card">
        <div class="txned-table-head">
          <div class="txned-chip-row">
            <button type="button" class="mini active" data-txned-chip="all">All</button>
            <button type="button" class="mini ghost" data-txned-chip="expense">Expense</button>
            <button type="button" class="mini ghost" data-txned-chip="debt">Debt</button>
            <button type="button" class="mini ghost" data-txned-chip="credit">Credit</button>
          </div>
          <div class="txned-date-filter">
            <input id="txned-date-from" type="date" value="${monthStartIso}" />
            <span>to</span>
            <input id="txned-date-to" type="date" value="${todayIso}" />
          </div>
        </div>
        <div class="table-wrap">
          <table class="txned-table">
            <thead>
              <tr><th>Date</th><th>Type</th><th>Category</th><th>Amount</th><th>Payment</th><th>Note</th><th>Action</th></tr>
            </thead>
            <tbody id="txned-table-body">
              ${
                summaryRows.length
                  ? summaryRows
                      .map((row) => {
                        const typeLabel =
                          row.type === 'EXPENSE'
                            ? 'Expense'
                            : row.type === 'CREDIT'
                              ? 'Credit'
                              : row.meta === 'REPAY'
                                ? 'Repay'
                                : 'Debt';
                        return `<tr data-kind="${row.type}" data-subtype="${esc(row.meta)}" data-date="${esc(row.date)}" data-label="${esc(row.label)}">
                          <td data-label="Date">${formatDateFromISOToDDMM(row.date)}</td>
                          <td data-label="Type">${typeLabel}</td>
                          <td data-label="Category">${esc(row.category || row.label)}</td>
                          <td data-label="Amount">${money(row.amount, state.settings.currency)}</td>
                          <td data-label="Payment">${esc(row.payment || '-') }</td>
                          <td data-label="Note">${esc(row.note || '-') }</td>
                          <td data-label="Action">
                            ${
                              row.type === 'EXPENSE'
                                ? `<button type="button" class="mini" data-edit-expense="${esc(row.id)}">Edit</button>
                                   <button type="button" class="mini ghost" data-del-expense="${esc(row.id)}">Delete</button>`
                                : row.type === 'CREDIT'
                                  ? `<button type="button" class="mini" data-edit-credit="${esc(row.id)}">Edit</button>
                                     <button type="button" class="mini ghost" data-del-credit="${esc(row.id)}">Delete</button>`
                                  : `<button type="button" class="mini" data-edit-debt="${esc(row.id)}">Edit</button>
                                     <button type="button" class="mini ghost" data-del-debt="${esc(row.id)}">Delete</button>`
                            }
                          </td>
                        </tr>`;
                      })
                      .join('')
                  : '<tr class="txned-empty-row"><td colspan="7">No entries yet.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </section>
    </section>
  `;
}

function renderExpenseDebtDashboard(state: AppState): string {
  const expenseSummary = summarizeExpenses(state.expenses);
  const debtSummary = summarizeDebt(state.debtItems);
  const { monthSeries, maxMonth } = buildExpenseDebtMonthly(state);
  const creditTotal = state.creditItems.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const netDebt = debtSummary.outstanding;

  const categoryRows = expenseSummary.byCategory.slice(0, 5);
  const totalCategory = Math.max(1, categoryRows.reduce((sum, row) => sum + row.amount, 0));
  const colors = ['#4f7cff', '#35c79a', '#f2b34d', '#7c6bf2', '#ff8f6b'];
  let offset = 0;
  const donutStops = categoryRows
    .map((row, idx) => {
      const pct = (row.amount / totalCategory) * 100;
      const start = offset;
      offset += pct;
      return `${colors[idx % colors.length]} ${start.toFixed(2)}% ${offset.toFixed(2)}%`;
    })
    .join(', ');

  const netSeries = monthSeries.map((m) => m.credit - m.expense - m.debt);
  const netSpark = buildSparkline(netSeries.length ? netSeries : [0]);

  const topCategory = categoryRows[0];
  const topPct = topCategory ? (topCategory.amount / totalCategory) * 100 : 0;

  return `
    <section class="edash-layout">
      <section class="edash-kpis">
        <article class="edash-kpi-card">
          <span>Expenses</span>
          <strong>${money(expenseSummary.total, state.settings.currency)}</strong>
        </article>
        <article class="edash-kpi-card">
          <span>Debts</span>
          <strong>${money(debtSummary.borrowed, state.settings.currency)}</strong>
        </article>
        <article class="edash-kpi-card">
          <span>Credit</span>
          <strong>${money(creditTotal, state.settings.currency)}</strong>
        </article>
        <article class="edash-kpi-card">
          <span>Net Debt</span>
          <strong>${money(netDebt, state.settings.currency)}</strong>
        </article>
      </section>

      <section class="edash-grid">
        <section class="panel edash-income-expense">
          <div class="edash-card-head">
            <h3>Income vs Expenses</h3>
          </div>
          <div class="edash-bars">
            ${monthSeries
              .map(
                (m) => `<div>
                  <strong class="bar-exp" style="height:${Math.max(8, (m.expense / maxMonth) * 100).toFixed(0)}%"></strong>
                  <strong class="bar-credit" style="height:${Math.max(8, (m.credit / maxMonth) * 100).toFixed(0)}%"></strong>
                  <span>${esc(formatMonthShort(m.month))}</span>
                </div>`
              )
              .join('')}
          </div>
          <div class="edash-bar-legend">
            <span><i class="bar-exp"></i>Expenses</span>
            <span><i class="bar-credit"></i>Credit</span>
          </div>
        </section>

        <section class="panel edash-donut-card">
          <div class="edash-card-head">
            <h3>Spending Analysis</h3>
          </div>
          <div class="edash-donut-wrap">
            <div class="edash-donut-ring" style="background: conic-gradient(${donutStops || '#e9eef9 0% 100%'});">
              <div class="edash-donut-center">${money(expenseSummary.total, state.settings.currency)}</div>
            </div>
            <div class="edash-donut-legend">
              ${
                categoryRows.length
                  ? categoryRows
                      .map((row, idx) => {
                        const pct = (row.amount / totalCategory) * 100;
                        return `<div><i style="background:${colors[idx % colors.length]}"></i>${esc(row.category)} ${pct.toFixed(0)}%</div>`;
                      })
                      .join('')
                  : '<div>No expenses yet.</div>'
              }
            </div>
          </div>
        </section>

        <section class="panel edash-networth">
          <div class="edash-card-head">
            <h3>Net Worth Growth</h3>
          </div>
          <div class="edash-line">
            <svg viewBox="0 0 ${netSpark.width} ${netSpark.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Net worth trend">
              <path class="edash-line-area" d="${netSpark.areaPath}"></path>
              <path class="edash-line-path" d="${netSpark.linePath}"></path>
            </svg>
          </div>
        </section>

        <section class="panel edash-insights">
          <div class="edash-card-head">
            <h3>Insights</h3>
          </div>
          <div class="edash-insight-list">
            <div class="edash-insight-item">Top category: ${esc(topCategory?.category || 'N/A')} (${topPct.toFixed(0)}%)</div>
            <div class="edash-insight-item">Outstanding debt: ${money(netDebt, state.settings.currency)}</div>
            <div class="edash-insight-item">Credit total: ${money(creditTotal, state.settings.currency)}</div>
          </div>
        </section>
      </section>
    </section>
  `;
}
function renderExitAnalysis(
  sim: ExitSimulationResult,
  suggestions: ExitSuggestion,
  currency: string
): string {
  const profitCls = sim.netProfit >= 0 ? 'profit' : 'loss';
  return `
    <div class="insight-card">
      <div class="insight-row-head">
        <div>
          <div class="insight-name">${esc(sim.stock)}</div>
          <div class="tiny-label">Sold ${sim.sellQty} | Price ${money(sim.sellPrice, currency)}</div>
        </div>
        <div class="insight-right">
          <div class="insight-strong ${profitCls}">${money(sim.netProfit, currency)}</div>
          <div class="tiny-label">${sim.profitPct.toFixed(2)}% profit on sold lot</div>
        </div>
      </div>

      <div class="tiny-label mt-1"><strong>Impact on Holdings</strong></div>
      <div class="insight-kv"><span>Remaining Qty</span><span>${sim.remainingQty}</span></div>
      <div class="insight-kv"><span>Old Avg -> New Avg</span><span>${money(sim.oldAvg, currency)} -> ${sim.newAvgAfterSell > 0 ? money(sim.newAvgAfterSell, currency) : '-'}</span></div>
      <div class="insight-kv"><span>Avg Improvement</span><span>${money(sim.avgImprovement, currency)}</span></div>
      <div class="insight-kv"><span>Allocation</span><span>${sim.allocBefore.toFixed(2)}% -> ${sim.allocAfter.toFixed(2)}%</span></div>
      <div class="insight-kv"><span>Historical Realized Return</span><span>${sim.myHistReturnPct.toFixed(2)}%</span></div>

      <div class="insight-sub-card">
        <div class="tiny-label"><strong>If price moves UP</strong></div>
        <div class="tiny-label">Nearest safe re-entry: ${money(suggestions.upSuggestion.nearestSafeLevel, currency)}</div>
        <div class="tiny-label">${esc(suggestions.upSuggestion.confirmationCondition)}</div>
      </div>

      <div class="insight-sub-card">
        <div class="tiny-label"><strong>If price moves DOWN</strong></div>
        <div class="tiny-label">Suggested re-buy: ${money(suggestions.downSuggestion.suggestedPrice, currency)} | Qty: ${suggestions.downSuggestion.suggestedQty}</div>
        <div class="tiny-label">Projected new avg: ${money(suggestions.downSuggestion.newAvg, currency)} (avg improve ${money(suggestions.downSuggestion.avgImprovementOnRebuy, currency)})</div>
        <div class="tiny-label">${esc(suggestions.downSuggestion.details)}</div>
      </div>

      ${
        suggestions.candidates.length
          ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Stock</th><th>Hist %</th><th>Active %</th><th>Alloc %</th></tr></thead>
          <tbody>
            ${suggestions.candidates
              .map(
                (c) => `<tr>
                  <td>${esc(c.stock)}</td>
                  <td class="${c.histPct >= 0 ? 'profit' : 'loss'}">${c.histPct.toFixed(2)}%</td>
                  <td>${c.activeReturnPct == null ? '-' : `${c.activeReturnPct.toFixed(2)}%`}</td>
                  <td>${c.capitalSharePct.toFixed(2)}%</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`
          : ''
      }
    </div>
  `;
}

function renderPageContent(view: AppView, session: UserSession, state: AppState): string {
  const holdings = calculateHoldings(state.transactions, getExpandedMappings(state), state.livePrices);

  if (view === 'dashboard') {
    return renderDashboardHome(state);
  }

  if (view === 'transactions') {
    const toDateDefault = toIsoDate(new Date());
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);
    const fromDateDefault = toIsoDate(fromDate);
    return `
      <section class="txn-toolbar panel">
        <div class="txn-toolbar-main">
          <button id="add-trade-btn" type="button">+ Add Trade</button>
          <button id="import-cta-btn" type="button" class="ghost">Import CSV</button>
          <select id="import-broker" class="ghost" aria-label="Import broker">
            <option value="AUTO">Auto-detect</option>
            <option value="ZERODHA">Zerodha</option>
            <option value="UPSTOX">Upstox</option>
            <option value="ANGEL_ONE">Angel One</option>
            <option value="GROWW">Groww</option>
            <option value="OTHER">Other</option>
          </select>
          <button id="jump-requests-btn" type="button" class="ghost mini" title="Go to ticker requests">Requests</button>
          <button id="sync-live-btn" type="button" class="ghost">Sync Live</button>
          <button id="clear-transactions-btn" type="button" class="ghost">Delete All</button>
        </div>
        <div class="tiny-label">Last Live Sync: ${state.lastLiveSyncAt ? new Date(state.lastLiveSyncAt).toLocaleString() : 'Never'}</div>
        <form id="import-form" class="txn-hidden-import">
          <input name="csv" type="file" accept=".csv,.txt,.xlsx,.xls,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" />
        </form>
      </section>

      <section class="panel txn-filter-row">
        <select id="tx-filter-side">
          <option value="ALL">All</option>
          <option value="BUY">BUY</option>
          <option value="SELL">SELL</option>
        </select>
        <input id="tx-filter-text" type="text" placeholder="Search stock..." />
        <input id="tx-filter-from" type="date" value="${fromDateDefault}" />
        <input id="tx-filter-to" type="date" value="${toDateDefault}" />
        <button id="tx-reset-filters" type="button" class="ghost">Reset</button>
      </section>

      <section class="panel">
        <div class="insight-section-head">
          <h2>Transaction History</h2>
        </div>
        <div id="txn-cards-grid" class="txn-cards-grid">
          ${transactionCards(state, state.settings.currency)}
        </div>
      </section>

      <section class="panel ticker-requests-panel" id="ticker-requests">
        <div class="insight-section-head">
          <h2>Ticker Requests</h2>
          <span class="tiny-label">Unmatched symbols are routed to admin for approval.</span>
        </div>
        <div class="ticker-requests-list">
          ${renderTickerRequests(state, session, session.role === 'ADMIN' ? 'admin' : 'user')}
        </div>
      </section>

      <div id="trade-modal" class="trade-modal" aria-hidden="true">
        <div class="trade-modal-card">
          <div class="trade-modal-head">
            <h2 id="trade-modal-title">Add New Trade</h2>
            <button id="close-trade-modal-btn" type="button" class="ghost mini">Close</button>
          </div>
          <div class="trade-tabs">
            <button id="trade-tab-details" type="button" class="mini">Trade Details</button>
            <button id="trade-tab-checklist" type="button" class="mini ghost">Run Pre-Buy Checklist</button>
          </div>
          <div id="trade-panel-details" class="trade-panel active">
            <form id="manual-form" class="stack compact">
              <input name="editId" type="hidden" />
              <input name="tradeDateTime" type="datetime-local" value="${toIsoDateTimeLocal(new Date())}" required />
              <input name="symbol" type="text" list="trade-ticker-options" placeholder="Stock Symbol (e.g. TCS)" required />
              <datalist id="trade-ticker-options">
                ${buildTickerOptions(state)}
              </datalist>
              <select name="side" required>
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
              <div class="split">
                <input name="quantity" type="number" min="1" step="1" placeholder="Quantity" required />
                <input name="price" type="number" min="0.01" step="0.01" placeholder="Price" required />
              </div>
              <input name="note" type="text" placeholder="Note (optional)" />
              <label class="muted"><input name="enforceChecklist" type="checkbox" checked /> Run Pre-Buy Checklist</label>
              <div class="actions-row">
                <button id="open-checklist-tab-btn" type="button" class="ghost">Open Checklist</button>
                <button type="submit">Save Trade</button>
              </div>
            </form>
          </div>
          <div id="trade-panel-checklist" class="trade-panel">
            <div class="actions-row">
              <button id="run-checklist-btn" type="button">Run Checklist</button>
            </div>
            <div id="checklist-output" class="muted">Checklist not run yet.</div>
            <div id="checklist-summary" class="muted"></div>
          </div>
        </div>
      </div>
      ${renderTickerRequestModal(state)}
    `;
  }

  if (view === 'holdings') {
    return renderHoldingsHome(state, holdings);
  }

  if (view === 'pnl') {
    return buildPnlStudio(state);
  }

  if (view === 'expenses') {
    return renderExpenseDebtTransactions(state);
  }
  if (view === 'debt') {
    return renderExpenseDebtDashboard(state);
  }

  if (view === 'insights') {
    const insights = buildInsightsData(state);
    const search = getInsightsSearch();
    const stockOptions = insights.stockOptions || [];
    const selectedStock =
      (search && stockOptions.find((s) => s.toUpperCase().includes(search))) ||
      stockOptions[0] ||
      '';
    const selectedAvgDown = insights.avgDownRows.find((row) => row.stock === selectedStock);
    const selectedAdvanced = insights.advancedRows.find((row) => row.stock === selectedStock);
    const selectedCapital = insights.capitalRows.find((row) => row.stock === selectedStock);
    const currentPrice = selectedCapital?.referencePrice || selectedAvgDown?.l1Price || 0;
    const buyMaxDiff =
      selectedAdvanced && selectedAdvanced.buys.length
        ? Math.max(1, ...selectedAdvanced.buys.map((b) => Math.abs(b.diffPct)))
        : 1;
    const realizedRows = calculateRealizedPnlRows(state.transactions);
    const byMonth = new Map<string, number>();
    realizedRows.forEach((row) => {
      const monthKey = String(row.date || '').slice(0, 7);
      if (!monthKey) return;
      byMonth.set(monthKey, Number(byMonth.get(monthKey) || 0) + Number(row.net || 0));
    });
    const monthly = Array.from(byMonth.entries())
      .map(([month, net]) => ({ month, net }))
      .sort((a, b) => a.month.localeCompare(b.month));
    const monthSpark = buildSparkline(monthly.map((m) => Number(m.net || 0)));
    const wins = realizedRows.filter((row) => Number(row.net || 0) >= 0).length;
    const losses = realizedRows.length - wins;
    const winPct = (wins / Math.max(1, realizedRows.length)) * 100;
    return `
      <section class="panel insights-overview">
        <div class="insights-overview-head">
          <div>
            <h2>Insights Overview</h2>
            <p class="muted">Personalized insights and decision-quality trends for your portfolio.</p>
          </div>
          <div></div>
        </div>

        <div class="insights-kpi-grid">
          <article class="insight-kpi-card">
            <span>Active Holdings</span>
            <strong>${insights.summary.activeHoldings}</strong>
          </article>
          <article class="insight-kpi-card">
            <span>Active Invested</span>
            <strong>${money(insights.summary.activeInvested, state.settings.currency)}</strong>
          </article>
          <article class="insight-kpi-card">
            <span>Unrealized</span>
            <strong class="${insights.summary.unrealized >= 0 ? 'profit' : 'loss'}">${money(insights.summary.unrealized, state.settings.currency)}</strong>
          </article>
          <article class="insight-kpi-card">
            <span>Avg Return</span>
            <strong class="${insights.summary.avgReturnPct >= 0 ? 'profit' : 'loss'}">${insights.summary.avgReturnPct.toFixed(2)}%</strong>
          </article>
          <article class="insight-kpi-card">
            <span>Shares</span>
            <strong>${insights.summary.sharesPct.toFixed(1)}%</strong>
            <em>Top 5 capital share</em>
          </article>
          <article class="insight-kpi-card">
            <span>Over Allocated Stocks</span>
            <strong>${insights.summary.overAllocated}</strong>
          </article>
        </div>
      </section>

      <section class="panel portfolio-signals">
        <div class="insight-section-head">
          <h2>Portfolio Signals</h2>
          <span class="tiny-label">Monthly profit trend</span>
        </div>
        <div class="signals-grid">
          <section class="signals-chart">
            <div class="pnl-trend-chart">
              <svg viewBox="0 0 ${monthSpark.width} ${monthSpark.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Monthly profit trend">
                <path class="pnl-trend-area" d="${monthSpark.areaPath}"></path>
                <path class="pnl-trend-line" d="${monthSpark.linePath}"></path>
                ${monthSpark.points
                  .map((pt) => {
                    const row = monthly[pt.idx];
                    if (!row) return '';
                    return `<circle cx="${pt.x.toFixed(2)}" cy="${pt.y.toFixed(2)}" r="6" class="pnl-trend-point ${row.net >= 0 ? 'profit-dot' : 'loss-dot'}">
                        <title>${esc(formatMonthShort(row.month))}: ${formatCurrency(row.net, state.settings.currency)}</title>
                      </circle>`;
                  })
                  .join('')}
              </svg>
            </div>
            <div class="pnl-axis">
              ${monthly.map((m) => `<span>${esc(formatMonthShort(m.month))}</span>`).join('')}
            </div>
          </section>
          <aside class="signals-donut">
            <div class="pnl-donut-wrap">
              <div class="pnl-donut-ring" style="--p:${winPct.toFixed(2)};"></div>
              <div class="pnl-donut-center">${winPct.toFixed(0)}%</div>
            </div>
            <div class="pnl-donut-meta">
              <div><span>Wins</span><strong>${wins}</strong></div>
              <div><span>Losses</span><strong>${losses}</strong></div>
            </div>
          </aside>
        </div>
      </section>

      <section class="panel">
        <div class="insight-section-head">
          <h2>Portfolio Allocation</h2>
          <button type="button" class="mini ghost" data-toggle-panel="allocation-panel">Toggle</button>
        </div>
        <div id="allocation-panel" style="display:none">
          <div class="insight-bars">
            ${
              insights.capitalRows.length
                ? insights.capitalRows
                    .slice(0, 8)
                    .map(
                      (row) => `<div class="insight-bar-row">
                        <span>${esc(row.stock)}</span>
                        <div class="insight-bar-track">
                          <i class="insight-bar-fill bar-good" style="width:${Math.max(1, row.capitalSharePct).toFixed(2)}%"></i>
                        </div>
                        <strong>${row.capitalSharePct.toFixed(2)}%</strong>
                      </div>`
                    )
                    .join('')
                : '<p class="muted">No active holdings</p>'
            }
          </div>
          <div class="insight-list">
            ${insights.allocationRows
              .map(
                (row) => `<article class="insight-card">
                  <div class="insight-row-head">
                    <div>
                      <div class="insight-name">${esc(row.stock)}</div>
                      <span class="insight-pill ${toneClass(row.horizonTone)}">${esc(row.horizonLabel)}</span>
                      <div class="tiny-label">First Buy: ${esc(row.firstBuyDate)} | Last Buy: ${esc(row.lastBuyDate)}</div>
                    </div>
                    <div class="insight-right">
                      <div class="insight-strong">${money(row.invested, state.settings.currency)}</div>
                      <div class="tiny-label">Invested | Buys: ${row.activeBuyCount}</div>
                      <span class="insight-pill ${toneClass(row.statusTone)}">${esc(row.status)}</span>
                    </div>
                  </div>
                  <div class="tiny-label">Allocation: ${row.allocationPct.toFixed(2)}%</div>
                </article>`
              )
              .join('')}
          </div>
        </div>
      </section>

      <section class="panel insights-search-panel">
        <div class="insight-section-head">
          <h2>Focus Stock</h2>
          <span class="tiny-label">Press Enter to apply</span>
        </div>
        <div class="insights-search">
          <input id="insights-search" type="text" placeholder="Search insights..." value="${esc(search)}" />
        </div>
      </section>

      <section class="insights-duo-grid">
        <section class="panel smart-exit-card">
          <div class="insight-section-head">
            <h2>Smart Exit & Re-Entry</h2>
            <button type="button" class="mini ghost" data-toggle-panel="exit-panel">Toggle</button>
          </div>
          <div class="smart-exit-summary">
            <div>
              <div class="tiny-label">Profit Potential</div>
              <strong class="${(selectedCapital?.returnPct ?? 0) >= 0 ? 'profit' : 'loss'}">
                ${selectedCapital ? `${selectedCapital.returnPct.toFixed(2)}%` : '--'}
              </strong>
              <div class="tiny-label">
                Stock: ${esc(selectedCapital?.stock || '--')}
              </div>
            </div>
            <button id="open-exit-modal" type="button">Simulate Sell</button>
          </div>
        </section>

        <section class="panel buy-tips-card">
          <div class="insight-section-head">
            <h2>Buy More Tips</h2>
            <span class="tiny-label">Upcoming buy levels</span>
          </div>
          <div class="buy-tips-body">
            <div class="buy-tips-stock">
              <strong>${esc(selectedAvgDown?.stock || 'No data')}</strong>
              <span>${selectedAvgDown ? `${selectedAvgDown.horizonLabel}` : 'No active holdings'}</span>
            </div>
            <div class="buy-tips-bar">
              <div class="buy-tips-progress" style="width:${Math.min(100, Math.max(8, selectedAvgDown?.remainingBudget && selectedAvgDown?.maxStockBudget ? (selectedAvgDown.remainingBudget / selectedAvgDown.maxStockBudget) * 100 : 18)).toFixed(0)}%"></div>
            </div>
            <div class="buy-tips-meta">
              <span>Potential: ${money(selectedAvgDown?.remainingBudget || 0, state.settings.currency)}</span>
              <button id="buy-tips-btn" type="button">View Tips</button>
            </div>
            <div class="buy-tips-levels">
              <div>
                <div class="tiny-label">Level 1</div>
                <strong>${selectedAvgDown ? money(selectedAvgDown.l1Price, state.settings.currency) : '-'}</strong>
              </div>
              <div>
                <div class="tiny-label">Level 2</div>
                <strong>${selectedAvgDown ? money(selectedAvgDown.l2Price, state.settings.currency) : '-'}</strong>
              </div>
            </div>
          </div>
        </section>
      </section>

      <div id="exit-modal" class="trade-modal" aria-hidden="true">
        <div class="trade-modal-card insight-modal-card">
          <div class="trade-modal-head">
            <h2>Simulate Exit</h2>
            <button id="close-exit-modal" type="button" class="ghost mini">Close</button>
          </div>
          <div class="smart-exit-panel">
            <div class="split">
              <div>
                <label class="tiny-label">Stock</label>
                <input id="exitStockInput" list="exitStockOptions" type="text" placeholder="Select stock" value="${esc(selectedStock)}" />
                <datalist id="exitStockOptions">
                  ${insights.stockOptions.map((stock) => `<option value="${esc(stock)}"></option>`).join('')}
                </datalist>
              </div>
              <div>
                <label class="tiny-label">Sell Qty</label>
                <input id="exitSellQty" type="number" min="1" placeholder="Qty" />
              </div>
            </div>
            <div class="split">
              <div>
                <label class="tiny-label">Sell Price</label>
                <input id="exitSellPrice" type="number" step="0.01" min="0.01" placeholder="Price" />
              </div>
              <div>
                <div class="tiny-label">Hold days (since first buy): <strong id="exitHoldDays">-</strong></div>
                <div class="actions-row">
                  <button id="exitSimulateBtn" type="button">Simulate Sell</button>
                  <button id="exitResetBtn" type="button" class="ghost">Reset</button>
                </div>
              </div>
            </div>
            <div id="exitAnalyzerResult"></div>
          </div>
        </div>
      </div>

      <div id="buy-tips-modal" class="trade-modal" aria-hidden="true">
        <div class="trade-modal-card insight-modal-card">
          <div class="trade-modal-head">
            <h2>View Buy Tips</h2>
            <button id="close-buy-tips-modal" type="button" class="ghost mini">Close</button>
          </div>
          <div class="buy-tips-modal-body">
            <h3>${esc(selectedAvgDown?.stock || 'No stock')}</h3>
            <div class="tiny-label">Next optimal buy levels</div>
            <div class="buy-tips-levels">
              <div>
                <div class="tiny-label">Level 1</div>
                <strong>${selectedAvgDown ? money(selectedAvgDown.l1Price, state.settings.currency) : '-'}</strong>
              </div>
              <div>
                <div class="tiny-label">Level 2</div>
                <strong>${selectedAvgDown ? money(selectedAvgDown.l2Price, state.settings.currency) : '-'}</strong>
              </div>
            </div>
            <div class="buy-tips-meta">
              <span>Remaining Budget: ${money(selectedAvgDown?.remainingBudget || 0, state.settings.currency)}</span>
              <span>Max Budget: ${money(selectedAvgDown?.maxStockBudget || 0, state.settings.currency)}</span>
            </div>
          </div>
        </div>
      </div>

      <section class="panel">
        <div class="insight-section-head">
          <h2>Average Down Levels</h2>
          <button type="button" class="mini ghost" data-toggle-panel="avgdown-panel">Toggle</button>
        </div>
        <div id="avgdown-panel" class="avgdown-grid">
          ${
            selectedAvgDown
              ? `<article class="avgdown-card avgdown-shell">
                  <div class="avgdown-card-head">
                    <div class="avgdown-title">
                      <div class="insight-name">${esc(selectedAvgDown.stock)}</div>
                      <span class="avgdown-pill">${esc(selectedAvgDown.horizonLabel)}</span>
                    </div>
                    <div class="avgdown-amount">${money(selectedCapital?.invested || 0, state.settings.currency)}</div>
                  </div>
                  <div class="avgdown-inner">
                    <div class="avgdown-row">
                      <span>Current Price</span>
                      <strong>${money(currentPrice, state.settings.currency)}</strong>
                    </div>
                    <div class="avgdown-zone">
                      <div class="avgdown-zone-head">
                        <strong>L1 Zone</strong>
                        <span>${state.settings.l1DipPct}% (${state.settings.l1DipPct}%)</span>
                      </div>
                      <div class="avgdown-bar">
                        <div class="avgdown-bar-fill l1" style="width:${state.settings.l1DipPct}%"></div>
                      </div>
                      <div class="tiny-label">${state.settings.l1DipPct}% dip</div>
                    </div>
                    <div class="avgdown-zone">
                      <div class="avgdown-zone-head">
                        <strong>L2 Zone</strong>
                        <span>${state.settings.l2DipPct}% (${state.settings.l2DipPct}%)</span>
                      </div>
                      <div class="avgdown-bar">
                        <div class="avgdown-bar-fill l2" style="width:${state.settings.l2DipPct}%"></div>
                      </div>
                      <div class="tiny-label">${state.settings.l2DipPct}% dip</div>
                    </div>
                    <div class="avgdown-warning">
                      ${selectedAvgDown.warning ? esc(selectedAvgDown.warning) : 'Wait for L1 price zone'}
                    </div>
                  </div>
                </article>`
              : '<div class="txn-empty">No matching stock found.</div>'
          }
        </div>
      </section>

      <section class="panel">
        <div class="insight-section-head">
          <h2>Advanced Analysis</h2>
          <button type="button" class="mini ghost" data-toggle-panel="advanced-panel">Toggle</button>
        </div>
        <div id="advanced-panel" class="advanced-grid">
          ${
            selectedAdvanced
              ? `<article class="advanced-card advanced-shell">
                  <div class="advanced-head">
                    <div class="insight-name">${esc(selectedAdvanced.stock)}</div>
                    <span class="avgdown-pill">${esc(selectedAdvanced.allocationRisk)}</span>
                  </div>
                  <div class="tiny-label">Review your historical buys, price impact, and timing to enhance decision quality.</div>
                  <div class="advanced-timeline">
                    <div class="advanced-timeline-head">
                      <strong>Buy Timeline</strong>
                      <span>${money(selectedAdvanced.invested / Math.max(1, selectedAdvanced.activeQty), state.settings.currency)}</span>
                    </div>
                    ${selectedAdvanced.buys
                      .map((buy) => {
                        const width = Math.max(10, Math.min(100, (Math.abs(buy.diffPct) / buyMaxDiff) * 100));
                        const barClass = buy.diffPct >= 0 ? 'good' : 'bad';
                        return `
                        <div class="advanced-timeline-row">
                          <div>Buy #${buy.index + 1}</div>
                          <div class="advanced-bar">
                            <i class="${barClass}" style="width:${width.toFixed(0)}%"></i>
                          </div>
                          <div>${money(buy.price, state.settings.currency)}</div>
                        </div>
                      `;
                      })
                      .join('')}
                  </div>
                  <div class="advanced-action">
                    <div>
                      <div class="tiny-label">Next Action</div>
                      <strong>${esc(selectedAdvanced.suggestion)}</strong>
                    </div>
                  </div>
                </article>`
              : '<div class="txn-empty">No matching stock found.</div>'
          }
        </div>
      </section>
    `;
  }

  if (view === 'target') {
    return renderTargetPlanner(state);
  }

  if (view === 'cloud') {
    const registry = Array.isArray(state.tickerRegistry) ? state.tickerRegistry : [];
    const totalMappings = registry.length;
    const validMappings = registry.filter((m) => isValidTickerFormat(m.ticker)).length;
    const invalidMappings = Math.max(0, totalMappings - validMappings);
    const lastSyncText = state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : 'Never';
    const autoSyncEnabled = getCloudAutoSyncEnabled();
    const autoSyncInterval = getCloudAutoSyncInterval();
    const logs = getActivityLogs().slice(0, 20);
    return `
      <section class="cloud-header">
        <div>
          <p class="muted">Manage backups, synchronization and live data</p>
        </div>
      </section>

      <section class="cloud-kpi-row">
        <article class="panel cloud-kpi-card">
          <span class="cloud-kpi-title">Last Sync</span>
          <strong>${lastSyncText}</strong>
          <em class="muted">Upload local database</em>
        </article>
        <article class="panel cloud-kpi-card">
          <span class="cloud-kpi-title">Last Snapshot</span>
          <strong>${state.transactions.length + state.expenses.length + state.debtItems.length + state.creditItems.length}</strong>
          <em class="muted">Holdings: ${calculateHoldings(state.transactions, getExpandedMappings(state), state.livePrices).length}</em>
        </article>
        <article class="panel cloud-kpi-card">
          <span class="cloud-kpi-title">Auto Sync</span>
          <strong>Enabled</strong>
          <em class="muted">Interval: 10 min</em>
        </article>
        <article class="panel cloud-kpi-card cloud-live-card">
          <span class="cloud-kpi-title">Live Price Feed</span>
          <strong>Active</strong>
          <em class="muted">Interval: ${state.settings.livePriceRefreshSec} sec</em>
        </article>
      </section>

      <section class="panel cloud-actions">
        <h3>Cloud Backup</h3>
        <div class="cloud-action-grid">
          <button id="push-btn" type="button" class="cloud-action primary">Push to Cloud</button>
          <button id="pull-btn" type="button" class="cloud-action ghost">Pull from Cloud</button>
          <button id="create-snapshot-btn" type="button" class="cloud-action">Create Snapshot</button>
          <label class="cloud-action success cloud-file-btn">
            Restore Snapshot
            <input id="restore-snapshot-input" type="file" accept=".json" />
          </label>
        </div>
        <div class="cloud-export-row">
          <button id="export-excel-btn" class="ghost mini" type="button">Export Excel</button>
          <button id="export-word-btn" class="ghost mini" type="button">Export Word</button>
        </div>
      </section>

      <section class="cloud-grid">
        <section class="panel cloud-card">
          <h3>Ticker Summary</h3>
          <div class="cloud-ticker-grid">
            <button id="open-mapping-btn" type="button" class="cloud-ticker-item">
              <span>Total Tickers</span>
              <strong>${totalMappings}</strong>
            </button>
            <div class="cloud-ticker-item">
              <span>Valid Tickers</span>
              <strong>${validMappings}</strong>
            </div>
            <div class="cloud-ticker-item">
              <span>Invalid Tickers</span>
              <strong>${invalidMappings}</strong>
            </div>
          </div>
        </section>

        <section class="panel cloud-card">
          <h3>Auto Sync</h3>
          <div class="cloud-auto-row">
            <label class="cloud-toggle">
              <input id="cloud-autosync-toggle" type="checkbox" ${autoSyncEnabled ? 'checked' : ''} />
              <span>Enabled</span>
            </label>
            <div class="cloud-input">
              <span>Sync Interval (min)</span>
              <input id="cloud-autosync-interval" type="number" min="1" value="${autoSyncInterval}" />
            </div>
            <div class="cloud-input">
              <span>Price Refresh (sec)</span>
              <input id="cloud-price-interval" type="number" min="10" value="${state.settings.livePriceRefreshSec}" />
            </div>
          </div>
          <button id="cloud-save-settings" class="cloud-action primary" type="button">Save Changes</button>
        </section>
      </section>

      <section class="panel cloud-card cloud-logs">
        <div class="insight-section-head">
          <h3>Log Summary</h3>
          <div class="cloud-log-filters">
            <select id="cloud-log-type">
              <option value="all" selected>All</option>
              <option value="auth">Auth</option>
              <option value="trade">Trades</option>
              <option value="expense">Expense</option>
              <option value="debt">Debt</option>
              <option value="credit">Credit</option>
              <option value="cloud">Cloud</option>
              <option value="mapping">Mapping</option>
            </select>
            <input id="cloud-log-search" type="text" placeholder="Search logs..." />
          </div>
        </div>
        <ul id="cloud-log-list" class="cloud-activity">
          ${
            logs.length
              ? logs
                  .map((log) => `<li data-log-type="${esc(log.type)}"><span class="dot ok"></span>${esc(log.detail)} <em>${new Date(log.ts).toLocaleString()}</em></li>`)
                  .join('')
              : '<li><span class="dot warn"></span>No logs yet.</li>'
          }
        </ul>
      </section>
    `;
  }

  if (view === 'settings') {
    const currency = state.settings.currency;
    const portfolioSize = Number(state.settings.portfolioSize || 0);
    const monthlyBudget = Number(state.settings.monthlyBudget || 0);
    const maxAllocationRaw = Number(state.settings.allocationLimitPct);
    const maxAllocationPct = Number.isFinite(maxAllocationRaw) ? maxAllocationRaw : 0;
    const maxAllocationAmt = (portfolioSize * maxAllocationPct) / 100;
    const l1Dip = Number(state.settings.l1DipPct || 0);
    const l2Dip = Number(state.settings.l2DipPct || 0);
    const sellTarget = Number(state.settings.sellTargetPct || 0);
    const stopLoss = Number(state.settings.stopLossPct || 0);
    const buyBrokerage = Number(state.settings.brokerageBuyPct || 0);
    const sellBrokerage = Number(state.settings.brokerageSellPct || 0);
    const dpCharge = Number(state.settings.dpCharge || 0);
    const liveRefresh = Number(state.settings.livePriceRefreshSec || 0);
    const healthTone =
      stopLoss >= 12 || maxAllocationPct >= 20 ? 'risk' : stopLoss >= 8 || maxAllocationPct >= 15 ? 'warn' : 'ok';
    const healthLabel = healthTone === 'risk' ? 'High' : healthTone === 'warn' ? 'Medium' : 'Good';
    return `
      <section class="settings-page">
        <header class="settings-hero">
          <div>
            <p class="muted">Configure portfolio, risk, brokerage, and market data rules.</p>
          </div>
          <div class="settings-hero-meta">
            <div class="meta-pill">Role: ${esc(session.role)}</div>
            <div class="meta-pill">Profile: ${esc(session.name)}</div>
          </div>
        </header>
        <form id="strategy-settings-form" class="settings-grid">
          <section class="settings-card span-2">
            <div class="card-head">
              <span class="card-icon">PC</span>
              <div>
                <h3>Portfolio Configuration</h3>
                <p class="tiny-label">Sizing and allocation limits</p>
              </div>
            </div>
            <div class="settings-panel">
              <div class="settings-row">
                <label>Portfolio Size</label>
                <div class="settings-input">
                  <input name="portfolioSize" type="number" step="1" min="0" value="${state.settings.portfolioSize}" />
                </div>
              </div>
              <div class="settings-row">
                <label>Monthly Budget</label>
                <div class="settings-input">
                  <input name="monthlyBudget" type="number" step="1" min="0" value="${state.settings.monthlyBudget}" />
                </div>
              </div>
              <div class="settings-row">
                <label>Per Stock Budget</label>
                <div class="settings-input">
                  <input name="stockBudget" type="number" step="1" min="0" value="${state.settings.stockBudget}" />
                </div>
              </div>
              <div class="settings-row">
                <label>Max Allocation %</label>
                <div class="settings-input">
                  <input name="allocationLimitPct" type="number" step="0.1" min="1" max="100" value="${state.settings.allocationLimitPct}" />
                </div>
              </div>
              <div class="settings-progress">
                <span>Max stock allocation</span>
                <strong>${formatCurrency(maxAllocationAmt, currency)}</strong>
              </div>
            </div>
          </section>

          <section class="settings-card">
            <div class="card-head">
              <span class="card-icon warm">RM</span>
              <div>
                <h3>Risk Management</h3>
                <p class="tiny-label">Dip, targets, and guardrails</p>
              </div>
            </div>
            <div class="settings-panel">
              <div class="settings-row">
                <label>L1 Dip</label>
                <div class="settings-input">
                  <input name="l1DipPct" type="number" step="0.1" min="1" max="50" value="${state.settings.l1DipPct}" />
                </div>
              </div>
              <div class="settings-row">
                <label>L2 Dip</label>
                <div class="settings-input">
                  <input name="l2DipPct" type="number" step="0.1" min="1" max="60" value="${state.settings.l2DipPct}" />
                </div>
              </div>
              <div class="settings-row">
                <label>Sell Target</label>
                <div class="settings-input">
                  <input name="sellTargetPct" type="number" step="0.1" min="0" value="${state.settings.sellTargetPct}" />
                </div>
              </div>
              <div class="settings-row">
                <label>Stop Loss</label>
                <div class="settings-input">
                  <input name="stopLossPct" type="number" step="0.1" min="0" value="${state.settings.stopLossPct}" />
                </div>
              </div>
              <div class="settings-row">
                <label>Min Hold Days</label>
                <div class="settings-input">
                  <input name="minHoldDaysTrim" type="number" step="1" min="0" value="${state.settings.minHoldDaysTrim}" />
                </div>
              </div>
              <div class="settings-badges">
                <span class="badge">${l1Dip.toFixed(1)}% dip</span>
                <span class="badge">${l2Dip.toFixed(1)}% dip</span>
                <span class="badge">${sellTarget.toFixed(1)}% target</span>
                <span class="badge ${stopLoss >= 10 ? 'badge-warn' : 'badge-ok'}">${stopLoss.toFixed(1)}% stop</span>
              </div>
            </div>
          </section>

          <section class="settings-card span-2">
            <div class="card-head">
              <span class="card-icon cool">TC</span>
              <div>
                <h3>Trading Costs</h3>
                <p class="tiny-label">Brokerage and charges</p>
              </div>
            </div>
            <div class="settings-panel">
              <div class="settings-row">
                <label>Buy Brokerage %</label>
                <div class="settings-input">
                  <input name="brokerageBuyPct" type="number" step="0.01" min="0" value="${state.settings.brokerageBuyPct}" />
                </div>
              </div>
              <div class="settings-row">
                <label>Sell Brokerage %</label>
                <div class="settings-input">
                  <input name="brokerageSellPct" type="number" step="0.01" min="0" value="${state.settings.brokerageSellPct}" />
                </div>
              </div>
              <div class="settings-row">
                <label>DP Charge</label>
                <div class="settings-input">
                  <input name="dpCharge" type="number" step="0.01" min="0" value="${state.settings.dpCharge}" />
                </div>
              </div>
              <div class="settings-footnote tiny-label">
                Example: Buy ${formatCurrency(10000, currency)} | Brokerage ${buyBrokerage.toFixed(2)}% | Sell ${sellBrokerage.toFixed(2)}% | DP ${formatCurrency(dpCharge, currency)}
              </div>
            </div>
          </section>

          <section class="settings-card">
            <div class="card-head">
              <span class="card-icon green">MD</span>
              <div>
                <h3>Market Data</h3>
                <p class="tiny-label">Inflation and live feeds</p>
              </div>
            </div>
            <div class="settings-panel">
              <div class="settings-row">
                <label>FD Rate %</label>
                <div class="settings-input">
                  <input name="fdRatePct" type="number" step="0.1" min="0" value="${state.settings.fdRatePct}" />
                </div>
              </div>
              <div class="settings-row">
                <label>Inflation Rate %</label>
                <div class="settings-input">
                  <input name="inflationRatePct" type="number" step="0.1" min="0" value="${state.settings.inflationRatePct}" />
                </div>
              </div>
              <div class="settings-row">
                <label>Live Price Refresh (sec)</label>
                <div class="settings-input">
                  <input name="livePriceRefreshSec" type="number" step="1" min="60" value="${state.settings.livePriceRefreshSec}" />
                </div>
              </div>
              <div class="settings-status">
                <span class="badge badge-ok">Connected</span>
                <span class="tiny-label">Last synced: ${new Date(state.lastLiveSyncAt || Date.now()).toLocaleString()}</span>
              </div>
            </div>
          </section>

          <section class="settings-card summary-card">
            <div class="card-head">
              <span class="card-icon">SS</span>
              <div>
                <h3>Strategy Summary</h3>
                <p class="tiny-label">Live snapshot of current rules</p>
              </div>
            </div>
            <div class="summary-list">
              <div><span>Portfolio Size</span><strong>${formatCurrency(portfolioSize, currency)}</strong></div>
              <div><span>Monthly Budget</span><strong>${formatCurrency(monthlyBudget, currency)}</strong></div>
              <div><span>Max Stock Allocation</span><strong>${formatCurrency(maxAllocationAmt, currency)}</strong></div>
              <div><span>Risk Per Trade</span><strong>${stopLoss.toFixed(1)}%</strong></div>
              <div><span>Expected Profit Target</span><strong>${sellTarget.toFixed(1)}%</strong></div>
              <div><span>Live Refresh</span><strong>${liveRefresh}s</strong></div>
            </div>
            <div class="summary-health">
              <div>
                <span>Strategy Health</span>
                <strong class="status-pill ${healthTone}">${healthLabel}</strong>
              </div>
              <div>
                <span>Allocation Limit</span>
                <strong class="${maxAllocationPct <= 15 ? 'ok' : 'warn'}">${maxAllocationPct <= 15 ? 'OK' : 'Review'}</strong>
              </div>
              <div>
                <span>Live Feed</span>
                <strong class="ok">Active</strong>
              </div>
            </div>
          </section>

          <div class="settings-save">
            <button type="submit" class="settings-save-btn">Save Settings</button>
          </div>
        </form>
      </section>
    `;
  }

  if (view === 'admin') {
    if (session.role !== 'ADMIN') {
      return `<section class="panel"><h2>Admin Control</h2><p class="muted">Admin access required.</p></section>`;
    }
    return `
      <section class="admin-panel">
        <section class="admin-kpi-grid">
          <article class="panel admin-kpi-card">
            <span>Pending Requests</span>
            <strong id="admin-kpi-pending">--</strong>
            <em class="tiny-label">Awaiting approval</em>
          </article>
          <article class="panel admin-kpi-card">
            <span>Active Users</span>
            <strong id="admin-kpi-users">--</strong>
            <em class="tiny-label">Status: Active</em>
          </article>
          <article class="panel admin-kpi-card">
            <span>Last Cloud Sync</span>
            <strong>${state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : 'Never'}</strong>
            <em class="tiny-label">From this session</em>
          </article>
          <article class="panel admin-kpi-card">
            <span>Live Price Feed</span>
            <strong class="ok">${state.lastLiveSyncAt ? 'Active' : 'Idle'}</strong>
            <em class="tiny-label">Next run: <span data-live-sync-countdown>--</span></em>
          </article>
        </section>

        <section class="admin-main-grid">
          <section class="panel admin-users-panel">
            <div class="insight-section-head">
              <h2>User Management</h2>
              <div class="actions-row">
                <input id="admin-user-search" type="text" placeholder="Search user..." />
                <select id="admin-user-filter">
                  <option value="ALL">All</option>
                  <option value="ACTIVE">Active</option>
                  <option value="DISABLED">Disabled</option>
                </select>
                <button id="admin-users-refresh" type="button" class="mini">Refresh</button>
              </div>
            </div>
            <div class="table-wrap">
              <table class="admin-users-table">
                <thead>
                  <tr>
                    <th>Name</th><th>Login</th><th>Role</th><th>Status</th><th>Created</th><th>Action</th>
                  </tr>
                </thead>
                <tbody id="admin-users-body"><tr class="admin-empty-row"><td colspan="6">Loading users...</td></tr></tbody>
              </table>
            </div>
          </section>

          <section class="panel admin-pending-panel">
            <div class="insight-section-head">
              <h2>Requests Queue</h2>
              <button id="admin-pending-refresh" type="button" class="mini">Refresh</button>
            </div>
            <div class="table-wrap">
              <table class="admin-pending-table">
                <thead>
                  <tr>
                    <th>Name</th><th>Login</th><th>Email</th><th>Requested</th><th>Action</th>
                  </tr>
                </thead>
                <tbody id="admin-pending-body"><tr class="admin-empty-row"><td colspan="5">Loading pending requests...</td></tr></tbody>
              </table>
            </div>
          </section>
          <section class="panel admin-ticker-panel">
            <div class="insight-section-head">
              <h2>NSE Master</h2>
              <div class="actions-row">
                <button id="admin-nse-import" type="button" class="mini ghost">Upload NSE Master</button>
                <input id="admin-nse-file" type="file" accept=".csv" hidden />
              </div>
            </div>
            <div class="tiny-label">
              NSE master rows: ${(state.nseMaster || []).length}
            </div>
          </section>
        </section>

        <section class="panel admin-ticker-requests">
          <div class="insight-section-head">
            <h2>Ticker Requests</h2>
            <span class="tiny-label">Approve to add to registry and auto-fix past trades.</span>
          </div>
          <div class="ticker-requests-list">
            ${renderTickerRequests(state, session, 'admin')}
          </div>
        </section>

        <section class="panel admin-system-panel">
          <div class="insight-section-head">
            <h2>System & Sync</h2>
            <div class="actions-row">
              <button id="admin-live-sync" type="button" class="mini">Run Live Price Sync</button>
              <button id="admin-cloud-push" type="button" class="mini ghost">Run Cloud Push</button>
              <button id="admin-cloud-pull" type="button" class="mini ghost">Run Cloud Pull</button>
            </div>
          </div>
          <div class="admin-sync-grid">
            <div>
              <span class="tiny-label">Live Price Sync</span>
              <strong data-live-sync-countdown>--</strong>
            </div>
            <div>
              <span class="tiny-label">Cloud Auto Sync</span>
              <strong data-cloud-sync-countdown>--</strong>
            </div>
            <div>
              <span class="tiny-label">Last Cloud Sync</span>
              <strong>${state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : 'Never'}</strong>
            </div>
          </div>
          <div class="admin-config-row">
            <label class="tiny-label">Maximum Snapshot Count</label>
            <div class="admin-config-controls">
              <input id="admin-max-snapshots" type="number" min="1" value="10" />
              <button id="admin-save-config" type="button" class="mini">Save</button>
              <button id="admin-trim-snapshots" type="button" class="mini ghost">Trim Now</button>
            </div>
            <div class="tiny-label">Applies per user; older snapshots are deleted on sync/restore.</div>
          </div>
        </section>

          <section class="panel admin-activity-panel">
            <div class="insight-section-head">
              <h2>Activity & Audit</h2>
              <div class="actions-row">
                <select id="admin-log-filter">
                  <option value="all">All</option>
                <option value="auth">Auth</option>
                <option value="cloud">Cloud</option>
                <option value="trade">Trades</option>
                <option value="mapping">Mapping</option>
              </select>
              <input id="admin-log-search" type="text" placeholder="Search logs..." />
            </div>
          </div>
          <ul id="admin-log-list" class="cloud-activity"></ul>
        </section>
      </section>
      ${renderTickerRequestModal(state)}
    `;
  }

  return '';
}

function viewLabel(view: AppView): string {
  if (view === 'transactions') return 'Trades';
  if (view === 'holdings') return 'Holdings';
  if (view === 'pnl') return 'Profit / Loss';
  if (view === 'expenses') return 'Transactions';
  if (view === 'debt') return 'Expense & Debt Dashboard';
  if (view === 'insights') return 'Insights';
  if (view === 'cloud') return 'Cloud Sync';
  if (view === 'settings') return 'Settings';
  if (view === 'admin') return 'Admin Control';
  if (view === 'target') return 'Target Planner';
  return 'Dashboard';
}

function pagePath(view: AppView): string {
  if (view === 'transactions') return './transactions.html';
  if (view === 'holdings') return './holdings.html';
  if (view === 'pnl') return './pnl.html';
  if (view === 'expenses') return './expenses.html';
  if (view === 'debt') return './debt.html';
  if (view === 'insights') return './insights.html';
  if (view === 'cloud') return './cloud.html';
  if (view === 'settings') return './settings.html';
  if (view === 'admin') return './admin.html';
  if (view === 'target') return './target.html';
  return './dashboard.html';
}

function renderWorkspace(
  root: HTMLElement,
  session: UserSession,
  state: AppState,
  view: AppView,
  message = ''
): void {
  const holdings = calculateHoldings(state.transactions, getExpandedMappings(state), state.livePrices);
  const snapshot = dashboardFromState(state);
  const effectiveView = view === 'admin' && session.role !== 'ADMIN' ? 'dashboard' : view;
  const viewKey = effectiveView;
  const insightsView = viewKey === 'insights' ? buildInsightsData(state) : null;
  const menuItems: Array<{ view: AppView; label: string; icon: string }> = [
    { view: 'dashboard', label: 'Dashboard', icon: 'DB' },
    { view: 'transactions', label: 'Trades', icon: 'TX' },
    { view: 'holdings', label: 'Holdings', icon: 'HD' },
    { view: 'pnl', label: 'Profit / Loss', icon: 'PL' },
    { view: 'expenses', label: 'Transactions', icon: 'TR' },
    { view: 'debt', label: 'Expense & Debt Dashboard', icon: 'ED' },
    { view: 'insights', label: 'Insights', icon: 'IN' },
    { view: 'target', label: 'Target Planner', icon: 'TG' },
    { view: 'cloud', label: 'Cloud Sync', icon: 'CL' },
    { view: 'settings', label: 'Settings', icon: 'ST' }
  ];
  if (session.role === 'ADMIN') {
    menuItems.push({ view: 'admin', label: 'Admin Control', icon: 'AD' });
  }

  root.innerHTML = `
    <main class="screen app-screen workspace">
      <aside class="sidebar">
        <button id="app-logo-btn" type="button" class="logo-btn">${APP_NAME}</button>
        <p>${session.name}</p>
        <nav class="menu">
          ${menuItems
            .map(
              (item) => `<a class="menu-item ${view === item.view ? 'active' : ''}" href="${pagePath(item.view)}">
                <span class="menu-icon">${item.icon}</span>
                <span>${item.label}</span>
              </a>`
            )
            .join('')}
        </nav>
        <section class="sidebar-user">
          <div class="sidebar-avatar">${session.name.slice(0, 1).toUpperCase()}</div>
          <div>
            <div class="sidebar-user-name">${session.name}</div>
            <div class="sidebar-user-role">${session.role}</div>
          </div>
          <button id="logout-btn" class="ghost">Logout</button>
        </section>
      </aside>

      <section class="content">
        <header class="mobile-header">
          <button id="mobile-menu-btn" type="button" class="mobile-icon-btn" aria-label="Open menu">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
            </svg>
          </button>
          <button id="mobile-logo-btn" type="button" class="mobile-logo-btn">${APP_NAME}</button>
          <div class="mobile-header-actions">
            <button id="mobile-info-btn" type="button" class="mobile-icon-btn" aria-label="Info">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/>
                <path d="M12 10.5v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                <circle cx="12" cy="7.5" r="1" fill="currentColor"/>
              </svg>
            </button>
            <button id="mobile-profile-btn" type="button" class="mobile-icon-btn" aria-label="Profile">${session.name.slice(0, 1).toUpperCase()}</button>
          </div>
        </header>
        <header class="topbar">
          <div class="topbar-title">
            <h1>${viewLabel(effectiveView)}</h1>
            <p>${session.name} | Role: ${session.role}</p>
          </div>
          <div class="topbar-search">
            <form id="global-search-form" class="topbar-search-form">
              <input id="global-search-input" type="text" placeholder="Try: / to search, tx INFY, holding CDSL, pnl, cloud..." />
            </form>
            <div class="profile-menu-wrap">
              <button id="profile-menu-btn" type="button" class="profile-btn">${session.name.slice(0, 1).toUpperCase()}</button>
              <div id="profile-menu" class="profile-menu">
                <div class="profile-menu-title">${session.name}</div>
                <div class="tiny-label">Role: ${session.role}</div>
                <button id="profile-logout-btn" type="button" class="ghost mini">Logout</button>
              </div>
            </div>
          </div>
        </header>

        <section class="dashboard-grid ${viewKey === 'dashboard' ? 'dashboard-grid-home' : ''}">
          <div class="main-col">${renderPageContent(viewKey, session, state)}</div>
          ${
            viewKey === 'dashboard'
              ? ''
              : `<aside class="right-col">
                  <section class="panel profile-card">
                    <div class="account-head">
                      <div class="avatar">${session.name.slice(0, 1).toUpperCase()}</div>
                      <div>
                        <h3>${session.name}</h3>
                        <span class="account-role">${session.role}</span>
                      </div>
                    </div>
                    <div class="account-meta">
                      <div><span>Live Price Sync</span><strong data-live-sync-countdown>--</strong></div>
                      <div><span>Last Sync</span><strong>${state.lastLiveSyncAt ? new Date(state.lastLiveSyncAt).toLocaleTimeString() : 'Never'}</strong></div>
                      <div><span>Last Cloud Sync</span><strong>${state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleTimeString() : 'Never'}</strong></div>
                      <div><span>Next Cloud Sync</span><strong class="countdown-pulse" data-cloud-sync-countdown>--</strong></div>
                    </div>
                    <button id="account-sync-btn" type="button" class="mini">Sync Live Prices</button>
                  </section>
                  <section class="panel progress-card">
                    <h2>Quick Stats</h2>
                    <div class="progress-row"><span>Holdings</span><strong>${holdings.length}</strong></div>
                    <div class="progress-row"><span>Trades</span><strong>${snapshot.tradeCount}</strong></div>
                    <div class="progress-row"><span>Live Tickers</span><strong>${Object.keys(state.livePrices).length}</strong></div>
                    <div class="progress-row"><span>Win Rate</span><strong>${snapshot.winRate.toFixed(0)}%</strong></div>
                  </section>
                  ${
                    viewKey === 'insights' && insightsView
                      ? `
                      <section class="panel trading-insights-panel">
                        <h2>Trading Insights</h2>
                        <div class="insight-list">
                          ${insightsView.tradingInsights
                            .map(
                              (item) => `
                              <div class="insight-alert ${toneClass(item.tone)}">
                                <strong>${esc(item.title)}</strong>
                                <span>${esc(item.detail)}</span>
                              </div>
                            `
                            )
                            .join('')}
                        </div>
                      </section>
                      <section class="panel trading-insights-panel">
                        <h2>Top Insights</h2>
                        <div class="insight-list">
                          ${insightsView.topInsights
                            .map(
                              (item) => `
                              <div class="insight-alert ${toneClass(item.tone)}">
                                <strong>${esc(item.stock)}</strong>
                                <span>${esc(item.title)} • ${esc(item.detail)}</span>
                              </div>
                            `
                            )
                            .join('')}
                        </div>
                      </section>
                      `
                      : ''
                  }
                </aside>`
          }
        </section>

        <footer class="status">${message || 'Ready'}</footer>
      </section>
      <div id="ui-settings-modal" class="trade-modal" aria-hidden="true">
        <div class="trade-modal-card ui-settings-card">
          <div class="trade-modal-head">
            <div>
              <h3>Appearance & Preferences</h3>
              <div class="tiny-label">Tune display size, density, and motion.</div>
            </div>
            <button id="close-ui-settings" type="button" class="ghost mini">Close</button>
          </div>
          <div class="stack compact ui-settings-grid">
            <label class="tiny-label">
              Font Size
              <input id="ui-font-scale" type="range" min="0.9" max="1.2" step="0.02" />
              <span id="ui-font-scale-value" class="tiny-label"></span>
            </label>
            <div class="ui-toggle-row">
              <button type="button" class="ui-toggle-btn" data-ui-toggle="compact" aria-pressed="false">
                <span class="ui-toggle-icon">CD</span>
                <span>Compact Mode</span>
              </button>
              <button type="button" class="ui-toggle-btn" data-ui-toggle="motion" aria-pressed="false">
                <span class="ui-toggle-icon">RM</span>
                <span>Reduce Motion</span>
              </button>
              <button type="button" class="ui-toggle-btn" data-ui-toggle="background" aria-pressed="false">
                <span class="ui-toggle-icon">BG</span>
                <span>Soft Background</span>
              </button>
              <button type="button" class="ui-toggle-btn" data-ui-toggle="theme" aria-pressed="false">
                <span class="ui-toggle-icon">DM</span>
                <span>Dark Mode</span>
              </button>
            </div>
          </div>
          <div class="actions-row">
            <button id="mobile-logout-btn" type="button" class="ghost mini">Logout</button>
          </div>
        </div>
      </div>
        <nav class="mobile-bottom-nav">
          <a class="${view === 'dashboard' ? 'active' : ''}" href="${pagePath('dashboard')}" aria-label="Dashboard">
            <span class="nav-icon-wrap">
              <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3.5 10.5 12 4l8.5 6.5V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
              </svg>
            </span>
            <span class="nav-label">Dashboard</span>
          </a>
          <a class="${view === 'transactions' ? 'active' : ''}" href="${pagePath('transactions')}" aria-label="Trades">
            <span class="nav-icon-wrap">
              <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h13m0 0-3-3m3 3-3 3M20 17H7m0 0 3 3m-3-3 3-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <span class="nav-label">Trades</span>
          </a>
          <a class="${view === 'holdings' ? 'active' : ''}" href="${pagePath('holdings')}" aria-label="Holdings">
            <span class="nav-icon-wrap">
              <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 19V5m0 14h16M8 17v-6m4 6V7m4 10v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <span class="nav-label">Holdings</span>
          </a>
          <a class="${view === 'pnl' ? 'active' : ''}" href="${pagePath('pnl')}" aria-label="Profit and Loss">
            <span class="nav-icon-wrap">
              <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 16h5l2-4 3 6 2-3h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M4 19h16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
              </svg>
            </span>
            <span class="nav-label">P/L</span>
          </a>
          <a class="${view === 'insights' ? 'active' : ''}" href="${pagePath('insights')}" aria-label="Insights">
            <span class="nav-icon-wrap">
              <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 18h6m-7-3h8m-6.5-2.5c-2.2-1.3-3.2-4.4-1.2-6.5a4.5 4.5 0 0 1 6.4 0c2 2.1 1 5.2-1.2 6.5L13 14h-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <span class="nav-label">Insights</span>
          </a>
        </nav>
      </section>

      <div id="mobile-drawer" class="mobile-drawer" aria-hidden="true">
        <div class="mobile-drawer-panel">
          <div class="mobile-drawer-head">
            <strong>${APP_NAME}</strong>
            <button id="mobile-drawer-close" type="button" class="ghost mini">Close</button>
          </div>
          <nav class="mobile-drawer-nav">
            ${menuItems
              .map(
                (item) => `<a class="menu-item ${view === item.view ? 'active' : ''}" href="${pagePath(item.view)}">
                  <span class="menu-icon">${item.icon}</span>
                  <span>${item.label}</span>
                </a>`
              )
              .join('')}
          </nav>
        </div>
      </div>
      <div id="mobile-info-panel" class="mobile-info-panel" aria-hidden="true">
        <div class="mobile-info-card">
          <div class="mobile-info-head">
            <strong>Account & Sync</strong>
            <button id="mobile-info-close" type="button" class="ghost mini">Close</button>
          </div>
          <section class="mobile-info-section">
            <div class="account-head">
              <div class="avatar">${session.name.slice(0, 1).toUpperCase()}</div>
              <div>
                <h3>${session.name}</h3>
                <span class="account-role">${session.role}</span>
              </div>
            </div>
            <div class="account-meta">
              <div><span>Live Price Sync</span><strong data-live-sync-countdown>--</strong></div>
              <div><span>Last Sync</span><strong>${state.lastLiveSyncAt ? new Date(state.lastLiveSyncAt).toLocaleTimeString() : 'Never'}</strong></div>
              <div><span>Last Cloud Sync</span><strong>${state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleTimeString() : 'Never'}</strong></div>
              <div><span>Next Cloud Sync</span><strong class="countdown-pulse" data-cloud-sync-countdown>--</strong></div>
            </div>
            <button id="mobile-info-sync-btn" type="button" class="mini">Sync Live Prices</button>
          </section>
          <section class="mobile-info-section">
            <h3>Quick Stats</h3>
            <div class="progress-row"><span>Holdings</span><strong>${holdings.length}</strong></div>
            <div class="progress-row"><span>Trades</span><strong>${snapshot.tradeCount}</strong></div>
            <div class="progress-row"><span>Live Tickers</span><strong>${Object.keys(state.livePrices).length}</strong></div>
            <div class="progress-row"><span>Win Rate</span><strong>${snapshot.winRate.toFixed(0)}%</strong></div>
          </section>
        </div>
      </div>
    </main>
  `;

  if (message) {
    showToast(message, messageTone(message));
  }

  root.querySelector<HTMLButtonElement>('#logout-btn')?.addEventListener('click', () => {
    addActivityLog('auth', 'Logout');
    logout();
    showToast('Logged out', 'info');
    bootstrapApp(root);
  });
  root.querySelector<HTMLButtonElement>('#profile-logout-btn')?.addEventListener('click', () => {
    addActivityLog('auth', 'Logout');
    logout();
    showToast('Logged out', 'info');
    bootstrapApp(root);
  });
  root.querySelector<HTMLButtonElement>('#mobile-logout-btn')?.addEventListener('click', () => {
    addActivityLog('auth', 'Logout');
    logout();
    showToast('Logged out', 'info');
    bootstrapApp(root);
  });

  const mediaQuery = window.matchMedia('(max-width: 768px)');
  const handleMobileChange = (e: MediaQueryListEvent | MediaQueryList) => {
    if (e.matches) {
      const drawer = root.querySelector<HTMLElement>('#mobile-drawer');
      const infoPanel = root.querySelector<HTMLElement>('#mobile-info-panel');
      let lastDrawerTrigger: HTMLElement | null = null;
      let lastInfoTrigger: HTMLElement | null = null;
      drawer?.setAttribute('inert', 'true');
      infoPanel?.setAttribute('inert', 'true');
      const openDrawer = (): void => {
        if (!drawer) return;
        drawer.classList.add('open');
        drawer.removeAttribute('inert');
        drawer.setAttribute('aria-hidden', 'false');
      };
      const openInfo = (): void => {
        if (!infoPanel) return;
        infoPanel.classList.add('open');
        infoPanel.removeAttribute('inert');
        infoPanel.setAttribute('aria-hidden', 'false');
      };
      const closeDrawer = (): void => {
        if (!drawer) return;
        if (drawer.contains(document.activeElement)) {
          (lastDrawerTrigger ?? root.querySelector<HTMLElement>('#mobile-menu-btn') ?? document.body).focus();
        }
        drawer.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
        drawer.setAttribute('inert', 'true');
      };
      const closeInfo = (): void => {
        if (!infoPanel) return;
        if (infoPanel.contains(document.activeElement)) {
          (lastInfoTrigger ?? root.querySelector<HTMLElement>('#mobile-info-btn') ?? document.body).focus();
        }
        infoPanel.classList.remove('open');
        infoPanel.setAttribute('aria-hidden', 'true');
        infoPanel.setAttribute('inert', 'true');
      };
      const handleOpenDrawer = (event: Event): void => {
        lastDrawerTrigger = event.currentTarget as HTMLElement | null;
        openDrawer();
      };
      const handleOpenInfo = (event: Event): void => {
        lastInfoTrigger = event.currentTarget as HTMLElement | null;
        openInfo();
      };
      root.querySelector<HTMLButtonElement>('#mobile-menu-btn')?.addEventListener('click', handleOpenDrawer);
      root.querySelector<HTMLButtonElement>('#mobile-more-btn')?.addEventListener('click', handleOpenDrawer);
      root.querySelector<HTMLButtonElement>('#mobile-drawer-close')?.addEventListener('click', closeDrawer);
      root.querySelector<HTMLButtonElement>('#mobile-info-btn')?.addEventListener('click', handleOpenInfo);
      root.querySelector<HTMLButtonElement>('#mobile-info-close')?.addEventListener('click', closeInfo);
      drawer?.addEventListener('click', (event) => {
        if (event.target === drawer) closeDrawer();
      });
      infoPanel?.addEventListener('click', (event) => {
        if (event.target === infoPanel) closeInfo();
      });
    }
  };
  mediaQuery.addEventListener('change', handleMobileChange);
  handleMobileChange(mediaQuery);

  const profileBtn = root.querySelector<HTMLButtonElement>('#profile-menu-btn');
  const profileMenu = root.querySelector<HTMLDivElement>('#profile-menu');
  const uiModal = root.querySelector<HTMLElement>('#ui-settings-modal');
  let lastUiTrigger: HTMLElement | null = null;
  uiModal?.setAttribute('inert', '');
  const uiCloseBtn = root.querySelector<HTMLButtonElement>('#close-ui-settings');
  const logoBtn = root.querySelector<HTMLButtonElement>('#app-logo-btn');
  const fontScaleInput = root.querySelector<HTMLInputElement>('#ui-font-scale');
  const fontScaleValue = root.querySelector<HTMLElement>('#ui-font-scale-value');
  const toggleButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-ui-toggle]'));
  const prefs = loadUiPrefs();

  const applyPrefsFromInputs = (): void => {
    const next: UiPrefs = {
      fontScale: Number(fontScaleInput?.value || prefs.fontScale || 1),
      compact: prefs.compact,
      reduceMotion: prefs.reduceMotion,
      softBackground: prefs.softBackground,
      theme: prefs.theme
    };
    applyUiPrefs(next);
    if (fontScaleValue) fontScaleValue.textContent = `${next.fontScale.toFixed(2)}x`;
  };

  if (fontScaleInput) fontScaleInput.value = String(prefs.fontScale);
  if (fontScaleValue) fontScaleValue.textContent = `${prefs.fontScale.toFixed(2)}x`;

  const syncToggleButtons = (): void => {
    toggleButtons.forEach((btn) => {
      const key = String(btn.dataset.uiToggle || '');
      let pressed = false;
      if (key === 'compact') pressed = prefs.compact;
      if (key === 'motion') pressed = prefs.reduceMotion;
      if (key === 'background') pressed = prefs.softBackground;
      if (key === 'theme') pressed = prefs.theme === 'dark';
      btn.classList.toggle('active', pressed);
      btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
  };
  syncToggleButtons();

  fontScaleInput?.addEventListener('input', applyPrefsFromInputs);
  toggleButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = String(btn.dataset.uiToggle || '');
      if (key === 'compact') prefs.compact = !prefs.compact;
      if (key === 'motion') prefs.reduceMotion = !prefs.reduceMotion;
      if (key === 'background') prefs.softBackground = !prefs.softBackground;
      if (key === 'theme') prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
      applyUiPrefs(prefs);
      syncToggleButtons();
    });
  });

  const openUiModal = (trigger?: HTMLElement | null): void => {
    if (!uiModal) return;
    if (trigger) lastUiTrigger = trigger;
    uiModal.classList.add('open');
    uiModal.setAttribute('aria-hidden', 'false');
    uiModal.removeAttribute('inert');
  };
  const closeUiModal = (): void => {
    if (!uiModal) return;
    if (uiModal.contains(document.activeElement)) {
      (lastUiTrigger ?? document.body).focus();
    }
    uiModal.classList.remove('open');
    uiModal.setAttribute('aria-hidden', 'true');
    uiModal.setAttribute('inert', '');
  };

  const handleOpenUiModal = (event: Event): void => {
    openUiModal(event.currentTarget as HTMLElement | null);
  };
  profileBtn?.addEventListener('click', (event) => {
    profileMenu?.classList.remove('open');
    handleOpenUiModal(event);
  });
  logoBtn?.addEventListener('click', handleOpenUiModal);
  root.querySelector<HTMLButtonElement>('#mobile-profile-btn')?.addEventListener('click', handleOpenUiModal);
  root.querySelector<HTMLButtonElement>('#mobile-ui-btn')?.addEventListener('click', handleOpenUiModal);
  uiCloseBtn?.addEventListener('click', closeUiModal);
  uiModal?.addEventListener('click', (event) => {
    if (event.target === uiModal) closeUiModal();
  });

  root.querySelector<HTMLFormElement>('#global-search-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = root.querySelector<HTMLInputElement>('#global-search-input');
    const raw = String(input?.value || '').trim();
    if (!raw) return;
    const resolved = resolveGlobalSearch(raw);
    if (resolved.toast) {
      showToast(resolved.toast, 'info');
      return;
    }
    if (resolved.store) {
      localStorage.setItem('fds_global_search', resolved.store);
    }
    if (resolved.view) {
      window.location.href = pagePath(resolved.view);
      return;
    }
    showToast(GLOBAL_SEARCH_HELP, 'info');
  });

  if (viewKey === 'dashboard' && window.matchMedia('(max-width: 768px)').matches) {
    if (getTrendRange() !== '7D') {
      setTrendRange('7D');
    }
  }

  bindGlobalShortcuts(root);

  if (viewKey === 'dashboard') {
    const loadDashboardTrends = async (): Promise<void> => {
      const dailyNode = root.querySelector<HTMLElement>('#daily-pnl-chart');
      const splitNode = root.querySelector<HTMLElement>('#pnl-split-chart');
      if (!dailyNode && !splitNode) return;

      const trendRange = getTrendRange();
      const trendDays = trendRange === '7D' ? 7 : trendRange === '14D' ? 14 : 30;
      const holdings = calculateHoldings(state.transactions, getExpandedMappings(state), state.livePrices)
        .filter((h) => Number(h.quantity || 0) > 0);
      if (!holdings.length) {
        if (dailyNode) dailyNode.innerHTML = '<div class="muted">No holdings yet.</div>';
        if (splitNode) splitNode.innerHTML = '<div class="muted">No holdings yet.</div>';
        return;
      }

      const sorted = holdings
        .slice()
        .sort((a, b) => Number(b.invested || 0) - Number(a.invested || 0))
        .slice(0, 8);
      const tickers = sorted.map((h) => resolveTicker(state, h.stock || h.ticker || '')).filter((t) => t);

      try {
        const histories = await Promise.all(
          tickers.map(async (ticker) => {
            const history = await fetchPriceHistory(ticker, trendDays);
            return { ticker, points: history.points || [] };
          })
        );

        const dateSet = new Set<string>();
        histories.forEach((h) => h.points.forEach((p) => dateSet.add(String(p.date || ''))));
        const dates = Array.from(dateSet).filter((d) => isValidIsoDate(d)).sort();
        if (!dates.length) {
          if (dailyNode) dailyNode.innerHTML = '<div class="muted">No price history available.</div>';
          if (splitNode) splitNode.innerHTML = '<div class="muted">No price history available.</div>';
          return;
        }

        const priceMaps = new Map<string, Map<string, number>>();
        histories.forEach((h) => {
          const map = new Map<string, number>();
          h.points.forEach((p) => {
            map.set(String(p.date || ''), Number(p.close || 0));
          });
          priceMaps.set(h.ticker, map);
        });

        const values: number[] = [];
        const dailyPnl: number[] = [];
        const investedTotal = sorted.reduce((sum, h) => sum + Number(h.invested || 0), 0);

        let prevValue = 0;
        dates.forEach((date) => {
          let dayValue = 0;
          histories.forEach((h) => {
            const map = priceMaps.get(h.ticker);
            let price = Number(map?.get(date) || 0);
            if (!price) {
              // forward fill
              const idx = dates.indexOf(date);
              for (let i = idx - 1; i >= 0; i -= 1) {
                const prior = map?.get(dates[i]);
                if (prior) {
                  price = Number(prior);
                  break;
                }
              }
            }
            const holding = sorted.find((s) => resolveTicker(state, s.stock || s.ticker || '') === h.ticker);
            const qty = Number(holding?.quantity || 0);
            dayValue += qty * price;
          });
          values.push(dayValue);
          if (values.length === 1) {
            dailyPnl.push(0);
          } else {
            dailyPnl.push(dayValue - prevValue);
          }
          prevValue = dayValue;
        });

        if (dailyNode) {
          dailyNode.innerHTML = buildDailyPnlChartMarkup(
            dates.slice(-trendDays),
            dailyPnl.slice(-trendDays),
            state.settings.currency
          );
          bindDailyPnlTooltip(dailyNode, state.settings.currency);
        }

        const pnlRows = calculateRealizedPnlRows(state.transactions);
        const realizedByDate = new Map<string, number>();
        pnlRows.forEach((row) => {
          const date = String(row.date || '');
          if (!isValidIsoDate(date)) return;
          realizedByDate.set(date, Number(realizedByDate.get(date) || 0) + Number(row.net || 0));
        });

        let realizedRunning = 0;
        const realizedSeries: number[] = [];
        const unrealizedSeries: number[] = [];
        dates.forEach((date, idx) => {
          if (realizedByDate.has(date)) {
            realizedRunning += Number(realizedByDate.get(date) || 0);
          }
          realizedSeries.push(realizedRunning);
          const value = values[idx] || 0;
          unrealizedSeries.push(value - investedTotal);
        });

        if (splitNode) {
          splitNode.innerHTML = buildRealizedUnrealizedChartMarkup(
            dates.slice(-trendDays),
            realizedSeries.slice(-trendDays),
            unrealizedSeries.slice(-trendDays),
            state.settings.currency
          );
          bindPnlSplitTooltip(splitNode, state.settings.currency);
        }
      } catch (error) {
        if (dailyNode) dailyNode.innerHTML = '<div class="muted">Failed to load price history.</div>';
        if (splitNode) splitNode.innerHTML = '<div class="muted">Failed to load price history.</div>';
      }
    };

    loadDashboardTrends();

    root.querySelectorAll<HTMLButtonElement>('button[data-trend-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = String(btn.dataset.trendRange || '').trim().toUpperCase() as TrendRange;
        if (!next || next === getTrendRange()) return;
        setTrendRange(next);
        renderWorkspace(root, session, state, view);
      });
    });
    root.querySelectorAll<HTMLButtonElement>('button[data-mobile-trend]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (getTrendRange() === '7D') return;
        setTrendRange('7D');
        renderWorkspace(root, session, state, view);
      });
    });
  }

  if (viewKey === 'admin' && session.role === 'ADMIN') {
    const adminToken = session.adminSessionToken ?? '';
    const usersBody = root.querySelector<HTMLTableSectionElement>('#admin-users-body');
    const pendingBody = root.querySelector<HTMLTableSectionElement>('#admin-pending-body');
    const pendingKpi = root.querySelector<HTMLElement>('#admin-kpi-pending');
    const usersKpi = root.querySelector<HTMLElement>('#admin-kpi-users');
    const logList = root.querySelector<HTMLUListElement>('#admin-log-list');
    const logFilter = root.querySelector<HTMLSelectElement>('#admin-log-filter');
    const logSearch = root.querySelector<HTMLInputElement>('#admin-log-search');
    const userSearch = root.querySelector<HTMLInputElement>('#admin-user-search');
    const userFilter = root.querySelector<HTMLSelectElement>('#admin-user-filter');
    const maxSnapshotsInput = root.querySelector<HTMLInputElement>('#admin-max-snapshots');

    const renderUserRows = (rows: AdminUserRow[]): string => {
      if (!rows.length) return '<tr class="admin-empty-row"><td colspan="6">No users found.</td></tr>';
      return rows
        .map((row) => {
          const roleLabel = row.role === 'ADMIN' ? 'ADMIN' : 'USER';
          const statusLabel = row.status === 'DISABLED' ? 'Disabled' : 'Active';
          return `
            <tr data-user="${esc(row.userId)}">
              <td data-label="Name">${esc(row.name)}</td>
              <td data-label="Login">${esc(row.loginId)}</td>
              <td data-label="Role">${roleLabel}</td>
              <td data-label="Status">${statusLabel}</td>
              <td data-label="Created">${esc(row.createdAt || '')}</td>
              <td data-label="Action">
                <button class="mini" data-admin-action="toggle-role" data-user="${esc(row.userId)}">${roleLabel === 'ADMIN' ? 'Make User' : 'Make Admin'}</button>
                <button class="mini ghost" data-admin-action="toggle-status" data-user="${esc(row.userId)}">${statusLabel === 'Active' ? 'Disable' : 'Activate'}</button>
              </td>
            </tr>
          `;
        })
        .join('');
    };

    const renderPendingRows = (rows: PendingRequest[]): string => {
      if (!rows.length) return '<tr class="admin-empty-row"><td colspan="5">No pending requests.</td></tr>';
      return rows
        .map(
          (row) => `
          <tr>
            <td data-label="Name">${esc(row.name)}</td>
            <td data-label="Login">${esc(row.loginId)}</td>
            <td data-label="Email">${esc(row.email || '')}</td>
            <td data-label="Requested">${esc(row.requestedAt)}</td>
            <td data-label="Action">
              <button class="mini" data-pending-action="approve" data-id="${esc(row.requestId)}">Approve</button>
              <button class="mini ghost" data-pending-action="reject" data-id="${esc(row.requestId)}">Reject</button>
            </td>
          </tr>
        `
        )
        .join('');
    };

    const renderLogs = (entries: ActivityLogEntry[]): void => {
      if (!logList) return;
      const type = String(logFilter?.value || 'all').toLowerCase();
      const query = String(logSearch?.value || '').trim().toLowerCase();
      const filtered = entries.filter((row) => {
        const matchesType = type === 'all' || String(row.type || '').toLowerCase() === type;
        const matchesText = !query || String(row.detail || '').toLowerCase().includes(query);
        return matchesType && matchesText;
      });
      logList.innerHTML = filtered.length
        ? filtered
            .map(
              (row) => `
              <li data-log-type="${esc(row.type)}">
                <strong>${esc(row.type)}</strong>
                <span>${esc(row.detail)}</span>
                <em>${esc(new Date(row.ts).toLocaleString())}</em>
              </li>
            `
            )
            .join('')
        : '<li class="muted">No matching logs.</li>';
    };

    const refreshAdminData = async (): Promise<void> => {
      if (!adminToken) {
        renderWorkspace(root, session, state, 'dashboard', 'Admin session expired. Please login again.');
        return;
      }
      showBlockingLoader('Loading admin data...');
      try {
        const [pendingRows, users, config] = await Promise.all([
          listPendingRequests(session.userId, adminToken),
          listAdminUsers(session.userId, adminToken),
          getAdminConfig(session.userId, adminToken)
        ]);
        if (pendingBody) pendingBody.innerHTML = renderPendingRows(pendingRows);
        if (usersBody) usersBody.innerHTML = renderUserRows(users);
        if (pendingKpi) pendingKpi.textContent = String(pendingRows.length);
        if (usersKpi) usersKpi.textContent = String(users.filter((u) => u.status === 'ACTIVE').length);
        if (maxSnapshotsInput) maxSnapshotsInput.value = String(config.maxSnapshots);
        renderLogs(getActivityLogs());
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Failed to load admin data';
        showToast(messageText, 'error');
      } finally {
        hideBlockingLoader();
      }
    };

    refreshAdminData();

    root.querySelector<HTMLButtonElement>('#admin-users-refresh')?.addEventListener('click', refreshAdminData);
    root.querySelector<HTMLButtonElement>('#admin-pending-refresh')?.addEventListener('click', refreshAdminData);
    userSearch?.addEventListener('input', () => {
      if (!usersBody) return;
      const query = String(userSearch.value || '').trim().toLowerCase();
      const status = String(userFilter?.value || 'ALL').toUpperCase();
      Array.from(usersBody.querySelectorAll<HTMLTableRowElement>('tr[data-user]')).forEach((row) => {
        const text = String(row.textContent || '').toLowerCase();
        const statusText = String(row.children[3]?.textContent || '').toUpperCase();
        const matchesText = !query || text.includes(query);
        const matchesStatus = status === 'ALL' || statusText === status;
        row.style.display = matchesText && matchesStatus ? '' : 'none';
      });
    });
    userFilter?.addEventListener('change', () => userSearch?.dispatchEvent(new Event('input')));
    logFilter?.addEventListener('change', () => renderLogs(getActivityLogs()));
    logSearch?.addEventListener('input', () => renderLogs(getActivityLogs()));

    usersBody?.addEventListener('click', async (event) => {
      const target = event.target as HTMLButtonElement | null;
      if (!target) return;
      const action = String(target.dataset.adminAction || '');
      const userId = String(target.dataset.user || '');
      if (!action || !userId) return;
      const roleCell = target.closest('tr')?.children[2]?.textContent || '';
      const statusCell = target.closest('tr')?.children[3]?.textContent || '';
      const nextRole: UserRole = roleCell.trim().toUpperCase() === 'ADMIN' ? 'USER' : 'ADMIN';
      const nextStatus = statusCell.trim().toUpperCase() === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
      const ok = await confirmPopup(`Apply ${action === 'toggle-role' ? nextRole : nextStatus} to user?`, 'Update User');
      if (!ok) return;
      showBlockingLoader('Updating user...');
      try {
        await updateAdminUser({
          adminUserId: session.userId,
          adminToken,
          userId,
          role: action === 'toggle-role' ? nextRole : undefined,
          status: action === 'toggle-status' ? nextStatus : undefined
        });
        addActivityLog('auth', `Admin updated user ${userId}`);
        await refreshAdminData();
        showToast('User updated', 'success');
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Failed to update user';
        showToast(messageText, 'error');
      } finally {
        hideBlockingLoader();
      }
    });

    pendingBody?.addEventListener('click', async (event) => {
      const target = event.target as HTMLButtonElement | null;
      if (!target) return;
      const action = String(target.dataset.pendingAction || '');
      const requestId = String(target.dataset.id || '');
      if (!action || !requestId) return;
      const ok = await confirmPopup(`Confirm ${action} request?`, 'Review Request');
      if (!ok) return;
      showBlockingLoader('Updating request...');
      try {
        await reviewPendingRequest({
          adminUserId: session.userId,
          adminToken,
          requestId,
          decision: action === 'approve' ? 'approve' : 'reject'
        });
        addActivityLog('auth', `Admin ${action} request ${requestId}`);
        await refreshAdminData();
        showToast(`Request ${action}d`, 'success');
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Admin action failed';
        showToast(messageText, 'error');
      } finally {
        hideBlockingLoader();
      }
    });

    setupTickerRequestModalHandlers();

    // Registry editing handlers removed (NSE master + requests only).

    // NSE master upload handled below.

    root.querySelector<HTMLButtonElement>('#admin-nse-import')?.addEventListener('click', () => {
      root.querySelector<HTMLInputElement>('#admin-nse-file')?.click();
    });

    root.querySelector<HTMLInputElement>('#admin-nse-file')?.addEventListener('change', async (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files && input.files.length ? input.files[0] : null;
      if (!file) return;
      try {
        const text = await file.text();
        const lines = text.split(/\r?\n/).filter((line) => line.trim());
        if (lines.length < 2) {
          showToast('NSE file is empty.', 'error');
          return;
        }
        const header = parseCsvLine(lines[0]).map((h) => h.toUpperCase());
        const symbolIdx = header.findIndex((h) => h.includes('SYMBOL'));
        const nameIdx = header.findIndex((h) => h.includes('NAME'));
        const isinIdx = header.findIndex((h) => h.includes('ISIN'));
        if (symbolIdx === -1 || nameIdx === -1 || isinIdx === -1) {
          showToast('NSE CSV missing SYMBOL, NAME, or ISIN columns.', 'error');
          return;
        }
        const rows = lines
          .slice(1)
          .map(parseCsvLine)
          .map((cols) => ({
            symbol: String(cols[symbolIdx] || '').trim().toUpperCase(),
            name: String(cols[nameIdx] || '').trim(),
            isin: String(cols[isinIdx] || '').trim().toUpperCase()
          }))
          .filter((row) => row.symbol && row.name);
        if (!rows.length) {
          showToast('No valid NSE rows found.', 'error');
          return;
        }
        const registry = await replaceNseMaster(session, rows);
        const next = { ...state, nseMaster: registry };
        addActivityLog('mapping', `NSE master uploaded: ${rows.length} rows`);
        renderWorkspace(root, session, next, view, `NSE master updated (${rows.length} rows)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to upload NSE master';
        showToast(message, 'error');
      } finally {
        input.value = '';
      }
    });

    root.querySelector<HTMLButtonElement>('#admin-save-config')?.addEventListener('click', async () => {
      const value = Number(maxSnapshotsInput?.value || 10);
      showBlockingLoader('Saving admin config...');
      try {
        await setAdminConfig({
          adminUserId: session.userId,
          adminToken,
          maxSnapshots: Math.max(1, Math.floor(value))
        });
        addActivityLog('cloud', `Admin set max snapshots: ${Math.max(1, Math.floor(value))}`);
        showToast('Config saved', 'success');
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Failed to save config';
        showToast(messageText, 'error');
      } finally {
        hideBlockingLoader();
      }
    });

    root.querySelector<HTMLButtonElement>('#admin-trim-snapshots')?.addEventListener('click', async () => {
      const ok = await confirmPopup('Trim snapshots for all users now?', 'Trim Snapshots');
      if (!ok) return;
      showBlockingLoader('Trimming snapshots...');
      try {
        await trimSnapshots({ adminUserId: session.userId, adminToken });
        addActivityLog('cloud', 'Admin trimmed snapshots');
        showToast('Snapshots trimmed', 'success');
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Trim failed';
        showToast(messageText, 'error');
      } finally {
        hideBlockingLoader();
      }
    });

    root.querySelector<HTMLButtonElement>('#admin-live-sync')?.addEventListener('click', () => {
      runLiveSync();
    });
    root.querySelector<HTMLButtonElement>('#admin-cloud-push')?.addEventListener('click', async () => {
      showBlockingLoader('Pushing to cloud...');
      try {
        await pushToCloud(session, state);
        addActivityLog('cloud', 'Admin cloud push');
        applyState({ ...state, lastSyncedAt: new Date().toISOString() }, 'Cloud push successful');
        await trimSnapshots({ userId: session.userId });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Cloud push failed';
        showToast(messageText, 'error');
      } finally {
        hideBlockingLoader();
      }
    });
    root.querySelector<HTMLButtonElement>('#admin-cloud-pull')?.addEventListener('click', async () => {
      showBlockingLoader('Pulling from cloud...');
      try {
        const pulled = await pullFromCloud(session);
        addActivityLog('cloud', 'Admin cloud pull');
        applyState({ ...ensureDefaultMappings(pulled), lastSyncedAt: new Date().toISOString() }, 'Cloud pull successful');
        await trimSnapshots({ userId: session.userId });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Cloud pull failed';
        showToast(messageText, 'error');
      } finally {
        hideBlockingLoader();
      }
    });
  }

  const applyState = (next: AppState, msg?: string): void => {
    const normalized = ensureDefaultMappings(next);
    writeState(session, normalized);
    renderWorkspace(root, session, normalized, view, msg || 'Saved');
  };

  const runCloudSync = async (): Promise<void> => {
    if (cloudSyncInFlight) return;
    if (!getCloudAutoSyncEnabled()) return;
    const intervalMs = Math.max(1, getCloudAutoSyncInterval()) * 60 * 1000;
    const lastSync = state.lastSyncedAt ? new Date(state.lastSyncedAt).getTime() : 0;
    if (lastSync && Date.now() - lastSync < intervalMs - 5000) return;
    cloudSyncInFlight = true;
    try {
      showToast('Cloud auto sync started...', 'info');
      await pushToCloud(session, state);
      addActivityLog('cloud', 'Auto cloud sync');
      applyState({ ...state, lastSyncedAt: new Date().toISOString() }, 'Cloud auto sync successful');
      await trimSnapshots({ userId: session.userId });
      showToast('Cloud auto sync completed', 'success');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Cloud auto sync failed';
      showToast(messageText, 'error');
    } finally {
      cloudSyncInFlight = false;
    }
  };

  const runLiveSync = async (): Promise<void> => {
    if (liveSyncInFlight) return;
    liveSyncInFlight = true;
    localStorage.setItem(LIVE_SYNC_ATTEMPT_KEY, String(Date.now()));
    showBlockingLoader('Syncing live prices...');
    try {
      showToast('Live price sync started...', 'info');
      const baseMappings = getCanonicalMappings(state);
      const holdings = calculateHoldings(state.transactions, getExpandedMappings(state), state.livePrices);
      const holdingTickers = holdings
        .map((row) => String(row.ticker || row.stock || '').trim().toUpperCase())
        .filter(Boolean);
      const tickerSet = new Set(baseMappings.map((row) => row.ticker));
      const merged = baseMappings.slice();
      holdingTickers.forEach((ticker) => {
        if (tickerSet.has(ticker)) return;
        tickerSet.add(ticker);
        merged.push({ stock: ticker, ticker, enabled: true, updatedAt: new Date().toISOString() });
      });
      const mappings = merged;
      const live = await syncLivePrices(mappings);
      if (live.success <= 0) {
        const failedPreview = live.failedTickers
          .slice(0, 5)
          .map((t) => `${t}: ${String(live.failureReasons?.[t] || 'unknown')}`)
          .join(' | ');
        renderWorkspace(
          root,
          session,
          state,
          view,
          `Live price sync failed: no valid prices fetched (${live.failedTickers.length} failed). ${failedPreview}`
        );
        showToast('Live price sync failed', 'error');
        return;
      }
      const failedText = live.failedTickers.length
        ? `, failed ${live.failedTickers.length} (${live.failedTickers
            .slice(0, 5)
            .map((t) => `${t}:${String(live.failureReasons?.[t] || 'unknown')}`)
            .join(', ')})`
        : '';
      const normalizedPrices: typeof live.prices = {};
      Object.entries(live.prices).forEach(([ticker, row]) => {
        normalizedPrices[String(ticker || '').trim().toUpperCase()] = row;
      });
      applyState(
        {
          ...state,
          livePrices: { ...state.livePrices, ...normalizedPrices },
          lastLiveSyncAt: new Date().toISOString()
        },
        `Live prices synced: ${live.success}${failedText}`
      );
      await trimSnapshots({ userId: session.userId });
      showToast(`Live prices synced: ${live.success}`, 'success');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Live price sync failed';
      renderWorkspace(root, session, state, view, messageText);
      showToast(messageText, 'error');
    } finally {
      hideBlockingLoader();
      liveSyncInFlight = false;
    }
  };

  function setupTickerRequestModalHandlers(): void {
    const modal = root.querySelector<HTMLElement>('#ticker-approve-modal');
    if (!modal) return;
    const form = modal.querySelector<HTMLFormElement>('#ticker-approve-form');
    const closeBtn = modal.querySelector<HTMLButtonElement>('#close-ticker-approve-btn');
    const rejectBtn = modal.querySelector<HTMLButtonElement>('#ticker-reject-btn');
    const rawInput = modal.querySelector<HTMLInputElement>('input[name="rawSymbol"]');
    const suggestedInput = modal.querySelector<HTMLInputElement>('input[name="suggestedSymbol"]');
    const resolvedInput = modal.querySelector<HTMLInputElement>('input[name="resolvedSymbol"]');
    const noteInput = modal.querySelector<HTMLInputElement>('input[name="rejectNote"]');
    const idInput = modal.querySelector<HTMLInputElement>('input[name="requestId"]');

    const openModal = (requestId: string, mode: 'approve' | 'reject'): void => {
      const request = (state.tickerRequests || []).find((req) => req.id === requestId);
      if (!request || !idInput || !rawInput || !suggestedInput || !resolvedInput) return;
      const suggested =
        (resolveTickerFromRegistry(state, request.rawSymbol) || resolveTickerFromNseMaster(state, request.rawSymbol))
          ?.ticker || '';
      modal.dataset.mode = mode;
      idInput.value = requestId;
      rawInput.value = request.rawSymbol || '';
      suggestedInput.value = suggested;
      resolvedInput.value = request.resolvedTicker || suggested || '';
      if (noteInput) noteInput.value = '';
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      resolvedInput.focus();
    };

    const closeModal = (): void => {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
    };

    root.querySelectorAll<HTMLButtonElement>('button[data-request-approve]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const requestId = String(btn.dataset.requestApprove || '').trim();
        if (!requestId) return;
        openModal(requestId, 'approve');
      });
    });

    root.querySelectorAll<HTMLButtonElement>('button[data-request-reject]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const requestId = String(btn.dataset.requestReject || '').trim();
        if (!requestId) return;
        openModal(requestId, 'reject');
      });
    });

    closeBtn?.addEventListener('click', closeModal);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal();
    });

    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const requestId = String(idInput?.value || '').trim();
      const resolved = String(resolvedInput?.value || '').trim().toUpperCase();
      if (!requestId) return;
      if (!resolved || !isValidTickerFormat(resolved)) {
        showToast('Enter a valid ticker symbol to approve.', 'error');
        return;
      }
      showBlockingLoader('Approving ticker...');
      try {
        await approveTickerRequestRemote(session, requestId, resolved);
        let next = await refreshTickerData(session, state);
        let updatedMessage = `Ticker request approved: ${resolved}`;
        try {
          const mappings = getCanonicalMappings(next);
          const live = await syncLivePrices(mappings);
          const normalizedPrices: typeof live.prices = {};
          Object.entries(live.prices || {}).forEach(([ticker, row]) => {
            normalizedPrices[String(ticker || '').trim().toUpperCase()] = row;
          });
          next = {
            ...next,
            livePrices: { ...next.livePrices, ...normalizedPrices },
            lastLiveSyncAt: live.success ? new Date().toISOString() : next.lastLiveSyncAt
          };
          if (live.success) updatedMessage += ` | Live prices updated (${live.success})`;
        } catch {
          // live sync failures should not block approval
        }
        addActivityLog('mapping', `Ticker request approved: ${resolved}`);
        renderWorkspace(root, session, next, view, updatedMessage);
      } catch (error) {
        showToast('Failed to approve ticker request', 'error');
      } finally {
        hideBlockingLoader();
        closeModal();
      }
    });

    rejectBtn?.addEventListener('click', async () => {
      const requestId = String(idInput?.value || '').trim();
      if (!requestId) return;
      const note = String(noteInput?.value || '').trim();
      showBlockingLoader('Rejecting ticker...');
      try {
        await rejectTickerRequestRemote(session, requestId, note);
        const next = await refreshTickerData(session, state);
        addActivityLog('mapping', `Ticker request rejected: ${requestId}`);
        renderWorkspace(root, session, next, view, `Ticker request rejected`);
      } catch (error) {
        showToast('Failed to reject ticker request', 'error');
      } finally {
        hideBlockingLoader();
        closeModal();
      }
    });
  }

  root.querySelector<HTMLButtonElement>('#account-sync-btn')?.addEventListener('click', () => {
    runLiveSync();
  });
  root.querySelector<HTMLButtonElement>('#mobile-info-sync-btn')?.addEventListener('click', () => {
    runLiveSync();
  });

  setupLiveSyncStatus(root, state, runLiveSync);
  setupCloudSyncStatus(root, state, runCloudSync);

  if (viewKey === 'target') {
    const modal = root.querySelector<HTMLElement>('#target-breakdown-modal');
    const title = root.querySelector<HTMLElement>('#target-breakdown-title');
    const body = root.querySelector<HTMLElement>('#target-breakdown-body');
    const closeBtn = root.querySelector<HTMLButtonElement>('#close-target-breakdown');
    const filterButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-target-filter]'));
    const sortButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-target-sort]'));

    const openModal = (stock: string): void => {
      if (!modal || !body) return;
      const safeStock = String(stock || '').trim();
      title && (title.textContent = `Breakdown of ${safeStock}`);
      body.innerHTML = renderTargetBreakdownTable(state, safeStock);
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
    };

    const closeModal = (): void => {
      if (!modal) return;
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
    };

    root.querySelectorAll<HTMLButtonElement>('[data-target-breakdown]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const stock = String(btn.dataset.targetBreakdown || '').trim();
        if (!stock) return;
        openModal(stock);
      });
    });

    closeBtn?.addEventListener('click', closeModal);
    modal?.addEventListener('click', (event) => {
      if (event.target === modal) closeModal();
    });

    filterButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = String(btn.dataset.targetFilter || '').trim().toUpperCase() as TargetFilter;
        if (!next || next === getTargetFilter()) return;
        setTargetFilter(next);
        renderWorkspace(root, session, state, view, 'Target filters updated');
      });
    });

    sortButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = String(btn.dataset.targetSort || '').trim().toUpperCase() as TargetSort;
        if (!next || next === getTargetSort()) return;
        setTargetSort(next);
        renderWorkspace(root, session, state, view, 'Target sort updated');
      });
    });
  }

  if (viewKey === 'transactions') {
    const modal = root.querySelector<HTMLElement>('#trade-modal');
    const titleNode = root.querySelector<HTMLElement>('#trade-modal-title');
    const detailsPanel = root.querySelector<HTMLElement>('#trade-panel-details');
    const checklistPanel = root.querySelector<HTMLElement>('#trade-panel-checklist');
    const detailsTab = root.querySelector<HTMLButtonElement>('#trade-tab-details');
    const checklistTab = root.querySelector<HTMLButtonElement>('#trade-tab-checklist');
    const manualFormRef = root.querySelector<HTMLFormElement>('#manual-form');
    const fileInput = root.querySelector<HTMLInputElement>('#import-form input[name="csv"]');
    const brokerSelect = root.querySelector<HTMLSelectElement>('#import-broker');
    const textFilter = root.querySelector<HTMLInputElement>('#tx-filter-text');
    const sideFilter = root.querySelector<HTMLSelectElement>('#tx-filter-side');
    const fromFilter = root.querySelector<HTMLInputElement>('#tx-filter-from');
    const toFilter = root.querySelector<HTMLInputElement>('#tx-filter-to');
    const requestsSection = root.querySelector<HTMLElement>('#ticker-requests');

    const openTradeModal = (mode: 'add' | 'edit'): void => {
      if (!modal) return;
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      if (titleNode) titleNode.textContent = mode === 'edit' ? 'Edit Trade' : 'Add New Trade';
    };

    const closeTradeModal = (): void => {
      if (!modal) return;
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
    };

    const showTradePanel = (panel: 'details' | 'checklist'): void => {
      const detailsActive = panel === 'details';
      detailsPanel?.classList.toggle('active', detailsActive);
      checklistPanel?.classList.toggle('active', !detailsActive);
      detailsTab?.classList.toggle('ghost', !detailsActive);
      checklistTab?.classList.toggle('ghost', detailsActive);
    };

    const applyTxnFilters = (): void => {
      const query = String(textFilter?.value || '').trim().toUpperCase();
      const side = String(sideFilter?.value || 'ALL').trim().toUpperCase();
      const fromDate = String(fromFilter?.value || '').trim();
      const toDate = String(toFilter?.value || '').trim();
      root.querySelectorAll<HTMLElement>('.txn-card').forEach((card) => {
        const cardSide = String(card.dataset.side || '').trim().toUpperCase();
        const cardSymbol = String(card.dataset.symbol || '').trim().toUpperCase();
        const cardDate = String(card.dataset.date || '').trim();
        const sideMatch = side === 'ALL' || cardSide === side;
        const textMatch = !query || cardSymbol.includes(query);
        const fromMatch = !fromDate || cardDate >= fromDate;
        const toMatch = !toDate || cardDate <= toDate;
        card.style.display = sideMatch && textMatch && fromMatch && toMatch ? '' : 'none';
      });
    };

    root.querySelector<HTMLButtonElement>('#add-trade-btn')?.addEventListener('click', () => {
      manualFormRef?.reset();
      if (manualFormRef) {
        const editIdField = manualFormRef.elements.namedItem('editId') as HTMLInputElement | null;
        if (editIdField) editIdField.value = '';
        const dateField = manualFormRef.elements.namedItem('tradeDateTime') as HTMLInputElement | null;
        if (dateField) dateField.value = toIsoDateTimeLocal(new Date());
      }
      showTradePanel('details');
      openTradeModal('add');
    });
    root.querySelector<HTMLButtonElement>('#close-trade-modal-btn')?.addEventListener('click', closeTradeModal);
    root.querySelector<HTMLButtonElement>('#trade-tab-details')?.addEventListener('click', () => showTradePanel('details'));
    root.querySelector<HTMLButtonElement>('#trade-tab-checklist')?.addEventListener('click', () => showTradePanel('checklist'));
    root.querySelector<HTMLButtonElement>('#open-checklist-tab-btn')?.addEventListener('click', () => showTradePanel('checklist'));
    modal?.addEventListener('click', (event) => {
      if (event.target === modal) closeTradeModal();
    });

    root.querySelector<HTMLButtonElement>('#import-cta-btn')?.addEventListener('click', () => {
      fileInput?.click();
    });
    root.querySelector<HTMLButtonElement>('#jump-requests-btn')?.addEventListener('click', () => {
      requestsSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    textFilter?.addEventListener('input', applyTxnFilters);
    sideFilter?.addEventListener('change', applyTxnFilters);
    fromFilter?.addEventListener('change', applyTxnFilters);
    toFilter?.addEventListener('change', applyTxnFilters);
    root.querySelector<HTMLButtonElement>('#tx-reset-filters')?.addEventListener('click', () => {
      if (textFilter) textFilter.value = '';
      if (sideFilter) sideFilter.value = 'ALL';
      if (fromFilter) {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        fromFilter.value = toIsoDate(d);
      }
      if (toFilter) {
        toFilter.value = toIsoDate(new Date());
      }
      applyTxnFilters();
    });
    const globalSearch = String(localStorage.getItem('fds_global_search') || '').trim();
    if (textFilter && globalSearch.toLowerCase().startsWith('tx ')) {
      textFilter.value = globalSearch.slice(3).trim().toUpperCase();
      localStorage.removeItem('fds_global_search');
    }
    const txContextRaw = String(localStorage.getItem('fds_tx_context') || '').trim();
    if (txContextRaw) {
      try {
        const txContext = JSON.parse(txContextRaw) as { stock?: string; from?: string; to?: string };
        if (textFilter && txContext.stock) textFilter.value = String(txContext.stock).toUpperCase();
        if (fromFilter && txContext.from) fromFilter.value = String(txContext.from);
        if (toFilter && txContext.to) toFilter.value = String(txContext.to);
      } catch {
        // ignore malformed context
      } finally {
        localStorage.removeItem('fds_tx_context');
      }
    }
    applyTxnFilters();

    const runImport = async (file: File | null): Promise<void> => {
      const brokerRaw = String(brokerSelect?.value || 'AUTO').trim();
      const broker = brokerRaw === 'AUTO' ? 'Imported' : brokerRaw.replace(/_/g, ' ');

      if (!file) {
        renderWorkspace(root, session, state, view, 'File is required');
        return;
      }

      showBlockingLoader('Importing trades...');
      try {
        const ok = await confirmPopup(`Import ${file.name}?`, 'Import Trades');
        if (!ok) return;
        const baseState = await refreshTickerData(session, state);
        const result = await importBrokerageFile(file, broker);
        const totalRows = result.accepted.length + result.rejected.length;
        const unmatched = new Set<string>();
        const normalizedImport = result.accepted.map((txn) => {
          const feesFromFile = Number(txn.fees || 0);
          const fees =
            Number.isFinite(feesFromFile) && feesFromFile > 0
              ? feesFromFile
              : computeTxnFees(txn.side, txn.quantity, txn.price, baseState.settings);
          const rawSymbol = String(txn.symbol || '').trim().toUpperCase();
          const resolved =
            resolveTickerFromRegistry(baseState, rawSymbol) || resolveTickerFromNseMaster(baseState, rawSymbol);
          if (!resolved) {
            if (rawSymbol) unmatched.add(rawSymbol);
          }
          const symbol = resolved ? resolved.ticker : rawSymbol;
          const nextNote =
            resolved && rawSymbol && rawSymbol !== resolved.ticker
              ? [txn.note, `Raw: ${rawSymbol}`].filter(Boolean).join(' | ')
              : txn.note;
          return { ...txn, fees, symbol, note: nextNote };
        });
        const deduped = dedupeImportedTransactions(baseState.transactions, normalizedImport);
        const filtered = filterImportImpossibleSells(baseState.transactions, deduped.accepted);
        let nextState = appendTransactions(session, baseState, filtered.accepted);
        if (unmatched.size) {
          await submitTickerRequests(session, Array.from(unmatched.values()));
          nextState = await refreshTickerData(session, nextState);
        }
        const reasonCounts = result.rejected.reduce<Record<string, number>>((acc, row) => {
          acc[row.reason] = (acc[row.reason] || 0) + 1;
          return acc;
        }, {});
        const topReasons = Object.entries(reasonCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([reason, count]) => `${reason} (${count})`)
          .join('; ');
        renderWorkspace(
          root,
          session,
          ensureDefaultMappings(nextState),
          view,
          `Total ${totalRows} | Imported ${filtered.accepted.length} | Rejected ${result.rejected.length}${
            topReasons ? ` (${topReasons})` : ''
          } | Duplicates skipped ${deduped.duplicatesSkipped} | Invalid SELL skipped ${filtered.skippedImpossible}${
            unmatched.size ? ` | Ticker requests ${unmatched.size}` : ''
          }`
        );
      } finally {
        hideBlockingLoader();
      }
    };

    fileInput?.addEventListener('change', async () => {
      const selected = fileInput.files && fileInput.files.length ? fileInput.files[0] : null;
      await runImport(selected);
      if (fileInput) fileInput.value = '';
    });

    root.querySelector<HTMLButtonElement>('#sync-live-btn')?.addEventListener('click', () => {
      runLiveSync();
    });
    setupTickerRequestModalHandlers();

    root.querySelector<HTMLButtonElement>('#run-checklist-btn')?.addEventListener('click', () => {
      const output = root.querySelector<HTMLDivElement>('#checklist-output');
      if (!output) return;

      const manualForm = root.querySelector<HTMLFormElement>('#manual-form');
      const summaryNode = root.querySelector<HTMLDivElement>('#checklist-summary');
      if (!manualForm || !summaryNode) return;

      const manual = new FormData(manualForm);
      const symbol = String(manual.get('symbol') || '').trim().toUpperCase();
      const quantity = Number(manual.get('quantity') || 0);
      const price = Number(manual.get('price') || 0);
      const fees = 0;
      if (!symbol || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
        output.className = 'loss';
        output.textContent = 'Enter symbol, quantity and price first.';
        summaryNode.innerHTML = '';
        return;
      }

      const summary = buildPreBuySummary(state, symbol, quantity, price, Number.isFinite(fees) ? fees : 0);
      const result = runPreBuyChecklist(summary, state);
      if (result.passed) {
        output.className = 'profit';
        output.textContent = `Checklist Passed (${result.score}/${result.total})`;
      } else {
        output.className = 'loss';
        output.textContent = `Checklist Failed (${result.score}/${result.total}) | Missing: ${result.reasons.join(', ')}`;
      }

      const zoneText = summary.price <= summary.l2 ? 'At/Below L2 zone' : summary.price <= summary.l1 ? 'At/Below L1 zone' : 'Above L1/L2 zones';
      const dropText =
        summary.dropFromLastBuyPct === undefined
          ? 'First tracked buy'
          : `Drop from last buy: ${summary.dropFromLastBuyPct.toFixed(1)}%`;
      summaryNode.innerHTML = `
        <div class="tiny-label">
          Stock: ${esc(summary.stock)} | Qty: ${summary.qty} | Price: ${formatCurrency(summary.price, state.settings.currency)} | Buy Cost: ${formatCurrency(summary.buyCost, state.settings.currency)}
        </div>
        <div class="tiny-label">${zoneText} | ${dropText} | Allocation ${summary.allocationPct.toFixed(1)}% (limit ${state.settings.allocationLimitPct.toFixed(1)}%)</div>
        <div class="tiny-label">Targets | L1: ${formatCurrency(summary.l1, state.settings.currency)} | L2: ${formatCurrency(summary.l2, state.settings.currency)}</div>
        <div class="tiny-label">Current Avg (Old): ${formatCurrency(summary.currentAvg, state.settings.currency)} | Projected New Avg: ${formatCurrency(summary.projectedAvg, state.settings.currency)}</div>
        <div class="tiny-label">Stock Budget: ${formatCurrency(summary.stockBudget, state.settings.currency)} | Remaining: ${formatCurrency(summary.remainingBudget, state.settings.currency)}</div>
        <div class="tiny-label"><strong>Suggestion:</strong> ${esc(summary.suggestion)}</div>
      `;
    });

    root.querySelector<HTMLFormElement>('#manual-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);

      const editId = String(data.get('editId') || '').trim();
      const tradeDateTimeRaw = String(data.get('tradeDateTime') || '').trim();
      const tradeDateTime = parseDateTimeLocal(tradeDateTimeRaw);
      const tradeDate = tradeDateTime ? toIsoDate(tradeDateTime) : '';
      const broker = 'Manual';
      const rawSymbol = String(data.get('symbol') || '').trim().toUpperCase();
      const resolvedSymbol = resolveTickerFromRegistry(state, rawSymbol) || resolveTickerFromNseMaster(state, rawSymbol);
      const symbol = resolvedSymbol ? resolvedSymbol.ticker : rawSymbol;
      const side = String(data.get('side') || '').trim().toUpperCase();
      const quantity = Number(data.get('quantity') || 0);
      const price = Number(data.get('price') || 0);
      const note = String(data.get('note') || '').trim();
      const enforceChecklist = String(data.get('enforceChecklist') || '') === 'on';

      if (!tradeDateTime || !rawSymbol || (side !== 'BUY' && side !== 'SELL')) {
        renderWorkspace(root, session, state, view, 'Manual entry: required fields missing (date/time or symbol)');
        return;
      }
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
        renderWorkspace(root, session, state, view, 'Manual entry: quantity and price must be valid');
        return;
      }

      if (side === 'SELL') {
        const baseline = state.transactions.filter((item) => item.id !== editId);
        const available = availableQtyForStock(baseline, symbol);
        if (quantity > available) {
          renderWorkspace(
            root,
            session,
            state,
            view,
            `Invalid SELL qty. Available holding for ${symbol}: ${available}`
          );
          return;
        }
      }

      let checklistNote = '';
      if (side === 'BUY' && enforceChecklist) {
        const summaryNode = root.querySelector<HTMLDivElement>('#checklist-summary');
        const summary = buildPreBuySummary(
          state,
          symbol,
          quantity,
          price,
          computeTxnFees('BUY', quantity, price, state.settings)
        );
        const result = runPreBuyChecklist(summary, state);
        checklistNote = `Checklist ${result.passed ? 'PASS' : 'FAIL'} ${result.score}/${result.total}`;
        if (summaryNode) {
          summaryNode.innerHTML = `<div class="tiny-label"><strong>Suggestion:</strong> ${esc(summary.suggestion)}</div>`;
        }
      }

      const txn = {
        id: editId || crypto.randomUUID(),
        importedAt: new Date().toISOString(),
        tradeDate,
        tradeDateTime: tradeDateTime.toISOString(),
        broker,
        symbol,
        side: side as 'BUY' | 'SELL',
        quantity,
        price,
        fees: computeTxnFees(side as 'BUY' | 'SELL', quantity, price, state.settings),
        note: [
          note,
          checklistNote,
          resolvedSymbol && rawSymbol && rawSymbol !== resolvedSymbol.ticker ? `Raw: ${rawSymbol}` : ''
        ]
          .filter(Boolean)
          .join(' | ')
      };

      let next = upsertTransaction(session, state, txn);
      if (!resolvedSymbol && rawSymbol) {
        await submitTickerRequests(session, [rawSymbol]);
        next = await refreshTickerData(session, next);
      }
      const msgBase = editId ? 'Transaction updated' : 'Transaction added';
      const msg = `${msgBase}${checklistNote.includes('FAIL') ? ' (checklist warning)' : ''}${
        !resolvedSymbol && rawSymbol ? ' | Ticker request sent' : ''
      }`;
      addActivityLog('trade', `${editId ? 'Edited' : 'Added'} trade ${side} ${symbol}`);
      renderWorkspace(root, session, next, view, msg);
    });

    root.querySelectorAll<HTMLButtonElement>('button[data-edit-txn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = String(btn.dataset.editTxn || '').trim();
        const txn = state.transactions.find((item) => item.id === id);
        const form = root.querySelector<HTMLFormElement>('#manual-form');
        if (!txn || !form) return;
        const set = (name: string, value: string) => {
          const input = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
          if (input) input.value = value;
        };
        set('editId', txn.id);
        const dtValue = txn.tradeDateTime
          ? toIsoDateTimeLocal(new Date(txn.tradeDateTime))
          : txn.tradeDate
            ? `${txn.tradeDate}T09:15`
            : toIsoDateTimeLocal(new Date());
        set('tradeDateTime', dtValue);
        set('symbol', txn.symbol);
        set('side', txn.side);
        set('quantity', String(txn.quantity));
        set('price', String(txn.price));
        set('note', String(txn.note || ''));
        const symbolInput = form.elements.namedItem('symbol') as HTMLInputElement | null;
        symbolInput?.focus();
        showTradePanel('details');
        openTradeModal('edit');
      });
    });

    root.querySelectorAll<HTMLButtonElement>('button[data-del-txn]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = String(btn.dataset.delTxn || '').trim();
        if (!id) return;
        const ok = await confirmPopup('Delete this transaction?', 'Delete Transaction');
        if (!ok) return;
        const next = deleteTransaction(session, state, id);
        addActivityLog('trade', 'Deleted trade');
        renderWorkspace(root, session, next, view, 'Transaction deleted');
      });
    });

    root.querySelector<HTMLButtonElement>('#clear-transactions-btn')?.addEventListener('click', async () => {
      const ok = await confirmPopup('Delete all transactions? This cannot be undone.', 'Delete All Transactions');
      if (!ok) return;
      const next = clearTransactions(session, state);
      addActivityLog('trade', 'Deleted all trades');
      renderWorkspace(root, session, next, view, 'All transactions deleted');
    });
  }

  if (viewKey === 'holdings') {
    const holdGrid = root.querySelector<HTMLElement>('#holdings-cards-grid');
    const holdSort = root.querySelector<HTMLSelectElement>('#hold-sort');
    const holdSearch = root.querySelector<HTMLInputElement>('#hold-search');
    const holdTickerSearch = root.querySelector<HTMLInputElement>('#holding-ticker-search');
    const holdTickerSort = root.querySelector<HTMLSelectElement>('#holding-ticker-sort');
    const holdTickerTable = root.querySelector<HTMLElement>('#holding-ticker-table');

    const applyHoldingsFilters = (): void => {
      if (!holdGrid) return;
      const search = String(holdSearch?.value || '').trim().toUpperCase();
      const activeFilterBtn = root.querySelector<HTMLButtonElement>('[data-hold-filter].active');
      const filterMode = String(activeFilterBtn?.dataset.holdFilter || 'ALL').toUpperCase();

      const cards = Array.from(holdGrid.querySelectorAll<HTMLElement>('.hold-card'));
      cards.forEach((card) => {
        const stock = String(card.dataset.stock || '').toUpperCase();
        const upnl = Number(card.dataset.upnl || 0);
        const textMatch = !search || stock.includes(search);
        const modeMatch =
          filterMode === 'ALL' ||
          (filterMode === 'PROFIT' && upnl >= 0) ||
          (filterMode === 'LOSS' && upnl < 0);
        card.style.display = textMatch && modeMatch ? '' : 'none';
      });

      const visible = cards.filter((card) => card.style.display !== 'none');
      const sortMode = String(holdSort?.value || 'loss');
      visible.sort((a, b) => {
        const upnlA = Number(a.dataset.upnl || 0);
        const upnlB = Number(b.dataset.upnl || 0);
        const allocA = Number(a.dataset.alloc || 0);
        const allocB = Number(b.dataset.alloc || 0);
        const stockA = String(a.dataset.stock || '');
        const stockB = String(b.dataset.stock || '');
        if (sortMode === 'gain') return upnlB - upnlA;
        if (sortMode === 'alloc') return allocB - allocA;
        if (sortMode === 'name') return stockA.localeCompare(stockB);
        return upnlA - upnlB;
      });
      visible.forEach((card) => holdGrid.appendChild(card));
    };

    const applyHoldingTickerFilters = (): void => {
      if (!holdTickerTable) return;
      const query = String(holdTickerSearch?.value || '').trim().toUpperCase();
      const sortMode = String(holdTickerSort?.value || 'az');
      const rows = Array.from(holdTickerTable.querySelectorAll<HTMLElement>('.ticker-row[data-ticker]'));
      rows.forEach((row) => {
        const ticker = String(row.dataset.ticker || '').toUpperCase();
        row.style.display = !query || ticker.includes(query) ? '' : 'none';
      });
      const visible = rows.filter((row) => row.style.display !== 'none');
      visible.sort((a, b) => {
        const tA = String(a.dataset.ticker || '');
        const tB = String(b.dataset.ticker || '');
        const ltpA = Number(a.dataset.ltp || 0);
        const ltpB = Number(b.dataset.ltp || 0);
        const chA = Number(a.dataset.change || 0);
        const chB = Number(b.dataset.change || 0);
        if (sortMode === 'za') return tB.localeCompare(tA);
        if (sortMode === 'ltp') return ltpB - ltpA;
        if (sortMode === 'change') return chB - chA;
        return tA.localeCompare(tB);
      });
      visible.forEach((row) => holdTickerTable.appendChild(row));
    };

    root.querySelectorAll<HTMLButtonElement>('[data-hold-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        root.querySelectorAll<HTMLButtonElement>('[data-hold-filter]').forEach((b) => {
          b.classList.add('ghost');
          b.classList.remove('active');
        });
        btn.classList.remove('ghost');
        btn.classList.add('active');
        applyHoldingsFilters();
      });
    });
    holdSort?.addEventListener('change', applyHoldingsFilters);
    holdSearch?.addEventListener('input', applyHoldingsFilters);
    holdTickerSearch?.addEventListener('input', applyHoldingTickerFilters);
    holdTickerSort?.addEventListener('change', applyHoldingTickerFilters);
    const globalSearch = String(localStorage.getItem('fds_global_search') || '').trim();
    if (holdSearch && globalSearch.toLowerCase().startsWith('holding ')) {
      holdSearch.value = globalSearch.slice(8).trim().toUpperCase();
      localStorage.removeItem('fds_global_search');
    }
    applyHoldingsFilters();
    applyHoldingTickerFilters();

    root.querySelector<HTMLButtonElement>('#sync-live-btn')?.addEventListener('click', () => {
      runLiveSync();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-hold-showtx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const stock = String(btn.dataset.holdShowtx || '').trim().toUpperCase();
        if (!stock) return;
        const cycleFrom = currentCycleStartDateForStock(state, stock);
        localStorage.setItem(
          'fds_tx_context',
          JSON.stringify({
            stock,
            from: cycleFrom || '',
            to: toIsoDate(new Date())
          })
        );
        localStorage.setItem('fds_global_search', `tx ${stock}`);
        window.location.href = pagePath('transactions');
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-hold-details]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const stock = String(btn.dataset.holdDetails || '').trim().toUpperCase();
        if (!stock) return;
        const card = btn.closest<HTMLElement>('.hold-card');
        const ticker = String(card?.dataset.ticker || stock).trim().toUpperCase();
        const modal = root.querySelector<HTMLElement>('#hold-detail-modal');
        const title = root.querySelector<HTMLElement>('#hold-detail-title');
        const wrap = root.querySelector<HTMLElement>('#hold-detail-chart-wrap');
        if (!modal || !title || !wrap) return;
        title.textContent = `${stock} (${ticker})`;
        wrap.innerHTML = '<div class="muted">Loading last 7 trading days...</div>';
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
        showBlockingLoader('Fetching price history...');
        try {
          const history = await fetchPriceHistory(ticker, 7);
          wrap.innerHTML = buildHistoryChartMarkup(history.points, state.settings.currency);
          bindHistoryChartTooltip(wrap, state.settings.currency);
        } catch (error) {
          const messageText = error instanceof Error ? error.message : 'Failed to load price history';
          wrap.innerHTML = `<div class="loss">${esc(messageText)}</div>`;
          showToast(messageText, 'error');
        } finally {
          hideBlockingLoader();
        }
      });
    });
    root.querySelector<HTMLButtonElement>('#close-hold-detail-btn')?.addEventListener('click', () => {
      const modal = root.querySelector<HTMLElement>('#hold-detail-modal');
      modal?.classList.remove('open');
      modal?.setAttribute('aria-hidden', 'true');
    });
    root.querySelector<HTMLElement>('#hold-detail-modal')?.addEventListener('click', (event) => {
      const modal = root.querySelector<HTMLElement>('#hold-detail-modal');
      if (!modal) return;
      if (event.target === modal) {
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
      }
    });
  }

  if (viewKey === 'pnl') {
    const pnlFrom = root.querySelector<HTMLInputElement>('#pnl-filter-from');
    const pnlTo = root.querySelector<HTMLInputElement>('#pnl-filter-to');
    const pnlMode = root.querySelector<HTMLSelectElement>('#pnl-filter-mode');
    const pnlSearch = root.querySelector<HTMLInputElement>('#pnl-filter-search');
    const pnlApply = root.querySelector<HTMLButtonElement>('#pnl-filter-apply');
    const pnlReset = root.querySelector<HTMLButtonElement>('#pnl-filter-reset');
    const pnlShell = root.querySelector<HTMLElement>('.pnl-filter-shell');
    const rangeButtons = root.querySelectorAll<HTMLButtonElement>('[data-pnl-range]');
    const viewButtons = root.querySelectorAll<HTMLButtonElement>('[data-pnl-view]');

    const applyPnlFilterState = (): void => {
      if (!pnlFrom || !pnlTo || !pnlMode || !pnlSearch) return;
      let from = String(pnlFrom.value || '').trim();
      let to = String(pnlTo.value || '').trim();
      if (isValidIsoDate(from) && isValidIsoDate(to) && new Date(from).getTime() > new Date(to).getTime()) {
        const swap = from;
        from = to;
        to = swap;
      }
      const filters: PnlFilterState = {
        from,
        to,
        mode: (String(pnlMode.value || 'ALL').toUpperCase() as PnlFilterMode) || 'ALL',
        search: String(pnlSearch.value || '').trim()
      };
      savePnlFilters(filters);
      renderWorkspace(root, session, state, view, 'P/L filters applied');
    };

    pnlApply?.addEventListener('click', applyPnlFilterState);
    pnlReset?.addEventListener('click', () => {
      clearPnlFilters();
      renderWorkspace(root, session, state, view, 'P/L filters reset');
    });
    viewButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextView = String(btn.dataset.pnlView || 'REALIZED').toUpperCase() === 'UNREALIZED' ? 'UNREALIZED' : 'REALIZED';
        setPnlView(nextView);
        renderWorkspace(root, session, state, view, nextView === 'UNREALIZED' ? 'Unrealized view enabled' : 'Realized view enabled');
      });
    });
    rangeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!pnlFrom || !pnlTo) return;
        const mode = String(btn.dataset.pnlRange || '').toUpperCase();
        const today = new Date();
        if (mode === 'MONTH') {
          pnlFrom.value = startOfMonthIso(today);
          pnlTo.value = toIsoDate(today);
        } else if (mode === '30D') {
          const from = new Date();
          from.setDate(from.getDate() - 30);
          pnlFrom.value = toIsoDate(from);
          pnlTo.value = toIsoDate(today);
        } else if (mode === 'ALL') {
          const minDate = String(pnlShell?.dataset.minDate || '');
          const maxDate = String(pnlShell?.dataset.maxDate || '');
          if (isValidIsoDate(minDate)) pnlFrom.value = minDate;
          if (isValidIsoDate(maxDate)) pnlTo.value = maxDate;
        }
        applyPnlFilterState();
      });
    });
    pnlMode?.addEventListener('change', applyPnlFilterState);
    pnlFrom?.addEventListener('change', applyPnlFilterState);
    pnlTo?.addEventListener('change', applyPnlFilterState);
    let pnlSearchTimer: number | undefined;
    pnlSearch?.addEventListener('input', () => {
      if (pnlSearchTimer) window.clearTimeout(pnlSearchTimer);
      pnlSearchTimer = window.setTimeout(() => applyPnlFilterState(), 250);
    });

    root.querySelectorAll<HTMLButtonElement>('[data-pnl-showtx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const stock = String(btn.dataset.pnlShowtx || '').trim().toUpperCase();
        if (!stock) return;
        const cycleFrom = currentCycleStartDateForStock(state, stock);
        localStorage.setItem(
          'fds_tx_context',
          JSON.stringify({
            stock,
            from: cycleFrom || '',
            to: toIsoDate(new Date())
          })
        );
        localStorage.setItem('fds_global_search', `tx ${stock}`);
        window.location.href = pagePath('transactions');
      });
    });

    root.querySelectorAll<HTMLButtonElement>('[data-pnl-detail]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const stock = String(btn.dataset.pnlDetail || '').trim().toUpperCase();
        if (!stock) return;
        const viewMode = getPnlView();
        const allRows = calculateRealizedPnlRows(state.transactions);
        const filters = loadPnlFilters(allRows);
        const filtered = applyPnlFilters(allRows, filters).filter((row) => row.stock === stock);
        const unrealizedRows = buildUnrealizedRows(state);
        const unrealized = unrealizedRows.find((row) => row.stock === stock);
        if (viewMode === 'REALIZED' && !filtered.length) {
          showToast(`No realized trades for ${stock} in the active filter range`, 'info');
          return;
        }
        if (viewMode === 'UNREALIZED' && !unrealized) {
          showToast(`No active holding found for ${stock}`, 'info');
          return;
        }

        const modal = root.querySelector<HTMLElement>('#pnl-detail-modal');
        const title = root.querySelector<HTMLElement>('#pnl-detail-title');
        const summary = root.querySelector<HTMLElement>('#pnl-detail-summary');
        const thead = root.querySelector<HTMLElement>('#pnl-detail-thead');
        const tableBody = root.querySelector<HTMLElement>('#pnl-detail-tbody');
        const chartWrap = root.querySelector<HTMLElement>('#pnl-detail-chart-wrap');
        if (!modal || !title || !summary || !thead || !tableBody || !chartWrap) return;

        const ticker = resolveTicker(state, stock);
        title.textContent = `${stock} (${ticker})`;

        if (viewMode === 'REALIZED') {
          thead.innerHTML = `<tr><th>Date</th><th>Qty</th><th>Invested</th><th>Sell Value</th><th>Fees</th><th>Net</th><th>Hold</th><th>Return</th></tr>`;
          const totals = filtered.reduce(
            (acc, row) => {
              acc.trades += 1;
              acc.qty += Number(row.quantity || 0);
              acc.buyCost += Number(row.buyCost || 0) + Number(row.buyFees || 0);
              acc.sellValue += Number(row.sellValue || 0);
              acc.fees += Number(row.sellFees || 0);
              acc.net += Number(row.net || 0);
              acc.holdDaysWeighted += Number(row.holdDays || 0) * Number(row.quantity || 0);
              acc.returnTotal += Number(row.returnPct || 0);
              return acc;
            },
            { trades: 0, qty: 0, buyCost: 0, sellValue: 0, fees: 0, net: 0, holdDaysWeighted: 0, returnTotal: 0 }
          );
          const avgHoldDays = totals.qty > 0 ? totals.holdDaysWeighted / totals.qty : 0;
          const avgReturnPct = totals.trades > 0 ? totals.returnTotal / totals.trades : 0;
          const netCls = totals.net >= 0 ? 'profit' : 'loss';

          summary.innerHTML = `
            <div><span class="tiny-label">Realized Net</span><strong class="${netCls}">${formatCurrency(totals.net, state.settings.currency)}</strong></div>
            <div><span class="tiny-label">Trades</span><strong>${totals.trades}</strong></div>
            <div><span class="tiny-label">Avg Hold</span><strong>${avgHoldDays.toFixed(0)}d</strong></div>
            <div><span class="tiny-label">Avg Return</span><strong class="${avgReturnPct >= 0 ? 'profit' : 'loss'}">${avgReturnPct.toFixed(2)}%</strong></div>
            <div><span class="tiny-label">Buy Cost</span><strong>${formatCurrency(totals.buyCost, state.settings.currency)}</strong></div>
            <div><span class="tiny-label">Sell Value</span><strong>${formatCurrency(totals.sellValue, state.settings.currency)}</strong></div>
            <div><span class="tiny-label">Fees</span><strong>${formatCurrency(totals.fees, state.settings.currency)}</strong></div>
          `;

          tableBody.innerHTML = filtered
            .map((row) => {
              const cls = row.net >= 0 ? 'profit' : 'loss';
              return `
                <tr>
                  <td>${formatDateFromISOToDDMM(row.date)}</td>
                  <td>${row.quantity.toFixed(2)}</td>
                  <td>${formatCurrency(row.buyCost + row.buyFees, state.settings.currency)}</td>
                  <td>${formatCurrency(row.sellValue, state.settings.currency)}</td>
                  <td>${formatCurrency(row.sellFees, state.settings.currency)}</td>
                  <td class="${cls}">${formatCurrency(row.net, state.settings.currency)}</td>
                  <td>${row.holdDays.toFixed(0)}d</td>
                  <td class="${cls}">${row.returnPct.toFixed(2)}%</td>
                </tr>
              `;
            })
            .join('');
        } else if (unrealized) {
          thead.innerHTML = `<tr><th>Stock</th><th>Qty</th><th>Invested</th><th>Current Value</th><th>Unrealized</th><th>Hold</th><th>Return</th></tr>`;
          const netCls = unrealized.unrealized >= 0 ? 'profit' : 'loss';
          summary.innerHTML = `
            <div><span class="tiny-label">Unrealized Net</span><strong class="${netCls}">${formatCurrency(unrealized.unrealized, state.settings.currency)}</strong></div>
            <div><span class="tiny-label">Quantity</span><strong>${unrealized.qty.toFixed(2)}</strong></div>
            <div><span class="tiny-label">Hold Days</span><strong>${unrealized.holdDays}d</strong></div>
            <div><span class="tiny-label">Return</span><strong class="${unrealized.unrealizedPct >= 0 ? 'profit' : 'loss'}">${unrealized.unrealizedPct.toFixed(2)}%</strong></div>
            <div><span class="tiny-label">Invested</span><strong>${formatCurrency(unrealized.invested, state.settings.currency)}</strong></div>
            <div><span class="tiny-label">Current Value</span><strong>${formatCurrency(unrealized.currentValue, state.settings.currency)}</strong></div>
            <div><span class="tiny-label">Fees</span><strong>-</strong></div>
          `;
          tableBody.innerHTML = `<tr><td colspan="7">${esc('No realized trades in unrealized view.')}</td></tr>`;
        }

        chartWrap.innerHTML = '<div class="muted">Loading selected date range...</div>';
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
        showBlockingLoader('Fetching price history...');
        try {
          const history = await fetchPriceHistory(ticker, 30, filters.from, filters.to);
          chartWrap.innerHTML = buildHistoryChartMarkup(history.points, state.settings.currency);
          bindHistoryChartTooltip(chartWrap, state.settings.currency);
        } catch (error) {
          const messageText = error instanceof Error ? error.message : 'Failed to load price history';
          chartWrap.innerHTML = `<div class="loss">${esc(messageText)}</div>`;
          showToast(messageText, 'error');
        } finally {
          hideBlockingLoader();
        }
      });
    });

    root.querySelector<HTMLButtonElement>('#close-pnl-detail-btn')?.addEventListener('click', () => {
      const modal = root.querySelector<HTMLElement>('#pnl-detail-modal');
      modal?.classList.remove('open');
      modal?.setAttribute('aria-hidden', 'true');
    });
    root.querySelector<HTMLElement>('#pnl-detail-modal')?.addEventListener('click', (event) => {
      const modal = root.querySelector<HTMLElement>('#pnl-detail-modal');
      if (!modal) return;
      if (event.target === modal) {
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
      }
    });
  }

  if (viewKey === 'expenses') {
    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-txned-tab]'));
    const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-txned-panel]'));
    const debtCategorySelect = root.querySelector<HTMLSelectElement>('#txned-debt-category');
    const creditCategorySelect = root.querySelector<HTMLSelectElement>('#txned-credit-category');
    const debtPersonInput = root.querySelector<HTMLInputElement>('#debt-form input[name="person"]');
    let activeDebtMode: 'debt' | 'credit' = 'debt';
    const setActiveTab = (key: string): void => {
      tabs.forEach((btn) => {
        const active = String(btn.dataset.txnedTab || '') === key;
        btn.classList.toggle('active', active);
        btn.classList.toggle('ghost', !active);
      });
      panels.forEach((panel) => {
        const panelKey = String(panel.dataset.txnedPanel || '');
        const show = key === 'expense' ? panelKey === 'expense' : panelKey === 'debt';
        panel.classList.toggle('hidden', !show);
      });
      if (key === 'debt' || key === 'credit') {
        activeDebtMode = key;
      }
      if (debtCategorySelect && creditCategorySelect) {
        if (key === 'credit') {
          debtCategorySelect.classList.add('hidden');
          debtCategorySelect.required = false;
          creditCategorySelect.classList.remove('hidden');
          creditCategorySelect.required = true;
        } else if (key === 'debt') {
          creditCategorySelect.classList.add('hidden');
          creditCategorySelect.required = false;
          debtCategorySelect.classList.remove('hidden');
          debtCategorySelect.required = true;
        }
      }
      if (debtPersonInput) {
        if (key === 'credit') {
          debtPersonInput.value = '';
          debtPersonInput.required = false;
          debtPersonInput.classList.add('hidden');
        } else if (key === 'debt') {
          debtPersonInput.required = true;
          debtPersonInput.classList.remove('hidden');
        }
      }
    };
    if (tabs.length && panels.length) {
      const initial = tabs.find((btn) => btn.classList.contains('active')) || tabs[0];
      setActiveTab(String(initial?.dataset.txnedTab || 'expense'));
      tabs.forEach((btn) => {
        btn.addEventListener('click', () => setActiveTab(String(btn.dataset.txnedTab || 'expense')));
      });
    }

    const categoryForm = root.querySelector<HTMLFormElement>('#txned-category-form');
    const categoryInput = root.querySelector<HTMLInputElement>('#txned-category-input');
    const catTabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-cat-tab]'));
    const catPanels = Array.from(root.querySelectorAll<HTMLElement>('[data-cat-panel]'));
    let activeCatType: 'expense' | 'debt' | 'credit' = 'expense';
    const setActiveCatTab = (type: 'expense' | 'debt' | 'credit'): void => {
      activeCatType = type;
      catTabs.forEach((btn) => {
        const active = String(btn.dataset.catTab || '') === type;
        btn.classList.toggle('active', active);
        btn.classList.toggle('ghost', !active);
      });
      catPanels.forEach((panel) => {
        const show = String(panel.dataset.catPanel || '') === type;
        panel.classList.toggle('hidden', !show);
      });
      if (categoryForm) categoryForm.dataset.editing = '';
      if (categoryInput) categoryInput.value = '';
    };
    if (catTabs.length && catPanels.length) {
      const initial = catTabs.find((btn) => btn.classList.contains('active')) || catTabs[0];
      setActiveCatTab(String(initial?.dataset.catTab || 'expense') as 'expense' | 'debt' | 'credit');
      catTabs.forEach((btn) => {
        btn.addEventListener('click', () => {
          setActiveCatTab(String(btn.dataset.catTab || 'expense') as 'expense' | 'debt' | 'credit');
        });
      });
    }

    const applyCategoryChange = (type: 'expense' | 'debt' | 'credit', nextCategories: string[], message: string): void => {
      saveCategoriesFor(type, nextCategories);
      renderWorkspace(root, session, state, view, message);
    };
    categoryForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = String(categoryInput?.value || '').trim();
      if (!name) return;
      const current = getCategoriesFor(activeCatType);
      const editing = String(categoryForm.dataset.editing || '').trim();
      if (editing) {
        const replaced = current.map((c) => (c.toLowerCase() === editing.toLowerCase() ? name : c));
        categoryForm.dataset.editing = '';
        if (categoryInput) categoryInput.value = '';
        applyCategoryChange(activeCatType, replaced, 'Category updated');
        return;
      }
      if (current.some((c) => c.toLowerCase() === name.toLowerCase())) return;
      applyCategoryChange(activeCatType, [...current, name], 'Category added');
      if (categoryInput) categoryInput.value = '';
    });

    root.querySelectorAll<HTMLButtonElement>('button[data-edit-category]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = String(btn.dataset.editCategory || '').trim();
        const type = String(btn.dataset.catType || 'expense') as 'expense' | 'debt' | 'credit';
        if (!name || !categoryInput || !categoryForm) return;
        setActiveCatTab(type);
        categoryInput.value = name;
        categoryForm.dataset.editing = name;
        categoryInput.focus();
      });
    });

    root.querySelectorAll<HTMLButtonElement>('button[data-del-category]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = String(btn.dataset.delCategory || '').trim();
        const type = String(btn.dataset.catType || 'expense') as 'expense' | 'debt' | 'credit';
        if (!name) return;
        const ok = await confirmPopup(`Delete ${type} category "${name}"?`, 'Delete Category');
        if (!ok) return;
        const next = getCategoriesFor(type).filter((c) => c.toLowerCase() !== name.toLowerCase());
        applyCategoryChange(type, next, 'Category deleted');
      });
    });

    const tableBody = root.querySelector<HTMLTableSectionElement>('#txned-table-body');
    const tableRows = tableBody ? Array.from(tableBody.querySelectorAll<HTMLTableRowElement>('tr[data-kind]')) : [];
    const chipButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-txned-chip]'));
    const dateFrom = root.querySelector<HTMLInputElement>('#txned-date-from');
    const dateTo = root.querySelector<HTMLInputElement>('#txned-date-to');
    let activeChip = 'all';
    const applyTableFilter = (): void => {
      if (!tableBody) return;
      const from = String(dateFrom?.value || '').trim();
      const to = String(dateTo?.value || '').trim();
      const filtered = tableRows.filter((row) => {
        const kind = String(row.dataset.kind || '');
        const date = String(row.dataset.date || '');
        if (activeChip === 'expense' && kind !== 'EXPENSE') return false;
        if (activeChip === 'debt' && kind !== 'DEBT') return false;
        if (activeChip === 'credit' && kind !== 'CREDIT') return false;
        if (from && date < from) return false;
        if (to && date > to) return false;
        return true;
      });
      filtered.sort((a, b) => {
        const aDate = String(a.dataset.date || '');
        const bDate = String(b.dataset.date || '');
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      });
      tableBody.innerHTML = '';
      if (!filtered.length) {
        tableBody.innerHTML = '<tr><td colspan="7">No entries yet.</td></tr>';
        return;
      }
      filtered.forEach((row) => tableBody.appendChild(row));
    };
    if (chipButtons.length && tableBody) {
      const initial = chipButtons.find((btn) => btn.classList.contains('active')) || chipButtons[0];
      activeChip = String(initial?.dataset.txnedChip || 'all');
      chipButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
          activeChip = String(btn.dataset.txnedChip || 'all');
          chipButtons.forEach((b) => {
            const active = String(b.dataset.txnedChip || '') === activeChip;
            b.classList.toggle('active', active);
            b.classList.toggle('ghost', !active);
          });
          applyTableFilter();
        });
      });
      applyTableFilter();
    }
    if (dateFrom && !dateFrom.value) dateFrom.value = startOfMonthIso(new Date());
    if (dateTo && !dateTo.value) dateTo.value = toIsoDate(new Date());
    dateFrom?.addEventListener('change', applyTableFilter);
    dateTo?.addEventListener('change', applyTableFilter);
    applyTableFilter();

    root.querySelector<HTMLFormElement>('#expense-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const id = String(data.get('id') || '').trim() || crypto.randomUUID();
      const date = String(data.get('date') || '').trim();
      const category = String(data.get('category') || '').trim();
      const amount = Number(data.get('amount') || 0);
      const paymentMode = String(data.get('paymentMode') || '').trim();
      const note = String(data.get('note') || '').trim();

      const isEdit = state.expenses.some((item) => item.id === id);
      if (!date || !category || !Number.isFinite(amount) || amount <= 0 || !paymentMode) {
        renderWorkspace(root, session, state, view, 'Expense form: invalid input');
        return;
      }

      const next = upsertExpense(session, state, { id, date, category, amount, paymentMode, note });
      addActivityLog('expense', `${isEdit ? 'Edited' : 'Added'} expense ${category} ${money(amount, state.settings.currency)}`);
      renderWorkspace(root, session, next, view, 'Expense saved');
    });

    const handleEditExpense = (id: string): void => {
      const row = state.expenses.find((item) => item.id === id);
      const form = root.querySelector<HTMLFormElement>('#expense-form');
      if (!row || !form) return;
      setActiveTab('expense');
      (form.elements.namedItem('id') as HTMLInputElement).value = row.id;
      (form.elements.namedItem('date') as HTMLInputElement).value = row.date;
      const categoryField = form.elements.namedItem('category') as HTMLSelectElement | null;
      if (categoryField) {
        const exists = Array.from(categoryField.options).some((opt) => opt.value === row.category);
        if (!exists) {
          const customOption = new Option(row.category, row.category, true, true);
          categoryField.add(customOption);
        }
        categoryField.value = row.category;
      }
      (form.elements.namedItem('amount') as HTMLInputElement).value = String(row.amount);
      (form.elements.namedItem('paymentMode') as HTMLSelectElement).value = row.paymentMode;
      (form.elements.namedItem('note') as HTMLInputElement).value = row.note || '';
    };

    const handleEditDebt = (id: string): void => {
      const row = state.debtItems.find((item) => item.id === id);
      const form = root.querySelector<HTMLFormElement>('#debt-form');
      if (!row || !form) return;
      setActiveTab('debt');
      (form.elements.namedItem('id') as HTMLInputElement).value = row.id;
      (form.elements.namedItem('date') as HTMLInputElement).value = row.date;
      const personInput = form.elements.namedItem('person') as HTMLInputElement | null;
      if (personInput) personInput.value = row.person;
      const debtCat = form.querySelector<HTMLSelectElement>('#txned-debt-category');
      const creditCat = form.querySelector<HTMLSelectElement>('#txned-credit-category');
      if (creditCat) creditCat.value = '';
      if (debtCat) debtCat.value = row.category || '';
      (form.elements.namedItem('amount') as HTMLInputElement).value = String(row.amount);
      (form.elements.namedItem('note') as HTMLInputElement).value = row.note || '';
    };

    const handleEditCredit = (id: string): void => {
      const row = state.creditItems.find((item) => item.id === id);
      const form = root.querySelector<HTMLFormElement>('#debt-form');
      if (!row || !form) return;
      setActiveTab('credit');
      (form.elements.namedItem('id') as HTMLInputElement).value = row.id;
      (form.elements.namedItem('date') as HTMLInputElement).value = row.date;
      const personInput = form.elements.namedItem('person') as HTMLInputElement | null;
      if (personInput) personInput.value = '';
      const debtCat = form.querySelector<HTMLSelectElement>('#txned-debt-category');
      const creditCat = form.querySelector<HTMLSelectElement>('#txned-credit-category');
      if (debtCat) debtCat.value = '';
      if (creditCat) creditCat.value = row.category || '';
      (form.elements.namedItem('amount') as HTMLInputElement).value = String(row.amount);
      (form.elements.namedItem('note') as HTMLInputElement).value = row.note || '';
    };

    tableBody?.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement | null;
      const btn = target?.closest('button');
      if (!btn) return;
      const editExpense = String((btn as HTMLButtonElement).dataset.editExpense || '');
      const delExpense = String((btn as HTMLButtonElement).dataset.delExpense || '');
      const editDebt = String((btn as HTMLButtonElement).dataset.editDebt || '');
      const delDebt = String((btn as HTMLButtonElement).dataset.delDebt || '');
      const editCredit = String((btn as HTMLButtonElement).dataset.editCredit || '');
      const delCredit = String((btn as HTMLButtonElement).dataset.delCredit || '');
      if (editExpense) {
        handleEditExpense(editExpense);
        return;
      }
      if (editDebt) {
        handleEditDebt(editDebt);
        return;
      }
      if (editCredit) {
        handleEditCredit(editCredit);
        return;
      }
      if (delExpense) {
        const ok = await confirmPopup('Delete this expense entry?', 'Delete Expense');
        if (!ok) return;
        const next = deleteExpense(session, state, delExpense);
        addActivityLog('expense', 'Deleted expense');
        renderWorkspace(root, session, next, view, 'Expense deleted');
        return;
      }
      if (delDebt) {
        const ok = await confirmPopup('Delete this debt entry?', 'Delete Debt');
        if (!ok) return;
        const next = deleteDebtItem(session, state, delDebt);
        addActivityLog('debt', 'Deleted debt');
        renderWorkspace(root, session, next, view, 'Debt entry deleted');
        return;
      }
      if (delCredit) {
        const ok = await confirmPopup('Delete this credit entry?', 'Delete Credit');
        if (!ok) return;
        const next = deleteCreditItem(session, state, delCredit);
        addActivityLog('credit', 'Deleted credit');
        renderWorkspace(root, session, next, view, 'Credit entry deleted');
      }
    });

    root.querySelector<HTMLFormElement>('#debt-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const id = String(data.get('id') || '').trim() || crypto.randomUUID();
      const date = String(data.get('date') || '').trim();
      const person = String(data.get('person') || '').trim();
      const debtCategory = String(data.get('debtCategory') || '').trim();
      const creditCategory = String(data.get('creditCategory') || '').trim();
      const amount = Number(data.get('amount') || 0);
      const note = String(data.get('note') || '').trim();

      if (!date || !Number.isFinite(amount) || amount <= 0) {
        renderWorkspace(root, session, state, view, 'Form: invalid input');
        return;
      }

      if (activeDebtMode === 'credit') {
        if (!creditCategory) {
          renderWorkspace(root, session, state, view, 'Credit form: category required');
          return;
        }
        const next = upsertCreditItem(session, state, {
          id,
          date,
          category: creditCategory,
          amount,
          note
        });
        const isEdit = state.creditItems.some((item) => item.id === id);
        addActivityLog('credit', `${isEdit ? 'Edited' : 'Added'} credit ${money(amount, state.settings.currency)}`);
        renderWorkspace(root, session, next, view, 'Credit entry saved');
        return;
      }

      if (!person) {
        renderWorkspace(root, session, state, view, 'Debt form: person required');
        return;
      }
      if (!debtCategory) {
        renderWorkspace(root, session, state, view, 'Debt form: category required');
        return;
      }
      const normalizedDebtCategory = debtCategory.toLowerCase();
      const isDebtRepay = normalizedDebtCategory === 'repay' || normalizedDebtCategory === 'emi';
      const type = isDebtRepay ? 'REPAY' : 'BORROW';
      const isEdit = state.debtItems.some((item) => item.id === id);

      const next = upsertDebtItem(session, state, {
        id,
        date,
        person,
        type: type as 'BORROW' | 'REPAY',
        amount,
        note,
        category: debtCategory
      });
      addActivityLog('debt', `${isEdit ? 'Edited' : 'Added'} debt ${money(amount, state.settings.currency)}`);
      renderWorkspace(root, session, next, view, 'Debt entry saved');
    });

    // Edit/delete handlers are handled via table event delegation above.
  }

  if (viewKey === 'insights') {
    const insights = buildInsightsData(state);

    root.querySelectorAll<HTMLButtonElement>('button[data-toggle-panel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const panelId = String(btn.dataset.togglePanel || '').trim();
        if (!panelId) return;
        const panel = root.querySelector<HTMLElement>(`#${panelId}`);
        if (!panel) return;
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      });
    });

    const stockInput = root.querySelector<HTMLInputElement>('#exitStockInput');
    const insightsSearch = root.querySelector<HTMLInputElement>('#insights-search');
    const qtyInput = root.querySelector<HTMLInputElement>('#exitSellQty');
    const priceInput = root.querySelector<HTMLInputElement>('#exitSellPrice');
    const holdDaysNode = root.querySelector<HTMLElement>('#exitHoldDays');
    const resultNode = root.querySelector<HTMLElement>('#exitAnalyzerResult');

    const refreshHoldDays = (): void => {
      if (!holdDaysNode) return;
      const days = getHoldDays(insights, String(stockInput?.value || ''));
      holdDaysNode.textContent = days === null ? '-' : `${days} days`;
    };

    if (insightsSearch) {
      insightsSearch.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        setInsightsSearch(String(insightsSearch.value || ''));
        renderWorkspace(root, session, state, view, 'Insights filtered');
      });
    }

    stockInput?.addEventListener('input', refreshHoldDays);
    refreshHoldDays();

    root.querySelector<HTMLButtonElement>('#open-exit-modal')?.addEventListener('click', () => {
      const modal = root.querySelector<HTMLElement>('#exit-modal');
      modal?.classList.add('open');
      modal?.setAttribute('aria-hidden', 'false');
    });
    root.querySelector<HTMLButtonElement>('#close-exit-modal')?.addEventListener('click', () => {
      const modal = root.querySelector<HTMLElement>('#exit-modal');
      modal?.classList.remove('open');
      modal?.setAttribute('aria-hidden', 'true');
    });
    root.querySelector<HTMLElement>('#exit-modal')?.addEventListener('click', (event) => {
      const modal = root.querySelector<HTMLElement>('#exit-modal');
      if (!modal) return;
      if (event.target === modal) {
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
      }
    });

    root.querySelector<HTMLButtonElement>('#exitSimulateBtn')?.addEventListener('click', () => {
      if (!resultNode) return;
      const stock = String(stockInput?.value || '').trim();
      const sellQty = Number(qtyInput?.value || 0);
      const sellPrice = Number(priceInput?.value || 0);

      const sim = simulatePartialExit(insights, stock, sellQty, sellPrice, state.settings);
      if ('error' in sim) {
        resultNode.innerHTML = `<div class="loss">${esc(sim.error)}</div>`;
        return;
      }

      const suggestions = suggestReentry(sim, insights);
      resultNode.innerHTML = renderExitAnalysis(sim, suggestions, state.settings.currency);
      refreshHoldDays();
    });

    root.querySelector<HTMLButtonElement>('#exitResetBtn')?.addEventListener('click', () => {
      if (stockInput) stockInput.value = '';
      if (qtyInput) qtyInput.value = '';
      if (priceInput) priceInput.value = '';
      if (resultNode) resultNode.innerHTML = '';
      refreshHoldDays();
    });

    root.querySelector<HTMLButtonElement>('#buy-tips-btn')?.addEventListener('click', () => {
      const modal = root.querySelector<HTMLElement>('#buy-tips-modal');
      modal?.classList.add('open');
      modal?.setAttribute('aria-hidden', 'false');
    });
    root.querySelector<HTMLButtonElement>('#close-buy-tips-modal')?.addEventListener('click', () => {
      const modal = root.querySelector<HTMLElement>('#buy-tips-modal');
      modal?.classList.remove('open');
      modal?.setAttribute('aria-hidden', 'true');
    });
    root.querySelector<HTMLElement>('#buy-tips-modal')?.addEventListener('click', (event) => {
      const modal = root.querySelector<HTMLElement>('#buy-tips-modal');
      if (!modal) return;
      if (event.target === modal) {
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
      }
    });
  }

  if (viewKey === 'cloud') {
    root.querySelector<HTMLButtonElement>('#push-btn')?.addEventListener('click', async () => {
      showBlockingLoader('Pushing to cloud...');
      try {
        await pushToCloud(session, state);
        addActivityLog('cloud', 'Push to cloud');
        applyState({ ...state, lastSyncedAt: new Date().toISOString() }, 'Cloud push successful');
        await trimSnapshots({ userId: session.userId });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Cloud push failed';
        renderWorkspace(root, session, state, view, messageText);
      } finally {
        hideBlockingLoader();
      }
    });

    root.querySelector<HTMLButtonElement>('#pull-btn')?.addEventListener('click', async () => {
      showBlockingLoader('Pulling from cloud...');
      try {
        const pulled = await pullFromCloud(session);
        addActivityLog('cloud', 'Pull from cloud');
        applyState({ ...ensureDefaultMappings(pulled), lastSyncedAt: new Date().toISOString() }, 'Cloud pull successful');
        await trimSnapshots({ userId: session.userId });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Cloud pull failed';
        renderWorkspace(root, session, state, view, messageText);
      } finally {
        hideBlockingLoader();
      }
    });

    root.querySelector<HTMLButtonElement>('#open-mapping-btn')?.addEventListener('click', () => {
      window.location.href = './transactions.html#mapping';
    });

    root.querySelector<HTMLButtonElement>('#cloud-save-settings')?.addEventListener('click', () => {
      const toggle = root.querySelector<HTMLInputElement>('#cloud-autosync-toggle');
      const interval = root.querySelector<HTMLInputElement>('#cloud-autosync-interval');
      const price = root.querySelector<HTMLInputElement>('#cloud-price-interval');
      setCloudAutoSyncEnabled(Boolean(toggle?.checked));
      setCloudAutoSyncInterval(Number(interval?.value || 10));
      const priceSec = Number(price?.value || state.settings.livePriceRefreshSec);
      const next = {
        ...state,
        settings: {
          ...state.settings,
          livePriceRefreshSec: Number.isFinite(priceSec) ? Math.max(10, Math.floor(priceSec)) : state.settings.livePriceRefreshSec
        }
      };
      addActivityLog('cloud', 'Auto sync settings updated');
      applyState(next, 'Cloud settings saved');
    });

    root.querySelector<HTMLButtonElement>('#create-snapshot-btn')?.addEventListener('click', () => {
      confirmPopup('Export full snapshot as JSON?', 'Export Snapshot').then((ok) => {
        if (!ok) return;
        const snapshot = {
          exportedAt: new Date().toISOString(),
          state
        };
        const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `fds-snapshot-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        addActivityLog('cloud', 'Snapshot exported (JSON)');
        showToast('Snapshot exported (JSON)', 'export');
      });
    });

    root.querySelector<HTMLInputElement>('#restore-snapshot-input')?.addEventListener('change', async (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files && input.files.length ? input.files[0] : null;
      if (!file) return;
      const ok = await confirmPopup(`Restore snapshot from ${file.name}?`, 'Restore Snapshot');
      if (!ok) {
        input.value = '';
        return;
      }
      showBlockingLoader('Restoring snapshot...');
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as { state?: AppState };
        if (!parsed.state) {
          showToast('Invalid snapshot file', 'error');
          return;
        }
        addActivityLog('cloud', 'Snapshot restored (JSON)');
        applyState(ensureDefaultMappings(parsed.state), 'Snapshot restored');
        await trimSnapshots({ userId: session.userId });
      } catch (error) {
        showToast('Failed to restore snapshot', 'error');
      } finally {
        hideBlockingLoader();
        input.value = '';
      }
    });

    root.querySelector<HTMLButtonElement>('#export-excel-btn')?.addEventListener('click', async () => {
      const ok = await confirmPopup('Export an Excel workbook with all datasets?', 'Export Excel');
      if (!ok) return;
      const XLSX = (await import('xlsx')) as typeof import('xlsx');
      const wb = XLSX.utils.book_new();
      const datasets: Array<{ name: string; rows: Record<string, unknown>[] }> = [
        { name: 'expenses', rows: state.expenses as unknown as Record<string, unknown>[] },
        { name: 'debts', rows: state.debtItems as unknown as Record<string, unknown>[] },
        { name: 'credits', rows: state.creditItems as unknown as Record<string, unknown>[] },
        { name: 'trades', rows: state.transactions as unknown as Record<string, unknown>[] },
        { name: 'ticker_registry', rows: (state.tickerRegistry || []) as unknown as Record<string, unknown>[] },
        { name: 'ticker_requests', rows: (state.tickerRequests || []) as unknown as Record<string, unknown>[] },
        { name: 'nse_master', rows: (state.nseMaster || []) as unknown as Record<string, unknown>[] }
      ];
      datasets.forEach((set) => {
        const sheet = XLSX.utils.json_to_sheet(set.rows);
        XLSX.utils.book_append_sheet(wb, sheet, set.name.slice(0, 31));
      });
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fds-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addActivityLog('cloud', 'Snapshot exported (Excel)');
      showToast('Excel export generated', 'export');
    });

    root.querySelector<HTMLButtonElement>('#export-word-btn')?.addEventListener('click', async () => {
      const ok = await confirmPopup('Export a Word document with all datasets?', 'Export Word');
      if (!ok) return;
      const docContent = `
        <html>
          <head><meta charset="utf-8" /></head>
          <body>
            <h1>Finance Decision System Export</h1>
            <pre>${esc(JSON.stringify(state, null, 2))}</pre>
          </body>
        </html>
      `;
      const blob = new Blob([docContent], { type: 'application/msword' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fds-export-${new Date().toISOString().slice(0, 10)}.doc`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addActivityLog('cloud', 'Snapshot exported (Word)');
      showToast('Word export generated', 'export');
    });

    const logType = root.querySelector<HTMLSelectElement>('#cloud-log-type');
    const logSearch = root.querySelector<HTMLInputElement>('#cloud-log-search');
    const logList = root.querySelector<HTMLUListElement>('#cloud-log-list');
    const applyLogFilter = (): void => {
      if (!logList) return;
      const type = String(logType?.value || 'all');
      const query = String(logSearch?.value || '').trim().toLowerCase();
      Array.from(logList.querySelectorAll<HTMLLIElement>('li[data-log-type]')).forEach((li) => {
        const rowType = String(li.dataset.logType || '');
        const text = String(li.textContent || '').toLowerCase();
        const matchesType = type === 'all' || rowType === type;
        const matchesText = !query || text.includes(query);
        li.style.display = matchesType && matchesText ? '' : 'none';
      });
    };
    logType?.addEventListener('change', applyLogFilter);
    logSearch?.addEventListener('input', applyLogFilter);
    applyLogFilter();
  }

  if (viewKey === 'settings') {
    root.querySelector<HTMLFormElement>('#strategy-settings-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const portfolioSize = Number(data.get('portfolioSize') || 0);
      const monthlyBudget = Number(data.get('monthlyBudget') || 0);
      const stockBudget = Number(data.get('stockBudget') || 0);
      const allocationLimitPct = Number(
        data.get('allocationLimitPct') || state.settings.allocationLimitPct || 0
      );
      const l1DipPct = Number(data.get('l1DipPct') || state.settings.l1DipPct || 0);
      const l2DipPct = Number(data.get('l2DipPct') || state.settings.l2DipPct || 0);
      const brokerageBuyPct = Number(data.get('brokerageBuyPct') || 0);
      const brokerageSellPct = Number(data.get('brokerageSellPct') || 0);
      const dpCharge = Number(data.get('dpCharge') || 0);
      const sellTargetPct = Number(data.get('sellTargetPct') || 15);
      const stopLossPct = Number(data.get('stopLossPct') || 8);
      const minHoldDaysTrim = Number(data.get('minHoldDaysTrim') || 20);
      const fdRatePct = Number(data.get('fdRatePct') || 6.5);
      const inflationRatePct = Number(data.get('inflationRatePct') || 6.0);
      const refreshSec = Number(data.get('livePriceRefreshSec') || 300);

      applyState(
        {
          ...state,
          settings: {
            ...state.settings,
            portfolioSize: Number.isFinite(portfolioSize) ? Math.max(0, portfolioSize) : state.settings.portfolioSize,
            monthlyBudget: Number.isFinite(monthlyBudget) ? Math.max(0, monthlyBudget) : state.settings.monthlyBudget,
            stockBudget: Number.isFinite(stockBudget) ? Math.max(0, stockBudget) : state.settings.stockBudget,
            allocationLimitPct: Number.isFinite(allocationLimitPct) ? Math.max(1, Math.min(100, allocationLimitPct)) : state.settings.allocationLimitPct,
            l1DipPct: Number.isFinite(l1DipPct) ? Math.max(1, Math.min(50, l1DipPct)) : state.settings.l1DipPct,
            l2DipPct: Number.isFinite(l2DipPct) ? Math.max(1, Math.min(60, l2DipPct)) : state.settings.l2DipPct,
            brokerageBuyPct: Number.isFinite(brokerageBuyPct) ? Math.max(0, brokerageBuyPct) : state.settings.brokerageBuyPct,
            brokerageSellPct: Number.isFinite(brokerageSellPct) ? Math.max(0, brokerageSellPct) : state.settings.brokerageSellPct,
            dpCharge: Number.isFinite(dpCharge) ? Math.max(0, dpCharge) : state.settings.dpCharge,
            sellTargetPct: Number.isFinite(sellTargetPct) ? Math.max(0, sellTargetPct) : state.settings.sellTargetPct,
            stopLossPct: Number.isFinite(stopLossPct) ? Math.max(0, stopLossPct) : state.settings.stopLossPct,
            minHoldDaysTrim: Number.isFinite(minHoldDaysTrim) ? Math.max(0, Math.floor(minHoldDaysTrim)) : state.settings.minHoldDaysTrim,
            fdRatePct: Number.isFinite(fdRatePct) ? Math.max(0, fdRatePct) : state.settings.fdRatePct,
            inflationRatePct: Number.isFinite(inflationRatePct) ? Math.max(0, inflationRatePct) : state.settings.inflationRatePct,
            livePriceRefreshSec: Number.isFinite(refreshSec) ? Math.max(60, refreshSec) : state.settings.livePriceRefreshSec
          }
        },
        'Strategy settings saved'
      );
    });
  }

  // Admin controls handled in admin view.
}

export function bootstrapApp(root: HTMLElement, forcedView?: AppView): void {
  applyUiPrefs(loadUiPrefs());
  const session = getSession();
  if (!session) {
    renderAuth(root, 'login');
    return;
  }

  const state = ensureDefaultMappings(readState(session));
  writeState(session, state);
  const view = forcedView || getInitialView();
  saveView(view);
  renderWorkspace(root, session, state, view);
  void (async () => {
    const next = await refreshTickerData(session, state);
    const registryChanged = (next.tickerRegistry || []).length !== (state.tickerRegistry || []).length;
    const requestsChanged = (next.tickerRequests || []).length !== (state.tickerRequests || []).length;
    if (registryChanged || requestsChanged) {
      renderWorkspace(root, session, next, view);
    }
  })();
}
