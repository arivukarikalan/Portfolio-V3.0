import { DEFAULT_SETTINGS } from './constants';
import type {
  AppState,
  CreditRow,
  DebtRow,
  ExpenseRow,
  StockMapping,
  TickerRegistryItem,
  TickerRequest,
  NseMasterItem,
  TickerAliasGroup,
  Transaction,
  UserSession
} from './types';

function stateKey(userId: string): string {
  return `fds_state_${userId}`;
}

export function readState(session: UserSession): AppState {
  const raw = localStorage.getItem(stateKey(session.userId));
  if (!raw) {
    return {
      transactions: [],
      stockMappings: [],
      tickerRegistry: [],
      tickerRequests: [],
      nseMaster: [],
      blockedMappings: [],
      tickerAliases: [],
      livePrices: {},
      expenses: [],
      debtItems: [],
      creditItems: [],
      settings: DEFAULT_SETTINGS
    };
  }

  try {
    const parsed = JSON.parse(raw) as AppState;
    const stockMappings = Array.isArray(parsed.stockMappings) ? parsed.stockMappings : [];
    const blockedMappings = Array.isArray(parsed.blockedMappings) ? parsed.blockedMappings : [];
    const tickerAliases = Array.isArray(parsed.tickerAliases) ? parsed.tickerAliases : [];
    const tickerRegistry = Array.isArray(parsed.tickerRegistry) ? parsed.tickerRegistry : [];
    const tickerRequests = Array.isArray(parsed.tickerRequests) ? parsed.tickerRequests : [];
    const nseMaster = Array.isArray(parsed.nseMaster) ? parsed.nseMaster : [];
    return {
      transactions: parsed.transactions ?? [],
      stockMappings,
      tickerRegistry,
      tickerRequests,
      nseMaster,
      blockedMappings,
      tickerAliases,
      livePrices: parsed.livePrices ?? {},
      expenses: parsed.expenses ?? [],
      debtItems: parsed.debtItems ?? [],
      creditItems: parsed.creditItems ?? [],
      lastLiveSyncAt: parsed.lastLiveSyncAt,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      lastSyncedAt: parsed.lastSyncedAt
    };
  } catch {
    return {
      transactions: [],
      stockMappings: [],
      tickerRegistry: [],
      tickerRequests: [],
      nseMaster: [],
      blockedMappings: [],
      tickerAliases: [],
      livePrices: {},
      expenses: [],
      debtItems: [],
      creditItems: [],
      settings: DEFAULT_SETTINGS
    };
  }
}

export function writeState(session: UserSession, state: AppState): void {
  localStorage.setItem(stateKey(session.userId), JSON.stringify(state));
}

function normalizeKey(value: string): string {
  return String(value || '').trim().toUpperCase();
}

function buildMappingsFromRegistry(registry: TickerRegistryItem[]): StockMapping[] {
  const mappings: StockMapping[] = [];
  registry.forEach((item) => {
    const ticker = normalizeKey(item.ticker);
    if (!ticker) return;
    const aliases = Array.isArray(item.synonyms) ? item.synonyms : [];
    const keys = new Set([ticker, ...aliases.map((alias) => normalizeKey(alias))].filter(Boolean));
    keys.forEach((alias) => {
      mappings.push({
        stock: alias,
        ticker,
        enabled: true,
        updatedAt: item.updatedAt || new Date().toISOString()
      });
    });
  });
  mappings.sort((a, b) => a.stock.localeCompare(b.stock));
  return mappings;
}

