// Labels for the two diagnostic columns that stay English in storage.
//
// `scope` is an id the worker writes and the tests filter on, and `level` is a
// union the badge color depends on; only the display turns them into words. An
// id this table has never seen renders as itself, so a new scope can never
// show up as a blank cell.

const SCOPES: Record<string, string> = {
  applier: '远端改动应用',
  background: '后台',
  coordinator: '同步调度',
  'event-processor': '事件处理',
  'initial-reconcile': '初始对账',
  integrity: '完整性',
  pairing: '配对',
  'reconcile-steps': '对账步骤',
  resync: '重新同步',
  'start-page': '起始页',
  verify: '副本校验',
};

const LEVELS: Record<string, string> = {
  info: '信息',
  warn: '警告',
  error: '错误',
};

export const scopeLabel = (scope: string): string => SCOPES[scope] ?? scope;

export const levelLabel = (level: string): string => LEVELS[level] ?? level;
