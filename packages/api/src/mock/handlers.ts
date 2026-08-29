import { http, HttpResponse } from 'msw';

const BASE = '/api/v1';

/**
 * Remaining backend gaps. Everything else is served by the real Go
 * server; only the background job system is still mock-only. Remove as
 * the backend catches up.
 */
export const gapHandlers = [
  // ─── Background jobs (not implemented server-side yet) ────
  http.get(`${BASE}/admin/jobs`, () => {
    return HttpResponse.json({ jobs: [] });
  }),

  http.post(`${BASE}/admin/jobs/:jobId/cancel`, () => {
    return HttpResponse.json({ status: 'ok' });
  }),
];

/**
 * Handlers for a fully-mocked session ('all' mode): the gap endpoints plus
 * a minimal in-memory auth so the UI can run without the Go server.
 */
const SESSION_KEY = 'pontis-mock-session';

function loadSession(): { username: string } | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as { username: string }) : null;
  } catch {
    return null;
  }
}

function saveSession(session: { username: string } | null) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage unavailable: session lives for this page only.
  }
}

let mockSession: { username: string } | null = loadSession();

function mockUser(username: string) {
  return {
    id: 'u001', username, display_name: username, email: `${username}@pontis.local`, role: 'admin', status: 'active', locale: 'zh-CN', created_at: '2026-08-20T08:00:00Z',
  };
}

export const mockAuthHandlers = [
  http.post(`${BASE}/auth/login`, async ({ request }) => {
    const body = (await request.json()) as { username?: string };
    const username = body.username?.trim() || 'admin';
    mockSession = { username };
    saveSession(mockSession);
    return HttpResponse.json({
      token: `mock-session-token-${Date.now()}`,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      user: mockUser(username),
    });
  }),

  http.get(`${BASE}/auth/me`, () => {
    if (!mockSession) {
      return HttpResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'not logged in', request_id: 'req_mock' } }, { status: 401 });
    }
    return HttpResponse.json(mockUser(mockSession.username));
  }),

  http.post(`${BASE}/auth/logout`, () => {
    mockSession = null;
    saveSession(null);
    return HttpResponse.json({ status: 'ok' });
  }),

  http.get(`${BASE}/meta`, () => HttpResponse.json({ instance_id: 'mock', product_version: '0.1.0', api_version: 'v1', sync_protocol_versions: [1] })),
];

export const allHandlers = [...mockAuthHandlers, ...gapHandlers];
