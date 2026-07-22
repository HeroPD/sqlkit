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
// to the editor. Styling lives in sql-editor's shadow styles (.find-widget).

const MAX_COUNT = 1000

const button = (classes: string, icon: string, title: string) => {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = classes
  el.title = title
  el.setAttribute('aria-label', title)
  el.innerHTML = `<i class="codicon codicon-${icon}" aria-hidden="true"></i>`
  return el
}

export function createFindPanel(view: EditorView): Panel {
  const initial = getSearchQuery(view.state)
  let caseSensitive = initial.caseSensitive
  let wholeWord = initial.wholeWord
  let regexp = initial.regexp

  const dom = document.createElement('div')
  dom.className = 'find-widget'

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
  const closeBtn = button('find-btn', 'close', t('find.close', { shortcut: 'Esc' }))
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

  rows.append(findRow, replaceRow)
  dom.append(toggleReplace, rows)

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
    toggleReplace.innerHTML = `<i class="codicon codicon-chevron-${on ? 'down' : 'right'}" aria-hidden="true"></i>`
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
