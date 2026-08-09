// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { EngineBadge } from './engine-badge'

afterEach(() => document.body.replaceChildren())

describe('EngineBadge', () => {
  for (const engine of ['mysql', 'sqlserver'] as const) {
    it(`renders the ${engine} brand logo instead of the database fallback`, async () => {
      const badge = new EngineBadge()
      badge.engine = engine
      document.body.append(badge)
      await badge.updateComplete

      expect(badge.shadowRoot?.querySelector('.icon-database')).toBeNull()
      expect(badge.shadowRoot?.querySelector(`svg[aria-label="${engine}"] path`)).toBeTruthy()
      expect(badge.shadowRoot?.querySelector('.badge')?.getAttribute('style')).toContain(
        engine === 'mysql' ? '#4479a1' : '#cc2927',
      )
    })
  }

  it('renders the MariaDB sea-lion mark for the MySQL-compatible flavor', async () => {
    const badge = new EngineBadge()
    badge.engine = 'mysql'
    badge.flavor = 'mariadb'
    document.body.append(badge)
    await badge.updateComplete

    expect(badge.shadowRoot?.querySelector('svg[aria-label="mariadb"] path')).toBeTruthy()
    expect(badge.shadowRoot?.querySelector('.icon-database')).toBeNull()
    expect(badge.shadowRoot?.querySelector('.badge')?.getAttribute('style')).toContain('#003545')
  })
})
