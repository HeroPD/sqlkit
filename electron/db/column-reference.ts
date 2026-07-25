import type { ColumnReference } from '../../src/electron'

// Builds the optional `references` half of a ColumnRef from four catalog values
// that may each be null. Kept in its own module so the SQLite worker can import
// it without pulling in the rest of the driver graph (like ./limits).
//
// A missing table/column/constraint means the target could not be resolved — a
// dropped or invisible referenced relation — so the column keeps `foreignKey`
// but gains no navigable target. `schema` is legitimately null on the engines
// with a flat namespace (MySQL, SQLite), so it never disqualifies a reference.
export function columnReference(
  schema: string | null | undefined,
  table: string | null | undefined,
  column: string | null | undefined,
  constraint: string | null | undefined,
): { references?: ColumnReference } {
  if (!table || !column || !constraint) return {}
  return { references: { schema: schema ?? null, table, column, constraint } }
}
