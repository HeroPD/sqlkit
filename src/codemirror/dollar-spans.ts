// The postgres editor dialect parses dollar-quoted bodies as plain SQL (see
// dialects.ts), so the syntax tree no longer marks them. Callers that need
// string semantics back — statement splitting, blank-line separation — recover
// the regions from this one text pass, which skips strings and comments so a
// `$tag$` inside them can't open a span.

/** One dollar-quoted literal, delimiters included: [start of $tag$, end of closing $tag$). */
export type DollarSpan = [from: number, to: number]

const TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y

export function dollarSpans(text: string): DollarSpan[] {
  const spans: DollarSpan[] = []
  if (!text.includes('$')) return spans
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]!
    if (c === '-' && text[i + 1] === '-') {
      i += 2
      while (i < n && text[i] !== '\n') i += 1
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
    } else if (c === "'" || c === '"') {
      i += 1
      while (i < n) {
        if (text[i] === c) {
          if (text[i + 1] === c) { i += 2; continue }
          i += 1
          break
        }
        i += 1
      }
    } else if (c === '$') {
      TAG.lastIndex = i
      const tag = TAG.exec(text)?.[0]
      if (tag) {
        const close = text.indexOf(tag, i + tag.length)
        // Unterminated (still being typed): the literal runs to the end.
        const end = close < 0 ? n : close + tag.length
        spans.push([i, end])
        i = end
      } else {
        i += 1
      }
    } else {
      i += 1
    }
  }
  return spans
}

/** The span strictly containing `pos`; span edges count as outside. */
export function spanAt(spans: DollarSpan[], pos: number): DollarSpan | null {
  for (const span of spans) {
    if (pos <= span[0]) break
    if (pos < span[1]) return span
  }
  return null
}
