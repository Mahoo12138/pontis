import { http, HttpResponse } from 'msw';
import metaJson from './data/meta.json';
import spacesJson from './data/spaces.json';
import nodesJsonRaw from './data/nodes.json';
import devicesJson from './data/devices.json';
import deviceOverviewJsonRaw from './data/device-overview.json';
import type { DeviceOverviewResponse, Node, RootSlot } from '../types';

// Typed, mutable view of the fixture so session-stateful CRUD compiles.
const nodesJson = nodesJsonRaw as { nodes: Node[]; root_slots: RootSlot[] };
const deviceOverview = deviceOverviewJsonRaw as DeviceOverviewResponse;
const revokedDevices = new Set<string>();

const BASE = '/api/v1';

/**
 * In-memory mock session. Login accepts any credentials and flips the flag;
 * /auth/me answers 401 until then, so the auth guard keeps unauthenticated
 * visitors on the login page.
 */
let mockSession: { username: string } | null = null;

function mockUser(username: string) {
  return {
    id: 'u001', username, display_name: username, email: `${username}@pontis.local`, role: 'admin', status: 'active', locale: 'zh-CN', created_at: '2026-08-20T08:00:00Z',
  };
}

/** Auth endpoints mocked with "any credentials accepted" semantics. */
export const authHandlers = [
  http.post(`${BASE}/auth/login`, async ({ request }) => {
    const body = (await request.json()) as { username?: string; password?: string };
    const username = body.username?.trim() || 'admin';
    mockSession = { username };
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
    return HttpResponse.json({ status: 'ok' });
  }),
];

