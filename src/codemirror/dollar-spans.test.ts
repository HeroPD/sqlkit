import { describe, expect, it } from 'vitest'
import { dollarSpans, spanAt } from './dollar-spans'

const spans = (text: string) => dollarSpans(text).map(([from, to]) => text.slice(from, to))

describe('dollarSpans', () => {
  it('returns whole literals, delimiters included', () => {
    expect(spans('a $$one$$ b $fn$two$fn$')).toEqual(['$$one$$', '$fn$two$fn$'])
  })

  it('closes only on the matching tag, keeping a nested quote inside', () => {
    expect(spans('$a$ x $$ y $$ z $a$')).toEqual(['$a$ x $$ y $$ z $a$'])
  })

  it('runs an unterminated literal to the end of the text', () => {
    expect(spans('$fn$ never closed')).toEqual(['$fn$ never closed'])
  })

  it('ignores dollars inside strings, comments, and parameters', () => {
    expect(spans("select '$fn$' -- $fn$\n, $1 + 2, \"a$$b\"")).toEqual([])
    expect(spans('/* $$ */ select 1')).toEqual([])
  })

  it('does not treat a tag starting with a digit as an opener', () => {
    expect(spans('select $1$2')).toEqual([])
  })
})

describe('spanAt', () => {
  it('reports strict containment only — edges are outside', () => {
    const found = dollarSpans('ab $$x$$ cd')
    expect(spanAt(found, 3)).toBeNull()
    expect(spanAt(found, 5)).toEqual([3, 8])
    expect(spanAt(found, 8)).toBeNull()
  })
})
