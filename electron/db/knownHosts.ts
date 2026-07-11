import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// host:port -> base64 of the raw SSH host-key blob pinned on first use.
type Store = Record<string, string>
const MAX_STORE_BYTES = 1024 * 1024

// OpenSSH-style fingerprint of a raw host-key blob — matches `ssh-keygen -lf`,
// so the strings we show line up with what the user can verify out of band.
export const hostKeyFingerprint = (key: Buffer): string =>
  `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`

const readStore = (file: string): Store => {
  try {
    if (fs.statSync(file).size > MAX_STORE_BYTES) return {}
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {}
  } catch {
    return {}
  }
}

const writeStore = (file: string, store: Store) => {
  // temp+rename so a crash mid-write can't truncate the pin store.
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
  fs.renameSync(tmp, file)
}

export type HostKeyOutcome =
  | { trusted: true; firstUse: boolean }
  | { trusted: false; firstUse: true; presented: string }
  | { trusted: false; firstUse: false; presented: string; pinned: string }

// Check against a JSON known-hosts store. An unknown host is reported for an
// explicit user decision; it is never silently trusted. Takes the
// store path explicitly so the policy is unit-testable without Electron paths.
export function verifyHostKey(file: string, hostId: string, key: Buffer): HostKeyOutcome {
  const presented = key.toString('base64')
  const store = readStore(file)
  const pinned = store[hostId]

  if (!pinned) {
    return { trusted: false, firstUse: true, presented: hostKeyFingerprint(key) }
  }

  if (pinned === presented) return { trusted: true, firstUse: false }
  return {
    trusted: false,
    firstUse: false,
    presented: hostKeyFingerprint(key),
    pinned: hostKeyFingerprint(Buffer.from(pinned, 'base64')),
  }
}

export function trustHostKey(file: string, hostId: string, key: Buffer): void {
  const store = readStore(file)
  store[hostId] = key.toString('base64')
  writeStore(file, store)
}

export const hasPinnedHostKey = (file: string, hostId: string): boolean =>
  readStore(file)[hostId] !== undefined

export const knownHostsPath = () => path.join(app.getPath('userData'), 'known_hosts.json')

// Builds an ssh2 hostVerifier keyed on host:port. Returns true to accept the
// handshake; otherwise calls onReject with a message a human can act on and
// returns false so ssh2 aborts. First-use approval happens before the real
// connect (see openSshTunnel) — mid-handshake there is no one left to ask.
export function makeHostVerifier(
  host: string,
  port: number,
  onReject: (message: string) => void,
) {
  const hostId = `${host}:${port}`
  return (key: Buffer): boolean => {
    const outcome = verifyHostKey(knownHostsPath(), hostId, key)
    if (outcome.trusted) return true
    if (outcome.firstUse) {
      onReject(`Unknown SSH host key for ${hostId}: ${outcome.presented}. Verify the fingerprint with the server administrator before trusting it.`)
      return false
    }
    onReject(
      `Host key verification failed for ${hostId}: the server presented ${outcome.presented} but ` +
        `${outcome.pinned} was pinned on a previous connection. If this change is unexpected the ` +
        `connection may be intercepted. Delete the saved key for this host to trust the new one.`,
    )
    return false
  }
}
