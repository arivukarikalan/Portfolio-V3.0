import { APPS_SCRIPT_URL, SESSION_KEY } from './constants';
import type { UserRole, UserSession } from './types';

type ApiResponse<T> = {
  ok: boolean;
  message?: string;
  data?: T;
};

type LoginData = {
  user: {
    userId: string;
    name: string;
    email?: string;
    role: UserRole;
    adminSessionToken?: string;
  };
};

export type PendingRequest = {
  requestId: string;
  name: string;
  loginId: string;
  email: string;
  requestedAt: string;
  status: string;
};

export type AdminUserRow = {
  userId: string;
  name: string;
  loginId: string;
  email: string;
  role: UserRole;
  status: string;
  createdAt: string;
  approvedAt: string;
  approvedBy: string;
};

export type AdminConfig = {
  maxSnapshots: number;
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

export function getSession(): UserSession | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as UserSession;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export async function loginWithSheet(loginId: string, password: string): Promise<UserSession> {
  const data = await postApi<LoginData>({
    mode: 'login',
    loginId: loginId.trim(),
    password
  });

  const session: UserSession = {
    userId: data.user.userId,
    name: data.user.name,
    email: data.user.email ?? '',
    role: data.user.role,
    adminSessionToken: data.user.adminSessionToken,
    createdAt: new Date().toISOString()
  };

  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export async function requestUserAccess(input: {
  name: string;
  loginId: string;
  password: string;
  email?: string;
}): Promise<string> {
  const data = await postApi<{ requestId: string; message: string }>({
    mode: 'register_user',
    name: input.name.trim(),
    loginId: input.loginId.trim(),
    password: input.password,
    email: (input.email || '').trim().toLowerCase()
  });

  return data.message || `Request submitted: ${data.requestId}`;
}

export async function listPendingRequests(adminUserId: string, adminToken: string): Promise<PendingRequest[]> {
  const data = await postApi<{ rows: PendingRequest[] }>({
    mode: 'list_pending',
    adminUserId: adminUserId.trim(),
    adminToken
  });

  return Array.isArray(data.rows) ? data.rows : [];
}

export async function reviewPendingRequest(input: {
  adminUserId: string;
  adminToken: string;
  requestId: string;
  decision: 'approve' | 'reject';
  role?: UserRole;
  note?: string;
}): Promise<string> {
  const data = await postApi<{ message: string }>({
    mode: input.decision === 'approve' ? 'approve_user' : 'reject_user',
    adminUserId: input.adminUserId.trim(),
    adminToken: input.adminToken,
    requestId: input.requestId,
    role: input.role || 'USER',
    note: input.note || ''
  });

  return data.message || 'Completed';
}

export async function listAdminUsers(adminUserId: string, adminToken: string): Promise<AdminUserRow[]> {
  const data = await postApi<{ rows: AdminUserRow[] }>({
    mode: 'list_users',
    adminUserId: adminUserId.trim(),
    adminToken
  });

  return Array.isArray(data.rows) ? data.rows : [];
}

export async function updateAdminUser(input: {
  adminUserId: string;
  adminToken: string;
  userId: string;
  role?: UserRole;
  status?: 'ACTIVE' | 'DISABLED';
}): Promise<string> {
  const data = await postApi<{ message: string }>({
    mode: 'update_user',
    adminUserId: input.adminUserId.trim(),
    adminToken: input.adminToken,
    userId: input.userId.trim(),
    role: input.role,
    status: input.status
  });

  return data.message || 'Updated';
}

export async function getAdminConfig(adminUserId: string, adminToken: string): Promise<AdminConfig> {
  const data = await postApi<AdminConfig>({
    mode: 'get_admin_config',
    adminUserId: adminUserId.trim(),
    adminToken
  });

  return {
    maxSnapshots: Number.isFinite(Number(data.maxSnapshots)) ? Number(data.maxSnapshots) : 10
  };
}

export async function setAdminConfig(input: {
  adminUserId: string;
  adminToken: string;
  maxSnapshots: number;
}): Promise<string> {
  const data = await postApi<{ message: string }>({
    mode: 'set_admin_config',
    adminUserId: input.adminUserId.trim(),
    adminToken: input.adminToken,
    maxSnapshots: Math.max(1, Math.floor(input.maxSnapshots))
  });

  return data.message || 'Saved';
}

export function logout(): void {
  localStorage.removeItem(SESSION_KEY);
}
