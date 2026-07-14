// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import './picker-input'

describe('picker-input', () => {
  it('filters and selects a metadata suggestion', async () => {
    const picker = document.createElement('picker-input')
    picker.items = [
      { value: 'public.accounts', detail: 'table' },
      { value: 'public.users', detail: 'table' },
    ]
    const changed = vi.fn()
    picker.addEventListener('value-change', changed)
    document.body.append(picker)
    await picker.updateComplete

    const input = picker.shadowRoot!.querySelector('input')!
    input.dispatchEvent(new FocusEvent('focus'))
    input.value = 'acc'
    input.dispatchEvent(new Event('input'))
    await picker.updateComplete
    const option = picker.shadowRoot!.querySelector<HTMLButtonElement>('.picker button')!
    expect(option.textContent).toContain('public.accounts')
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ detail: { value: 'public.accounts' } }))
    picker.remove()
  })

  it('completes one column in a comma-separated list', async () => {
    const picker = document.createElement('picker-input')
    picker.multiple = true
    picker.value = 'tenant_id, em'
    picker.items = [{ value: 'email', detail: 'text' }]
    document.body.append(picker)
    await picker.updateComplete

    const input = picker.shadowRoot!.querySelector('input')!
    input.dispatchEvent(new FocusEvent('focus'))
    await picker.updateComplete
    picker.shadowRoot!.querySelector<HTMLButtonElement>('.picker button')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

    expect(picker.value).toBe('tenant_id, email')
    picker.remove()
  })
})
