const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

export function formatDateTime(iso: string | null): string {
  return iso === null ? '—' : dateTime.format(new Date(iso));
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** From start to end, or to `now` while still running. */
export function elapsedMs(
  startedAt: string | null,
  endedAt: string | null,
  now: number,
): number | null {
  if (startedAt === null) return null;
  const end = endedAt === null ? now : new Date(endedAt).getTime();
  return Math.max(0, end - new Date(startedAt).getTime());
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
