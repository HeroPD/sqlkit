import type { Engine } from './electron'

/** The two plan flavors History offers: `plan` only compiles the statement,
 * `analyze` runs it and reports what the server actually did. */
export type ExplainFlavor = 'plan' | 'analyze'

/** Leading version numbers of a serverVersion banner ("MySQL 8.0.18" → [8, 0, 18]). */
const versionParts = (serverVersion: string): number[] =>
  (/(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(serverVersion)?.slice(1) ?? []).map((part) => Number(part ?? 0))

const atLeast = (serverVersion: string, ...minimum: number[]): boolean => {
  const parts = versionParts(serverVersion)
  if (!parts.length) return false
  for (const [index, floor] of minimum.entries()) {
    const part = parts[index] ?? 0
    if (part !== floor) return part > floor
  }
  return true
}

/** MySQL grew EXPLAIN ANALYZE in 8.0.18; MariaDB never took that syntax and
 * spells the same thing `ANALYZE <statement>` (10.1+). Neither exists on older
 * servers, and an unreported version is treated as too old. */
const mysqlAnalyzePrefix = (serverVersion: string | null): string | null => {
  if (!serverVersion) return null
  if (/mariadb/i.test(serverVersion)) return atLeast(serverVersion, 10, 1) ? 'analyze ' : null
  return atLeast(serverVersion, 8, 0, 18) ? 'explain analyze ' : null
}

/** Which flavors the live server understands. Order is menu order. */
export function explainFlavors(engine: Engine, serverVersion: string | null): ExplainFlavor[] {
  switch (engine) {
    // EXPLAIN ANALYZE predates every supported release, here and on the
    // PG-compatible engines that reach this driver.
    case 'postgresql':
      return ['plan', 'analyze']
    case 'mysql':
      return mysqlAnalyzePrefix(serverVersion) ? ['plan', 'analyze'] : ['plan']
    // EXPLAIN QUERY PLAN is the only plan SQLite reports; it never runs the query.
    case 'sqlite':
      return ['plan']
    case 'sqlserver':
      return ['plan', 'analyze']
  }
}

const trimStatement = (sql: string) => sql.trim().replace(/;+\s*$/, '')

/** SQL Server has no EXPLAIN: a plan comes from a session SET that makes the
 * statements after it report themselves, so each flavor is a small script.
 *
 * SET SHOWPLAN_ALL has to own its batch, hence the GO, and the restoring SET is
 * left out — a batch that returns nothing still counts as a result set, and the
 * plan has to be the run's last one or the results panel opens on an empty grid.
 * Releasing the pooled connection resets it (sp_reset_connection), which clears
 * the switch; a connection pinned by a manual transaction is never reset, so
 * there the script restores the session itself.
 *
 * SET STATISTICS PROFILE carries no batch rule, so the analyze flavor turns
 * itself back off inside its single batch — which is also what lets it run with
 * parameters bound. */
const sqlServerExplain = (flavor: ExplainFlavor, sql: string, inTransaction: boolean): string => {
  const statement = trimStatement(sql)
  if (flavor === 'analyze') return `set statistics profile on; ${statement}; set statistics profile off`
  const script = `set showplan_all on\ngo\n${statement}`
  return inTransaction ? `${script}\ngo\nset showplan_all off` : script
}

/** The statement that reports `sql`'s plan on this server. Any explain wrapper
 * the SQL already carries is stripped first, so re-explaining never stacks. */
export function explainStatement(args: {
  engine: Engine
  serverVersion: string | null
  flavor: ExplainFlavor
  sql: string
  /** A manual transaction pins the connection, which changes what SQL Server
   * may leave switched on. */
  inTransaction?: boolean
}): string {
  const sql = stripExplain(args.sql)
  if (args.engine === 'sqlserver') return sqlServerExplain(args.flavor, sql, args.inTransaction ?? false)
  if (args.engine === 'sqlite') return `explain query plan ${sql}`
  if (args.flavor === 'plan') return `explain ${sql}`
  if (args.engine === 'mysql') return (mysqlAnalyzePrefix(args.serverVersion) ?? 'explain ') + sql
  return `explain analyze ${sql}`
}

// Postgres/MySQL/SQLite wrappers, including pg's option list and MariaDB's bare
// ANALYZE — which is only a wrapper in front of a query, never in front of the
// ANALYZE TABLE that maintains statistics.
const EXPLAIN_PREFIX = /^\s*explain\b\s*(\([^)]*\)\s*)?((?:query\s+plan|analyze|verbose|format\s*=\s*\w+)\b\s*)*/i
const ANALYZE_PREFIX = /^\s*analyze\s+(?:format\s*=\s*\w+\s+)?(?=(?:select|with|insert|update|delete|replace)\b)/i
// The SQL Server SETs above, with the GO or semicolon that separates them.
const PLAN_SET = /set\s+(?:showplan_(?:all|xml|text)|statistics\s+(?:xml|profile))/.source
// Both only strip around a statement, so a run of the SET on its own survives.
const PLAN_SET_ON = new RegExp(`^\\s*${PLAN_SET}\\s+on\\s*;?\\s*(?:go\\b[^\\n]*\\n)?(?=[\\s\\S]*\\S)`, 'i')
const PLAN_SET_OFF = new RegExp(`(?<=\\S)\\s*(?:;|\\bgo\\b[^\\n]*\\n)?\\s*${PLAN_SET}\\s+off\\s*;?\\s*$`, 'i')

/** Strips whatever explain wrapper `sql` carries, so an explain of an explain
 * plans the original statement. */
export function stripExplain(sql: string): string {
  const unwrapped = sql.replace(PLAN_SET_ON, '').replace(PLAN_SET_OFF, '')
  return unwrapped.replace(EXPLAIN_PREFIX, '').replace(ANALYZE_PREFIX, '')
}
