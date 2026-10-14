#!/usr/bin/env node
// Two real Chromium profiles converging through a real server (doc 21 §10).
//
// Fake adapter + httptest each use their own double, so the shape differences
// that only a real browser can show — chrome.bookmarks' actual behaviour, MV3
// service-worker lifetime, IndexedDB under Dexie, the event echo of our own
// writes — never meet in a unit test. This script runs that meeting:
//
//   server (built binary, clean data dir)
//     ├── profile A: unpacked extension → pair → bind → initial reconcile
//     └── profile B: the same, same space
//   then each side edits its browser bookmarks, both sync, and the script
//   asserts the server and BOTH browsers hold the same tree.
//
// It drives Chrome over the DevTools protocol with Node's global fetch/WebSocket
// and adds no dependency. It needs a display, so CI does not run it — see the
// README's known limits. It uses the E2E extension build (extension/wxt.config.ts
// puts the server origin in host_permissions) because the permission bubble that
// pairing triggers is browser UI no automation can click.
//
//   pnpm build && node scripts/e2e-dual-profile.mjs [--keep] [--debug]

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARGS = new Set(process.argv.slice(2));
const KEEP = ARGS.has('--keep');
const DEBUG = ARGS.has('--debug');
const PORT = Number(process.env.PONTIS_E2E_PORT || 8199);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'pontis-e2e-pass';
const WORK = path.join(os.tmpdir(), 'pontis-e2e');
const EXT_DIR = path.join(ROOT, 'extension', '.e2e-output', 'chrome-mv3');
// A CDP call that never answers used to hang the whole run: it is one dead tab
// away from a green-looking process that prints nothing for twenty minutes.
const CDP_TIMEOUT_MS = 30_000;

let failed = 0;
const log = (...a) => console.log(...a);
function check(ok, label, detail) {
  if (ok) {
    log(`  ok   ${label}`);
    return true;
  }
  failed++;
  log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}
