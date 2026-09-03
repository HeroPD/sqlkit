import type { HistoryItem, HistoryLimits } from './electron'

export type { HistoryLimits }

// What the query history keeps, shared with the main process: the renderer holds
// the list and main holds the file, and a retention rule the two disagreed about
// would either resurrect entries the view dropped or hide ones it still shows.

// Collapses repeats of the same SQL in the same context to their newest run.
// Re-running one query twenty times says nothing the newest entry doesn't, and it
// pushes everything else out of view. Keyed per context, since the same SQL
// against another database is a different thing to re-run. Input is newest-first,
// so the first occurrence seen is the one to keep.
export const dedupeHistory = (items: HistoryItem[]): HistoryItem[] => {
  const seen = new Set<string>()
  return items.filter((item) => {
    // Trimmed, so an edit that only added trailing whitespace isn't a new entry;
    // the stored SQL itself is left exactly as it ran.
    const key = `${item.contextKey}\u0000${item.sql.trim()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Caps each context's entries to `max`, keeping the newest. Input is newest-first.
export const capHistoryPerContext = (items: HistoryItem[], max: number): HistoryItem[] => {
  const seen = new Map<string, number>()
  return items.filter((item) => {
    const count = (seen.get(item.contextKey) ?? 0) + 1
    seen.set(item.contextKey, count)
    return count <= max
  })
}

/** Everything the workspace's retention rules keep, newest first. */
export const limitHistory = (items: HistoryItem[], limits: HistoryLimits): HistoryItem[] => {
  const cutoff = limits.historyRetentionDays === 0
    ? null
    : Date.now() - limits.historyRetentionDays * 24 * 60 * 60 * 1000
  const retained = cutoff === null ? items : items.filter((item) => {
    const created = Date.parse(item.createdAt)
    // An unreadable date is kept: hand-edited history is still the user's.
    return !Number.isFinite(created) || created >= cutoff
  })
  return capHistoryPerContext(dedupeHistory(retained), limits.maxHistoryPerContext)
}
