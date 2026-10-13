// The log table shows labels, not the ids the worker writes; an id the map has
// never seen must still come through rather than render blank.

import { describe, expect, it } from 'vitest';
import { levelLabel, scopeLabel } from './diagnosticLabels';

describe('scopeLabel', () => {
  it('names the scopes the worker writes', () => {
    expect(scopeLabel('coordinator')).toBe('同步调度');
    expect(scopeLabel('initial-reconcile')).toBe('初始对账');
    expect(scopeLabel('start-page')).toBe('起始页');
  });

  it('shows an unknown scope as itself', () => {
    expect(scopeLabel('not-seen-yet')).toBe('not-seen-yet');
  });
});

describe('levelLabel', () => {
  it('turns the three levels into words', () => {
    expect([levelLabel('info'), levelLabel('warn'), levelLabel('error')]).toEqual(['信息', '警告', '错误']);
  });
});
