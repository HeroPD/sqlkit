import { Client, type ConnectConfig } from 'ssh2'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { SshConfig } from '../../src/electron'
import type { Tunnel } from './transport'
import { makeHostVerifier } from './knownHosts'

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

  if (!config.host) throw new Error('SSH host is required')
  if (!config.username) throw new Error('SSH username is required')

  if (ssh.authType === 'key') {
    const keyPath = expandHome(ssh.keyPath.trim())
    if (!keyPath) throw new Error('SSH private key path is required')
    try {
      config.privateKey = fs.readFileSync(keyPath)
    } catch (error) {
      throw new Error(`Failed to read SSH key at ${keyPath}: ${(error as Error).message}`, { cause: error })
    }
    if (ssh.passphrase) config.passphrase = ssh.passphrase
  } else {
    if (!ssh.password) throw new Error('SSH password is required')
    config.password = ssh.password
  }

  return config
}

// Opens an SSH connection and forwards a random local port to
// (remoteHost, remotePort). Resolves once the local TCP server is listening;
// callers dial 127.0.0.1:localPort. close() destroys every forwarded socket
// so teardown never waits on in-flight streams. `onError` fires if the SSH
// session drops after it was established (it never double-reports a connect
// failure, which surfaces through the returned promise).
export function openSshTunnel(
  ssh: SshConfig,
  remoteHost: string,
  remotePort: number,
  onError: (message: string) => void,
): Promise<Tunnel> {
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
      const finalError = rejectionMessage ? new Error(rejectionMessage) : error
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
      const config = buildConnectConfig(ssh)
      // Pin the bastion's host key on first use and reject if it ever changes;
      // without this ssh2 accepts any key, leaving the tunnel open to MITM.
      config.hostVerifier = makeHostVerifier(config.host as string, config.port as number, (message) => {
        rejectionMessage = message
      })
      client.connect(config)
    } catch (error) {
      fail(error as Error)
    }
  })
}