function buildAliasGroups(state: AppState): Map<string, TickerAliasGroup> {
  const groups = new Map<string, TickerAliasGroup>();
  const blocked = new Set((state.blockedMappings || []).map((s) => normalizeKey(s)));

  const addAlias = (ticker: string, alias: string, enabled = true, updatedAt = new Date().toISOString()) => {
    const t = normalizeKey(ticker);
    const a = normalizeKey(alias);
    if (!t || !a || blocked.has(a)) return;
    const current = groups.get(t);
    if (!current) {
      groups.set(t, { ticker: t, aliases: [t, a].filter(Boolean), enabled, updatedAt });
      return;
    }
    const aliasSet = new Set(current.aliases.map(normalizeKey));
    aliasSet.add(t);
    aliasSet.add(a);
    current.aliases = Array.from(aliasSet.values());
    current.enabled = enabled;
    current.updatedAt = updatedAt;
  };

  (state.tickerAliases || []).forEach((group) => {
    const t = normalizeKey(group.ticker);
    if (!t || blocked.has(t)) return;
    const aliases = Array.isArray(group.aliases) ? group.aliases : [];
    aliases.forEach((alias) => addAlias(t, alias, group.enabled, group.updatedAt));
    addAlias(t, t, group.enabled, group.updatedAt);
  });

  state.stockMappings.forEach((row) => {
    const t = normalizeKey(row.ticker);
    const s = normalizeKey(row.stock);
    if (!t || blocked.has(t)) return;
    addAlias(t, s || t, row.enabled, row.updatedAt);
  });

  return groups;
}

function finalizeGroups(groups: Map<string, TickerAliasGroup>): { tickerAliases: TickerAliasGroup[]; stockMappings: StockMapping[] } {
  const tickerAliases = Array.from(groups.values()).map((group) => ({
    ...group,
    aliases: Array.from(new Set(group.aliases.map(normalizeKey))).sort()
  }));
  const stockMappings: StockMapping[] = [];
  tickerAliases.forEach((group) => {
    const aliases = Array.isArray(group.aliases) && group.aliases.length ? group.aliases : [group.ticker];
    aliases.forEach((alias) => {
      stockMappings.push({
        stock: normalizeKey(alias),
        ticker: normalizeKey(group.ticker),
        enabled: group.enabled,
        updatedAt: group.updatedAt
      });
    });
  });
  stockMappings.sort((a, b) => a.stock.localeCompare(b.stock));
  return { tickerAliases, stockMappings };
}

export function appendTransactions(
  session: UserSession,
  currentState: AppState,
  entries: Transaction[]
): AppState {
  const next: AppState = {
    ...currentState,
    transactions: [...entries, ...currentState.transactions]
  };
  writeState(session, next);
  return next;
}

export function upsertTransaction(
  session: UserSession,
  currentState: AppState,
  entry: Transaction
): AppState {
  const existingIndex = currentState.transactions.findIndex((item) => item.id === entry.id);
  const nextTransactions = currentState.transactions.slice();
  if (existingIndex >= 0) {
    nextTransactions[existingIndex] = entry;
  } else {
    nextTransactions.unshift(entry);
  }

  const nextState: AppState = {
    ...currentState,
    transactions: nextTransactions
  };
  writeState(session, nextState);
  return nextState;
}

export function upsertTickerRegistry(
  session: UserSession,
  currentState: AppState,
  ticker: string,
  synonyms: string[] = []
): AppState {
  const key = normalizeKey(ticker || '');
  if (!key) return currentState;
  const registry = Array.isArray(currentState.tickerRegistry) ? currentState.tickerRegistry.slice() : [];
  const existing = registry.find((item) => normalizeKey(item.ticker) === key);
  const nextSynonyms = new Set(
    (existing?.synonyms || [])
      .concat(synonyms)
      .map((s) => normalizeKey(s))
      .filter((s) => s && s !== key)
  );
  const updated: TickerRegistryItem = {
    ticker: key,
    synonyms: Array.from(nextSynonyms.values()),
    updatedAt: new Date().toISOString()
  };
  const nextRegistry = existing
    ? registry.map((item) => (normalizeKey(item.ticker) === key ? updated : item))
    : [updated, ...registry];
  const stockMappings = buildMappingsFromRegistry(nextRegistry);
  const nextState: AppState = { ...currentState, tickerRegistry: nextRegistry, stockMappings };
  writeState(session, nextState);
  return nextState;
}

export function addTickerSynonym(
  session: UserSession,
  currentState: AppState,
  ticker: string,
  synonym: string
): AppState {
  return upsertTickerRegistry(session, currentState, ticker, [synonym]);
}

