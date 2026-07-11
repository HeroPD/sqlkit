import type { Engine } from '../../src/electron'
import { maskSql } from '../../src/sql-mask'

export { maskSql }

// SQLite trigger DDL, tested on masked SQL. Shared with sqlite-engine.ts: both
// sides must classify a script identically or END counts wrong (see below).
export const containsSqliteTrigger = (masked: string) => /\bcreate\s+(?:temp(?:orary)?\s+)?trigger\b/i.test(masked)

type SplitScript = { statements: { raw: string; masked: string }[]; masked: string }

// One mask pass shared by the splitter and every per-statement consumer.
function splitScript(sql: string, engine?: Engine): SplitScript {
  const masked = maskSql(sql, engine)
  const statements: SplitScript['statements'] = []
  let depth = 0
  let start = 0
  const push = (from: number, to: number) => {
    if (masked.slice(from, to).trim()) statements.push({ raw: sql.slice(from, to).trim(), masked: masked.slice(from, to).trim() })
  }
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1
    else if (masked[i] === ')') depth = Math.max(0, depth - 1)
    else if (masked[i] === ';' && depth === 0) {
      push(start, i)
      start = i + 1
    }
  }
  push(start, sql.length)
  return { statements, masked }
}

export function splitTopLevelStatements(sql: string, engine?: Engine): string[] {
  return splitScript(sql, engine).statements.map((statement) => statement.raw)
}

// Pooled server queries cannot safely leave a transaction open for a later run:
// that later run may get another connection. Self-contained transaction scripts
// remain supported because one driver.query call keeps one checked-out connection.
export function assertSelfContainedTransaction(sql: string, engine: Engine) {
  let depth = 0
  let sawControl = false
  const script = splitScript(sql, engine)
  // SQLite spells COMMIT as END too, but trigger bodies (BEGIN stmt; … END)
  // split at their inner semicolons here — their END is not a commit.
  const endIsCommit = engine === 'postgresql' || (engine === 'sqlite' && !containsSqliteTrigger(script.masked))
  for (const statement of script.statements) {
    const masked = statement.masked.toLowerCase()
    if (engine === 'sqlserver') {
      // T-SQL semicolons are optional, so scan bodies for tokens; a close at depth
      // 0 may sit in an unexecuted branch (TRY/CATCH), so leave it to the server.
      const controls = masked.matchAll(/\b(?:(begin\s+tran(?:saction)?)|commit(?:\s+(?:tran(?:saction)?|work))?|rollback(?:\s+(?:tran(?:saction)?|work))?)\b/g)
      for (const match of controls) {
        sawControl = true
        if (match[1]) depth += 1
        else if (depth > 0) depth -= 1
      }
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
