import type { TableKind } from './electron'
import { t, type MessageKey } from './i18n'

/** Explorer/inspect icon per relation kind (bundled icon classes). */
export const TABLE_KIND_ICONS: Record<TableKind, string> = {
  table: 'icon-table',
  view: 'icon-eye',
  matview: 'icon-layers',
  foreign: 'icon-link',
}

const TABLE_KIND_MESSAGE_KEYS: Record<TableKind, MessageKey> = {
  table: 'tableKind.table',
  view: 'tableKind.view',
  matview: 'tableKind.materializedView',
  foreign: 'tableKind.foreignTable',
}

export const tableKindLabel = (kind: TableKind) => t(TABLE_KIND_MESSAGE_KEYS[kind])
