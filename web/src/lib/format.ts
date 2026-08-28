/** Display helpers shared across screens. */

export function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function duration(startIso: string | null, endIso: string | null): string {
  if (!startIso) return '—';
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const s = Math.max(0, Math.floor((end - new Date(startIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function cost(usd: string | number | null): string {
  if (usd === null || usd === undefined) return '—';
  const n = Number(usd);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
