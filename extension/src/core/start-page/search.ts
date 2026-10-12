// The adapter between "the reader pressed Enter in 网页 mode" and whatever this
// browser can actually do about it (start-page doc §7.2).
//
// chrome.* calls stay out of the components: the page asks an adapter, and the
// adapter is where a browser that has no default-search surface says so. That
// refusal is the point — the page must not quietly substitute some engine the
// reader never chose.

import type { ChromeSearchApi } from '../../runtime/chromeApi';

export interface SearchAdapter {
  /** Whether web search can be done at all in this browser. */
  readonly canSearchWeb: boolean;
  /** Why it cannot, in the page's own words. Empty when it can. */
  readonly unavailableReason: string;
  /** Hand the query to the browser's default provider, in this tab. */
  searchWeb(query: string): Promise<void>;
}

/**
 * The chrome.search-backed adapter.
 *
 * `search` is passed as a maybe: a browser without the API, or a build whose
 * permission was refused, gets the same object with `canSearchWeb` false. The
 * caller then shows that state instead of failing on a missing property.
 */
export function createSearchAdapter(search: ChromeSearchApi | undefined): SearchAdapter {
  if (!search?.query) {
    return {
      canSearchWeb: false,
      unavailableReason: '这个浏览器没有提供默认搜索能力，也没有可用的搜索引擎被选定。',
      searchWeb: async () => {
        throw new Error('search: no default search capability in this browser');
      },
    };
  }
  const api = search;
  return {
    canSearchWeb: true,
    unavailableReason: '',
    async searchWeb(query: string) {
      const text = query.trim();
      // An empty box is not a search, and chrome.search would say so by
      // rejecting; refusing here keeps the page from showing that as a fault.
      if (!text) return;
      // No `tab` option: CURRENT is the default, and this runs in the page that
      // received the keystroke, so the result replaces this page — which is
      // what a submitted search means here, and what a background worker
      // round-trip would get wrong (§7.2).
      await api.query({ text });
    },
  };
}

/** The preset list is deliberately empty for V1: with no browser default
 * available the page asks the reader to choose, and the list to choose from is
 * still an open product decision (§7.2, §23). */
export const PRESET_ENGINES: readonly { id: string; label: string }[] = [];
