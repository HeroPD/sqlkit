import { css } from 'lit'
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view'
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from '@codemirror/search'
import { t } from '../i18n'

// VS Code's find widget, rebuilt as a CodeMirror search panel: a find input
// with the case / whole-word / regex toggles inside it, an "N of M" match
// counter, arrow prev/next, and a replace row folded behind the left chevron.
// Search runs as you type; Enter / Shift+Enter step matches, Escape returns
// to the editor. A read-only editor gets no replace row and no chevron.
// Hosts compose findWidgetStyles (below) into their shadow styles.

const MAX_COUNT = 1000

const button = (classes: string, icon: string, title: string) => {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = classes
  el.title = title
  el.setAttribute('aria-label', title)
  el.innerHTML = `<i class="icon icon-${icon}" aria-hidden="true"></i>`
  return el
}

export function createFindPanel(view: EditorView): Panel {
  const initial = getSearchQuery(view.state)
  let caseSensitive = initial.caseSensitive
  let wholeWord = initial.wholeWord
  let regexp = initial.regexp
  const canReplace = !view.state.readOnly

  const dom = document.createElement('div')
  dom.className = canReplace ? 'find-widget' : 'find-widget no-replace'

  // --- DOM ----------------------------------------------------------------
  const toggleReplace = button('toggle-replace', 'chevron-right', t('find.toggleReplace'))
  toggleReplace.setAttribute('aria-expanded', 'false')

  const rows = document.createElement('div')
  rows.className = 'find-rows'

  const findRow = document.createElement('div')
  findRow.className = 'find-row'
  const findBox = document.createElement('div')
  findBox.className = 'find-input-box'
  const findInput = document.createElement('input')
  findInput.placeholder = t('find.find')
  findInput.value = initial.search
  findInput.setAttribute('main-field', 'true')
  findInput.spellcheck = false
  const caseBtn = button('find-toggle', 'case-sensitive', t('find.matchCase'))
  const wordBtn = button('find-toggle', 'whole-word', t('find.matchWholeWord'))
  const regexBtn = button('find-toggle', 'regex', t('find.useRegex'))
  findBox.append(findInput, caseBtn, wordBtn, regexBtn)

  const count = document.createElement('span')
  count.className = 'find-count'
  const prevBtn = button('find-btn', 'arrow-up', t('find.previousMatch', { shortcut: '⇧↵' }))
  const nextBtn = button('find-btn', 'arrow-down', t('find.nextMatch', { shortcut: '↵' }))
  const closeBtn = button('find-btn', 'x', t('find.close', { shortcut: 'Esc' }))
  findRow.append(findBox, count, prevBtn, nextBtn, closeBtn)

  const replaceRow = document.createElement('div')
  replaceRow.className = 'find-row replace-row'
  const replaceBox = document.createElement('div')
  replaceBox.className = 'find-input-box'
  const replaceInput = document.createElement('input')
  replaceInput.placeholder = t('find.replace')
  replaceInput.value = initial.replace
  replaceInput.spellcheck = false
  replaceBox.append(replaceInput)
  const replaceBtn = button('find-btn', 'replace', t('find.replace'))
  const replaceAllBtn = button('find-btn', 'replace-all', t('find.replaceAll'))
  replaceRow.append(replaceBox, replaceBtn, replaceAllBtn)

  rows.append(findRow)
  if (canReplace) {
    rows.append(replaceRow)
    dom.append(toggleReplace)
  }
  dom.append(rows)

  // --- behavior -------------------------------------------------------------
  const query = () =>
    new SearchQuery({ search: findInput.value, caseSensitive, wholeWord, regexp, replace: replaceInput.value })

  const commit = () => {
    const next = query()
    if (!next.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(next) })
    refresh()
  }

  // "N of M": walk the matches (capped) and find the one the selection is on.
  const refresh = () => {
    const current = getSearchQuery(view.state)
    const hasSearch = current.search.length > 0
    findBox.classList.toggle('invalid', hasSearch && !current.valid)

    let text = ''
    let none = false
    if (hasSearch && current.valid) {
      const selection = view.state.selection.main
      const cursor = current.getCursor(view.state) as Iterator<{ from: number; to: number }>
      let total = 0
      let index = 0
      for (let item = cursor.next(); !item.done; item = cursor.next()) {
        total++
        if (item.value.from === selection.from && item.value.to === selection.to) index = total
        if (total >= MAX_COUNT) break
      }
      none = total === 0
      text = none
        ? t('find.noResults')
        : t('find.matchCount', { index: index || '?', total, capped: total >= MAX_COUNT ? '+' : '' })
    }
    count.textContent = text
    count.classList.toggle('no-results', none)

    const enabled = hasSearch && current.valid && !none
    for (const el of [prevBtn, nextBtn, replaceBtn, replaceAllBtn]) el.disabled = !enabled
    caseBtn.classList.toggle('on', caseSensitive)
    wordBtn.classList.toggle('on', wholeWord)
    regexBtn.classList.toggle('on', regexp)
  }

  const syncFromState = () => {
    const current = getSearchQuery(view.state)
    if (findInput.value !== current.search) findInput.value = current.search
    if (replaceInput.value !== current.replace) replaceInput.value = current.replace
    caseSensitive = current.caseSensitive
    wholeWord = current.wholeWord
    regexp = current.regexp
    refresh()
  }

  const toggle = (flip: () => void) => (event: Event) => {
    event.preventDefault() // keep focus in the input
    flip()
    commit()
  }
  caseBtn.addEventListener('mousedown', toggle(() => (caseSensitive = !caseSensitive)))
  wordBtn.addEventListener('mousedown', toggle(() => (wholeWord = !wholeWord)))
  regexBtn.addEventListener('mousedown', toggle(() => (regexp = !regexp)))

  toggleReplace.addEventListener('click', () => {
    const on = dom.classList.toggle('replace-on')
    toggleReplace.setAttribute('aria-expanded', String(on))
    toggleReplace.innerHTML = `<i class="icon icon-chevron-${on ? 'down' : 'right'}" aria-hidden="true"></i>`
    if (on) replaceInput.focus()
  })

  findInput.addEventListener('input', commit)
  replaceInput.addEventListener('input', commit)

  findInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    ;(event.shiftKey ? findPrevious : findNext)(view)
  })
  replaceInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    replaceNext(view)
  })
  // Defer to CodeMirror's search-panel keymap scope first (Escape close,
  // F3 / Mod-g stepping, Mod-f reseed-from-selection), like the stock panel.
  dom.addEventListener('keydown', (event) => {
    if (runScopeHandlers(view, event, 'search-panel')) {
      event.preventDefault()
      return
    }
    if (event.key !== 'Escape') return
    event.preventDefault()
    closeSearchPanel(view)
    view.focus()
  })

  prevBtn.addEventListener('click', () => findPrevious(view))
  nextBtn.addEventListener('click', () => findNext(view))
  replaceBtn.addEventListener('click', () => replaceNext(view))
  replaceAllBtn.addEventListener('click', () => replaceAll(view))
  closeBtn.addEventListener('click', () => {
    closeSearchPanel(view)
    view.focus()
  })

  refresh()

  return {
    dom,
    top: true,
    mount() {
      findInput.focus()
      findInput.select()
    },
    update(update: ViewUpdate) {
      // ⌘F while open reseeds the query from the selection; mirror it here.
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(setSearchQuery)) {
            syncFromState()
            return
          }
        }
      }
      if (update.docChanged || update.selectionSet) refresh()
    },
  }
}

