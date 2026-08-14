/**
 * A byte count read from an engine's catalog, normalised.
 *
 * Catalogs answer with a string (bigint columns), a number, or NULL — the last
 * one for a relation dropped between the listing and the size call, and for
 * columns an engine simply does not populate. Number(null) is 0, so converting
 * blind would report a live table as empty rather than as unmeasured; anything
 * unusable is reported as unknown, and the caller drops the row.
 */
export function byteCount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const bytes = Number(value)
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null
}

/**
 * An inspection row carrying the size its engine reported for that object.
 *
 * `approximate` marks catalogs that sample rather than measure — MySQL's
 * InnoDB stats are recalculated on ANALYZE, where Postgres and SQL Server both
 * answer with allocated pages. An unusable size drops both fields, so the UI
 * shows no badge at all rather than a wrong or zero one.
 */
export function sizedRow<T extends { name: string; definition: string }>(
  row: T,
  value: string | number | null | undefined,
  approximate = false,
): T & { sizeBytes?: number; approximateSize?: boolean } {
  const sizeBytes = byteCount(value)
  if (sizeBytes === null) return row
  return { ...row, sizeBytes, ...(approximate ? { approximateSize: true } : {}) }
}
