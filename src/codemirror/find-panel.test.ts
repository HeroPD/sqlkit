// @vitest-environment jsdom
import { beforeAll, expect, test } from 'vitest'
import { EditorView } from '@codemirror/view'
import { getSearchQuery, openSearchPanel, searchPanelOpen } from '@codemirror/search'
import { search } from '@codemirror/search'
import { createFindPanel } from './find-panel'

import { stubEditorLayout } from '../test/dom-stubs'

beforeAll(stubEditorLayout)

const make = (doc: string) => {
  const view = new EditorView({
    doc,
    parent: document.body,
    extensions: [search({ top: true, createPanel: createFindPanel })],
  })
  openSearchPanel(view)
  return view
}

const findInput = (view: EditorView) => view.dom.querySelector<HTMLInputElement>('input[main-field]')!

const type = (input: HTMLInputElement, text: string) => {
  input.value = text
  input.dispatchEvent(new Event('input'))
}

test('panel opens with the custom widget and typing updates the query', () => {
  const view = make('select a;\nselect b;\nselect a;')
  expect(searchPanelOpen(view.state)).toBe(true)
  expect(view.dom.querySelector('.find-widget')).toBeTruthy()

  type(findInput(view), 'select')
  expect(getSearchQuery(view.state).search).toBe('select')
  view.destroy()
})

test('enter steps the selection through matches', () => {
  const view = make('select a;\nselect b;')
  const input = findInput(view)
  type(input, 'select')

  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  const first = view.state.selection.main
  expect(view.state.sliceDoc(first.from, first.to)).toBe('select')
  expect(first.from).toBe(0)

  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  const second = view.state.selection.main
  expect(second.from).toBe(10)
  view.destroy()
})

test('match counter reports N of M and No results', () => {
  const view = make('select a;\nselect b;')
  const input = findInput(view)
  const count = view.dom.querySelector('.find-count')!

  type(input, 'select')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(count.textContent).toBe('1 of 2')

  type(input, 'nope-nothing')
  expect(count.textContent).toBe('No results')
  expect(count.classList.contains('no-results')).toBe(true)
  view.destroy()
})

test('replace row replaces the current match', () => {
  const view = make('select a;')
  const input = findInput(view)
  type(input, 'select')

  const widget = view.dom.querySelector('.find-widget')!
  ;(widget.querySelector('.toggle-replace') as HTMLButtonElement).click()
  const replaceInput = widget.querySelectorAll('input')[1]!
  type(replaceInput, 'SELECT')

  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  replaceInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  expect(view.state.doc.toString()).toBe('SELECT a;')
  view.destroy()
})
