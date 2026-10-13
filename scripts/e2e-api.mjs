#!/usr/bin/env node
// Run against `pnpm dev:test`; all fixtures and assertions use real HTTP APIs.
// Each run leaves an empty, uniquely named Space and its activity for inspection.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const API = origin('PONTIS_E2E_API_URL', 'http://127.0.0.1:8180');
const WEB = origin('PONTIS_E2E_WEB_URL', 'http://127.0.0.1:5180');
const credentials = {
  username: process.env.PONTIS_E2E_USERNAME || 'e2e',
  password: process.env.PONTIS_E2E_PASSWORD || 'pontis-e2e-pass',
};
let token;
let cookie;

function origin(name, fallback) {
  const url = new URL(process.env[name] || fallback);
  assert(['http:', 'https:'].includes(url.protocol), `${name} must use HTTP(S)`);
  assert(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    `${name} must be an origin such as http://127.0.0.1:8180`);
  return url.origin;
}

async function request(base, method, path, { body, headers = {}, status = 200, code } = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${method} ${base}/api/v1${path}: expected JSON, got HTTP ${response.status}`);
  }
  const allowed = Array.isArray(status) ? status : [status];
  assert(allowed.includes(response.status),
    `${method} ${base}/api/v1${path}: HTTP ${response.status} (${data?.error?.code || 'no error code'}), expected ${allowed.join('/')}`);
  if (code) assert.equal(data?.error?.code, code, `${method} ${path}: error code`);
  return { data, response };
}

async function direct(method, path, options = {}) {
  return (await request(API, method, path, {
    ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers },
  })).data;
}

async function proxy(method, path, options = {}) {
  return (await request(WEB, method, path, {
    ...options, headers: { Cookie: cookie, Origin: WEB, ...options.headers },
  })).data;
}

async function main() {
  const backend = (await request(API, 'GET', '/meta')).data;
  const frontend = (await request(WEB, 'GET', '/meta')).data;
  assert.equal(typeof backend.instance_id, 'string');
  assert(backend.instance_id.length > 0, 'backend must identify its instance');
  assert.equal(frontend.instance_id, backend.instance_id, 'frontend proxy must target this backend');
  for (const base of [API, WEB]) {
    await request(base, 'GET', '/spaces', { status: 401, code: 'UNAUTHENTICATED' });
  }
  console.log('ok: frontend proxy reaches the backend; anonymous access is rejected');

  // /meta does not report setup state. Only this documented 409 permits reuse.
  const setup = await request(API, 'POST', '/auth/setup', {
    body: { ...credentials, display_name: 'API E2E' }, status: [201, 409],
  });
  if (setup.response.status === 409) {
    assert.equal(setup.data?.error?.code, 'ALREADY_INITIALIZED', 'unexpected setup conflict');
  }
  let login;
  try {
    login = await request(WEB, 'POST', '/auth/login', { body: credentials });
  } catch (error) {
    throw new Error(`${error.message}. Check PONTIS_E2E_USERNAME/PONTIS_E2E_PASSWORD for this database, or restart the test environment with --reset-db.`);
  }
  token = login.data.token;
  assert.equal(typeof token, 'string', 'login must return a Bearer session token');
  assert(token.length > 0, 'login token must not be empty');
  cookie = login.response.headers.getSetCookie()
    .map((value) => value.split(';', 1)[0]).join('; ');
  assert(cookie.length > 0, 'login through the proxy must set a session cookie');
  const me = await direct('GET', '/auth/me');
  assert.equal(me.username, credentials.username);
  assert.equal((await proxy('GET', '/auth/me')).id, me.id);
  console.log(`ok: ${setup.response.status === 201 ? 'initialized database and logged in' : 'logged in to existing database'} using cookie and Bearer authentication`);

  const space = await proxy('POST', '/spaces', {
    body: { name: `API E2E ${new Date().toISOString()} ${randomUUID().slice(0, 8)}` }, status: 201,
  });
  const root = `/spaces/${space.id}`;
  console.log(`space: ${space.id} (retained with activity; every run creates a new Space)`);
  const slots = await direct('GET', `${root}/root-slots`);
  assert(slots.root_slots.some((slot) => slot.key === 'main'), 'new Space must have a main root');
  const folder = await proxy('POST', `${root}/nodes`, {
    body: { type: 'folder', title: '接口测试目录', parent: { type: 'root', key: 'main' } }, status: 201,
  });
  const child = await direct('POST', `${root}/nodes`, {
    body: { type: 'folder', title: 'Nested folder', parent: { type: 'node', id: folder.id } }, status: 201,
  });
  const bookmark = await direct('POST', `${root}/nodes`, {
    body: { type: 'bookmark', title: 'API E2E bookmark', url: 'https://example.com/e2e', parent: { type: 'node', id: child.id } }, status: 201,
  });
  const before = await direct('GET', `${root}/nodes`);
  assert.equal(before.nodes.length, 3);
  assert.deepEqual(await proxy('GET', `${root}/nodes`), before, 'proxy and backend must read the same writes');

  await proxy('PATCH', `${root}/nodes/${bookmark.id}`, {
    body: { title: 'must not persist' }, headers: { Origin: 'https://foreign.example' },
    status: 403, code: 'ORIGIN_MISMATCH',
  });
  const revision = (await direct('GET', '/spaces')).spaces.find((item) => item.id === space.id).revision;
  await direct('PATCH', `${root}/nodes/${folder.id}/move`, {
    body: { parent: { type: 'node', id: child.id } }, status: 409, code: 'INVALID_MOVE',
  });
  assert.deepEqual(await direct('GET', `${root}/nodes`), before, 'rejected writes must preserve the entire tree');
  assert.equal((await direct('GET', '/spaces')).spaces.find((item) => item.id === space.id).revision, revision,
    'rejected move must not increment the Space revision');
  console.log('ok: cookie Origin protection and cycle rejection preserve persisted state');

  const moved = await proxy('PATCH', `${root}/nodes/${bookmark.id}/move`, {
    body: { parent: { type: 'root', key: 'main' } },
  });
  assert.equal(moved.parent_id, null);
  assert.equal(moved.root_key, 'main');
  const updated = await direct('PATCH', `${root}/nodes/${bookmark.id}`, {
    body: { title: 'Updated bookmark', url: 'https://example.com/e2e/updated' },
  });
  assert.equal(updated.title, 'Updated bookmark');
  assert.equal(updated.url, 'https://example.com/e2e/updated');
  assert.deepEqual((await proxy('GET', `${root}/nodes`)).nodes.find((node) => node.id === bookmark.id), updated);
  await proxy('DELETE', `${root}/nodes/${folder.id}`, { status: 204 });
  assert.deepEqual((await direct('GET', `${root}/nodes`)).nodes, [{ ...updated, position: 0 }],
    'folder deletion must cascade and reindex the surviving root bookmark');
  await direct('DELETE', `${root}/nodes/${bookmark.id}`, { status: 204 });
  assert.deepEqual((await proxy('GET', `${root}/nodes`)).nodes, []);
  await direct('DELETE', `${root}/nodes/${bookmark.id}`, { status: 404, code: 'NODE_NOT_FOUND' });
  console.log('ok: move, update, cascading delete and repeated-delete rejection');

  await proxy('POST', '/auth/logout');
  await direct('GET', '/auth/me', { status: 401, code: 'SESSION_INVALID' });
  await proxy('GET', '/auth/me', { status: 401, code: 'SESSION_INVALID' });
  token = undefined;
  console.log('ok: logout invalidates both Bearer token and cookie');
  console.log('API E2E passed');
}

try {
  await main();
} catch (error) {
  console.error(`API E2E failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (token) {
    try {
      await direct('POST', '/auth/logout');
    } catch {
      console.error('API E2E: could not close the test session after failure');
    }
  }
}