export function removeTickerSynonym(
  session: UserSession,
  currentState: AppState,
  ticker: string,
  synonym: string
): AppState {
  const key = normalizeKey(ticker || '');
  const synKey = normalizeKey(synonym || '');
  if (!key || !synKey) return currentState;
  const registry = Array.isArray(currentState.tickerRegistry) ? currentState.tickerRegistry.slice() : [];
  const nextRegistry = registry.map((item) => {
    if (normalizeKey(item.ticker) !== key) return item;
    const nextSynonyms = (item.synonyms || []).filter((s) => normalizeKey(s) !== synKey);
    return { ...item, synonyms: nextSynonyms, updatedAt: new Date().toISOString() };
  });
  const stockMappings = buildMappingsFromRegistry(nextRegistry);
  const nextState: AppState = { ...currentState, tickerRegistry: nextRegistry, stockMappings };
  writeState(session, nextState);
  return nextState;
}

export function deleteTickerRegistry(
  session: UserSession,
  currentState: AppState,
  ticker: string
): AppState {
  const key = normalizeKey(ticker || '');
  if (!key) return currentState;
  const registry = Array.isArray(currentState.tickerRegistry) ? currentState.tickerRegistry : [];
  const nextRegistry = registry.filter((item) => normalizeKey(item.ticker) !== key);
  const stockMappings = buildMappingsFromRegistry(nextRegistry);
  const nextState: AppState = { ...currentState, tickerRegistry: nextRegistry, stockMappings };
  writeState(session, nextState);
  return nextState;
}

export function addTickerRequest(
  session: UserSession,
  currentState: AppState,
  rawSymbol: string
): AppState {
  const key = normalizeKey(rawSymbol || '');
  if (!key) return currentState;
  const requests = Array.isArray(currentState.tickerRequests) ? currentState.tickerRequests.slice() : [];
  const exists = requests.find(
    (req) =>
      normalizeKey(req.rawSymbol) === key && req.status === 'PENDING' && req.userId === session.userId
  );
  if (exists) return currentState;
  const nextRequest: TickerRequest = {
    id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userId: session.userId,
    userName: session.name,
    rawSymbol: key,
    status: 'PENDING',
    requestedAt: new Date().toISOString()
  };
  const nextState: AppState = { ...currentState, tickerRequests: [nextRequest, ...requests] };
  writeState(session, nextState);
  return nextState;
}

function applyTickerResolution(currentState: AppState, rawSymbol: string, ticker: string): AppState {
  const raw = normalizeKey(rawSymbol || '');
  const canonical = normalizeKey(ticker || '');
  if (!raw || !canonical) return currentState;
  const updatedTransactions = currentState.transactions.map((txn) => {
    const symbol = normalizeKey(txn.symbol);
    if (symbol !== raw) return txn;
    return { ...txn, symbol: canonical };
  });
  return { ...currentState, transactions: updatedTransactions };
}

export function resolveTickerRequest(
  session: UserSession,
  currentState: AppState,
  requestId: string,
  resolvedTicker: string
): AppState {
  const tickerKey = normalizeKey(resolvedTicker || '');
  if (!tickerKey) return currentState;
  const requests = Array.isArray(currentState.tickerRequests) ? currentState.tickerRequests.slice() : [];
  const request = requests.find((req) => req.id === requestId);
  if (!request || request.status !== 'PENDING') return currentState;
  const updatedRequests = requests.map((req) =>
    req.id === requestId
      ? {
          ...req,
          status: 'APPROVED',
          resolvedAt: new Date().toISOString(),
          resolvedBy: session.name,
          resolvedTicker: tickerKey
        }
      : req
  );
  let nextState = { ...currentState, tickerRequests: updatedRequests };
  nextState = applyTickerResolution(nextState, request.rawSymbol, tickerKey);
  nextState = upsertTickerRegistry(session, nextState, tickerKey, [request.rawSymbol]);
  return nextState;
}

export function rejectTickerRequest(
  session: UserSession,
  currentState: AppState,
  requestId: string,
  note = ''
): AppState {
  const requests = Array.isArray(currentState.tickerRequests) ? currentState.tickerRequests.slice() : [];
  const updatedRequests = requests.map((req) =>
    req.id === requestId
      ? {
          ...req,
          status: 'REJECTED',
          note,
          resolvedAt: new Date().toISOString(),
          resolvedBy: session.name
        }
      : req
  );
  const nextState: AppState = { ...currentState, tickerRequests: updatedRequests };
  writeState(session, nextState);
  return nextState;
}

