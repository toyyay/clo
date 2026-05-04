// Tiny helpers shared between sidebar / topbar / chat-view.

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Mirror legacy "2d" / "3h" / "Apr 27" rendering used in the old sidebar.
 * < 60s   → "now"
 * < 60m   → "Nm"
 * < 24h   → "Nh"
 * < 7d    → "Nd"
 * else    → "Mon DD" (or "Mon DD YY" if not current year)
 */
export function formatRelative(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const delta = now - t;
  if (delta < 0) return "now";
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d`;
  const d = new Date(t);
  const sameYear = new Date(now).getUTCFullYear() === d.getUTCFullYear();
  const month = SHORT_MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  return sameYear ? `${month} ${day}` : `${month} ${day} ${String(d.getUTCFullYear()).slice(-2)}`;
}

export function formatBytes(b: number): string {
  if (!b) return "0";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
