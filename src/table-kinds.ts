import type { TableKind } from './electron'

/** Explorer/inspect icon per relation kind (bundled codicon classes). */
export const TABLE_KIND_ICONS: Record<TableKind, string> = {
  table: 'codicon-table',
  view: 'codicon-eye',
  matview: 'codicon-layers',
  foreign: 'codicon-link',
}

export const TABLE_KIND_LABELS: Record<TableKind, string> = {
  table: 'table',
  view: 'view',
  matview: 'materialized view',
  foreign: 'foreign table',
}