export function deleteTransaction(
  session: UserSession,
  currentState: AppState,
  id: string
): AppState {
  const nextState: AppState = {
    ...currentState,
    transactions: currentState.transactions.filter((item) => item.id !== id)
  };
  writeState(session, nextState);
  return nextState;
}

export function clearTransactions(
  session: UserSession,
  currentState: AppState
): AppState {
  const nextState: AppState = {
    ...currentState,
    transactions: [],
    livePrices: {},
    lastLiveSyncAt: undefined
  };
  writeState(session, nextState);
  return nextState;
}

export function upsertStockMapping(
  session: UserSession,
  currentState: AppState,
  stock: string,
  ticker: string
): AppState {
  const normalizedStock = normalizeKey(stock || '');
  const normalizedTicker = normalizeKey(ticker || '');
  if (!normalizedStock || !normalizedTicker) return currentState;

  const groups = buildAliasGroups(currentState);
  const nextBlocked = (currentState.blockedMappings || []).filter((item) => normalizeKey(item) !== normalizedStock);
  groups.forEach((group) => {
    group.aliases = group.aliases.filter((alias) => normalizeKey(alias) !== normalizedStock);
  });
  const target = groups.get(normalizedTicker);
  if (target) {
    const aliasSet = new Set(target.aliases.map(normalizeKey));
    aliasSet.add(normalizedStock);
    aliasSet.add(normalizedTicker);
    target.aliases = Array.from(aliasSet.values());
    target.updatedAt = new Date().toISOString();
  } else {
    groups.set(normalizedTicker, {
      ticker: normalizedTicker,
      aliases: [normalizedTicker, normalizedStock],
      enabled: true,
      updatedAt: new Date().toISOString()
    });
  }
  for (const [key, group] of groups.entries()) {
    if (group.aliases.length === 0) groups.delete(key);
  }
  const { tickerAliases, stockMappings } = finalizeGroups(groups);
  const nextState: AppState = {
    ...currentState,
    stockMappings,
    tickerAliases,
    blockedMappings: nextBlocked
  };
  writeState(session, nextState);
  return nextState;
}

export function deleteStockMapping(
  session: UserSession,
  currentState: AppState,
  stock: string
): AppState {
  const normalizedStock = normalizeKey(stock || '');
  if (!normalizedStock) return currentState;
  const groups = buildAliasGroups(currentState);
  if (groups.has(normalizedStock)) {
    groups.delete(normalizedStock);
  } else {
    groups.forEach((group) => {
      group.aliases = group.aliases.filter((alias) => normalizeKey(alias) !== normalizedStock);
    });
  }
  for (const [key, group] of groups.entries()) {
    if (group.aliases.length === 0) groups.delete(key);
  }
  const { tickerAliases, stockMappings } = finalizeGroups(groups);
  const nextState: AppState = {
    ...currentState,
    stockMappings,
    tickerAliases
  };
  writeState(session, nextState);
  return nextState;
}

export function blockStockMapping(
  session: UserSession,
  currentState: AppState,
  stock: string
): AppState {
  const normalizedStock = normalizeKey(stock || '');
  if (!normalizedStock) return currentState;
  const nextBlocked = Array.from(
    new Set([...(currentState.blockedMappings || []), normalizedStock])
  );
  const groups = buildAliasGroups(currentState);
  if (groups.has(normalizedStock)) {
    groups.delete(normalizedStock);
  } else {
    groups.forEach((group) => {
      group.aliases = group.aliases.filter((alias) => normalizeKey(alias) !== normalizedStock);
    });
  }
  for (const [key, group] of groups.entries()) {
    if (group.aliases.length === 0) groups.delete(key);
  }
  const { tickerAliases, stockMappings } = finalizeGroups(groups);
  const nextState: AppState = {
    ...currentState,
    stockMappings,
    tickerAliases,
    blockedMappings: nextBlocked
  };
  writeState(session, nextState);
  return nextState;
}

