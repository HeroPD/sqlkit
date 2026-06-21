// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { InspectSection, ServerInfoResult } from '../electron'
import { ServerView } from './server-view'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
const defer = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const internals = (view: ServerView) =>
  view as never as { _load(): Promise<void>; _state: { phase: string; sections?: InspectSection[] } }

const section = (title: string): InspectSection => ({ title, rows: [] })

describe('ServerView stale-load guard', () => {
  it('ignores a result for a child the user already switched away from', async () => {
    const billing = defer<ServerInfoResult>()
    const analytics = defer<ServerInfoResult>()
    const inspectServer = vi.fn((_profileId: string, childDb: string | null) =>
      childDb === 'billing' ? billing.promise : analytics.promise,
    )
    ;(window as never as { sqlkit: { inspectServer: typeof inspectServer } }).sqlkit = { inspectServer }

    const view = new ServerView()
    view.profileId = 'p1'
    view.childDb = 'billing'
    const first = internals(view)._load()

    // User switches child mid-flight; a second load starts for analytics.
    view.childDb = 'analytics'
    const second = internals(view)._load()

    // The stale billing response resolves last — it must not overwrite analytics.
    analytics.resolve({ success: true, sections: [section('Analytics')] })
    billing.resolve({ success: true, sections: [section('Billing')] })
    await Promise.all([first, second])

    expect(internals(view)._state).toMatchObject({ phase: 'done', sections: [section('Analytics')] })
  })
})
