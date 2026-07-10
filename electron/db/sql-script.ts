import type { Engine } from '../../src/electron'

// Masks quoted text and comments while preserving offsets/newlines, so client-side
// batch handling never treats their contents as SQL control syntax.
export function maskSql(sql: string): string {
  const chars = sql.split('')
  let i = 0
  const blank = (from: number, to: number) => {
    for (let p = from; p < to; p += 1) if (chars[p] !== '\n' && chars[p] !== '\r') chars[p] = ' '
  }
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2)
      const to = end < 0 ? sql.length : end
      blank(i, to)
      i = to
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const to = end < 0 ? sql.length : end + 2
      blank(i, to)
      i = to
      continue
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length)
        const to = end < 0 ? sql.length : end + tag.length
        blank(i, to)
        i = to
        continue
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let p = i + 1
      while (p < sql.length) {
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
    if (ch === '[') {
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
    i += 1
  }
  return chars.join('')
}

export function splitTopLevelStatements(sql: string): string[] {
  const masked = maskSql(sql)
  const statements: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1
    else if (masked[i] === ')') depth = Math.max(0, depth - 1)
    else if (masked[i] === ';' && depth === 0) {
      const statement = sql.slice(start, i).trim()
      if (masked.slice(start, i).trim()) statements.push(statement)
      start = i + 1
    }
  }
  const tail = sql.slice(start).trim()
  if (masked.slice(start).trim()) statements.push(tail)
  return statements
}

// Conservative eligibility for stopping result production at the client cap.
// Never interrupt scripts/CTEs or SELECT INTO: cancellation there could skip a
// later statement or leave intentional side effects only partly performed.
export function isCappableRead(sql: string): boolean {
  const statements = splitTopLevelStatements(sql)
  if (statements.length !== 1) return false
  const masked = maskSql(statements[0]!).trimStart()
  return /^select\b/i.test(masked) && !/\binto\b/i.test(masked)
}

// Pooled server queries cannot safely leave a transaction open for a later run:
// that later run may get another connection. Self-contained transaction scripts
// remain supported because one driver.query call keeps one checked-out connection.
export function assertSelfContainedTransaction(sql: string, engine: Engine) {
  let depth = 0
  let sawControl = false
  for (const statement of splitTopLevelStatements(sql)) {
    const head = maskSql(statement).trimStart().toLowerCase()
    const begins = engine === 'sqlserver'
      ? /^begin\s+tran(?:saction)?\b/.test(head)
      : /^(?:begin(?:\s+(?:work|transaction))?|start\s+transaction)\b/.test(head)
    const closes = /^commit(?:\s+(?:work|transaction|tran))?\b/.test(head)
      || (engine === 'postgresql' && /^end(?:\s+(?:work|transaction))?\b/.test(head))
      || (/^rollback(?:\s+(?:work|transaction|tran))?\b/.test(head) && !/^rollback\s+to\b/.test(head))
    if (begins) {
      sawControl = true
      depth += 1
    } else if (closes) {
      sawControl = true
      if (depth === 0) {
        throw new Error('No transaction is active in this query run. Run BEGIN and COMMIT/ROLLBACK together in one selection.')
      }
      depth -= 1
    }
  }
  if (sawControl && depth !== 0) {
    throw new Error('Transactions must begin and commit or roll back in the same query run; pooled connections cannot preserve them across runs.')
  }
}

/** SQL Server's GO is a client batch separator, not T-SQL. */
export function splitSqlServerBatches(sql: string): string[] {
  const masked = maskSql(sql)
  const batches: string[] = []
  let start = 0
  const line = /^\s*go(?:\s+(\d+))?\s*$/gim
  for (const match of masked.matchAll(line)) {
    const batch = sql.slice(start, match.index).trim()
    const repeat = match[1] === undefined ? 1 : Number(match[1])
    if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 1_000) {
      throw new Error('SQL Server GO repeat count must be between 1 and 1,000.')
    }
    if (batch) for (let index = 0; index < repeat; index += 1) batches.push(batch)
    start = match.index + match[0].length
  }
  const tail = sql.slice(start).trim()
  if (tail) batches.push(tail)
  return batches
}

/** Removes mysql-client DELIMITER directives and restores terminators to `;`. */
export function preprocessMysqlDelimiters(sql: string): string {
  let delimiter = ';'
  let state: 'normal' | 'single' | 'double' | 'backtick' | 'block' = 'normal'
  const output: string[] = []
  for (const line of sql.split(/\r?\n/)) {
    const directive = state === 'normal' ? /^\s*delimiter\s+(\S+)\s*$/i.exec(line) : null
    if (directive) {
      delimiter = directive[1]!
      continue
    }
    let transformed = ''
    for (let index = 0; index < line.length;) {
      const char = line[index]!
      const next = line[index + 1]
      if (state === 'block') {
        transformed += char
        index += 1
        if (char === '*' && next === '/') {
          transformed += '/'
          index += 1
          state = 'normal'
        }
        continue
      }
      if (state !== 'normal') {
        transformed += char
        index += 1
        const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`'
        if (char === '\\' && index < line.length) {
          transformed += line[index]!
          index += 1
        } else if (char === quote && next === quote) {
          transformed += next
          index += 1
        } else if (char === quote) {
          state = 'normal'
        }
        continue
      }
      if (char === '-' && next === '-' && (line[index + 2] === undefined || /\s/.test(line[index + 2]!))) {
        transformed += line.slice(index)
        index = line.length
      } else if (char === '#') {
        transformed += line.slice(index)
        index = line.length
      } else if (char === '/' && next === '*') {
        transformed += '/*'
        index += 2
        state = 'block'
      } else if (char === "'" || char === '"' || char === '`') {
        transformed += char
        state = char === "'" ? 'single' : char === '"' ? 'double' : 'backtick'
        index += 1
      } else if (delimiter !== ';' && line.startsWith(delimiter, index)) {
        transformed += ';'
        index += delimiter.length
      } else {
        transformed += char
        index += 1
      }
    }
    output.push(transformed)
  }
  return output.join('\n')
}