export function unblockStockMapping(
  session: UserSession,
  currentState: AppState,
  stock: string
): AppState {
  const normalizedStock = normalizeKey(stock || '');
  if (!normalizedStock) return currentState;
  const nextBlocked = (currentState.blockedMappings || []).filter(
    (item) => normalizeKey(item) !== normalizedStock
  );
  const nextState: AppState = {
    ...currentState,
    blockedMappings: nextBlocked
  };
  writeState(session, nextState);
  return nextState;
}

export function addAliasToTicker(
  session: UserSession,
  currentState: AppState,
  ticker: string,
  alias: string
): AppState {
  const t = normalizeKey(ticker || '');
  const a = normalizeKey(alias || '');
  if (!t || !a) return currentState;
  const groups = buildAliasGroups(currentState);
  const target = groups.get(t);
  if (!target) {
    groups.set(t, { ticker: t, aliases: [t, a], enabled: true, updatedAt: new Date().toISOString() });
  } else {
    const aliasSet = new Set(target.aliases.map(normalizeKey));
    aliasSet.add(t);
    aliasSet.add(a);
    target.aliases = Array.from(aliasSet.values());
    target.updatedAt = new Date().toISOString();
  }
  const { tickerAliases, stockMappings } = finalizeGroups(groups);
  const nextState: AppState = { ...currentState, tickerAliases, stockMappings };
  writeState(session, nextState);
  return nextState;
}

export function removeAliasFromTicker(
  session: UserSession,
  currentState: AppState,
  ticker: string,
  alias: string
): AppState {
  const t = normalizeKey(ticker || '');
  const a = normalizeKey(alias || '');
  if (!t || !a) return currentState;
  const groups = buildAliasGroups(currentState);
  const target = groups.get(t);
  if (!target) return currentState;
  target.aliases = target.aliases.filter((item) => normalizeKey(item) !== a);
  if (target.aliases.length === 0) groups.delete(t);
  const { tickerAliases, stockMappings } = finalizeGroups(groups);
  const nextState: AppState = { ...currentState, tickerAliases, stockMappings };
  writeState(session, nextState);
  return nextState;
}

export function renameAliasForTicker(
  session: UserSession,
  currentState: AppState,
  ticker: string,
  alias: string,
  nextAlias: string
): AppState {
  const t = normalizeKey(ticker || '');
  const a = normalizeKey(alias || '');
  const n = normalizeKey(nextAlias || '');
  if (!t || !a || !n) return currentState;
  const groups = buildAliasGroups(currentState);
  const target = groups.get(t);
  if (!target) return currentState;
  target.aliases = target.aliases.filter((item) => normalizeKey(item) !== a);
  target.aliases.push(n);
  target.updatedAt = new Date().toISOString();
  const { tickerAliases, stockMappings } = finalizeGroups(groups);
  const nextState: AppState = { ...currentState, tickerAliases, stockMappings };
  writeState(session, nextState);
  return nextState;
}