// The widget's look, composed into the shadow styles of every editor that
// mounts it (sql-editor, json-cell-editor). The panel's floating position is
// the host theme's business: see the .cm-panels-top override each editor sets.
export const findWidgetStyles = css`
  .find-widget {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 4px 4px 4px 0;
    background: var(--header-bg);
    border: 1px solid var(--border-subtle);
    border-top: none;
    border-radius: 0 0 4px 4px;
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.35);
    font-family: var(--ui-font);
    font-size: var(--font-size-sm);
    color: var(--text);
  }

  /* Read-only: no chevron column, so the find row carries the left inset. */
  .find-widget.no-replace {
    padding-left: 4px;
  }

  .toggle-replace {
    width: 16px;
    padding: 0;
    border: none;
    border-radius: 2px;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    --icon-size: 14px;
  }

  .toggle-replace:hover {
    background: var(--list-hover);
  }

  .find-rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .find-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .replace-row {
    display: none;
  }

  .find-widget.replace-on .replace-row {
    display: flex;
  }

  .find-input-box {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-right: 2px;
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: 3px;
  }

  .find-input-box:focus-within {
    border-color: var(--focus-border);
  }

  .find-input-box.invalid {
    border-color: var(--status-dot-error);
  }

  /* Standard control text size (13px), like every other input. */
  .find-input-box input {
    width: 150px;
    height: 22px;
    padding: 0 6px;
    border: none;
    background: transparent;
    color: var(--input-fg);
    font-family: inherit;
    font-size: var(--font-size);
    outline: none;
  }

  .find-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    --icon-size: 14px;
  }

  .find-toggle:hover {
    background: var(--list-hover);
  }

  .find-toggle.on {
    background: color-mix(in srgb, var(--accent) 35%, transparent);
    border-color: var(--accent);
    color: var(--text);
  }

  .find-count {
    padding: 0 4px;
    color: var(--text-2);
    white-space: nowrap;
  }

  /* No reserved space before a query exists — empty counter, no gap. */
  .find-count:empty {
    display: none;
  }

  .find-count.no-results {
    color: var(--status-dot-error);
  }

  .find-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--text);
    cursor: pointer;
    --icon-size: 14px;
  }

  .find-btn:hover:not(:disabled) {
    background: var(--list-hover);
  }

  .find-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
`