// Every process this run started. `die()` exits the process, which skips the
// finally blocks in main(), and a Chromium left behind holds its
// --remote-debugging-port: the next run then attaches to the *stale* browser,
// whose profile is already paired, and fails somewhere far from the cause.
const launched = [];
function killGroup(proc) {
  if (!proc || !proc.pid) return;
  try {
    // Every browser is spawned detached, so its pid is also a process group id:
    // signalling the group takes Chromium's helper children with it. Killing
    // only the parent leaves them holding the remote-debugging port.
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function shutdownAll() {
  for (const proc of launched.splice(0)) killGroup(proc);
  if (serverProc) killGroup(serverProc);
}

const die = (msg) => {
  console.error(`e2e: ${msg}`);
  shutdownAll();
  process.exit(2);
};

process.on('SIGINT', () => { shutdownAll(); process.exit(130); });
process.on('SIGTERM', () => { shutdownAll(); process.exit(143); });

// --- environment -------------------------------------------------------------

// Where Playwright keeps its downloaded browsers, and what the Chromium binary
// is called inside each build directory. The macOS bundle hides the executable
// inside the .app; Linux and Windows put it at the top of the folder.
const PLAYWRIGHT_LAYOUT = {
  darwin: {
    root: () => path.join(os.homedir(), 'Library/Caches', 'ms-playwright'),
    dirs: ['chrome-mac', 'chrome-mac-arm64'],
    exe: ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
  },
  linux: {
    root: () => process.env.PLAYWRIGHT_BROWSERS_PATH
      || path.join(os.homedir(), '.cache', 'ms-playwright'),
    dirs: ['chrome-linux', 'chrome-linux64'],
    exe: ['chrome'],
  },
  win32: {
    root: () => path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    dirs: ['chrome-win', 'chrome-win-x64'],
    exe: ['chrome.exe'],
  },
};

function chromeExecutable() {
  if (process.env.PONTIS_E2E_CHROME) return process.env.PONTIS_E2E_CHROME;
  const layout = PLAYWRIGHT_LAYOUT[process.platform] || PLAYWRIGHT_LAYOUT.linux;
  const root = layout.root();
  if (!existsSync(root)) die(`no playwright browser cache at ${root}; set PONTIS_E2E_CHROME`);
  const builds = readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
    .reverse();
  for (const b of builds) {
    for (const dir of layout.dirs) {
      for (const exe of layout.exe) {
        const candidate = path.join(root, b, dir, exe);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  die(`no Google Chrome for Testing binary under ${root}; set PONTIS_E2E_CHROME`);
}

/** Chrome's id for an unpacked extension: sha256 of its absolute path. */
function extensionId(dir) {
  return createHash('sha256')
    .update(dir)
    .digest('hex')
    .slice(0, 32)
    .split('')
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
}

function buildExtensionArtifact() {
  execFileSync('pnpm', ['--filter', '@pontis/extension', 'build'], {
    cwd: ROOT,
    stdio: DEBUG ? 'inherit' : 'pipe',
    env: { ...process.env, PONTIS_E2E_ORIGIN: `${ORIGIN}/*` },
  });
  const manifest = JSON.parse(readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  // Guard the switch itself: silently testing the shipped build would stop at
  // the permission bubble, and the failure would look like a sync bug.
  if (manifest.name !== 'Pontis (E2E)') die(`built artifact is "${manifest.name}", not the E2E build`);
  if (!(manifest.host_permissions || []).includes(`${ORIGIN}/*`)) {
    die(`built artifact lacks the host permission for ${ORIGIN}`);
  }
}

/**
 * Rebuild the package the way an upgrade delivers it: the directory is emptied
 * first, so a chunk the new build no longer emits cannot be left behind
 * (doc §10.2 step 4 describes exactly that residue).
 */
function rebuildExtensionAtSamePath() {
  rmSync(EXT_DIR, { recursive: true, force: true });
  buildExtensionArtifact();
}

// --- the server --------------------------------------------------------------

let serverProc;
async function startServer() {
  const bin = path.join(ROOT, 'server', 'pontis');
  if (!existsSync(bin)) die('server/pontis missing — run `pnpm build` first');
  serverProc = spawn(bin, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      PONTIS_LISTEN: `127.0.0.1:${PORT}`,
      PONTIS_DATA_DIR: path.join(WORK, 'data'),
      PONTIS_LOG_LEVEL: 'warn',
    },
    stdio: DEBUG ? 'inherit' : 'ignore',
    detached: true,
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${ORIGIN}/api/v1/meta`);
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  die('server did not answer /api/v1/meta');
}

/** Take the server away without touching its data directory or the profiles. */
function stopServer() {
  if (serverProc) killGroup(serverProc);
  serverProc = undefined;
}

async function api(method, pathname, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(ORIGIN + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** One account, one space, two bookmarks the browsers have never seen. */
async function seed() {
  await api('POST', '/api/v1/auth/setup', {
    body: { username: 'e2e', password: PASSWORD, display_name: 'E2E' },
  });
  const login = await api('POST', '/api/v1/auth/login', {
    body: { username: 'e2e', password: PASSWORD },
  });
  const token = login.token;
  const space = await api('POST', '/api/v1/spaces', { body: { name: 'E2E Converge' }, token });
  const parent = { type: 'root', key: 'main' };
  for (const title of ['Server One', 'Server Two']) {
    await api('POST', `/api/v1/spaces/${space.id}/nodes`, {
      body: { type: 'bookmark', title, url: `https://pontis.test/${title.toLowerCase().replace(' ', '-')}`, parent },
      token,
    });
  }
  return { token, spaceId: space.id };
}

async function serverTree(spaceId, token) {
  const { nodes } = await api('GET', `/api/v1/spaces/${spaceId}/nodes`, { token });
  return nodes.filter((n) => n.type === 'bookmark').map((n) => n.title).sort();
}

// --- DevTools protocol -------------------------------------------------------

class Session {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const hit = this.pending.get(msg.id);
      if (!hit) return;
      this.pending.delete(msg.id);
      msg.error ? hit.reject(new Error(msg.error.message)) : hit.resolve(msg.result);
    });
    // A tab that is closed or discarded takes its socket with it, and CDP then
    // never answers the requests already in flight. Without this the run sits
    // there forever instead of saying which step lost its page.
    ws.addEventListener('close', () => this.failAll(new Error('cdp socket closed')));
  }
  failAll(err) {
    for (const [, hit] of this.pending) hit.reject(err);
    this.pending.clear();
  }
  static async connect(wsUrl, { enableRuntime = true } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error(`cdp connect failed: ${wsUrl}`)));
    });
    const s = new Session(ws);
    // Only a page/extension target answers Runtime.*; the browser target would
    // reply "'Runtime.enable' wasn't found".
    if (enableRuntime) await s.send('Runtime.enable');
    return s;
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      // Backstop for the case the socket stays open but the target stops
      // answering — a hung extension page must fail the run, not stall it.
      const timer = setTimeout(() => reject(new Error(`cdp ${method} never answered`)),
        CDP_TIMEOUT_MS);
      timer.unref?.();
      const settle = (fn) => (v) => {
        clearTimeout(timer);
        this.pending.delete(id);
        fn(v);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

class Browser {
  constructor(name, debugPort, { reuseProfile = false } = {}) {
    this.name = name;
    this.debugPort = debugPort;
    this.dir = path.join(WORK, `profile-${name}`);
    // The upgrade run restarts over an existing profile on purpose — wiping it
    // would delete the very state the run is there to prove survives.
    if (!reuseProfile) {
      rmSync(this.dir, { recursive: true, force: true });
      mkdirSync(this.dir, { recursive: true });
    }
  }
  async start() {
    // A port already answering means a browser from an earlier run is still
    // alive. Say so here rather than driving that one by accident.
    const occupied = await fetch(`http://127.0.0.1:${this.debugPort}/json/version`)
      .then((r) => r.ok).catch(() => false);
    if (occupied) die(`debug port ${this.debugPort} is already answering; a stale browser is holding it`);
    this.proc = spawn(chromeExecutable(), [
      `--user-data-dir=${this.dir}`,
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
      `--remote-debugging-port=${this.debugPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-timer-throttling',
      // Without this, macOS pops a keychain prompt ("Chromium Safe Storage")
      // on the first cookie write and every fetch in the profile hangs behind
      // it — which reads as a pairing bug. Playwright passes the same flag.
      '--use-mock-keychain',
      // In a container the sandbox needs user namespaces the runner may not
      // grant; CI asks for this explicitly rather than every profile silently
      // failing to start.
      ...(process.env.PONTIS_E2E_NO_SANDBOX ? ['--no-sandbox'] : []),
      'about:blank',
    ], { stdio: DEBUG ? 'inherit' : 'ignore', detached: true });
    launched.push(this.proc);
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${this.debugPort}/json/version`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${this.name}: devtools never came up`);
  }
  /**
   * Attach to a page showing this url, reusing the tab when one is already
   * open. Driving the popup means one round after another, and creating a tab
   * for every round opens a hundred windows and then attaches to the oldest
   * one, which Chrome has long since discarded.
   */
  async page(url, { fresh = false } = {}) {
    if (!fresh) {
      const list = await (await fetch(`http://127.0.0.1:${this.debugPort}/json/list`)).json();
      const target = list.find((t) => t.url === url && t.webSocketDebuggerUrl);
      if (target) return Session.connect(target.webSocketDebuggerUrl);
    }
    await this.sendBrowser('Target.createTarget', { url });
    return this.findPage(url);
  }
  /** True once a tab showing this url exists — the extension may have opened it. */
  async waitForTarget(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const list = await (await fetch(`http://127.0.0.1:${this.debugPort}/json/list`)).json();
      if (list.some((t) => t.url === url)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }
  /**
   * Attach to a tab that already shows this url — including one the extension
   * moved there itself, which is how the guide hands off to the settings page.
   */
  async findPage(url) {
    for (let i = 0; i < 60; i++) {
      const list = await (await fetch(`http://127.0.0.1:${this.debugPort}/json/list`)).json();
      const target = list.find((t) => t.url === url);
      if (target?.webSocketDebuggerUrl) return Session.connect(target.webSocketDebuggerUrl);
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`${this.name}: page ${url} never appeared`);
  }
  async sendBrowser(method, params) {
    if (!this.browserSession) {
      const info = await (await fetch(`http://127.0.0.1:${this.debugPort}/json/version`)).json();
      this.browserSession = await Session.connect(info.webSocketDebuggerUrl, { enableRuntime: false });
    }
    return this.browserSession.send(method, params);
  }
  /**
   * Close every tab showing this url. The sync rounds drive the popup, and a
   * tab left behind is one more candidate the next `findPage` can attach to —
   * Chrome is free to discard it, and a discarded target answers nothing.
   */
  async closePages(url) {
    const list = await (await fetch(`http://127.0.0.1:${this.debugPort}/json/list`)).json();
    for (const t of list.filter((x) => x.url === url)) {
      await this.sendBrowser('Target.closeTarget', { targetId: t.id }).catch(() => undefined);
    }
  }
  stop() {
    this.browserSession?.close();
    killGroup(this.proc);
  }
}

// --- page driving ------------------------------------------------------------

/** The page-side helpers the steps below run through Runtime.evaluate. */
const HELPERS = `
  const byText = (sel, text) => [...document.querySelectorAll(sel)]
    .find((el) => (el.textContent || '').trim() === text);
  // A required field's label carries a trailing asterisk in the DOM, and the
  // person reading the screen does not say "服务器地址 star". Backslashes are
  // doubled because this is a string the page parses, not a regex literal.
  const labelOf = (el) => (el.querySelector('label')?.textContent || '')
    .replace(/\\s*\\*\\s*$/, '').trim();
  const fieldRoot = (label) => [...document.querySelectorAll(
      '.mantine-TextInput-root, .mantine-PasswordInput-root, .mantine-Select-root')]
    .find((el) => labelOf(el) === label);
  const rectOf = (el) => {
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  };
  const buttonRect = (label) => rectOf(byText('button', label));
  const buttonReady = (label) => {
    const b = byText('button', label);
    return !!b && !b.disabled;
  };
  const selectRect = (label) => {
    const root = fieldRoot(label);
    return root ? rectOf(root.querySelector('input')) : null;
  };
  const optionRect = (text) => rectOf([...document.querySelectorAll('[role="option"]')]
    .find((o) => (o.textContent || '').includes(text)));
  // The mount field is not a Select: its layer is a Popover of radio rows, one
  // per folder, so the role=option lookup above finds nothing in it. The row's
  // label is the click target — Mantine keeps the input itself visually hidden.
  const folderRect = (group, title) => {
    const input = [...document.querySelectorAll('input[type=radio]')]
      .filter((i) => i.getAttribute('name') === group)
      .find((i) => ((i.getAttribute('aria-label') || '').trim() === title));
    return input ? rectOf(input.closest('label') || input) : null;
  };
  const typeInto = (label, value) => {
    const root = fieldRoot(label);
    if (!root) return 'no field: ' + label;
    const input = root.querySelector('input');
    if (!input) return 'no input: ' + label;
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input), 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  };
  const bodyText = () => document.body.innerText;
`;

/**
 * A real mouse event, not element.click(): pairing calls
 * chrome.permissions.request, and that API only answers true inside a user
 * gesture — a synthetic click is not one, so the shipped flow would report
 * "需要允许扩展访问…" no matter what the manifest grants.
 */
async function clickAt(session, boxJson, what) {
  if (!boxJson) throw new Error(`${what}: element not found`);
  const { x, y } = JSON.parse(boxJson);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  return `clicked (${x},${y})`;
}

async function clickButton(session, label, what) {
  return clickAt(session, await session.evaluate(`${HELPERS}return buttonRect(${JSON.stringify(label)});`),
    `${what}: button ${label}`);
}

async function pickOption(session, field, option, what) {
  await clickAt(session, await session.evaluate(`${HELPERS}return selectRect(${JSON.stringify(field)});`),
    `${what}: select ${field}`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const box = await session.evaluate(`${HELPERS}return optionRect(${JSON.stringify(option)});`);
    if (box) return clickAt(session, box, `${what}: option ${option}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${what}: select ${field} never offered an option matching ${option}`);
}

/** Open the folder layer and choose one of its rows. */
async function pickFolder(session, field, group, title, what) {
  await clickAt(session, await session.evaluate(`${HELPERS}return selectRect(${JSON.stringify(field)});`),
    `${what}: folder field ${field}`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const box = await session.evaluate(
      `${HELPERS}return folderRect(${JSON.stringify(group)}, ${JSON.stringify(title)});`);
    if (box) return clickAt(session, box, `${what}: folder ${title}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${what}: the folder layer never offered a row named ${title}`);
}

async function waitStep(session, expr, want, what, timeoutMs = 90_000, failOn = '') {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = String(await session.evaluate(`${HELPERS}\nreturn ${expr};`));
    if (last.includes(want)) return last;
    // The extension surfaces its own failures in an Alert; waiting out the
    // timeout for a message already on screen wastes the run and hides the why.
    if (failOn && last.includes(failOn)) {
      throw new Error(`${what}: page reported failure — ${last.slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what}: never saw ${JSON.stringify(want)} (last: ${last.slice(0, 400)})`);
}

async function runStep(session, expr, label) {
  const out = await session.evaluate(`${HELPERS}\nreturn ${expr};`);
  check(!String(out).startsWith('no ') && out !== 'false', label, String(out));
  return out;
}

/**
 * Run a step, and if it fails say what the screen actually showed. Pairing
 * throws before main()'s finally is reached, so without this a run that stops
 * at a guide step reports only the expression that timed out — and the page is
 * what a person would read next.
 */
async function stepShowingPage(what, page, fn) {
  try {
    return await fn();
  } catch (err) {
    const text = String(await page.evaluate(`${HELPERS}return bodyText()`).catch(() => 'unreadable'));
    log(`  --- ${what}: page said --- ${text.split('\n').filter(Boolean).slice(0, 24).join(' / ')}`);
    throw err;
  }
}

const treeTitles = `
  const roots = await chrome.bookmarks.getTree();
  const out = [];
  const walk = (n) => { if (n.url) out.push(n.title); (n.children || []).forEach(walk); };
  roots.forEach(walk);
  return JSON.stringify(out.sort());
`;

/**
 * Walk the first-run guide the way a person does, and end up on the settings
 * page: pair (step 1) → bind the bookmark bar (step 2) → 完成并打开设置页
 * (step 3). Driving the guide rather than the settings page is the point — it
 * is the only surface that offers both forms without a tab click in between,
 * and the handoff is part of what this verifies.
 */
async function pairProfile(name, info) {
  const browser = new Browser(name, info.debugPort);
  await browser.start();
  const optionsUrl = `chrome-extension://${info.extId}/options.html#sync`;
  // A first install opens the guide by itself — that is the whole point of the
  // page — so drive that tab instead of creating a second window beside it.
  const guideUrl = `chrome-extension://${info.extId}/onboarding.html`;
  check(await browser.waitForTarget(guideUrl, 15_000), `${name}: installing opened the guide tab`);
  const page = await browser.page(guideUrl);

  // The E2E build carries the origin in the manifest; if this is false the
  // switch broke and pairing would hang on a bubble nobody can click.
  await runStep(page, `await chrome.permissions.contains({ origins: ['${ORIGIN}/*'] })`,
    `${name}: host permission already granted, no bubble`);
  // An extension page opens as soon as its URL resolves, which is before React
  // has mounted the form — typing into a field that is not there yet is the
  // difference between a green run and a flaky one.
  await waitStep(page, `!!fieldRoot('服务器地址')`, 'true', `${name}: guide step 1 mounted`, 20_000);

  await runStep(page, `typeInto('服务器地址', '${ORIGIN}')`, `${name}: server url`);
  await runStep(page, `typeInto('用户名', 'e2e')`, `${name}: username`);
  await runStep(page, `typeInto('密码', '${PASSWORD}')`, `${name}: password`);
  await runStep(page, `typeInto('设备名称', 'E2E ${name}')`, `${name}: device name`);
  log(`  step ${name}: 登录并注册设备 → ${await clickButton(page, '登录并注册设备', name)}`);
  // Step 1 collapses to a summary line once it is done, which is the guide's
  // own proof that pairing succeeded.
  await waitStep(page, "bodyText()", '已连接', `${name}: pairing`, 60_000, '操作失败');

  // Step 2 opens itself. Both fields are the signal it is ready: 同步空间 is a
  // Select and 挂载目录 a folder field, and the run needs one of each.
  await stepShowingPage(`${name}: guide step 2`, page, () => waitStep(page,
    `!!fieldRoot('同步空间') && !!fieldRoot('挂载目录')`,
    'true', `${name}: guide step 2 mounted`, 20_000));
  await pickOption(page, '同步空间', 'E2E Converge', name);
  await pickFolder(page, '挂载目录', 'mount-folder', 'Bookmarks Bar', name);
  log(`  step ${name}: 创建绑定 → ${await clickButton(page, '创建绑定', name)}`);

  await waitStep(page, `buttonReady('完成并打开设置页')`, 'true',
    `${name}: guide unlocks the settings page`, 30_000);
  log(`  step ${name}: 完成并打开设置页 → ${await clickButton(page, '完成并打开设置页', name)}`);
  page.close();

  // Same-tab navigation: attach to wherever the guide left the tab, and check
  // the settings page really took over (its tabs are the only place those
  // words appear).
  const settings = await browser.findPage(optionsUrl);
  await waitStep(settings, 'bodyText()', '账号管理', `${name}: settings page mounted`, 20_000);

  // The gate is the durable state, not the badge wording. The label for an idle
  // active binding is a product decision that has already changed once (同步中
  // → 监测中), and a harness wired to the string fails for reasons that are not
  // bugs. What the user is shown is still checked — by the convergence
  // assertions below, which read the browsers themselves.
  await waitStep(settings, BINDING_STATES, 'active', `${name}: binding reached active`, 120_000, 'needs_recovery');
  return { browser, page: settings };
}

/** The binding states this profile's replica store currently holds. */
const BINDING_STATES = `(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('pontis-replica');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const rows = await new Promise((res) => {
    const q = db.transaction('bindings').objectStore('bindings').getAll();
    q.onsuccess = () => res(q.result || []); q.onerror = () => res([]);
  });
  return rows.map((b) => b.state).join(',');
})()`;

// --- the run -----------------------------------------------------------------

/**
 * The replica store as the extension sees it, read from an extension page.
 * A red run has to say whether the local edit was never captured, captured
 * and stuck in the outbox, or undone by a change that came back from the
 * server — the page text alone cannot tell those apart.
 */
const REPLICA_DUMP = `
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('pontis-replica');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const all = (store) => new Promise((res) => {
    const q = db.transaction(store).objectStore(store).getAll();
    q.onsuccess = () => res(q.result || []); q.onerror = () => res([]);
  });
  const [bindings, nodes, ops, remote, diags] = await Promise.all(
    ['bindings', 'localNodes', 'pendingOps', 'remoteChanges', 'diagnostics'].map(all));
  return JSON.stringify({
    bindings: bindings.map((b) => ({ state: b.state, applied: b.appliedRevision, received: b.receivedRevision })),
    nodes: nodes.map((n) => ({ id: n.browserId, title: n.title, canonical: n.canonicalId })),
    ops: ops.map((o) => ({ type: o.type, status: o.status, title: o.title })),
    remote: remote.map((c) => ({ rev: c.revision, type: c.type, node: c.nodeId })).slice(-8),
    diags: diags.slice(-6).map((d) => [d.level, d.scope, d.message].join(' ')),
  });
`;

async function dumpReplica(name, page) {
  try {
    const raw = await page.evaluate(REPLICA_DUMP);
    log(`  --- ${name} replica --- ${raw}`);
  } catch (err) {
    log(`  --- ${name} replica: could not read (${err.message})`);
  }
}

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  log('building the E2E extension artifact…');
  buildExtensionArtifact();
  const extId = extensionId(EXT_DIR);

  log(`starting the server on ${ORIGIN}…`);
  await startServer();
  const { token, spaceId } = await seed();
  log(`space ${spaceId} seeded with 2 bookmarks`);

  log('launching two profiles (real Chromium windows)…');
  const [a, b] = await Promise.all([
    pairProfile('A', { extId, debugPort: 9401 }),
    pairProfile('B', { extId, debugPort: 9402 }),
  ]);

  try {
    // Initial reconciliation must have pushed the server's tree into both bars.
    for (const [name, ref] of [['A', a], ['B', b]]) {
      const titles = JSON.parse(await ref.page.evaluate(treeTitles));
      check(titles.includes('Server One') && titles.includes('Server Two'),
        `${name}: browser holds the server tree after the first sync`, titles.join(','));
    }

    // A local edit on each side: created through chrome.bookmarks, so the
    // extension sees it exactly as it sees a user's click. The expression is a
    // self-contained IIFE: splicing statements after the caller's `return`
    // would make ASI end the function there and the create would never run.
    const createIn = (title) => `(async () => {
      const n = await chrome.bookmarks.create({
        parentId: '1', title: ${JSON.stringify(title)},
        url: ${JSON.stringify(`https://pontis.test/${title}`) },
      });
      return n.id;
    })()`;
    for (const [name, ref, title] of [['A', a, 'From A'], ['B', b, 'From B']]) {
      const createdId = await ref.page.evaluate(`${HELPERS}return ${createIn(title)}`);
      const bar = JSON.parse(await ref.page.evaluate(treeTitles));
      log(`  step ${name}: created ${title} as browser id ${createdId}; bar now ${bar.join(',')}`);
    }

    // The popup, opened through its own url so a script can reach it. The tab is
    // closed as soon as the step is done — a page left behind is a page Chrome
    // can discard, and the next attach would then hang on a dead target.
    const popupUrl = `chrome-extension://${extId}/popup.html`;
    const withPopup = async (name, ref, fn) => {
      const popup = await ref.browser.page(popupUrl, { fresh: true });
      try {
        await waitStep(popup, 'bodyText()', '立即同步', `${name}: popup mounted`, 20_000);
        return await fn(popup);
      } finally {
        popup.close();
        await ref.browser.closePages(popupUrl);
      }
    };

    // One real click on 立即同步 per profile. That is the only place this control
    // is exercised, and it is what a person uses.
    for (const [name, ref] of [['A', a], ['B', b]]) {
      await withPopup(name, ref, (popup) => clickButton(popup, '立即同步', name));
    }

    // Every round after that is asked for over the same message the button
    // sends, from the settings page this run already has open. Reopening the
    // popup for each of the ~90 polling rounds only made a tab reload forever.
    const syncBoth = async () => {
      for (const [name, ref] of [['A', a], ['B', b]]) {
        await ref.page.evaluate(`return await chrome.runtime.sendMessage({ type: 'pontis/manual-sync' });`);
      }
    };

    await syncBoth();
    const want = ['From A', 'From B', 'Server One', 'Server Two'];
    // `pump` runs one more sync round on every profile between reads. Nothing
    // pushes to a device: a change the other side made lands during a round of
    // this one's, so when both profiles push in the same round the first one to
    // ask cannot have seen the second. Waiting without asking again just watches
    // a stale tree until the 5-minute alarm, which is longer than this run waits.
    const settled = async (fn, pump) => {
      for (let i = 0; i < 90; i++) {
        const got = await fn();
        if (want.every((t) => got.includes(t))) return got;
        if (pump) await pump();
        await new Promise((r) => setTimeout(r, 1000));
      }
      return fn();
    };

    const server = await settled(() => serverTree(spaceId, token));
    check(want.every((t) => server.includes(t)), 'server holds both local edits', server.join(','));
    check(server.length === want.length, 'no duplicate nodes appeared', server.join(','));

    // Nothing pushes to a device: a change the other side made lands on this
    // one during a round of its own, so ask for one more before judging.
    await syncBoth();

    for (const [name, ref] of [['A', a], ['B', b]]) {
      const titles = await settled(
        async () => JSON.parse(await ref.page.evaluate(treeTitles)),
        syncBoth,
      );
      check(want.every((t) => titles.includes(t)),
        `${name}: browser shows the other profile's bookmark`, titles.join(','));
      const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
      check(dupes.length === 0, `${name}: no doubled bookmarks`, dupes.join(','));

      // Read the popup, not the settings page: the settings page now hides the
      // binding list behind a tab, so its body text would pass this check while
      // saying nothing. The popup is what a person glances at, and it shows the
      // space's own name — stable data, unlike the status wording.
      const text = await withPopup(name, ref, (popup) =>
        popup.evaluate(`${HELPERS}return bodyText()`));
      check(text.includes('E2E Converge'), `${name}: popup lists the bound space`, text.slice(0, 160));
      check(!/需要恢复|等待确认|目录缺失/.test(text), `${name}: binding needs no human`, text.slice(0, 160));
    }

    // ─── 升级：同目录替换文件后重新加载 ─────────────────────────────
    // The release upgrade path a person walks (distribution doc §10.2): replace
    // the files in the same permanent directory, reload, keep using the same
    // install. Success is not "the page opens again" — it is the device
    // identity, the Binding, the local mapping, the watermark and an edit made
    // while the server was unreachable all still being there afterwards
    // (§14.2). This is the part a unit test cannot stand in for: it is about
    // what survives in a real profile.
    //
    // It reloads by restarting the browser over the same profile directory
    // rather than through an extension-reload call: an unpacked package is
    // re-read at startup either way, and doing it this round also covers §14.1's
    // separate gate — still installed and still connected after a restart.
    // What this does NOT prove is a schema migration, which needs two released
    // versions to move between.
    log('upgrade: snapshotting profile A, then editing with the server down');
    const before = JSON.parse(await a.page.evaluate(REPLICA_DUMP));
    const bootstrapBefore = await a.page.evaluate(
      `return (await chrome.storage.local.get('bootstrap')).bootstrap?.deviceId || 'none';`);
    check(before.bindings.length > 0, 'A: a binding exists to preserve', JSON.stringify(before.bindings));
    check(before.nodes.length > 0, 'A: local mappings exist to preserve', `${before.nodes.length} rows`);
    check(bootstrapBefore !== 'none', 'A: a device identity exists to preserve', bootstrapBefore);

    stopServer();
    const offlineTitle = 'Offline Across Upgrade';
    await a.page.evaluate(`${HELPERS}return ${createIn(offlineTitle)}`);
    // One sync attempt against a dead server, so the edit is in the outbox
    // rather than only in the bookmark bar.
    await a.page.evaluate(`return await chrome.runtime.sendMessage({ type: 'pontis/manual-sync' })
      .catch(() => 'unreachable');`);
    await new Promise((r) => setTimeout(r, 3000));
    const queued = JSON.parse(await a.page.evaluate(REPLICA_DUMP));
    check(queued.ops.some((o) => (o.title || '').includes(offlineTitle)),
      'A: the offline edit is queued before the upgrade', JSON.stringify(queued.ops));

    const extIdBefore = await a.page.evaluate('return chrome.runtime.id');
    a.browser.stop();
    rebuildExtensionAtSamePath();
    a.browser = new Browser('A', 9401, { reuseProfile: true });
    await a.browser.start();

    // The server stays down through the restart. That is the harder case the
    // doc cares about, and it makes the outbox assertions deterministic: with a
    // reachable server the new code drains it before anyone can look, and
    // "the edit is gone" would then read exactly like "the edit was dropped".
    // If the id had changed, this url would not resolve at all; the assertion
    // after it is what says so out loud.
    a.page = await a.browser.page(`chrome-extension://${extIdBefore}/options.html#sync`);
    await waitStep(a.page, 'bodyText()', '账号管理', 'A: settings page after the upgrade', 30_000);
    const extIdAfter = await a.page.evaluate('return chrome.runtime.id');
    check(extIdAfter === extIdBefore, 'A: extension id survived the file replacement',
      `${extIdBefore} → ${extIdAfter}`);

    const after = JSON.parse(await a.page.evaluate(REPLICA_DUMP));
    const bootstrapAfter = await a.page.evaluate(
      `return (await chrome.storage.local.get('bootstrap')).bootstrap?.deviceId || 'none';`);
    check(bootstrapAfter === bootstrapBefore, 'A: same device identity after the upgrade',
      `${bootstrapBefore} → ${bootstrapAfter}`);
    check(after.bindings.length === before.bindings.length
      && after.bindings[0].state === 'active',
      'A: binding survived and is still active', JSON.stringify(after.bindings));
    check(after.nodes.length >= before.nodes.length,
      'A: local node mappings survived', `${before.nodes.length} → ${after.nodes.length}`);
    check(after.bindings[0].applied > 0 && after.bindings[0].applied >= before.bindings[0].applied,
      'A: the applied watermark carried over',
      `${before.bindings[0].applied} → ${after.bindings[0].applied}`);
    check(after.ops.some((o) => (o.title || '').includes(offlineTitle)),
      'A: the offline edit is still queued, not silently dropped', JSON.stringify(after.ops));
    const barHeld = JSON.parse(await a.page.evaluate(treeTitles));
    check(barHeld.includes(offlineTitle),
      `A: the bar still holds the offline edit (bar: ${barHeld.join(', ') || 'empty'})`);

    await startServer();

    // The device list is the server's own witness: an upgrade that quietly
    // re-paired would add a third device.
    const devices = (await api('GET', '/api/v1/devices/overview', { token })).devices
      .map((d) => d.name).sort();
    check(devices.length === 2 && devices.some((d) => d === 'E2E A') && devices.some((d) => d === 'E2E B'),
      'A: the server still knows exactly the two devices', devices.join(','));

    let uploaded = [];
    for (let i = 0; i < 60; i++) {
      uploaded = await serverTree(spaceId, token);
      if (uploaded.includes(offlineTitle)) break;
      await syncBoth();
      await new Promise((r) => setTimeout(r, 1000));
    }
    check(uploaded.includes(offlineTitle),
      'A: the offline edit reached the server after the upgrade', uploaded.join(','));
    const drained = JSON.parse(await a.page.evaluate(REPLICA_DUMP));
    check(!drained.ops.some((o) => (o.title || '').includes(offlineTitle)),
      'A: the outbox emptied', JSON.stringify(drained.ops));
    const barAfter = JSON.parse(await a.page.evaluate(treeTitles));
    check(barAfter.includes(offlineTitle),
      `A: the edit is still in the bar once converged (bar: ${barAfter.join(', ') || 'empty'})`);
    // Nothing about the upgrade should have cost the other device anything.
    const barB = JSON.parse(await b.page.evaluate(treeTitles));
    check(barB.includes(offlineTitle),
      `B: the other profile received the edit too (bar: ${barB.join(', ') || 'empty'})`);
  } finally {
    if (failed) {
      // The page and the replica store are what a human would read next: a red
      // run that only says "did not converge" sends someone to the browser UI.
      for (const [name, ref] of [['A', a], ['B', b]]) {
        await dumpReplica(name, ref.page);
        const text = String(await ref.page.evaluate(`${HELPERS}return bodyText()`));
        const tail = text.split('\n').filter(Boolean).slice(-14).join(' / ');
        log(`  --- ${name} page tail --- ${tail}`);
      }
    }
    if (KEEP) log(`--keep: profiles and data under ${WORK}`);
    a.browser.stop();
    b.browser.stop();
    // The upgrade phase stops and restarts the server, so this one may already
    // be gone; `die()` also skips this block, which is why shutdownAll exists.
    serverProc?.kill();
  }

  if (failed) {
    console.error(`\ne2e: ${failed} check(s) failed`);
    process.exit(1);
  }
  log(`\ne2e: two real profiles converged on ${ORIGIN}`);
}

main().catch((err) => {
  // The profiles are opened before the run's finally block, so a throw there
  // would otherwise leave two real Chromium windows holding 9401/9402 — and the
  // next run would attach to those tabs and fail somewhere far from the cause.
  console.error(`e2e: ${err.stack || err.message}`);
  shutdownAll();
  process.exit(1);
});
