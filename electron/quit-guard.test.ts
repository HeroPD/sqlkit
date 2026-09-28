import { describe, expect, it } from 'vitest'
import type { ConnectionProfile, ConnectionStatus } from '../src/electron'
import { hasOpenTransaction, openTransactionTargets, rollbackPrompt, ROLLBACK_CONFIRMED } from './quit-guard'

const profile = (overrides: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: 'p1',
  name: 'Main DB',
  engine: 'postgresql',
  host: 'localhost',
  port: '5432',
  username: 'u',
  password: '',
  database: 'app',
  file: '',
  folder: '',
  ...overrides,
})

const connected = (profileId: string, transaction?: ConnectionStatus['transaction']): ConnectionStatus => ({
  profileId,
  phase: 'connected',
  ...(transaction ? { transaction } : {}),
})

describe('openTransactionTargets', () => {
  it('names only the connected profiles holding a transaction, with its database', () => {
    const targets = openTransactionTargets([{
      statuses: [
        connected('p1', { childDb: 'sales' }),
        connected('p2'),
        { profileId: 'p3', phase: 'connecting' },
        connected('p4', { childDb: '' }),
      ],
      profiles: [profile(), profile({ id: 'p2', name: 'Idle' }), profile({ id: 'p4', name: 'Solo' })],
    }])
    expect(targets).toEqual(['Main DB › sales', 'Solo'])
  })

  it('counts a failed transaction, which a disconnect still rolls back', () => {
    const statuses = [connected('p1', { childDb: 'app', failed: true })]
    expect(hasOpenTransaction(statuses)).toBe(true)
    expect(openTransactionTargets([{ statuses, profiles: [profile()] }])).toEqual(['Main DB › app'])
  })

  it('falls back to where an unnamed or unsaved connection points', () => {
    const targets = openTransactionTargets([{
      statuses: [connected('p1', { childDb: '' }), connected('gone', { childDb: 'x' })],
      profiles: [profile({ name: ' ', host: 'db.internal' })],
    }])
    expect(targets).toEqual(['db.internal', 'Untitled › x'])
  })

  it('lists every window at quit, once per target', () => {
    const targets = openTransactionTargets([
      { statuses: [connected('p1', { childDb: 'app' })], profiles: [profile()] },
      { statuses: [connected('p1', { childDb: 'app' }), connected('p2', { childDb: 'crm' })], profiles: [profile(), profile({ id: 'p2', name: 'CRM' })] },
    ])
    expect(targets).toEqual(['Main DB › app', 'CRM › crm'])
  })

  it('finds nothing when no connection holds a transaction', () => {
    const statuses = [connected('p1'), { profileId: 'p2', phase: 'error', error: 'refused' } as ConnectionStatus]
    expect(hasOpenTransaction(statuses)).toBe(false)
    expect(openTransactionTargets([{ statuses, profiles: [profile()] }])).toEqual([])
  })
})

describe('rollbackPrompt', () => {
  it('does not prompt when nothing would be rolled back', () => {
    expect(rollbackPrompt('close', [])).toBeNull()
    expect(rollbackPrompt('quit', [])).toBeNull()
  })

  it('asks before closing a window, defaulting to Cancel', () => {
    const prompt = rollbackPrompt('close', ['Main DB › app'])
    expect(prompt).toMatchObject({
      message: 'Close window?',
      detail: 'The open transaction on Main DB › app will be rolled back.',
      buttons: ['Cancel', 'Roll Back and Close'],
      defaultId: 0,
      cancelId: 0,
    })
    expect(prompt?.buttons?.[ROLLBACK_CONFIRMED]).toBe('Roll Back and Close')
  })

  it('asks once before quitting, listing every target', () => {
    const prompt = rollbackPrompt('quit', ['Main DB › app', 'CRM'])
    expect(prompt).toMatchObject({
      message: 'Quit SqlKit Studio?',
      detail: 'The open transaction on Main DB › app will be rolled back.\nThe open transaction on CRM will be rolled back.',
      buttons: ['Cancel', 'Roll Back and Quit'],
      cancelId: 0,
    })
  })
})
