import { http, HttpResponse } from 'msw';
import metaJson from './data/meta.json';
import spacesJson from './data/spaces.json';
import nodesJsonRaw from './data/nodes.json';
import devicesJson from './data/devices.json';
import deviceOverviewJsonRaw from './data/device-overview.json';
import publicationsJsonRaw from './data/publications.json';
import backupsJsonRaw from './data/backups.json';
import tokensJsonRaw from './data/tokens.json';
import type {
  ApiToken,
  Backup,
  DeviceOverviewResponse,
  DuplicateGroup,
  ImportPlanEntry,
  LinkCheckResult,
  Node,
  PublicationDetail,
  PublicationSummary,
  PublicationNodeDTO,
  RootSlot,
  SystemSettings,
} from '../types';

// Typed, mutable view of the fixture so session-stateful CRUD compiles.
const nodesJson = nodesJsonRaw as { nodes: Node[]; root_slots: RootSlot[] };
const deviceOverview = deviceOverviewJsonRaw as DeviceOverviewResponse;
const publications = publicationsJsonRaw.publications as PublicationDetail[];
const backups = backupsJsonRaw.backups as Backup[];
const tokens = tokensJsonRaw.tokens as ApiToken[];
const revokedDevices = new Set<string>();
const revokedTokenIds = new Set<string>();
const profileOverrides: { display_name?: string; email?: string } = {};
const settings: SystemSettings = {
  registration_mode: 'closed',
  default_locale: 'zh-CN',
  session_ttl_hours: 24,
  max_spaces_per_user: 16,
};

const BASE = '/api/v1';

