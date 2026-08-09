import type { Engine } from './electron'
import type { SqlModeFlags } from './sql-mask'
import { splitScript } from './sql-statements'

// Whether a script only reads, for the read-only guardrail on engines whose
// sessions can't enforce it themselves (SQL Server). Unlike sql-order's
// isReadOnlyQuery — which vets a single statement for re-run-safe export —
// this accepts multi-statement scripts and T-SQL's read-shaped tails
// (FOR JSON/XML/BROWSE, OPTION hints), checking each statement on its own.

/** Statement heads that begin a read. Everything else — EXEC, DECLARE, SET,
 * DDL — stays blocked: a head this classifier can't see into is not a read. */
const READ_HEADS = new Set(['select', 'values', 'show', 'pragma', 'table', 'with'])

// T-SQL statements need no semicolon between them, so a write can hide behind
// a read head ('SELECT 1 DELETE t' is two statements, one to the splitter).
// Scan the whole masked statement for writing/executing words at any depth;
// quoted names and strings are already blanked, a qualified name's tail
// (sys.objects' "objects") is skipped via the preceding dot, and multi-part
// words (create_date, dm_exec_sql_text) never match a bare keyword.
const WRITE_WORDS =
  /(?:^|[^.\w$])(?:insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|exec|execute|call|into|backup|restore|kill|dbcc)(?![\w$])/i

// Outside SQL Server a top-level FOR ends a query in a row lock
// (FOR UPDATE/SHARE); UPDATE is caught above, but SHARE and friends are not.
const FOR_WORD = /(?:^|[^.\w$])for(?![\w$])/i

const leadingKeyword = (masked: string): string => /^\s*([A-Za-z0-9_$]+)/.exec(masked)?.[1]!.toLowerCase() ?? ''

export function isReadOnlyScript(sql: string, engine?: Engine, mode?: SqlModeFlags): boolean {
  const { statements } = splitScript(sql, engine, mode)
  if (!statements.length) return false
  return statements.every(({ masked }) => {
    if (!READ_HEADS.has(leadingKeyword(masked))) return false
    if (WRITE_WORDS.test(masked)) return false
    return engine === 'sqlserver' || !FOR_WORD.test(masked)
  })
}
