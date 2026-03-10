import { DEFAULT_SETTINGS } from './constants';
import type { AppState, CreditRow, DebtRow, ExpenseRow, StockMapping, Transaction, UserSession } from './types';

function stateKey(userId: string): string {
  return `fds_state_${userId}`;
}

export function readState(session: UserSession): AppState {
  const raw = localStorage.getItem(stateKey(session.userId));
  if (!raw) {
    return {
      transactions: [],
      stockMappings: [],
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
    return {
      transactions: parsed.transactions ?? [],
      stockMappings,
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

export function appendTransactions(
  session: UserSession,
  currentState: AppState,
  entries: Transaction[]
): AppState {
  const mappingByStock = new Map(
    currentState.stockMappings.map((item) => [item.stock, item] as const)
  );

  for (const entry of entries) {
    const stock = String(entry.symbol || '').trim().toUpperCase();
    if (!stock || mappingByStock.has(stock)) continue;
    const created: StockMapping = {
      stock,
      ticker: stock,
      enabled: true,
      updatedAt: new Date().toISOString()
    };
    mappingByStock.set(stock, created);
  }

  const next: AppState = {
    ...currentState,
    transactions: [...entries, ...currentState.transactions],
    stockMappings: Array.from(mappingByStock.values()).sort((a, b) => a.stock.localeCompare(b.stock))
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

  const mappingByStock = new Map(
    currentState.stockMappings.map((item) => [item.stock, item] as const)
  );
  for (const txn of nextTransactions) {
    const stock = String(txn.symbol || '').trim().toUpperCase();
    if (!stock || mappingByStock.has(stock)) continue;
    mappingByStock.set(stock, {
      stock,
      ticker: stock,
      enabled: true,
      updatedAt: new Date().toISOString()
    });
  }

  const nextState: AppState = {
    ...currentState,
    transactions: nextTransactions,
    stockMappings: Array.from(mappingByStock.values()).sort((a, b) => a.stock.localeCompare(b.stock))
  };
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
  const normalizedStock = String(stock || '').trim().toUpperCase();
  const normalizedTicker = String(ticker || '').trim().toUpperCase();
  if (!normalizedStock || !normalizedTicker) return currentState;

  const nextMappings = currentState.stockMappings.filter((item) => item.stock !== normalizedStock);
  nextMappings.push({
    stock: normalizedStock,
    ticker: normalizedTicker,
    enabled: true,
    updatedAt: new Date().toISOString()
  });
  nextMappings.sort((a, b) => a.stock.localeCompare(b.stock));

  const nextState: AppState = {
    ...currentState,
    stockMappings: nextMappings
  };
  writeState(session, nextState);
  return nextState;
}

export function deleteStockMapping(
  session: UserSession,
  currentState: AppState,
  stock: string
): AppState {
  const normalizedStock = String(stock || '').trim().toUpperCase();
  if (!normalizedStock) return currentState;
  const nextState: AppState = {
    ...currentState,
    stockMappings: currentState.stockMappings.filter((item) => item.stock !== normalizedStock)
  };
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
