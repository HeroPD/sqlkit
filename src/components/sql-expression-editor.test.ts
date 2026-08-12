// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
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

  it('shares callable-function classification across dialects', () => {
    const postgres = expressionCompletionOptions('postgresql', [])
    const sqlserver = expressionCompletionOptions('sqlserver', [])

    expect(postgres).toContainEqual(expect.objectContaining({ label: 'NOW', type: 'function' }))
    expect(postgres).toContainEqual(expect.objectContaining({ label: 'CURRENT_DATE', type: 'keyword' }))
    expect(sqlserver).toContainEqual(expect.objectContaining({ label: 'GETDATE', type: 'function' }))
  })

  it('submits and cancels a compact expression with Enter and Escape', async () => {
    const editor = document.createElement('sql-expression-editor')
    editor.compact = true
    editor.submitOnEnter = true
    const submit = vi.fn()
    const cancel = vi.fn()
    editor.addEventListener('expression-submit', submit)
    editor.addEventListener('expression-cancel', cancel)
    document.body.append(editor)
    await editor.updateComplete

    const content = editor.shadowRoot!.querySelector<HTMLElement>('.cm-content')!
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(submit).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    editor.remove()
  })
})
