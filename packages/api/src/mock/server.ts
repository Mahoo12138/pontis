import { setupWorker } from 'msw/browser';
import { gapHandlers, allHandlers } from './handlers';

/**
 * Start MSW in the browser.
 * @param mode 'partial' = mock remaining gap endpoints only (proxy real
 *             requests to the Go server),
 *             'all' = mock everything (offline/storybook)
 */
export async function startMsw(mode: 'partial' | 'all' = 'partial') {
  const handlers = mode === 'all' ? allHandlers : gapHandlers;
  const worker = setupWorker(...handlers);
  await worker.start({ onUnhandledRequest: 'bypass' });
}
