// Vitest setup: in-memory IndexedDB for Dexie.
import 'fake-indexeddb/auto';

// jsdom ships no matchMedia, and Mantine's color-scheme provider calls it while
// mounting. Only the `.tsx` tests reach a DOM, so this stays inert for the node
// suite.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
