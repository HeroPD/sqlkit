// Static SQL colouring for the places that display a statement rather than edit
// one: the review dialog and the results panel's query popover. The editor uses
// CodeMirror's own highlighter, so this deliberately stays a small tokenizer —
// keywords and string literals are what make a statement readable at a glance.

const SQL_KEYWORDS = new Set(
  `SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL CROSS ON GROUP ORDER BY HAVING INSERT INTO VALUES UPDATE SET DELETE WITH AS DISTINCT UNION ALL EXCEPT INTERSECT CASE WHEN THEN ELSE END AND OR NOT NULL IS IN LIKE BETWEEN EXISTS TRUE FALSE CREATE ALTER DROP TABLE INDEX VIEW PRIMARY KEY FOREIGN REFERENCES RETURNING LIMIT OFFSET`
    .split(/\s+/),
)

export type SqlPreviewPart = { text: string; kind: 'keyword' | 'string' | null }

const pushPart = (parts: SqlPreviewPart[], text: string, kind: SqlPreviewPart['kind'] = null) => {
  if (!text) return
  const last = parts.at(-1)
  if (last?.kind === kind) last.text += text
  else parts.push({ text, kind })
}

export function sqlPreviewParts(sql: string): SqlPreviewPart[] {
  const parts: SqlPreviewPart[] = []
  for (let i = 0; i < sql.length;) {
    const ch = sql[i]
    if (ch === undefined) break
    if (ch === "'") {
      let end = i + 1
      while (end < sql.length) {
        if (sql[end] === "'" && sql[end + 1] === "'") {
          end += 2
          continue
        }
        if (sql[end] === "'") {
          end += 1
          break
        }
        end += 1
      }
      pushPart(parts, sql.slice(i, end), 'string')
      i = end
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][\w$]*/.exec(sql.slice(i))
      const word = match?.[0] ?? ch
      pushPart(parts, word, SQL_KEYWORDS.has(word.toUpperCase()) ? 'keyword' : null)
      i += word.length
      continue
    }
    pushPart(parts, ch)
    i += 1
  }
  return parts
}

// Renders a bound parameter in SQL-ish form for review only; execution still
// uses the original parameterized query.
export const formatPreviewParam = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return `'${JSON.stringify(value).replaceAll("'", "''")}'`
}

export const previewSql = (sql: string, params: unknown[]): string => {
  if (!params.length) return sql
  if (/\$\d+/.test(sql)) {
    return sql.replace(/\$(\d+)/g, (match, n: string) => {
      const value = params[Number(n) - 1]
      return value === undefined ? match : formatPreviewParam(value)
    })
  }
  // SQL Server binds named params (@p1, @p2, ..); substitute those for review too.
  if (/@p\d+/.test(sql)) {
    return sql.replace(/@p(\d+)/g, (match, n: string) => {
      const value = params[Number(n) - 1]
      return value === undefined ? match : formatPreviewParam(value)
    })
  }
  let index = 0
  return sql.replace(/\?/g, (match) => (index < params.length ? formatPreviewParam(params[index++]) : match))
}
