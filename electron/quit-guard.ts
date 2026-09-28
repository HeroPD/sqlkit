import type { MessageBoxOptions } from 'electron'
import { connectionLabel } from '../src/connection-label'
import type { ConnectionProfile, ConnectionStatus } from '../src/electron'
import { t } from '../src/i18n'

// Closing a window disconnects its connections and quitting disconnects them
// all, and a disconnect rolls back whatever manual transaction was left open.

export type GuardIntent = 'close' | 'quit'

/** One window's live connections, and the saved profiles that name them. */
export type WindowConnections = { statuses: readonly ConnectionStatus[]; profiles: readonly ConnectionProfile[] }

/** The button index that confirms the rollback; Cancel is 0, the default. */
export const ROLLBACK_CONFIRMED = 1

export const hasOpenTransaction = (statuses: readonly ConnectionStatus[]) =>
  statuses.some((status) => status.phase === 'connected' && status.transaction)

/** Names each connection whose open transaction these windows would roll back, as profile › database. */
export function openTransactionTargets(windows: readonly WindowConnections[]): string[] {
  const targets = windows.flatMap(({ statuses, profiles }) => statuses.flatMap((status) => {
    if (status.phase !== 'connected' || !status.transaction) return []
    const profile = profiles.find((entry) => entry.id === status.profileId)
    const name = profile ? connectionLabel(profile) : t('config.untitled')
    return [status.transaction.childDb ? `${name} › ${status.transaction.childDb}` : name]
  }))
  return [...new Set(targets)]
}

/** The dialog to show before closing or quitting, or null when nothing would be rolled back. */
export function rollbackPrompt(intent: GuardIntent, targets: readonly string[]): MessageBoxOptions | null {
  if (!targets.length) return null
  return {
    type: 'warning',
    message: intent === 'close' ? t('app.closeWindowPrompt') : t('app.quitPrompt', { name: t('app.name') }),
    detail: targets.map((target) => t('workbench.leaveTransaction', { target })).join('\n'),
    buttons: [t('common.cancel'), t(intent === 'close' ? 'app.rollBackAndClose' : 'app.rollBackAndQuit')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
}
