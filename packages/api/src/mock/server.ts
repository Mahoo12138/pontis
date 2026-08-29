import { setupWorker } from 'msw/browser';
import { gapHandlers, allHandlers, authHandlers } from './handlers';

/**
 * Start MSW in the browser.
 * @param mode 'partial' = mock auth + gap endpoints only (proxy real to Go),
 *             'all' = mock everything (offline/storybook)
 */
export async function startMsw(mode: 'partial' | 'all' = 'partial') {
  const handlers = mode === 'all' ? allHandlers : [...authHandlers, ...gapHandlers];
  const worker = setupWorker(...handlers);
  await worker.start({ onUnhandledRequest: 'bypass' });
}
