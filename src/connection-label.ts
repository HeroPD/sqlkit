import type { ConnectionProfile } from './electron'
import { t } from './i18n'

// What to call a connection with no name: where it points, before a placeholder.
export const connectionLabel = (profile: ConnectionProfile) =>
  profile.name.trim() || (profile.engine === 'sqlite' ? profile.file.split(/[\\/]/).pop() : profile.host.trim()) || t('config.untitled')
