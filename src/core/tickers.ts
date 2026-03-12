import { APPS_SCRIPT_URL } from './constants';
import type { NseMasterItem, TickerRegistryItem, TickerRequest, UserSession } from './types';

type ApiResponse<T> = {
  ok: boolean;
  message?: string;
  data?: T;
};

async function postApi<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  const payload = (await response.json()) as ApiResponse<T>;
  if (!payload.ok) {
    throw new Error(payload.message || 'Request failed');
  }

  if (payload.data === undefined) {
    return {} as T;
  }

  return payload.data;
}

export async function fetchTickerRegistry(): Promise<TickerRegistryItem[]> {
  const data = await postApi<{ rows: TickerRegistryItem[] }>({ mode: 'list_tickers' });
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function fetchNseMaster(): Promise<NseMasterItem[]> {
  const data = await postApi<{ rows: NseMasterItem[] }>({ mode: 'list_nse_master' });
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function fetchTickerRequests(session: UserSession): Promise<TickerRequest[]> {
  const body: Record<string, unknown> = { mode: 'list_ticker_requests', userId: session.userId };
  if (session.role === 'ADMIN') {
    body.adminUserId = session.userId;
    body.adminToken = session.adminSessionToken || '';
  }
  const data = await postApi<{ rows: TickerRequest[] }>(body);
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function submitTickerRequests(session: UserSession, rawSymbols: string[]): Promise<void> {
  const symbols = rawSymbols.map((s) => String(s || '').trim()).filter(Boolean);
  if (!symbols.length) return;
  await postApi({
    mode: 'create_ticker_requests',
    userId: session.userId,
    userName: session.name,
    symbols
  });
}

export async function replaceNseMaster(
  session: UserSession,
  rows: Array<{ symbol: string; name: string; isin: string }>
): Promise<NseMasterItem[]> {
  const data = await postApi<{ rows: NseMasterItem[] }>({
    mode: 'replace_nse_master',
    adminUserId: session.userId,
    adminToken: session.adminSessionToken || '',
    rows
  });
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function upsertTickerRegistryRemote(
  session: UserSession,
  ticker: string,
  synonyms: string[]
): Promise<TickerRegistryItem[]> {
  const data = await postApi<{ rows: TickerRegistryItem[] }>({
    mode: 'upsert_ticker',
    adminUserId: session.userId,
    adminToken: session.adminSessionToken || '',
    ticker,
    synonyms
  });
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function deleteTickerRegistryRemote(session: UserSession, ticker: string): Promise<TickerRegistryItem[]> {
  const data = await postApi<{ rows: TickerRegistryItem[] }>({
    mode: 'delete_ticker',
    adminUserId: session.userId,
    adminToken: session.adminSessionToken || '',
    ticker
  });
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function addTickerSynonymRemote(
  session: UserSession,
  ticker: string,
  synonym: string
): Promise<TickerRegistryItem[]> {
  const data = await postApi<{ rows: TickerRegistryItem[] }>({
    mode: 'add_ticker_synonym',
    adminUserId: session.userId,
    adminToken: session.adminSessionToken || '',
    ticker,
    synonym
  });
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function removeTickerSynonymRemote(
  session: UserSession,
  ticker: string,
  synonym: string
): Promise<TickerRegistryItem[]> {
  const data = await postApi<{ rows: TickerRegistryItem[] }>({
    mode: 'remove_ticker_synonym',
    adminUserId: session.userId,
    adminToken: session.adminSessionToken || '',
    ticker,
    synonym
  });
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function approveTickerRequestRemote(
  session: UserSession,
  requestId: string,
  resolvedTicker: string
): Promise<TickerRequest[]> {
  const data = await postApi<{ rows: TickerRequest[] }>({
    mode: 'approve_ticker_request',
    adminUserId: session.userId,
    adminToken: session.adminSessionToken || '',
    requestId,
    resolvedTicker
  });
  return Array.isArray(data.rows) ? data.rows : [];
}

export async function rejectTickerRequestRemote(
  session: UserSession,
  requestId: string,
  note: string
): Promise<TickerRequest[]> {
  const data = await postApi<{ rows: TickerRequest[] }>({
    mode: 'reject_ticker_request',
    adminUserId: session.userId,
    adminToken: session.adminSessionToken || '',
    requestId,
    note
  });
  return Array.isArray(data.rows) ? data.rows : [];
}
