import type { SessionContext, SessionTab } from './electron'

// The session may only describe what can actually be restored. A tab whose text
// reached no backup is dropped when nothing else holds it — an untitled tab is
// its buffer and nothing more — and kept, minus its dirty marker, when a file
// behind it can still be reopened.
export const recoverableContexts = (contexts: SessionContext[], unbacked: Set<string>): SessionContext[] => {
  if (!unbacked.size) return contexts
  const keep = (tab: SessionTab) => !(tab.kind === 'sql' && tab.path === null && unbacked.has(tab.id))
  const undirty = (tab: SessionTab): SessionTab => {
    if (tab.kind !== 'sql' || !unbacked.has(tab.id) || !tab.dirty) return tab
    const { dirty: _dirty, ...clean } = tab
    return clean
  }
  return contexts
    .map((context) => {
      const tabs = context.tabs.filter(keep).map(undirty)
      return {
        ...context,
        tabs,
        activeTabId: tabs.some((tab) => tab.id === context.activeTabId) ? context.activeTabId : (tabs.at(-1)?.id ?? null),
      }
    })
    .filter((context) => context.tabs.length)
}
