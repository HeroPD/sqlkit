import { describe, expect, it } from 'vitest'
import type { Engine } from './electron'
import { capabilitiesFor, ENGINE_CAPABILITIES } from './engine-capabilities'

describe('engine capabilities', () => {
  it('defines every supported engine', () => {
    const engines: Engine[] = ['postgresql', 'mysql', 'sqlserver', 'sqlite']
    expect(Object.keys(ENGINE_CAPABILITIES).sort()).toEqual([...engines].sort())
  })

  it('exposes user-visible execution guarantees', () => {
    expect(capabilitiesFor('mysql').ddlAtomicity).toBe('best-effort')
    expect(capabilitiesFor('postgresql').ddlAtomicity).toBe('atomic')
    expect(capabilitiesFor('sqlserver').cancellation).toBe('request')
    expect(capabilitiesFor('sqlite').rowCount).toBe('bounded-lower-bound')
  })
})