export function mergeAliasGroups(
  session: UserSession,
  currentState: AppState
): { next: AppState; merged: number } {
  const groups = buildAliasGroups(currentState);
  let merged = 0;
  let changed = true;

  const normalize = (v: string) => normalizeKey(v);
  const isTickerKey = (value: string) => groups.has(normalize(value));

  while (changed) {
    changed = false;
    for (const [ticker, group] of Array.from(groups.entries())) {
      for (const alias of group.aliases) {
        const aliasKey = normalize(alias);
        if (aliasKey === ticker) continue;
        if (isTickerKey(aliasKey)) {
          const target = groups.get(aliasKey);
          if (!target) continue;
          const aliasSet = new Set(target.aliases.map(normalize));
          group.aliases.forEach((item) => aliasSet.add(normalize(item)));
          target.aliases = Array.from(aliasSet.values());
          groups.delete(ticker);
          merged += 1;
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  const { tickerAliases, stockMappings } = finalizeGroups(groups);
  const next: AppState = { ...currentState, tickerAliases, stockMappings };
  writeState(session, next);
  return { next, merged };
}

export function renameTickerGroup(
  session: UserSession,
  currentState: AppState,
  currentTicker: string,
  nextTicker: string
): AppState {
  const from = normalizeKey(currentTicker || '');
  const to = normalizeKey(nextTicker || '');
  if (!from || !to || from === to) return currentState;

  const groups = buildAliasGroups(currentState);
  const source = groups.get(from);
  if (!source) return currentState;

  const mergedAliases = new Set(source.aliases.map(normalizeKey));
  mergedAliases.add(from);
  mergedAliases.add(to);
  groups.delete(from);

  const target = groups.get(to);
  if (target) {
    target.aliases.forEach((alias) => mergedAliases.add(normalizeKey(alias)));
    target.aliases = Array.from(mergedAliases.values());
    target.updatedAt = new Date().toISOString();
  } else {
    groups.set(to, {
      ticker: to,
      aliases: Array.from(mergedAliases.values()),
      enabled: source.enabled,
      updatedAt: new Date().toISOString()
    });
  }

  groups.forEach((group, key) => {
    if (key === to) return;
    group.aliases = group.aliases.filter((alias) => normalizeKey(alias) !== to);
    if (group.aliases.length === 0) groups.delete(key);
  });

  const { tickerAliases, stockMappings } = finalizeGroups(groups);
  const nextState: AppState = { ...currentState, tickerAliases, stockMappings };
  writeState(session, nextState);
  return nextState;
}

export function toggleStockMapping(
  session: UserSession,
  currentState: AppState,
  stock: string,
  enabled: boolean
): AppState {
  const normalizedStock = String(stock || '').trim().toUpperCase();
  if (!normalizedStock) return currentState;
  const nextMappings = currentState.stockMappings.map((item) => {
    if (item.stock !== normalizedStock) return item;
    return { ...item, enabled, updatedAt: new Date().toISOString() };
  });
  const nextState: AppState = { ...currentState, stockMappings: nextMappings };
  writeState(session, nextState);
  return nextState;
}

export function upsertExpense(
  session: UserSession,
  currentState: AppState,
  row: ExpenseRow
): AppState {
  const idx = currentState.expenses.findIndex((item) => item.id === row.id);
  const nextExpenses = currentState.expenses.slice();
  if (idx >= 0) nextExpenses[idx] = row;
  else nextExpenses.unshift(row);

  const nextState: AppState = { ...currentState, expenses: nextExpenses };
  writeState(session, nextState);
  return nextState;
}

export function deleteExpense(
  session: UserSession,
  currentState: AppState,
  id: string
): AppState {
  const nextState: AppState = {
    ...currentState,
    expenses: currentState.expenses.filter((item) => item.id !== id)
  };
  writeState(session, nextState);
  return nextState;
}

export function upsertDebtItem(
  session: UserSession,
  currentState: AppState,
  row: DebtRow
): AppState {
  const idx = currentState.debtItems.findIndex((item) => item.id === row.id);
  const nextRows = currentState.debtItems.slice();
  if (idx >= 0) nextRows[idx] = row;
  else nextRows.unshift(row);

  const nextState: AppState = { ...currentState, debtItems: nextRows };
  writeState(session, nextState);
  return nextState;
}

export function deleteDebtItem(
  session: UserSession,
  currentState: AppState,
  id: string
): AppState {
  const nextState: AppState = {
    ...currentState,
    debtItems: currentState.debtItems.filter((item) => item.id !== id)
  };
  writeState(session, nextState);
  return nextState;
}

export function upsertCreditItem(
  session: UserSession,
  currentState: AppState,
  row: CreditRow
): AppState {
  const idx = currentState.creditItems.findIndex((item) => item.id === row.id);
  const nextRows = currentState.creditItems.slice();
  if (idx >= 0) nextRows[idx] = row;
  else nextRows.unshift(row);

  const nextState: AppState = { ...currentState, creditItems: nextRows };
  writeState(session, nextState);
  return nextState;
}

export function deleteCreditItem(
  session: UserSession,
  currentState: AppState,
  id: string
): AppState {
  const nextState: AppState = {
    ...currentState,
    creditItems: currentState.creditItems.filter((item) => item.id !== id)
  };
  writeState(session, nextState);
  return nextState;
}
