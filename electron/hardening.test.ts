import { describe, expect, it } from 'vitest'
import { inspectionSwitch } from './hardening'

// argv[0] is the executable path, which is never a switch.
const launch = (...args: string[]) => ['/Applications/SqlKit Studio.app/Contents/MacOS/SqlKit Studio', ...args]

describe('inspectionSwitch', () => {
  it('passes a normal launch', () => {
    expect(inspectionSwitch(launch())).toBeNull()
    expect(inspectionSwitch(launch('/Users/me/queries', '--enable-features=Foo'))).toBeNull()
  })

  it('catches the Chromium debugger switches, with or without a value', () => {
    expect(inspectionSwitch(launch('--remote-debugging-port=9222'))).toBe('--remote-debugging-port')
    expect(inspectionSwitch(launch('--remote-debugging-pipe'))).toBe('--remote-debugging-pipe')
    expect(inspectionSwitch(launch('--remote-allow-origins=*'))).toBe('--remote-allow-origins')
  })

  it('catches the Node inspector switches', () => {
    for (const flag of ['--inspect', '--inspect-brk', '--inspect-port=1234', '--inspect-publish-uid=http']) {
      expect(inspectionSwitch(launch(flag))).not.toBeNull()
    }
    expect(inspectionSwitch(launch('--inspect=0.0.0.0:9229'))).toBe('--inspect')
  })

  it('catches raw V8 flags, which dump memory by a longer road', () => {
    expect(inspectionSwitch(launch('--js-flags=--prof'))).toBe('--js-flags')
  })

  it('catches an inspector smuggled in through NODE_OPTIONS', () => {
    expect(inspectionSwitch(launch(), '--inspect-brk=9229')).toBe('--inspect-brk')
    expect(inspectionSwitch(launch(), '--max-old-space-size=4096 --inspect')).toBe('--inspect')
    expect(inspectionSwitch(launch(), '--max-old-space-size=4096')).toBeNull()
    expect(inspectionSwitch(launch(), '')).toBeNull()
    expect(inspectionSwitch(launch(), undefined)).toBeNull()
  })

  it('does not fire on a switch that merely starts the same way', () => {
    // A real Chromium switch, and not one of ours.
    expect(inspectionSwitch(launch('--inspector-of-nothing'))).toBeNull()
    expect(inspectionSwitch(launch('--remote-debugging-port-ish=1'))).toBeNull()
  })

  it('reports the first offender when several are present', () => {
    expect(inspectionSwitch(launch('--inspect', '--remote-debugging-port=9222'))).toBe('--inspect')
  })
})
