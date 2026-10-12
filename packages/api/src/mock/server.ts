import { setupWorker } from 'msw/browser';
import { mockHandlers } from './handlers';

/**
 * Start the MSW shell in the browser.
 *
 * What this mocks is auth and /meta — enough to open the app and look at its
 * chrome without a backend. It does not mock any data endpoint: the ten JSON
 * files this module used to ship were read by nothing, and a "complete offline
 * mock" that serves fake shapes nobody validates is a second source of truth
 * that drifts from the Go server in silence. The bodies it does serve are run
 * through the same runtime checkers as the real ones (test/mock-contract.test.ts).
 */
export async function startMsw(): Promise<void> {
  const worker = setupWorker(...mockHandlers);
  await worker.start({ onUnhandledRequest: 'bypass' });
}
