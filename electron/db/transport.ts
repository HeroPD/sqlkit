import type { ConnectionProfile, TestSshResult } from '../../src/electron'
import { dialog } from 'electron'
import { openSshTunnel } from './sshTunnel'

// A tunnel exposes a local TCP port that forwards to the real database host.
// Future transports (SOCKS/HTTP proxies) share this shape, so a driver just
// dials 127.0.0.1:localPort and never learns the connection is tunneled.
export type Tunnel = {
  readonly localPort: number
  close(): Promise<void>
}

// Everything a driver needs to dial the server: a directly-reachable
// host/port (rewritten to the tunnel's local port when one is open) and the
// tunnel handle so its lifetime can be bound to the session.
export type Endpoint = {
  host: string
  port: number
  tunnel: Tunnel | null
}

const DEFAULT_PORT = { postgresql: 5432, mysql: 3306, sqlserver: 1433, sqlite: 0 } as const

const remoteTarget = (profile: ConnectionProfile) => ({
  host: profile.host.trim() || 'localhost',
  port: Number(profile.port) || DEFAULT_PORT[profile.engine],
})

const usesTunnel = (profile: ConnectionProfile) => profile.engine !== 'sqlite' && profile.ssh?.enabled === true

// Async so the prompt never blocks the main process; openSshTunnel asks before
// any handshake is in flight, so the user can take their time verifying.
const approveFirstUse = async (hostId: string, fingerprint: string) => (await dialog.showMessageBox({
  type: 'warning',
  title: 'Verify SSH host key',
  message: `Trust this SSH host key for ${hostId}?`,
  detail: `Fingerprint: ${fingerprint}\n\nVerify this fingerprint with the server administrator. Trusting an unverified key can expose the database connection to interception.`,
  buttons: ['Cancel', 'Trust Host Key'],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
})).response === 1

// Resolve the transport for a connection: open an SSH tunnel if the profile
// asks for one, then report the host/port a driver should actually dial. The
// returned tunnel (if any) is owned by the caller — the connection manager —
// so it can be torn down with the session.
export async function resolveEndpoint(
  profile: ConnectionProfile,
  onTunnelError: (message: string) => void,
): Promise<Endpoint> {
  const { host, port } = remoteTarget(profile)

  if (usesTunnel(profile)) {
    let tunnel: Tunnel
    try {
      tunnel = await openSshTunnel(profile.ssh!, host, port, onTunnelError, approveFirstUse)
    } catch (error) {
      throw new Error(`SSH tunnel failed: ${(error as Error).message}`, { cause: error })
    }
    return { host: '127.0.0.1', port: tunnel.localPort, tunnel }
  }

  return { host, port, tunnel: null }
}

// Stateless probe for the form's "Test SSH" button: open the tunnel, then
// immediately tear it down.
export async function testSshTunnel(profile: ConnectionProfile): Promise<TestSshResult> {
  if (!usesTunnel(profile)) return { success: false, error: 'SSH is not enabled', tookMs: 0 }

  const { host, port } = remoteTarget(profile)
  const started = performance.now()
  const tookMs = () => Math.round(performance.now() - started)
  let tunnel: Tunnel | null = null
  try {
    tunnel = await openSshTunnel(profile.ssh!, host, port, () => {}, approveFirstUse)
    return { success: true, tookMs: tookMs() }
  } catch (error) {
    return { success: false, error: (error as Error).message, tookMs: tookMs() }
  } finally {
    await tunnel?.close().catch(() => {})
  }
}
