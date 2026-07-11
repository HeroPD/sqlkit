import type { Engine } from './electron'

// Masks quoted text and comments while preserving offsets/newlines, so batch
// handling and edit-context inference never treat their contents as SQL syntax.
// Dialect-aware: each engine's comment/quote/escape rules differ enough that a
// generic scan misclassifies real scripts (MySQL '#'/backslash escapes, Postgres
// nested comments and E'' strings, SQL Server [brackets]). Shared by the
// renderer and the main-process drivers, like src/dialect.ts.
export function maskSql(sql: string, engine?: Engine): string {
  const chars = sql.split('')
  let i = 0
  const blank = (from: number, to: number) => {
    for (let p = from; p < to; p += 1) if (chars[p] !== '\n' && chars[p] !== '\r') chars[p] = ' '
  }
  while (i < sql.length) {
    const ch = sql[i]
    // MySQL requires whitespace (or end of input) after '--'; '3--2' is subtraction.
    const dashComment = engine !== 'mysql' || sql[i + 2] === undefined || /\s/.test(sql[i + 2]!)
    if (ch === '-' && sql[i + 1] === '-' && dashComment) {
      const end = sql.indexOf('\n', i + 2)
      const to = end < 0 ? sql.length : end
      blank(i, to)
      i = to
      continue
    }
    if (engine === 'mysql' && ch === '#') {
      const end = sql.indexOf('\n', i + 1)
      const to = end < 0 ? sql.length : end
      blank(i, to)
      i = to
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      // MySQL version comments are executable SQL, not inert comments. Mask
      // only their wrapper and continue scanning the contents normally.
      if (engine === 'mysql' && sql[i + 2] === '!') {
        let content = i + 3
        while (/\d/.test(sql[content] ?? '')) content += 1
        while (/\s/.test(sql[content] ?? '')) content += 1
        blank(i, content)
        i = content
        continue
      }
      let p = i + 2
      let depth = 1
      while (p < sql.length && depth > 0) {
        // Postgres and T-SQL nest block comments; MySQL and SQLite do not.
        if ((engine === 'postgresql' || engine === 'sqlserver') && sql[p] === '/' && sql[p + 1] === '*') {
          depth += 1
          p += 2
        } else if (sql[p] === '*' && sql[p + 1] === '/') {
          depth -= 1
          p += 2
        } else {
          p += 1
        }
      }
      blank(i, p)
      i = p
      continue
    }
    if ((engine === undefined || engine === 'postgresql') && ch === '$') {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length)
        const to = end < 0 ? sql.length : end + tag.length
        blank(i, to)
        i = to
        continue
      }
    }
    // SQLite accepts MySQL backticks and SQL Server brackets as identifier quotes too.
    if (ch === "'" || ch === '"' || ((engine === undefined || engine === 'mysql' || engine === 'sqlite') && ch === '`')) {
      const postgresEscapeString = engine === 'postgresql'
        && ch === "'"
        && /[eE]/.test(sql[i - 1] ?? '')
        && !/[A-Za-z0-9_$]/.test(sql[i - 2] ?? '')
      const backslashEscapes = engine === 'mysql' || postgresEscapeString
      let p = i + 1
      while (p < sql.length) {
        if (backslashEscapes && sql[p] === '\\') {
          p += Math.min(2, sql.length - p)
          continue
        }
        if (sql[p] === ch && sql[p + 1] === ch) {
          p += 2
          continue
        }
        if (sql[p] === ch) {
          p += 1
          break
        }
        p += 1
      }
      blank(i, p)
      i = p
      continue
    }
    if ((engine === undefined || engine === 'sqlserver' || engine === 'sqlite') && ch === '[') {
      let p = i + 1
      while (p < sql.length) {
        if (sql[p] === ']' && sql[p + 1] === ']') {
          p += 2
          continue
        }
        if (sql[p] === ']') {
          p += 1
          break
        }
        p += 1
      }
      blank(i, p)
      i = p
      continue
    }
    // A dangling MySQL version-comment terminator from the branch above.
    if (engine === 'mysql' && ch === '*' && sql[i + 1] === '/') {
      blank(i, i + 2)
      i += 2
      continue
    }
    i += 1
  }
  return chars.join('')
}
