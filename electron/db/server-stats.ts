// Shared formatting for the server panel's headline stats, so every engine
// renders uptime the same way — the engines report it in different shapes
// (Postgres an interval, MySQL/SQL Server a second count).

/** Coarse, sidebar-width uptime: the two largest useful units, never more. */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes) return `${minutes}m`
  return `${total}s`
}
