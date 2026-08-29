import { http, HttpResponse } from 'msw';

const BASE = '/api/v1';

/**
 * Remaining backend gaps. Everything else (auth, spaces, nodes, activity,
 * devices, settings, tokens, backups, organizer, plaza) is served by the
 * real Go server; these handlers only cover endpoints that are not
 * implemented yet. Remove each as the backend catches up.
 */
export const gapHandlers = [
  // ─── Import / Export (not implemented server-side yet) ───
  http.post(`${BASE}/spaces/:spaceId/import/preview`, async () => {
    return HttpResponse.json({
      plan_id: `plan-${Date.now()}`,
      format: 'netscape_html',
      total: 38,
      counts: { create: 24, update: 3, move: 2, delete: 0, keep: 6, ambiguous: 1, unsupported: 2 },
      warnings: [
        '2 个条目包含不支持将被忽略的属性(ICON / separator)。',
        '1 个条目匹配不明确,确认后将被跳过。',
      ],
      entries: [
        { title: 'Go 官方文档', url: 'https://go.dev/doc/', path: '开发资源', action: 'create' },
        { title: 'GitHub', url: 'https://github.com', path: '/', action: 'keep' },
        { title: 'React', url: 'https://react.dev', path: '/', action: 'update', reason: 'URL 相同,标题不同' },
      ],
      bound_revision: 1,
    });
  }),

  http.post(`${BASE}/spaces/:spaceId/import/apply`, async ({ request }) => {
    const body = (await request.json()) as { strategy?: string };
    return HttpResponse.json(
      body.strategy === 'replace'
        ? { created: 36, updated: 0, deleted: 14, kept: 0 }
        : { created: 24, updated: 3, deleted: 0, kept: 6 },
    );
  }),

  http.post(`${BASE}/spaces/:spaceId/export`, async () => {
    return HttpResponse.json({
      filename: 'export-bookmarks.html',
      content_type: 'text/html',
      content: '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p></DL><p>',
    });
  }),

  // ─── Admin users (not implemented server-side yet) ────────
  http.get(`${BASE}/admin/users`, () => {
    return HttpResponse.json({
      users: [
        { id: 'u-self', username: 'admin', display_name: 'Admin', email: '', role: 'admin', status: 'active', space_count: 1, created_at: '2026-08-20T08:00:00Z', last_seen_at: null },
      ],
    });
  }),

  http.patch(`${BASE}/admin/users/:userId`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({ id: 'u-self', username: 'admin', display_name: 'Admin', email: '', role: 'user', status: 'active', space_count: 1, created_at: '', ...body });
  }),

  http.post(`${BASE}/admin/users/:userId/reset-link`, () => {
    return HttpResponse.json({ reset_link: 'http://localhost:5174/reset?token=mock' });
  }),

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
