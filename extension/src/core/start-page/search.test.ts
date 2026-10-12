// The adapter is where a browser that cannot do a default search says so. A
// page that silently substituted an engine would be choosing a commercial
// provider on the reader's behalf (start-page doc §7.2).

import { describe, expect, it, vi } from 'vitest';
import { createSearchAdapter } from './search';

describe('createSearchAdapter', () => {
  it('says so when the browser has no default search surface', async () => {
    const adapter = createSearchAdapter(undefined);
    expect(adapter.canSearchWeb).toBe(false);
    expect(adapter.unavailableReason).not.toBe('');
    await expect(adapter.searchWeb('go 文档')).rejects.toThrow(/no default search/);
  });

  it('hands the text to the browser without naming a tab', async () => {
    const query = vi.fn(async () => undefined);
    const adapter = createSearchAdapter({ query });
    expect(adapter.canSearchWeb).toBe(true);
    await adapter.searchWeb('  go 文档  ');
    // One argument, no `tab`: CURRENT is the default, and this runs in the tab
    // that received the keystroke, so the result cannot land in some other tab
    // that took focus meanwhile (§7.2).
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([{ text: 'go 文档' }]);
  });

  it('does not submit an empty box', async () => {
    const query = vi.fn(async () => undefined);
    const adapter = createSearchAdapter({ query });
    await adapter.searchWeb('   ');
    expect(query).not.toHaveBeenCalled();
  });

  it('lets a failed submission reach the page', async () => {
    // The reader retries; nothing is resent from the background (§7.4).
    const adapter = createSearchAdapter({
      query: async () => {
        throw new Error('provider unavailable');
      },
    });
    await expect(adapter.searchWeb('go')).rejects.toThrow('provider unavailable');
  });
});
