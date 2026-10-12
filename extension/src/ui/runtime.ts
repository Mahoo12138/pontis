// The objects every extension surface needs, built once per page rather than
// once per render: the options page used to construct a Dexie handle, an
// ApiClient and a PairingService in its component body, which a tabbed page
// would redo on every tab switch.

import { createChromiumAdapter } from '../core/browser/chromium';
import type { BrowserAdapter } from '../core/browser/types';
import { PairingService } from '../core/pairing/pairing';
import { BootstrapStore } from '../core/store/bootstrap';
import { PontisDB } from '../core/store/db';
import { ApiClient } from '../core/transport/client';
import { chromeApi, kvArea } from '../runtime/chromeApi';
import type { ChromeGlobal } from '../runtime/chromeApi';

export interface Runtime {
  chrome: ChromeGlobal;
  db: PontisDB;
  bootstrap: BootstrapStore;
  client: ApiClient;
  adapter: BrowserAdapter;
  pairing: PairingService;
}

export function createRuntime(onBindingCreated?: () => Promise<void>): Runtime {
  const chrome = chromeApi();
  const db = new PontisDB();
  const bootstrap = new BootstrapStore(kvArea(chrome.storage.local));
  const client = new ApiClient(async () => {
    const b = await bootstrap.get();
    return { serverUrl: b.serverUrl ?? '', token: b.deviceToken };
  });
  const adapter = createChromiumAdapter(chrome.bookmarks);
  const pairing = new PairingService(client, bootstrap, db, onBindingCreated ?? (async () => undefined));
  return { chrome, db, bootstrap, client, adapter, pairing };
}

/** An ApiError carries a stable code; showing only its message loses the part
 *  a person would quote back to whoever runs the server. */
export function errText(err: unknown): string {
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message;
  return code ? `${code}: ${message ?? ''}` : String(err);
}

/** Ask the worker for a round now instead of leaving the surface showing a
 *  state the next alarm would have moved on its own. */
export async function wakeWorker(chrome: ChromeGlobal): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'pontis/manual-sync' });
}
