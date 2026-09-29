// @vitest-environment jsdom
import { render, type TemplateResult } from 'lit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerActivity, ServerActivityResult } from '../electron'
import { TasksView } from './tasks-view'

const activity = (selfIdentificationAvailable: boolean): ServerActivity => ({
  connections: { used: 2, max: 100 },
  stats: [{ label: 'Uptime', value: '1h' }],
  selfIdentificationAvailable,
  sessions: [],
})

const renderActivity = (value: ServerActivity) => {
  const view = new TasksView() as unknown as {
    _renderActivity(activity: ServerActivity): TemplateResult
  }
  const container = document.createElement('div')
  render(view._renderActivity(value), container)
  return container.textContent ?? ''
}

describe('TasksView server activity', () => {
  it('explains when the server cannot identify SqlKit-owned sessions', () => {
    expect(renderActivity(activity(false))).toContain(
      'Identifying SqlKit Studio sessions requires Performance Schema connection attributes.',
    )
  })

  it('omits the explanation when session identification is available', () => {
    expect(renderActivity(activity(true))).not.toContain('Performance Schema')
  })
})

describe('TasksView server polling', () => {
  afterEach(() => vi.useRealTimers())

  // Mounting used to fetch twice (connect and first update), and a slow server stacked a fetch every tick.
  it('fetches once on mount and never overlaps a fetch still in flight', async () => {
    vi.useFakeTimers()
    let resolve!: (value: ServerActivityResult) => void
    const serverActivity = vi.fn(() => new Promise<ServerActivityResult>((res) => (resolve = res)))
    ;(window as never as { sqlkit: { serverActivity: typeof serverActivity } }).sqlkit = { serverActivity }

    const view = new TasksView()
    view.profileId = 'p1'
    view.engine = 'postgresql'
    document.body.append(view)
    await view.updateComplete
    expect(serverActivity).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(serverActivity).toHaveBeenCalledTimes(1)

    resolve({ success: true, activity: activity(true) })
    await vi.advanceTimersByTimeAsync(2_500)
    expect(serverActivity).toHaveBeenCalledTimes(2)
    view.remove()
  })
})
