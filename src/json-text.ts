// Reformatting JSON documents without going through JSON.parse/stringify.
//
// A parse round-trip rewrites every literal it touches: 9007199254740993
// becomes …992 and 1.10 becomes 1.1. Rewriting a value the user only opened to
// read is exactly what a database client must not do, so this scanner copies
// string and number literals through verbatim and only ever changes the
// whitespace between them — the same care coerceValue takes with big integers
// in sql-write.ts.

const INDENT = '  '

// A JSON string literal starting at `text[start]` (a quote), through its
// closing quote. A backslash escapes the next character, so `\"` is not the
// end. An unterminated string runs to the end of the text; callers reformat
// only documents that parse, so that shape never reaches here in practice.
function stringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1
    else if (text[index] === '"') return index + 1
  }
  return text.length
}

type Emit = {
  /** A string literal, number, or bare word (`true`, `null`), exactly as written. */
  literal: (chunk: string) => void
  open: (char: string) => void
  close: (char: string) => void
  comma: () => void
  colon: () => void
}

const STRUCTURAL = new Set(['{', '}', '[', ']', ',', ':'])

// One walk over the document: structural characters go to `emit`, everything
// else is copied as-is. Whitespace between tokens is dropped — emitters put
// back whatever the output shape needs.
function scan(text: string, emit: Emit): void {
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (char === '"') {
      const end = stringEnd(text, index)
      emit.literal(text.slice(index, end))
      index = end
    } else if (char === '{' || char === '[') {
      emit.open(char)
      index += 1
    } else if (char === '}' || char === ']') {
      emit.close(char)
      index += 1
    } else if (char === ',') {
      emit.comma()
      index += 1
    } else if (char === ':') {
      emit.colon()
      index += 1
    } else if (/\s/.test(char)) {
      index += 1
    } else {
      // A bare token — number, true/false/null, or junk from a malformed doc.
      let end = index
      while (end < text.length && !STRUCTURAL.has(text[end]!) && text[end] !== '"' && !/\s/.test(text[end]!)) end += 1
      emit.literal(text.slice(index, end))
      index = end
    }
  }
}

/** The document on one line: every literal untouched, all other whitespace gone. */
export function minifyJson(text: string): string {
  const out: string[] = []
  scan(text, {
    literal: (chunk) => out.push(chunk),
    open: (char) => out.push(char),
    close: (char) => out.push(char),
    comma: () => out.push(','),
    colon: () => out.push(':'),
  })
  return out.join('')
}

/** The document indented two spaces per level; empty objects and arrays stay closed up. */
export function formatJson(text: string): string {
  const out: string[] = []
  let depth = 0
  // A break is owed after `{`, `[` and `,`, but only paid once the next token
  // arrives — so an immediately following `}` gives `{}` rather than a gap.
  let pendingBreak = false
  const flush = () => {
    if (!pendingBreak) return
    pendingBreak = false
    out.push(`\n${INDENT.repeat(depth)}`)
  }
  scan(text, {
    literal: (chunk) => {
      flush()
      out.push(chunk)
    },
    open: (char) => {
      flush()
      out.push(char)
      depth += 1
      pendingBreak = true
    },
    close: (char) => {
      depth -= 1
      if (pendingBreak) pendingBreak = false
      else out.push(`\n${INDENT.repeat(depth)}`)
      out.push(char)
    },
    comma: () => {
      out.push(',')
      pendingBreak = true
    },
    colon: () => out.push(': '),
  })
  return out.join('')
}

/** What is wrong with a document, and where the message says it is. */
export type JsonProblem = { message: string; position: number | null }

/**
 * V8 spells its JSON errors two ways, both too long to read in a status strip:
 *
 *   Unexpected token ',', ..."broken": ,\n  "after"... is not valid JSON
 *   Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)
 *
 * Keep the clause that names the problem and drop the echoed source and the
 * position — the position is shown as a place in the document instead.
 */
const tidy = (message: string) =>
  message
    .replace(/ in JSON at position \d+.*$/s, '')
    .replace(/ is not valid JSON$/, '')
    // The echoed source follows a comma AND a space; the comma inside a quoted
    // token ("Unexpected token ','") has no space after it, so it survives.
    .replace(/,\s+(?:\.\.\.|").*$/s, '')
    .trim()

/** The parse error of an invalid document, or null when it is valid JSON. */
export function jsonProblem(text: string): JsonProblem | null {
  try {
    JSON.parse(text)
    return null
  } catch (error) {
    const raw = (error as Error).message
    const stated = /at position (\d+)/.exec(raw)
    return { message: tidy(raw), position: stated ? Number(stated[1]) : null }
  }
}

/** The parse error's message alone, for callers that only ask whether it parses. */
export function jsonError(text: string): string | null {
  return jsonProblem(text)?.message ?? null
}
