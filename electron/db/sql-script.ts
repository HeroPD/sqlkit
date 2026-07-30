import { dialectFor } from '../../src/dialect'
import type { Engine, QuerySort } from '../../src/electron'
import { applyFilterCondition, isFilterableQuery } from '../../src/sql-filter'
import { maskSql, type SqlModeFlags } from '../../src/sql-mask'
import { isReorderableQuery } from '../../src/sql-order'
import { scanGoBatches, splitScript } from '../../src/sql-statements'
import { t } from '../../src/i18n'

export { maskSql }
export { splitTopLevelStatements } from '../../src/sql-statements'

// SQLite trigger DDL, tested on masked SQL. Shared with sqlite-engine.ts: both
// sides must classify a script identically or END counts wrong (see below).
export const containsSqliteTrigger = (masked: string) => /\bcreate\s+(?:temp(?:orary)?\s+)?trigger\b/i.test(masked)

// Pooled server queries cannot safely leave a transaction open for a later run:
// that later run may get another connection. Self-contained transaction scripts
// remain supported because one driver.query call keeps one checked-out connection.
// Returns whether the script drives its own transaction control, so a caller can
// avoid wrapping it in a redundant outer transaction.
export function assertSelfContainedTransaction(sql: string, engine: Engine, mode?: SqlModeFlags): boolean {
  let depth = 0
  let sawControl = false
  const script = splitScript(sql, engine, mode)
  // SQLite spells COMMIT as END too, but trigger bodies (BEGIN stmt; … END)
  // split at their inner semicolons here — their END is not a commit.
  const endIsCommit = engine === 'postgresql' || (engine === 'sqlite' && !containsSqliteTrigger(script.masked))
  const sqlServerTransactionNames = new Set<string>()
  const sqlServerSavepoints = new Set<string>()
  for (const statement of script.statements) {
    const masked = statement.masked.toLowerCase()
    if (engine === 'sqlserver') {
      // T-SQL semicolons are optional, so scan bodies for tokens; a close at depth
      // 0 may sit in an unexecuted branch (TRY/CATCH), so leave it to the server.
      const name = String.raw`[@#A-Za-z_][@#$A-Za-z0-9_]*`
      const transactionName = String.raw`(?!(?:begin|commit|delete|exec(?:ute)?|if|insert|merge|print|raiserror|return|rollback|save|select|set|throw|update|while|with)\b)${name}`
      const controls = masked.matchAll(new RegExp(
        String.raw`\b(?:(begin\s+tran(?:saction)?)(?:[ \t]+(${transactionName}))?|(save\s+tran(?:saction)?)[ \t]+(${transactionName})|(commit(?:\s+(?:tran(?:saction)?|work))?)(?:[ \t]+${transactionName})?|(rollback(?:\s+(?:tran(?:saction)?|work))?)(?:[ \t]+(${transactionName}))?)\b`,
        'g',
      ))
      for (const match of controls) {
        if (match[1]) {
          sawControl = true
          depth += 1
          if (match[2]) sqlServerTransactionNames.add(match[2].toLowerCase())
        } else if (match[3]) {
          sqlServerSavepoints.add(match[4]!.toLowerCase())
        } else if (match[5]) {
          sawControl = true
          if (depth > 0) depth -= 1
        } else if (depth > 0) {
          sawControl = true
          const rollbackName = match[7]?.toLowerCase()
          // An unnamed rollback, or one naming the outer transaction, clears
          // SQL Server's entire transaction stack. A known savepoint rollback
          // leaves @@TRANCOUNT unchanged. Unknown named targets fail closed.
          if (!rollbackName || sqlServerTransactionNames.has(rollbackName)) depth = 0
          else if (sqlServerSavepoints.has(rollbackName)) continue
        }
      }
      continue
    }
    // BEGIN/COMMIT are standalone semicolon-separated statements on these
    // engines, so heads suffice — bodies would false-positive on CASE … END.
    const head = masked.trimStart()
    const begins = /^(?:begin(?:\s+(?:work|transaction))?|start\s+transaction)\b/.test(head)
      && !/^begin\s+atomic\b/.test(head)
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
        throw new Error(t('query.transactionNotActive'))
      }
      depth -= 1
    }
  }
  // A T-SQL script consulting @@TRANCOUNT manages its own transaction state
  // across exclusive branches — token counting cannot judge it, and the
  // session reset at release rolls back anything it truly leaks.
  const managesTrancount = engine === 'sqlserver' && /@@trancount/i.test(script.masked)
  if (sawControl && depth !== 0 && !managesTrancount) {
    throw new Error(t('query.transactionSameRun'))
  }
  return sawControl
}

/** SQL Server's GO is a client batch separator, not T-SQL. Expands each batch by its repeat count. */
export function splitSqlServerBatches(sql: string): string[] {
  const batches: string[] = []
  for (const batch of scanGoBatches(sql)) {
    const repeat = batch.repeat ?? 1
    if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 1_000) {
      throw new Error(t('query.goRepeatRange'))
    }
    if (batch.sql) for (let index = 0; index < repeat; index += 1) batches.push(batch.sql)
  }
  return batches
}

/** Removes mysql-client DELIMITER directives and restores terminators to `;`. */
export function preprocessMysqlDelimiters(sql: string, mode?: SqlModeFlags): string {
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
        // Backslash escapes never apply inside backtick identifiers, and sql_mode
        // can disable them for strings too (same rules as maskSql).
        const backslashEscapes = state !== 'backtick'
          && !mode?.noBackslashEscapes
          && !(state === 'double' && mode?.ansiQuotes)
        if (backslashEscapes && char === '\\' && index < line.length) {
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

export type SqlRunPlan = {
  /** Native execution units. Only SQL Server's client-side GO creates several. */
  batches: string[]
  params: unknown[]
}

// The authoritative preparation step between renderer-selected text and a
// driver's native execution API. Editor selection stays presentation-only;
// dialect preprocessing, safe sorting, transaction validation and client-side
// batch separators are enforced again in the privileged main process.
export function prepareSqlRun(args: {
  engine: Engine
  sql: string
  params?: unknown[]
  sort?: QuerySort | null
  filter?: string | null
  /** MySQL: the session's masking-relevant sql_mode flags, read at connect. */
  sqlMode?: SqlModeFlags
}): SqlRunPlan {
  const params = args.params ?? []
  let sql = args.engine === 'mysql' ? preprocessMysqlDelimiters(args.sql, args.sqlMode) : args.sql

  if (args.filter) {
    if (!isFilterableQuery(sql, args.engine, args.sqlMode)) throw new Error(t('filter.singleSelect'))
    sql = applyFilterCondition(sql, args.filter, args.engine, args.sqlMode)
  }

  if (args.sort) {
    if (!isReorderableQuery(sql, args.engine, args.sqlMode)) throw new Error(t('query.sortSingleSelect'))
    sql = dialectFor(args.engine).applyOrderBy(sql, args.sort, args.sqlMode)
  }

  assertSelfContainedTransaction(sql, args.engine, args.sqlMode)
  const batches = args.engine === 'sqlserver' ? splitSqlServerBatches(sql) : [sql]
  if (params.length && batches.length > 1) {
    throw new Error(t('query.parametersSingleBatch'))
  }
  return { batches, params }
}
