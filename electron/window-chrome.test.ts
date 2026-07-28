import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ThemeId } from '../src/electron'
import { TITLEBAR_HEIGHT, WINDOW_CHROME } from './window-chrome'

// The main process cannot read the renderer's CSS variables, so the window
// chrome copies them. Copies drift; this pins them.
const dir = path.dirname(fileURLToPath(import.meta.url))
const css = fs.readFileSync(path.join(dir, '../src/index.css'), 'utf8')

const varsOf = (selector: string) => {
  const start = css.indexOf(`${selector} {`)
  expect(start, `${selector} block in src/index.css`).toBeGreaterThanOrEqual(0)
  const body = css.slice(start, css.indexOf('\n}', start))
  return (name: string) => body.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim()
}

const selectorFor = (theme: ThemeId) => (theme === 'dark' ? ':root' : `:root[data-theme='${theme}']`)

describe('window chrome mirrors the renderer theme', () => {
  it('matches the background and title bar colors of every theme', () => {
    for (const [theme, chrome] of Object.entries(WINDOW_CHROME)) {
      const read = varsOf(selectorFor(theme as ThemeId))
      expect({ background: read('bg'), titleBar: read('titlebar-bg'), symbol: read('titlebar-fg') }).toEqual(chrome)
    }
  })

  it('matches the title bar height the renderer reserves', () => {
    expect(varsOf(':root')('titlebar-h')).toBe(`${TITLEBAR_HEIGHT}px`)
  })
})
