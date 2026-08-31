// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { expressionCompletionOptions, SqlExpressionEditor } from './sql-expression-editor'

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

  it('submits and cancels a compact expression with Enter, Mod-Enter and Escape', async () => {
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
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    expect(editor.value).toBe('\n')
    expect(submit).not.toHaveBeenCalled()
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(submit).toHaveBeenCalledOnce()

    // The key that runs a query applies the filter here; CodeMirror resolves
    // Mod to Ctrl under jsdom, Cmd on the mac app.
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(submit).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledOnce()
    expect(editor.value).toBe('\n')
    editor.remove()
  })

  it('auto-grows compact expressions up to four lines before scrolling', async () => {
    const editor = document.createElement('sql-expression-editor')
    editor.compact = true
    document.body.append(editor)
    await editor.updateComplete

    expect(editor.hasAttribute('compact')).toBe(true)
    expect(SqlExpressionEditor.styles.cssText).toContain('max-height: 84px')
    expect(SqlExpressionEditor.styles.cssText).toContain('overflow-y: auto')
    editor.remove()
  })
})
