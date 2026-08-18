// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WelcomeScreen } from './welcome-screen'

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('WelcomeScreen', () => {
  it('shows the first-launch state when there are no recent workspaces', async () => {
    const screen = new WelcomeScreen()
    document.body.append(screen)
    await screen.updateComplete

    expect(screen.shadowRoot?.querySelector('.empty')?.textContent).toContain('No recent workspaces')
    expect(screen.shadowRoot?.querySelector('.recent-list')).toBeNull()
    expect(screen.shadowRoot?.querySelector('.updates')?.textContent).toContain('Release notes')
  })

  it('opens a rendered recent workspace by path', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T10:00:00Z'))
    const screen = new WelcomeScreen()
    screen.recents = [{
      name: 'analytics',
      path: '/work/analytics',
      lastOpened: '2026-08-17T08:00:00Z',
      profileCount: 3,
    }]
    const opened: string[] = []
    screen.addEventListener('open-recent', (event) => opened.push((event as CustomEvent<{ path: string }>).detail.path))
    document.body.append(screen)
    await screen.updateComplete

    const recent = screen.shadowRoot?.querySelector<HTMLButtonElement>('.recent')
    expect(recent?.textContent).toContain('analytics')
    expect(recent?.textContent).toContain('/work/analytics')
    expect(recent?.textContent).toContain('3 profiles · 2h')
    recent?.click()
    expect(opened).toEqual(['/work/analytics'])
  })

})
