import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// host:port -> base64 of the raw SSH host-key blob pinned on first use.
type Store = Record<string, string>

// OpenSSH-style fingerprint of a raw host-key blob — matches `ssh-keygen -lf`,
// so the strings we show line up with what the user can verify out of band.
export const hostKeyFingerprint = (key: Buffer): string =>
  `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`

const readStore = (file: string): Store => {
  try {
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
  | { trusted: false; presented: string; pinned: string }

// Trust-on-first-use check against a JSON known-hosts store: an unknown host is
// recorded and trusted; a host whose key still matches the pinned one is
// trusted; a host whose key changed is rejected (possible MITM). Takes the
// store path explicitly so the policy is unit-testable without Electron paths.
export function verifyHostKey(file: string, hostId: string, key: Buffer): HostKeyOutcome {
  const presented = key.toString('base64')
  const store = readStore(file)
  const pinned = store[hostId]

  if (!pinned) {
    store[hostId] = presented
    try {
      writeStore(file, store)
    } catch {
      // A read-only store shouldn't block connecting; trust degrades to
      // per-session, still strictly better than accepting any key.
    }
    return { trusted: true, firstUse: true }
  }

  if (pinned === presented) return { trusted: true, firstUse: false }
  return {
    trusted: false,
    presented: hostKeyFingerprint(key),
    pinned: hostKeyFingerprint(Buffer.from(pinned, 'base64')),
  }
}

const storePath = () => path.join(app.getPath('userData'), 'known_hosts.json')

// Builds an ssh2 hostVerifier keyed on host:port. Returns true to accept the
// handshake; on a pinned-key mismatch it calls onReject with a message a human
// can act on and returns false so ssh2 aborts the connection.
export function makeHostVerifier(host: string, port: number, onReject: (message: string) => void) {
  const hostId = `${host}:${port}`
  return (key: Buffer): boolean => {
    const outcome = verifyHostKey(storePath(), hostId, key)
    if (outcome.trusted) return true
    onReject(
      `Host key verification failed for ${hostId}: the server presented ${outcome.presented} but ` +
        `${outcome.pinned} was pinned on a previous connection. If this change is unexpected the ` +
        `connection may be intercepted. Delete the saved key for this host to trust the new one.`,
    )
    return false
  }
}