/**
 * Mock session. Login accepts any credentials and flips the flag;
 * /auth/me answers 401 until then, so the auth guard keeps unauthenticated
 * visitors on the login page. The flag is mirrored into sessionStorage so a
 * full page reload in mock-everything mode does not log the user out.
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
    // Storage may be unavailable; session then lives for this page only.
  }
}

let mockSession: { username: string } | null = loadSession();

function mockUser(username: string) {
  return {
    id: 'u001', username, display_name: profileOverrides.display_name ?? username, email: profileOverrides.email ?? `${username}@pontis.local`, role: 'admin', status: 'active', locale: 'zh-CN', created_at: '2026-08-20T08:00:00Z',
  };
}

/** Auth endpoints mocked with "any credentials accepted" semantics. */
export const authHandlers = [
  http.post(`${BASE}/auth/login`, async ({ request }) => {
    const body = (await request.json()) as { username?: string; password?: string };
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
    return HttpResponse.json({ settings });
  }),

  http.patch(`${BASE}/settings`, async ({ request }) => {
    const body = (await request.json()) as Partial<SystemSettings>;
    Object.assign(settings, body);
    return HttpResponse.json({ settings });
  }),

  http.patch(`${BASE}/auth/me`, async ({ request }) => {
    const body = (await request.json()) as { display_name?: string; email?: string };
    if (!mockSession) {
      return HttpResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'not logged in', request_id: 'req_mock' } }, { status: 401 });
    }
    profileOverrides.display_name = body.display_name ?? profileOverrides.display_name;
    profileOverrides.email = body.email ?? profileOverrides.email;
    return HttpResponse.json(mockUser(mockSession.username));
  }),

  http.post(`${BASE}/auth/password`, async ({ request }) => {
    const body = (await request.json()) as { current_password?: string; new_password?: string };
    if (!body.new_password || body.new_password.length < 8) {
      return HttpResponse.json({ error: { code: 'VALIDATION_FAILED', message: '新密码至少 8 位', request_id: 'req_mock' } }, { status: 400 });
    }
    return HttpResponse.json({ status: 'ok' });
  }),

  // ─── API Tokens (gap) ───────────────────────────────────
  http.get(`${BASE}/tokens`, () => {
    return HttpResponse.json({ tokens: tokens.filter((t) => !revokedTokenIds.has(t.id)) });
  }),

  http.post(`${BASE}/tokens`, async ({ request }) => {
    const body = (await request.json()) as { name?: string; scopes?: string[]; space_scope?: 'all' | string[] };
    if (!body.name?.trim()) {
      return HttpResponse.json({ error: { code: 'VALIDATION_FAILED', message: '名称不能为空', request_id: 'req_mock' } }, { status: 400 });
    }
    const token: ApiToken = {
      id: `tok-${Date.now()}`,
      name: body.name.trim(),
      scopes: body.scopes ?? ['bookmarks:read'],
      space_scope: body.space_scope ?? 'all',
      created_at: new Date().toISOString(),
      last_used_at: null,
    };
    tokens.push(token);
    return HttpResponse.json(
      { token, secret: `pnt_${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 14)}` },
      { status: 201 },
    );
  }),

  http.delete(`${BASE}/tokens/:tokenId`, ({ params }) => {
    revokedTokenIds.add(params.tokenId as string);
    return new HttpResponse(null, { status: 204 });
  }),

  // ─── Plaza / Publications (gap) ─────────────────────────
  http.get(`${BASE}/plaza/publications`, ({ request }) => {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    // Only plaza-visible publications enter the plaza index.
    const visible = publications.filter((p) => p.visibility === 'plaza');
    const matched = !q
      ? visible
      : visible.filter(
          (p) =>
            p.title.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.publisher.toLowerCase().includes(q) ||
            p.tags.some((t) => t.toLowerCase().includes(q)),
        );
    const summaries: PublicationSummary[] = matched.map(({ tree: _tree, ...rest }) => rest);
    return HttpResponse.json({ publications: summaries });
  }),

  http.get(`${BASE}/publications/:pubId`, ({ params }) => {
    const pub = publications.find((p) => p.id === params.pubId);
    if (!pub) {
      return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'publication not found', request_id: 'req_mock' } }, { status: 404 });
    }
    return HttpResponse.json(pub);
  }),

  http.post(`${BASE}/publications`, async ({ request }) => {
    const body = (await request.json()) as {
      space_id: string;
      root_node_id?: string;
      title: string;
      description?: string;
      tags?: string[];
    };
    // Publish from the in-memory node fixture when the subtree exists there.
    const source = body.root_node_id
      ? nodesJson.nodes.find((n) => n.id === body.root_node_id)
      : undefined;
    const now = new Date().toISOString();
    const tree: PublicationNodeDTO = source
      ? {
          id: 'pn-root',
          type: 'folder',
          title: body.title,
          children: nodesJson.nodes
            .filter((n) => n.parent_id === source.id)
            .map((n) =>
              n.type === 'folder'
                ? { id: `pn-${n.id}`, type: 'folder' as const, title: n.title, children: [] }
                : { id: `pn-${n.id}`, type: 'bookmark' as const, title: n.title, url: n.url ?? undefined },
            ),
        }
      : { id: 'pn-root', type: 'folder', title: body.title, children: [] };

    const countNodes = (node: PublicationNodeDTO): { bookmarks: number; folders: number } => {
      let bookmarks = node.type === 'bookmark' ? 1 : 0;
      let folders = node.type === 'folder' ? 1 : 0;
      for (const child of node.children ?? []) {
        const sub = countNodes(child);
        bookmarks += sub.bookmarks;
        folders += sub.folders;
      }
      return { bookmarks, folders };
    };
    const counts = countNodes(tree);

    const pub: PublicationDetail = {
      id: `pub-${Date.now()}`,
      slug: body.title.toLowerCase().replace(/\s+/g, '-').slice(0, 32),
      title: body.title,
      description: body.description ?? '',
      publisher: 'Mahoo',
      version: 1,
      visibility: 'plaza',
      bookmark_count: Math.max(0, counts.bookmarks),
      folder_count: Math.max(0, counts.folders - 1),
      tags: body.tags ?? [],
      created_at: now,
      updated_at: now,
      is_mine: true,
      tree,
    };
    publications.unshift(pub);
    const { tree: _t, ...summary } = pub;
    return HttpResponse.json(summary, { status: 201 });
  }),

  http.post(`${BASE}/publications/:pubId/apply`, async ({ request, params }) => {
    const body = (await request.json()) as {
      space_id: string;
      strategy: 'merge' | 'replace';
    };
    const pub = publications.find((p) => p.id === params.pubId);
    if (!pub) {
      return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'publication not found', request_id: 'req_mock' } }, { status: 404 });
    }
    // Merge keeps matched content (reported as kept/updated); replace
    // recreates the whole subtree (all created). Deep creation is left to
    // the real backend; the mock returns plausible counters.
    const base = pub.bookmark_count + pub.folder_count;
    return HttpResponse.json(
      body.strategy === 'merge'
        ? { created: Math.ceil(base * 0.6), updated: 2, kept: Math.floor(base * 0.4) }
        : { created: base, updated: 0, kept: 0 },
    );
  }),

  http.delete(`${BASE}/publications/:pubId`, ({ params }) => {
    const idx = publications.findIndex((p) => p.id === params.pubId);
    if (idx >= 0) publications.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // ─── Import / Export (gap) ──────────────────────────────
  http.post(`${BASE}/spaces/:spaceId/import/preview`, async ({ request }) => {
    const body = (await request.json()) as { format?: string; content?: string };
    const format = body.format === 'native_json' ? 'native_json' : 'netscape_html';
    // Deterministic sample plan; the real backend parses the uploaded file.
    void body.content;
    const counts = {
      create: 24,
      update: 3,
      move: 2,
      delete: 0,
      keep: 6,
      ambiguous: 1,
      unsupported: 2,
    };
    const entries: ImportPlanEntry[] = [
      { title: 'Go 官方文档', url: 'https://go.dev/doc/', path: '开发资源', action: 'create' },
      { title: '标准库参考', url: 'https://pkg.go.dev/std', path: '开发资源', action: 'create' },
      { title: 'Vite 指南', url: 'https://vite.dev/guide/', path: '开发资源/前端', action: 'create' },
      { title: 'GitHub', url: 'https://github.com', path: '/', action: 'keep' },
      { title: 'React', url: 'https://react.dev', path: '/', action: 'update', reason: 'URL 相同,标题不同' },
      { title: 'TanStack', url: 'https://tanstack.com', path: '/', action: 'move', reason: '位置与现有不同' },
      { title: '未命名页面', url: 'https://example.org/unknown', path: '开发资源', action: 'ambiguous', reason: '同名同 URL 已存在多处,不猜测' },
      { title: '带图标的书签', path: '开发资源', action: 'unsupported', reason: 'ICON 属性将被忽略' },
      { title: '分隔线', path: '开发资源', action: 'unsupported', reason: 'Separator 不支持跨浏览器同步' },
    ];
    return HttpResponse.json({
      plan_id: `plan-${Date.now()}`,
      format,
      total: 38,
      counts,
      warnings: [
        '2 个条目包含不支持将被忽略的属性(ICON / separator)。',
        '1 个条目匹配不明确,确认后将被跳过。',
      ],
      entries,
      bound_revision: 42,
    });
  }),

  http.post(`${BASE}/spaces/:spaceId/import/apply`, async ({ request }) => {
    const body = (await request.json()) as { plan_id?: string; strategy?: string };
    if (!body.plan_id) {
      return HttpResponse.json({ error: { code: 'PLAN_NOT_FOUND', message: 'plan required', request_id: 'req_mock' } }, { status: 400 });
    }
    // Replace recreates the target subtree; merge preserves matched content.
    return HttpResponse.json(
      body.strategy === 'replace'
        ? { created: 36, updated: 0, deleted: 14, kept: 0 }
        : { created: 24, updated: 3, deleted: 0, kept: 6 },
    );
  }),

  http.post(`${BASE}/spaces/:spaceId/export`, async ({ request, params }) => {    const body = (await request.json()) as { format?: string; root_key?: string };
    const spaceId = params.spaceId as string;
    const spaceName =
      spacesJson.spaces.find((s) => s.id === spaceId)?.name ?? 'space';
    const inScope = nodesJson.nodes.filter(
      (n) => n.space_id === spaceId && (!body.root_key || n.root_key === body.root_key),
    );

    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    if (body.format === 'native_json') {
      return HttpResponse.json({
        filename: `${spaceName}-export.json`,
        content_type: 'application/json',
        content: JSON.stringify(
          {
            format: 'pontis-portable-bookmarks',
            version: 1,
            exported_at: new Date().toISOString(),
            space: { name: spaceName },
            nodes: inScope.map((n) => ({
              id: n.id,
              type: n.type,
              title: n.title,
              url: n.url ?? undefined,
              parent_id: n.parent_id ?? undefined,
              root_key: n.root_key ?? undefined,
              position: n.position,
            })),
            root_slots: nodesJson.root_slots.filter((s) => s.space_id === spaceId),
          },
          null,
          2,
        ),
      });
    }

    const childrenOf = (parentId: string | null, rootKey: string | null) =>
      inScope.filter((n) =>
        parentId === null
          // top level: scope by root slot; deeper levels scope by parent only
          ? n.parent_id === null && n.root_key === rootKey
          : n.parent_id === parentId,
      );
    const renderFolder = (title: string, parentId: string | null, rootKey: string | null, depth: number): string => {
      const pad = '    '.repeat(depth);
      const kids = childrenOf(parentId, rootKey);
      const rows: string[] = [];
      for (const k of kids) {
        if (k.type === 'folder') {
          rows.push(`${pad}<DT><H3>${esc(k.title)}</H3>`);
          rows.push(renderFolder(k.title, k.id, rootKey, depth + 1));
        } else {
          rows.push(`${pad}<DT><A HREF="${esc(k.url ?? '')}">${esc(k.title)}</A>`);
        }
      }
      return `${pad}<DL><p>\n${rows.join('\n')}\n${pad}</DL><p>`;
    };

    const slots = nodesJson.root_slots.filter((s) => s.space_id === spaceId);
    const sections = slots
      .map((slot) =>
        `    <DT><H3>${esc(slot.display_name)}</H3>\n${renderFolder(slot.display_name, null, slot.key, 2)}`,
      )
      .join('\n');
    const html = [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      `<TITLE>Bookmarks</TITLE>`,
      '<H1>Bookmarks</H1>',
      '<DL><p>',
      sections,
      '</DL><p>',
    ].join('\n');
    return HttpResponse.json({
      filename: `${spaceName}-bookmarks.html`,
      content_type: 'text/html',
      content: html,
    });
  }),

  // ─── Organizer (gap) ────────────────────────────────────
  http.post(`${BASE}/spaces/:spaceId/organizer/link-check`, ({ params }) => {
    const spaceId = params.spaceId as string;
    const total = nodesJson.nodes.filter((n) => n.space_id === spaceId && n.type === 'bookmark').length;
    return HttpResponse.json({ job_id: `job-link-${Date.now()}`, total });
  }),

  http.get(`${BASE}/spaces/:spaceId/organizer/link-check/results`, ({ params }) => {
    const spaceId = params.spaceId as string;
    // Deterministic per-URL outcomes; the real backend runs a bounded
    // concurrent LinkCheckJob (HEAD first, GET fallback, per-host limits).
    const classify = (url: string) => {
      const latency = 120 + ((url.length * 37) % 900);
      if (url.includes('wal.html')) {
        return { status_class: 'client_4xx' as const, http_status: 404, latency_ms: latency };
      }
      if (url.includes('dribbble')) {
        return { status_class: 'server_5xx' as const, http_status: 503, latency_ms: latency };
      }
      if (url.includes('caniuse')) {
        return { status_class: 'timeout' as const, error_type: 'timeout', latency_ms: 8000 };
      }
      if (url.includes('vanilla-extract')) {
        return { status_class: 'network_error' as const, error_type: 'dns_resolution_failed', latency_ms: latency };
      }
      return { status_class: 'ok_2xx' as const, http_status: 200, latency_ms: latency };
    };
    const now = new Date().toISOString();
    const results = nodesJson.nodes
      .filter((n) => n.space_id === spaceId && n.type === 'bookmark')
      .map((n) => ({
        node_id: n.id,
        title: n.title,
        checked_url: n.url ?? '',
        checked_at: now,
        ...classify(n.url ?? ''),
      }));
    return HttpResponse.json({ job_id: 'job-link-latest', finished_at: now, results });
  }),

  http.get(`${BASE}/spaces/:spaceId/organizer/duplicates`, ({ params }) => {
    const spaceId = params.spaceId as string;
    const bookmarks = nodesJson.nodes.filter(
      (n) => n.space_id === spaceId && n.type === 'bookmark' && n.url,
    );

    const pathOf = (nodeId: string): string => {
      const parts: string[] = [];
      let cur = nodesJson.nodes.find((n) => n.id === nodeId);
      while (cur) {
        parts.unshift(cur.title);
        cur = cur.parent_id ? nodesJson.nodes.find((n) => n.id === cur?.parent_id) : undefined;
      }
      return parts.join(' / ');
    };

    // Exact duplicates: identical raw URL. Title is irrelevant.
    const byRaw = new Map<string, typeof bookmarks>();
    for (const b of bookmarks) {
      const list = byRaw.get(b.url!) ?? [];
      list.push(b);
      byRaw.set(b.url!, list);
    }
    const exactKeys = new Set<string>();
    const groups: DuplicateGroup[] = [];
    for (const [url, list] of byRaw) {
      if (list.length > 1) {
        exactKeys.add(url);
        groups.push({
          id: `exact-${url}`,
          kind: 'exact',
          items: list.map((b) => ({ node_id: b.id, title: b.title, url, path: pathOf(b.id) })),
        });
      }
    }

    // Suspected duplicates: conservative normalization with reasons.
    const normalize = (raw: string) => {
      try {
        const u = new URL(raw);
        const reasons: string[] = [];
        const tracking = [...u.searchParams.keys()].filter((k) => k.startsWith('utm_') || k === 'fbclid' || k === 'gclid');
        for (const k of tracking) u.searchParams.delete(k);
        if (tracking.length > 0) reasons.push('tracking_params_only');
        if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
          u.pathname = u.pathname.replace(/\/+$/, '');
          reasons.push('trailing_slash_only');
        }
        if (u.port && ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80'))) {
          u.port = '';
          reasons.push('default_port_only');
        }
        return { key: `${u.protocol}//${u.host}${u.pathname}${u.search}`, reasons };
      } catch {
        return { key: raw, reasons: [] as string[] };
      }
    };

    const byNorm = new Map<string, { items: DuplicateGroup['items']; reasons: Set<string>; raws: Set<string> }>();
    for (const b of bookmarks) {
      const { key, reasons } = normalize(b.url!);
      const entry = byNorm.get(key) ?? { items: [], reasons: new Set<string>(), raws: new Set<string>() };
      entry.items.push({ node_id: b.id, title: b.title, url: b.url!, path: pathOf(b.id) });
      entry.raws.add(b.url!);
      for (const r of reasons) entry.reasons.add(r);
      byNorm.set(key, entry);
    }
    for (const [key, entry] of byNorm) {
      const firstRaw = [...entry.raws][0];
      const isExact = entry.raws.size === 1 && firstRaw !== undefined && exactKeys.has(firstRaw);
      if (entry.items.length > 1 && !isExact) {
        groups.push({
          id: `suspected-${key}`,
          kind: 'suspected',
          reason: [...entry.reasons].join(', ') || 'url_normalization',
          items: entry.items,
        });
      }
    }

    return HttpResponse.json({ groups });
  }),

  // ─── Backups (gap) ──────────────────────────────────────
  http.get(`${BASE}/spaces/:spaceId/backups`, ({ params }) => {
    const spaceId = params.spaceId as string;
    const list = backups
      .filter((b) => b.space_id === spaceId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return HttpResponse.json({ backups: list });
  }),

  http.post(`${BASE}/spaces/:spaceId/backups`, async ({ params }) => {
    const spaceId = params.spaceId as string;
    const spaceName = spacesJson.spaces.find((s) => s.id === spaceId)?.name ?? 'space';
    const nodesInSpace = nodesJson.nodes.filter((n) => n.space_id === spaceId);
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
    const backup: Backup = {
      id: `bk-${Date.now()}`,
      space_id: spaceId,
      kind: 'manual',
      filename: `${spaceName}-${stamp}-full.tar.zst`,
      size_bytes: nodesInSpace.length * 17_311 + 12_400,
      node_count: nodesInSpace.length,
      bookmark_count: nodesInSpace.filter((n) => n.type === 'bookmark').length,
      created_at: now.toISOString(),
      protected: false,
    };
    backups.push(backup);
    return HttpResponse.json(backup, { status: 201 });
  }),

  http.post(`${BASE}/spaces/:spaceId/backups/:backupId/restore`, async ({ request, params }) => {
    const spaceId = params.spaceId as string;
    const spaceName = spacesJson.spaces.find((s) => s.id === spaceId)?.name ?? 'space';
    // Restore flow: create pre-restore safety backup → replace baseline →
    // epoch++ → revision=0 → bindings require resync (docs/14 §12).
    const safety: Backup = {
      id: `bk-safety-${Date.now()}`,
      space_id: spaceId,
      kind: 'safety',
      filename: `${spaceName}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-presafety.tar.zst`,
      size_bytes: 455_233,
      node_count: nodesJson.nodes.filter((n) => n.space_id === spaceId).length,
      bookmark_count: nodesJson.nodes.filter((n) => n.space_id === spaceId && n.type === 'bookmark').length,
      created_at: new Date().toISOString(),
      protected: false,
    };
    backups.push(safety);
    const epoch = 2 + (spaceId.length % 3);
    return HttpResponse.json({ safety_backup_id: safety.id, new_epoch: epoch });
  }),

  http.patch(`${BASE}/spaces/:spaceId/backups/:backupId`, async ({ request, params }) => {
    const body = (await request.json()) as { protected?: boolean };
    const backup = backups.find(
      (b) => b.id === params.backupId && b.space_id === params.spaceId,
    );
    if (!backup) {
      return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'backup not found', request_id: 'req_mock' } }, { status: 404 });
    }
    if (typeof body.protected === 'boolean') backup.protected = body.protected;
    return HttpResponse.json(backup);
  }),

  http.delete(`${BASE}/spaces/:spaceId/backups/:backupId`, ({ params }) => {
    const idx = backups.findIndex(
      (b) => b.id === params.backupId && b.space_id === params.spaceId,
    );
    if (idx < 0) {
      return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'backup not found', request_id: 'req_mock' } }, { status: 404 });
    }
    backups.splice(idx, 1);
    return new HttpResponse(null, { status: 204 });
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
