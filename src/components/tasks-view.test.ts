// @vitest-environment jsdom
import { render, type TemplateResult } from 'lit'
import { describe, expect, it } from 'vitest'
import type { ServerActivity } from '../electron'
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
