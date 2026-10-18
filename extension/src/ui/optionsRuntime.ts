// One runtime for the whole options page.
//
// It used to be a module-level const inside App.tsx, which meant nothing else
// could read the same Dexie handle / ApiClient / PairingService without going
// through the component. Sharing it is what lets the sync tab's state and
// actions live in a hook instead of being threaded through props.

import { createRuntime, wakeWorker } from './runtime';
import { chromeApi } from '../runtime/chromeApi';

/**
 * Built once for the page: a Dexie handle, an ApiClient and a PairingService per
 * render would be rebuilt on every tab switch. A binding written here is
 * activated by the worker, so ask it for a round instead of waiting on an alarm.
 */
export const runtime = createRuntime(() => wakeWorker(chromeApi()));
