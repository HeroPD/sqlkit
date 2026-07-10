import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Server, utils } from 'ssh2'
import type { SshConfig } from '../../src/electron'
import { openSshTunnel } from './sshTunnel'

// makeHostVerifier (via knownHosts) reads app.getPath('userData') for the
// known_hosts store; point it at a temp dir so pinning is isolated per test.
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))

// An in-process SSH server that accepts any auth and echoes every forwarded
// channel — enough to exercise the tunnel's connect, port-forward and teardown
// without a real bastion.
let server: Server
let sshPort = 0

beforeAll(async () => {
  const hostKey = utils.generateKeyPairSync('ed25519').private
  server = new Server({ hostKeys: [hostKey] }, (client) => {
    // The client aborts the handshake on a host-key mismatch; swallow the
    // resulting server-side error so it isn't an uncaught exception.
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => ctx.accept())
    client.on('tcpip', (accept) => {
      const channel = accept()
      channel.pipe(channel)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address && typeof address !== 'string') sshPort = address.port
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlkit-kh-'))
})

afterEach(() => {
  fs.rmSync(state.userData, { recursive: true, force: true })
})

const sshConfig = (overrides: Partial<SshConfig> = {}): SshConfig => ({
  enabled: true,
  host: '127.0.0.1',
  port: String(sshPort),
  username: 'u',
  authType: 'password',
  password: 'x',
  keyPath: '',
  passphrase: '',
  ...overrides,
})

// Sends a payload through the tunnel's local port and resolves with the echo.
const echo = (port: number, payload: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload))
    socket.on('data', (data) => {
      resolve(data.toString())
      socket.end()
    })
    socket.on('error', reject)
  })

describe('openSshTunnel: forwarding', () => {
  it('opens a tunnel and forwards bytes to the remote', async () => {
    const tunnel = await openSshTunnel(sshConfig(), 'example.invalid', 5432, () => undefined, () => true)
    try {
      expect(tunnel.localPort).toBeGreaterThan(0)
      expect(await echo(tunnel.localPort, 'ping')).toBe('ping')
    } finally {
      await tunnel.close()
    }
  }, 15000)

  it('stops accepting connections on the local port after close', async () => {
    const tunnel = await openSshTunnel(sshConfig(), 'example.invalid', 5432, () => undefined, () => true)
    await tunnel.close()
    const refused = await new Promise<boolean>((resolve) => {
      const socket = net.connect(tunnel.localPort, '127.0.0.1')
      socket.on('connect', () => {
        socket.destroy()
        resolve(false)
      })
      socket.on('error', () => resolve(true))
    })
    expect(refused).toBe(true)
  }, 15000)
})

describe('openSshTunnel: host-key pinning', () => {
  it('rejects an unknown host when the fingerprint is not approved', async () => {
    await expect(openSshTunnel(sshConfig(), 'example.invalid', 5432, () => undefined, () => false)).rejects.toThrow(
      /Unknown SSH host key/,
    )
  }, 15000)

  it('rejects with an actionable error when the pinned host key changed', async () => {
    const store = { [`127.0.0.1:${sshPort}`]: Buffer.from('a-different-host-key').toString('base64') }
    fs.writeFileSync(path.join(state.userData, 'known_hosts.json'), JSON.stringify(store))

    await expect(openSshTunnel(sshConfig(), 'example.invalid', 5432, () => undefined)).rejects.toThrow(
      /Host key verification failed/,
    )
  }, 15000)
})

describe('openSshTunnel: config validation', () => {
  it('rejects when the SSH host is missing', async () => {
    await expect(openSshTunnel(sshConfig({ host: '  ' }), 'h', 5432, () => undefined)).rejects.toThrow('SSH host is required')
  })

  it('rejects when the SSH username is missing', async () => {
    await expect(openSshTunnel(sshConfig({ username: '' }), 'h', 5432, () => undefined)).rejects.toThrow(
      'SSH username is required',
    )
  })

  it('rejects when password auth has no password', async () => {
    await expect(openSshTunnel(sshConfig({ password: '' }), 'h', 5432, () => undefined)).rejects.toThrow(
      'SSH password is required',
    )
  })

  it('rejects when the private key file cannot be read', async () => {
    await expect(
      openSshTunnel(sshConfig({ authType: 'key', keyPath: '/no/such/sqlkit-key' }), 'h', 5432, () => undefined),
    ).rejects.toThrow(/Failed to read SSH key/)
  })
})