/** MSW handlers for backend gap endpoints (always active) and real endpoints (test-only). */
export const gapHandlers = [
  // ─── Nodes (gap) ────────────────────────────────────────
  http.get(`${BASE}/spaces/:spaceId/nodes`, ({ params }) => {
    const spaceId = params.spaceId as string;
    const nodes = nodesJson.nodes.filter((n) => n.space_id === spaceId);
    return HttpResponse.json({ nodes });
  }),

  http.get(`${BASE}/spaces/:spaceId/root-slots`, ({ params }) => {
    const spaceId = params.spaceId as string;
    const root_slots = nodesJson.root_slots.filter((s) => s.space_id === spaceId);
    return HttpResponse.json({ root_slots });
  }),

  // Session-stateful CRUD: mutations update the in-memory fixture so
  // the explorer sees created/renamed/deleted nodes after invalidation.
  http.post(`${BASE}/spaces/:spaceId/nodes`, async ({ request, params }) => {
    const body = (await request.json()) as {
      type?: string;
      title?: string;
      url?: string | null;
      parent?: { type?: string; id?: string; key?: string };
    };
    const parent = body.parent ?? {};
    const newNode = {
      id: `n${Date.now()}`,
      space_id: params.spaceId as string,
      type: (body.type ?? 'bookmark') as Node['type'],
      title: body.title ?? 'New item',
      url: body.url ?? null,
      parent_id: parent.type === 'node' ? (parent.id ?? null) : null,
      root_key: parent.type === 'root' ? (parent.key ?? null) : null,
      position: 999,
      created_revision: 100,
      title_revision: 100,
      url_revision: body.url ? 100 : 0,
      structure_revision: 100,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    nodesJson.nodes.push(newNode);
    return HttpResponse.json(newNode, { status: 201 });
  }),

  http.patch(`${BASE}/spaces/:spaceId/nodes/:nodeId`, async ({ request, params }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const existing = nodesJson.nodes.find((n) => n.id === params.nodeId);
    if (!existing) {
      return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'node not found', request_id: 'req_mock' } }, { status: 404 });
    }
    Object.assign(existing, body, { updated_at: new Date().toISOString() });
    return HttpResponse.json(existing);
  }),

  http.delete(`${BASE}/spaces/:spaceId/nodes/:nodeId`, ({ params }) => {
    // Cascade like the real backend will: a folder deletes its subtree.
    const doomed = new Set<string>([params.nodeId as string]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of nodesJson.nodes) {
        if (n.parent_id && doomed.has(n.parent_id) && !doomed.has(n.id)) {
          doomed.add(n.id);
          grew = true;
        }
      }
    }
    nodesJson.nodes = nodesJson.nodes.filter((n) => !doomed.has(n.id));
    return new HttpResponse(null, { status: 204 });
  }),

  // ─── Devices (gap — full listing, not just register) ────
  http.get(`${BASE}/devices`, () => {
    return HttpResponse.json(devicesJson);
  }),

  // ─── Device overview (gap — joined Device × Binding view) ───
  http.get(`${BASE}/devices/overview`, () => {
    return HttpResponse.json({
      devices: deviceOverview.devices.filter((d) => !revokedDevices.has(d.id)),
    });
  }),

  http.post(`${BASE}/devices`, async ({ request }) => {
    const body = (await request.json()) as {
      name?: string;
      client_type?: string;
      browser?: string;
      platform?: string;
    };
    const device = {
      id: `d${Date.now()}`,
      name: body.name ?? 'New device',
      client_type: body.client_type ?? 'extension',
      browser: body.browser ?? '',
      platform: body.platform ?? '',
      sync_mode: '' as const,
      created_at: new Date().toISOString(),
      last_seen_at: null,
      bindings: [],
    };
    deviceOverview.devices.push(device);
    // One-time secret: server keeps only a hash; shown once to the user.
    return HttpResponse.json(
      { device, token: `pnt_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 14)}` },
      { status: 201 },
    );
  }),

  http.delete(`${BASE}/devices/:deviceId`, ({ params }) => {
    revokedDevices.add(params.deviceId as string);
    return new HttpResponse(null, { status: 204 });
  }),

  // ─── Activity (gap) ─────────────────────────────────────
  http.get(`${BASE}/spaces/:spaceId/activity`, () => {
    return HttpResponse.json({
      activity: [
        { id: 'a1', timestamp: '2026-08-28T15:32:00Z', actor: 'Edge on Windows', action: 'move', summary: '将「GitHub」移动到 开发 / 工具', undoable: true },
        { id: 'a2', timestamp: '2026-08-28T15:21:00Z', actor: 'Organizer', action: 'delete', summary: '删除了 12 个失效书签', undoable: true },
        { id: 'a3', timestamp: '2026-08-28T14:11:00Z', actor: 'Firefox on Mac', action: 'create', summary: '新建了「React」', undoable: true },
        { id: 'a4', timestamp: '2026-08-28T10:30:00Z', actor: 'Chrome on Linux', action: 'update', summary: '修改了「Vite」的标题', undoable: true },
        { id: 'a5', timestamp: '2026-08-27T20:00:00Z', actor: 'Edge on Windows', action: 'create', summary: '新建了「SQLite Documentation」', undoable: false },
      ],
    });
  }),

  // ─── Settings (gap) ─────────────────────────────────────
  http.get(`${BASE}/settings`, () => {
    return HttpResponse.json({
      settings: {
        registration_mode: 'closed',
        default_locale: 'zh-CN',
        session_ttl_hours: 24,
        max_spaces_per_user: 16,
      },
    });
  }),
];

/** MSW handlers for real backend endpoints (used in tests only). */
export const realHandlers = [
  http.get(`${BASE}/meta`, () => HttpResponse.json(metaJson)),

  http.get(`${BASE}/spaces`, () => HttpResponse.json(spacesJson)),

  http.post(`${BASE}/spaces`, async ({ request }) => {
    const body = (await request.json()) as { name: string };
    return HttpResponse.json({
      id: `0192-${Date.now()}`,
      name: body.name,
      epoch: 1,
      revision: 0,
      journal_floor_revision: 0,
      created_at: new Date().toISOString(),
    }, { status: 201 });
  }),
];

export const allHandlers = [...authHandlers, ...realHandlers, ...gapHandlers];
