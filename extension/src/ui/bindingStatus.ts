// One status vocabulary for both extension surfaces. The design system defines
// exactly four sync semantics (healthy / warning / recovery / error) plus the
// interaction blue, so a state reads the same in the popup, on the options page
// and in the web app instead of being re-coloured per screen.

import type { BindingRecord, BindingState } from '../core/store/db';

const STATE: Record<BindingState, { label: string; color: string }> = {
  active: { label: '同步中', color: 'healthyGreen' },
  pending_initial: { label: '待初始化', color: 'accentBlue' },
  initializing: { label: '初始化中', color: 'accentBlue' },
  resyncing: { label: '重新同步中', color: 'accentBlue' },
  waiting_user: { label: '等待确认', color: 'warningAmber' },
  mount_missing: { label: '目录缺失', color: 'recoveryOrange' },
  needs_recovery: { label: '需要恢复', color: 'recoveryOrange' },
  paused: { label: '已暂停', color: 'coolGray' },
};

export interface BindingStatus {
  label: string;
  /** Named color from the Pontis palette. */
  color: string;
  /** Revisions received but not yet applied to the browser. */
  pending: number;
}

/**
 * The watermarks are journal revisions, not a count of bookmarks: deleting one
 * bookmark advances the revision exactly like adding one does. Two bare numbers
 * separated by a slash read as "1402 of 1402 things", so the surfaces phrase the
 * same pair as the position this device has reached, and only mention the gap
 * when there is one.
 */
export function syncProgress(binding: BindingRecord): string {
  if (binding.appliedRevision === 0 && binding.receivedRevision === 0) return '还没有同步过';
  if (binding.appliedRevision < binding.receivedRevision) {
    return `已同步到修订 ${binding.appliedRevision}，还有 ${binding.receivedRevision - binding.appliedRevision} 项待应用`;
  }
  return `已同步到修订 ${binding.appliedRevision}`;
}

export function bindingStatus(binding: BindingRecord): BindingStatus {
  const s = STATE[binding.state] ?? { label: binding.state, color: 'coolGray' };
  const pending = Math.max(0, binding.receivedRevision - binding.appliedRevision);
  return { ...s, pending };
}

export function relTime(ts: number | null | undefined): string {
  if (!ts) return '从未同步';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5) return '刚刚';
  if (secs < 60) return `${secs} 秒前`;
  if (secs < 3600) return `${Math.round(secs / 60)} 分钟前`;
  if (secs < 86400) return `${Math.round(secs / 3600)} 小时前`;
  // A clock time alone would read as "today" for a sync from last month.
  return new Date(ts).toLocaleDateString();
}
