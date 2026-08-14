import { describe, expect, it } from 'vitest'
import { matchesCompletionTerm } from './dialects'

describe('completion term matching', () => {
  it('reaches a term through any of its underscore-separated words', () => {
    // The main editor's old prefix test could not get here from either word.
    expect(matchesCompletionTerm('CURRENT_TIMESTAMP', 'time')).toBe(true)
    expect(matchesCompletionTerm('CURRENT_DATE', 'date')).toBe(true)
    expect(matchesCompletionTerm('published_at', 'at')).toBe(true)
  })

  it('still reaches a term by its own prefix', () => {
    expect(matchesCompletionTerm('CURRENT_TIMESTAMP', 'cur')).toBe(true)
    expect(matchesCompletionTerm('CURRENT_TIMESTAMP', 'current_time')).toBe(true)
    expect(matchesCompletionTerm('COALESCE', 'coa')).toBe(true)
  })

  it('rejects a term the typed text only reaches as a scattered subsequence', () => {
    // CodeMirror's own matcher offers this one: curren(t)_tim(es)(t)amp.
    expect(matchesCompletionTerm('CURRENT_TIMESTAMP', 'test')).toBe(false)
    expect(matchesCompletionTerm('published_at', 'pat')).toBe(false)
    expect(matchesCompletionTerm('COALESCE', 'ale')).toBe(false)
  })

  it('is case-insensitive both ways', () => {
    expect(matchesCompletionTerm('title', 'TIT')).toBe(true)
    expect(matchesCompletionTerm('CURRENT_DATE', 'DaT')).toBe(true)
  })

  it('offers everything for the empty prefix an explicit completion sends', () => {
    expect(matchesCompletionTerm('COALESCE', '')).toBe(true)
    expect(matchesCompletionTerm('anything', '')).toBe(true)
  })
})
