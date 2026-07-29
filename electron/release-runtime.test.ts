import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  devDependencies?: Record<string, string>
}
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
  packages?: Record<string, { version?: string }>
}

const parts = (version: string) => version.replace(/^[^\d]*/, '').split('.').map(Number)
const atLeast = (version: string, floor: string) => {
  const actual = parts(version)
  const minimum = parts(floor)
  for (let index = 0; index < Math.max(actual.length, minimum.length); index += 1) {
    if ((actual[index] ?? 0) > (minimum[index] ?? 0)) return true
    if ((actual[index] ?? 0) < (minimum[index] ?? 0)) return false
  }
  return true
}

describe('packaged Electron runtime', () => {
  it('includes the macOS first-launch Safe Storage initialization fix', () => {
    const requested = manifest.devDependencies?.electron ?? ''
    const locked = lock.packages?.['node_modules/electron']?.version ?? ''

    expect(atLeast(requested, '42.4.1')).toBe(true)
    expect(atLeast(locked, '42.4.1')).toBe(true)
  })
})
