/** Format a date as relative time string (e.g. "2 分钟前", "昨天"). */
export function formatRelativeTime(dateStr: string, locale: string = 'zh-CN'): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

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

/** Extract hostname from a URL string. */
export function extractHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
