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
  /** The user switched this binding off. */
  disabled: boolean;
}

/**
 * What a binding is doing, in the words the user would use. An idle active
 * binding is not "同步中" — it is watching the browser, and saying otherwise
 * makes a quiet connection look like one that never finishes. It earns 同步中
 * only while remote revisions are still unapplied.
 */
export function bindingStatus(binding: BindingRecord): BindingStatus {
  const pending = Math.max(0, binding.receivedRevision - binding.appliedRevision);
  if (binding.enabled === false) {
    return { label: '已暂停', color: 'coolGray', pending, disabled: true };
  }
  const s = STATE[binding.state] ?? { label: binding.state, color: 'coolGray' };
  const label = binding.state === 'active' && pending === 0 ? '监测中' : s.label;
  return { ...s, label, pending, disabled: false };
}

export function relTime(ts: number | null | undefined): string {
  if (!ts) return '从未同步';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5) return '刚刚';
  if (secs < 60) return `${secs} 秒前`;
  if (secs < 3600) return `${Math.round(secs / 60)} 分钟前`;
  if (secs < 86400) return `${Math.round(secs / 3600)} 小时前`;
  const days = Math.round(secs / 86400);
  if (days < 30) return `${days} 天前`;
  // Past a month the relative number stops telling anything, so show a date —
  // a zh-CN one, because "10/11/2026" is two different days depending on who
  // reads it, and a clock time alone would read as today for a stale sync.
  return new Date(ts).toLocaleDateString('zh-CN');
}

/**
 * What a person should be shown first. A binding that cannot continue on its
 * own is the reason the popup was opened; one that is merely catching up is
 * not, and a switched-off binding is quiet on purpose.
 */
export function attentionRank(binding: BindingRecord): number {
  if (binding.enabled === false) return 4;
  switch (binding.state) {
    case 'needs_recovery':
    case 'mount_missing':
    case 'waiting_user':
      return 0;
    case 'pending_initial':
    case 'initializing':
    case 'resyncing':
      return 1;
    default:
      break;
  }
  return binding.receivedRevision > binding.appliedRevision ? 2 : 3;
}

/**
 * Both surfaces list bindings in the same order, so a row sits in the same
 * place on either screen. Ties fall back to the order the bindings were made:
 * predictable, and independent of how the platform collates a space name —
 * `localeCompare('zh-CN')` sorts by pinyin where available and by code point
 * where it is not, which would reshuffle the list between machines.
 */
export function sortBindings<T extends BindingRecord>(bindings: T[]): T[] {
  return [...bindings].sort(
    (a, b) => attentionRank(a) - attentionRank(b) || a.createdAt - b.createdAt,
  );
}

/**
 * The recovery note a person can act on. The code is for the log and the
 * options page: `MOUNT_MISSING` in a popup tells you nothing the badge did not
 * already say, and repeating it twice reads like two separate faults.
 */
export function recoveryNote(binding: BindingRecord): string {
  return binding.recovery?.message || binding.recovery?.code || '';
}
