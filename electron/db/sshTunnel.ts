import { Client, type ConnectConfig } from 'ssh2'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { SshConfig } from '../../src/electron'
import { t } from '../../src/i18n'
import type { Tunnel } from './transport'
import { hasPinnedHostKey, hostKeyFingerprint, knownHostsPath, makeHostVerifier, trustHostKey, unknownHostKeyMessage } from './knownHosts'

const expandHome = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

function buildConnectConfig(ssh: SshConfig): ConnectConfig {
  const config: ConnectConfig = {
    host: ssh.host.trim(),
    port: Number(ssh.port) || 22,
    username: ssh.username.trim(),
    readyTimeout: 15_000,
    // Bastion hosts commonly drop idle TCP sessions; keepalives hold the
    // tunnel open between queries.
    keepaliveInterval: 30_000,
  }

  if (!config.host) throw new Error(t('ssh.hostRequired'))
  if (!config.username) throw new Error(t('ssh.usernameRequired'))

  if (ssh.authType === 'key') {
    const keyPath = expandHome(ssh.keyPath.trim())
    if (!keyPath) throw new Error(t('ssh.keyPathRequired'))
    try {
      if (fs.statSync(keyPath).size > 1024 * 1024) throw new Error(t('ssh.keyTooLarge'))
      config.privateKey = fs.readFileSync(keyPath)
    } catch (error) {
      throw new Error(`Failed to read SSH key at ${keyPath}: ${(error as Error).message}`, { cause: error })
    }
    if (ssh.passphrase) config.passphrase = ssh.passphrase
  } else {
    if (!ssh.password) throw new Error(t('ssh.passwordRequired'))
    config.password = ssh.password
  }

  return config
}

// Fetches the host key on a throwaway pre-auth handshake: the verifier captures
// the key and refuses; connect failures reject, the post-capture refusal doesn't.
const probeHostKey = (config: ConnectConfig): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const client = new Client()
    let captured = false
    client.on('error', (error) => {
      if (!captured) reject(error)
    })
    client.connect({
      ...config,
      hostVerifier: (key: Buffer) => {
        captured = true
        resolve(Buffer.from(key))
        client.end()
        return false
      },
    })
  })

// First-use approval before the real handshake — inside ssh2's verifier a slow
// human answer trips readyTimeout. Returns whether a new key was just pinned.
async function ensureHostKeyApproved(
  config: ConnectConfig,
  approveFirstUse?: (hostId: string, fingerprint: string) => Promise<boolean> | boolean,
): Promise<boolean> {
  const hostId = `${config.host as string}:${config.port as number}`
  if (!approveFirstUse || hasPinnedHostKey(knownHostsPath(), hostId)) return false
  const key = await probeHostKey(config)
  if (!(await approveFirstUse(hostId, hostKeyFingerprint(key)))) {
    throw new Error(unknownHostKeyMessage(hostId, hostKeyFingerprint(key)))
  }
  try {
    trustHostKey(knownHostsPath(), hostId, key)
    return true
  } catch (error) {
    throw new Error(`Could not save the trusted SSH host key for ${hostId}: ${(error as Error).message}`, { cause: error })
  }
}

// Opens an SSH connection and forwards a random local port to
// (remoteHost, remotePort). Resolves once the local TCP server is listening;
// callers dial 127.0.0.1:localPort. close() destroys every forwarded socket
// so teardown never waits on in-flight streams. `onError` fires if the SSH
// session drops after it was established (it never double-reports a connect
// failure, which surfaces through the returned promise).
export async function openSshTunnel(
  ssh: SshConfig,
  remoteHost: string,
  remotePort: number,
  onError: (message: string) => void,
  approveFirstUse?: (hostId: string, fingerprint: string) => Promise<boolean> | boolean,
): Promise<Tunnel> {
  const approvedConfig = buildConnectConfig(ssh)
  const justPinned = await ensureHostKeyApproved(approvedConfig, approveFirstUse)
  return new Promise((resolve, reject) => {
    const client = new Client()
    const sockets = new Set<net.Socket>()
    let server: net.Server | null = null
    let settled = false
    let closing = false
    // Set by the host-key verifier on a pinned-key mismatch so the generic
    // ssh2 handshake error is replaced with one the user can act on.
    let rejectionMessage: string | null = null

    const close = () =>
      new Promise<void>((done) => {
        closing = true
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        try {
          server?.close(() => done())
        } catch {
          done()
        }
        client.end()
        if (!server) done()
      })

    const fail = (error: Error) => {
      // A mismatch right after first-use pinning usually means a load-balanced
      // host pool with per-node keys: the probe and the connect hit different nodes.
      const mismatchHint = justPinned && rejectionMessage?.includes('Host key verification failed')
        ? ' The server presented a different key than the one just approved — hosts behind a load balancer can carry distinct keys; retrying may reach the approved one.'
        : ''
      const finalError = rejectionMessage ? new Error(`${rejectionMessage}${mismatchHint}`) : error
      if (settled) {
        if (!closing) onError(`SSH tunnel: ${finalError.message}`)
        return
      }
      settled = true
      void close()
      reject(finalError)
    }

    client.on('error', fail)
    client.on('close', () => {
      if (settled && !closing) onError('SSH tunnel closed unexpectedly')
    })

    client.on('ready', () => {
      server = net.createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (error, stream) => {
          if (error) {
            socket.destroy()
            return
          }
          socket.pipe(stream).pipe(socket)
          stream.on('close', () => socket.destroy())
          stream.on('error', () => socket.destroy())
          socket.on('close', () => stream.end())
        })
      })

      server.on('error', fail)
      server.listen(0, '127.0.0.1', () => {
        const address = server?.address()
        if (!address || typeof address === 'string') {
          fail(new Error('SSH tunnel: failed to obtain local port'))
          return
        }
        settled = true
        resolve({ localPort: address.port, close })
      })
    })

    try {
      const config = { ...approvedConfig }
      // Pin the bastion's host key on first use and reject if it ever changes;
      // without this ssh2 accepts any key, leaving the tunnel open to MITM.
      config.hostVerifier = makeHostVerifier(
        config.host as string,
        config.port as number,
        (message) => { rejectionMessage = message },
      )
      client.connect(config)
    } catch (error) {
      fail(error as Error)
    }
  })
}
