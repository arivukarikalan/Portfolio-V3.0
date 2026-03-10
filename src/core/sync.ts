import { APPS_SCRIPT_URL } from './constants';
import type { AppState, UserSession } from './types';

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
    throw new Error(`Push failed with ${response.status}`);
  }

  const payload = (await response.json()) as ApiResponse<T>;
  if (!payload.ok) {
    throw new Error(payload.message || 'Request failed');
  }

  if (payload.data === undefined) return {} as T;
  return payload.data;
}

async function getApi<T>(params: Record<string, string>): Promise<T> {
  const endpoint = new URL(APPS_SCRIPT_URL);
  Object.entries(params).forEach(([key, value]) => endpoint.searchParams.set(key, value));

  const response = await fetch(endpoint.toString(), { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Pull failed with ${response.status}`);
  }

  const payload = (await response.json()) as ApiResponse<T>;
  if (!payload.ok) {
    throw new Error(payload.message || 'Request failed');
  }

  if (payload.data === undefined) return {} as T;
  return payload.data;
}

export async function pushToCloud(session: UserSession, state: AppState): Promise<void> {
  await postApi({
    mode: 'push',
    userId: session.userId,
    payload: state,
    pushedAt: new Date().toISOString()
  });
}

export async function pullFromCloud(session: UserSession): Promise<AppState> {
  const data = await getApi<{ payload: AppState }>({
    mode: 'pull',
    userId: session.userId
  });

  if (!data.payload) {
    throw new Error('Cloud response missing payload');
  }

  return data.payload;
}

export async function trimSnapshots(input: {
  userId?: string;
  adminUserId?: string;
  adminToken?: string;
}): Promise<void> {
  await postApi({
    mode: 'trim_snapshots',
    userId: input.userId || '',
    adminUserId: input.adminUserId || '',
    adminToken: input.adminToken || ''
  });
}
