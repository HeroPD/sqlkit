import type { Engine } from '../../src/electron'
import { maskSql } from '../../src/sql-mask'

export { maskSql }

export function splitTopLevelStatements(sql: string, engine?: Engine): string[] {
  const masked = maskSql(sql, engine)
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

// Pooled server queries cannot safely leave a transaction open for a later run:
// that later run may get another connection. Self-contained transaction scripts
// remain supported because one driver.query call keeps one checked-out connection.
export function assertSelfContainedTransaction(sql: string, engine: Engine) {
  let depth = 0
  let sawControl = false
  const apply = (control: 'begin' | 'close') => {
    sawControl = true
    if (control === 'begin') {
      depth += 1
    } else if (depth === 0) {
      throw new Error('No transaction is active in this query run. Run BEGIN and COMMIT/ROLLBACK together in one selection.')
    } else {
      depth -= 1
    }
  }
  // SQLite spells COMMIT as END too, but trigger bodies (BEGIN stmt; … END)
  // split at their inner semicolons here — their END is not a commit.
  const endIsCommit = engine === 'postgresql'
    || (engine === 'sqlite' && !/\bcreate\s+(?:temp(?:orary)?\s+)?trigger\b/i.test(maskSql(sql, engine)))
  for (const statement of splitTopLevelStatements(sql, engine)) {
    const masked = maskSql(statement, engine).toLowerCase()
    if (engine === 'sqlserver') {
      // T-SQL semicolons are optional, so one split statement can hold the whole
      // BEGIN TRAN … COMMIT script — scan bodies for control tokens, in order.
      const controls = masked.matchAll(/\b(?:(begin\s+tran(?:saction)?)|commit(?:\s+(?:tran(?:saction)?|work))?|rollback(?:\s+(?:tran(?:saction)?|work))?)\b/g)
      for (const match of controls) apply(match[1] ? 'begin' : 'close')
      continue
    }
    // BEGIN/COMMIT are standalone semicolon-separated statements on these
    // engines, so heads suffice — bodies would false-positive on CASE … END.
    const head = masked.trimStart()
    const begins = /^(?:begin(?:\s+(?:work|transaction))?|start\s+transaction)\b/.test(head)
      // MariaDB's anonymous compound block, not a transaction start.
      && !/^begin\s+not\s+atomic\b/.test(head)
    const closes = /^commit(?:\s+(?:work|transaction))?\b/.test(head)
      || (endIsCommit && /^end(?:\s+(?:work|transaction))?\b/.test(head))
      || (/^rollback(?:\s+(?:work|transaction))?\b/.test(head) && !/^rollback\s+to\b/.test(head))
    if (begins) apply('begin')
    else if (closes) apply('close')
  }
  if (sawControl && depth !== 0) {
    throw new Error('Transactions must begin and commit or roll back in the same query run; pooled connections cannot preserve them across runs.')
  }
}

/** SQL Server's GO is a client batch separator, not T-SQL. */
export function splitSqlServerBatches(sql: string): string[] {
  const masked = maskSql(sql, 'sqlserver')
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
