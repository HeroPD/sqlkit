import type { TableKind } from './electron'
import { t, type MessageKey } from './i18n'

/** Explorer/inspect icon per relation kind (bundled codicon classes). */
export const TABLE_KIND_ICONS: Record<TableKind, string> = {
  table: 'codicon-table',
  view: 'codicon-eye',
  matview: 'codicon-layers',
  foreign: 'codicon-link',
}

const TABLE_KIND_MESSAGE_KEYS: Record<TableKind, MessageKey> = {
  table: 'tableKind.table',
  view: 'tableKind.view',
  matview: 'tableKind.materializedView',
  foreign: 'tableKind.foreignTable',
}

export const tableKindLabel = (kind: TableKind) => t(TABLE_KIND_MESSAGE_KEYS[kind])
