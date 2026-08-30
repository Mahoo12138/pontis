/** Format a date as relative time string (e.g. "2 分钟前", "昨天", "3 小时后"). */
export function formatRelativeTime(dateStr: string, locale: string = 'zh-CN'): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diff = now - date.getTime();
  const future = diff < 0;
  const seconds = Math.floor(Math.abs(diff) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (future) {
    // Schedules carry next_run_at; "13 小时后" beats a stale "刚刚".
    if (seconds < 60) return locale === 'zh-CN' ? '即将执行' : 'any moment';
    if (minutes < 60) return locale === 'zh-CN' ? `${minutes} 分钟后` : `in ${minutes}m`;
    if (hours < 24) return locale === 'zh-CN' ? `${hours} 小时后` : `in ${hours}h`;
    return date.toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en', {
      month: 'short',
      day: 'numeric',
    });
  }

  if (seconds < 60) return locale === 'zh-CN' ? '刚刚' : 'just now';
  if (minutes < 60) return locale === 'zh-CN' ? `${minutes} 分钟前` : `${minutes}m ago`;
  if (hours < 24) return locale === 'zh-CN' ? `${hours} 小时前` : `${hours}h ago`;
  if (days < 7) return locale === 'zh-CN' ? `${days} 天前` : `${days}d ago`;

  return date.toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en', {
    month: 'short',
    day: 'numeric',
  });
}

/** Format a date as short time (e.g. "14:25"). */
export function formatShortTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Label a date as 今天 / 昨天 / M月D日 for day-grouped lists. */
export function formatDayLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

/** Extract hostname from a URL string. */
export function extractHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
