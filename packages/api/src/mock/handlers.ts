import { http, HttpResponse } from 'msw';
import type { LoginResponse, MetaResponse, SystemStatusResponse, User } from '../types';

const BASE = '/api/v1';

/**
 * The mock's whole surface: a session and an instance description, so the app
 * can be opened without the Go server. Everything else is served by the real
 * backend — the `/api` proxy in vite.config, or nothing at all, which is the
 * honest failure of running this shell against no server.
 *
 * These bodies are declared with their contract types and checked against the
 * same runtime validators the client uses (test/mock-contract.test.ts). A mock
 * that invents a field, or drops one, is worse than no mock: the screen looks
 * right and the real server disagrees.
 */
export const mockMeta: MetaResponse = {
  instance_id: 'mock',
  product_version: '0.1.0',
  api_version: 'v1',
  sync_protocol_versions: [1],
};

export const mockStatus: SystemStatusResponse = {
  initialized: true,
  // `open`, where a real instance ships `closed`: the mock exists so the auth
  // screens can be opened without a Go server, and /register is one of them.
  registration_mode: 'open',
  allow_registration: true,
};

export function mockUser(username: string): User {
  return {
    id: 'u001',
    username,
    display_name: username,
    email: `${username}@pontis.local`,
    role: 'admin',
    status: 'active',
    locale: 'zh-CN',
    created_at: '2026-08-20T08:00:00Z',
  };
}

export function mockLogin(username: string, at: number): LoginResponse {
  return {
    token: `mock-session-token-${at}`,
    expires_at: new Date(at + 86_400_000).toISOString(),
    user: mockUser(username),
  };
}

const SESSION_KEY = 'pontis-mock-session';

function loadSession(): { username: string } | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as { username: string }) : null;
  } catch {
    return null;
  }
}

function saveSession(session: { username: string } | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage unavailable: the session lives for this page only.
  }
}

let mockSession: { username: string } | null = loadSession();

export const mockHandlers = [
  http.post(`${BASE}/auth/login`, async ({ request }) => {
    const body = (await request.json()) as { username?: string };
    const username = body.username?.trim() || 'admin';
    mockSession = { username };
    saveSession(mockSession);
    return HttpResponse.json(mockLogin(username, Date.now()));
  }),

  http.get(`${BASE}/auth/me`, () => {
    if (!mockSession) {
      return HttpResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: 'not logged in', request_id: 'req_mock' } },
        { status: 401 },
      );
    }
    return HttpResponse.json(mockUser(mockSession.username));
  }),

  http.post(`${BASE}/auth/logout`, () => {
    mockSession = null;
    saveSession(null);
    return HttpResponse.json({ status: 'ok' });
  }),

  http.get(`${BASE}/meta`, () => HttpResponse.json(mockMeta)),

  http.get(`${BASE}/system/status`, () => HttpResponse.json(mockStatus)),

  http.post(`${BASE}/auth/register`, async ({ request }) => {
    const body = (await request.json()) as { username?: string };
    return HttpResponse.json(mockUser(body.username?.trim() || 'newcomer'), { status: 201 });
  }),
];
