// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { expressionCompletionOptions } from './sql-expression-editor'

describe('SQL expression completion', () => {
  it('offers table columns and dialect keywords', () => {
    const options = expressionCompletionOptions('postgresql', ['age', 'display name'])

    expect(options).toContainEqual(expect.objectContaining({ label: 'age', apply: 'age', type: 'property' }))
    expect(options).toContainEqual(expect.objectContaining({ label: 'display name', apply: '"display name"', type: 'property' }))
    expect(options).toContainEqual(expect.objectContaining({ label: 'COALESCE', type: 'function' }))
    expect(options).toContainEqual(expect.objectContaining({ label: 'ILIKE', type: 'keyword' }))
  })

  it('uses the selected engine identifier quoting', () => {
    const options = expressionCompletionOptions('sqlserver', ['order'])
    expect(options).toContainEqual(expect.objectContaining({ label: 'order', apply: '[order]' }))
  })
})
