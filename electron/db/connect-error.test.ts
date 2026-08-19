import { describe, expect, it, vi } from 'vitest'
import { testConnection } from './manager'
import { profileFromUrl } from './test-db'

// The manager transitively imports electron (transport → sshTunnel → knownHosts).
// No SSH here, so app.getPath is never called.
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

// Guards the regression where a refused connection surfaced as error: "". Node's
// dual-stack connect rejects with an AggregateError whose own message is empty,
// and pg/mysql2 propagate it verbatim. Needs no database — the point is that
// nothing is listening. Deliberately loose about the errno: a host with IPv6
// disabled, or a firewall answering EPERM instead of ECONNREFUSED, is still a
// pass so long as the failure is described rather than blanked out.
const DEAD_PORT = '59321'

describe('connect failure reporting', () => {
  it.each([
    ['postgresql' as const, 'postgres'],
    ['mysql' as const, 'mysql'],
  ])('%s names the address it could not reach', async (engine, scheme) => {
    const profile = profileFromUrl(`${scheme}://u:p@localhost:${DEAD_PORT}/none`, { engine })
    const result = await testConnection(profile)

    expect(result.success).toBe(false)
    const error = result.success ? '' : result.error
    expect(error).not.toBe('')
    expect(error).toContain(DEAD_PORT)
  })
})
