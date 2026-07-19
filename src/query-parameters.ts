import type { Engine } from './electron'
import { maskSql } from './sql-mask'

export type QueryParameter = { label: string; position: number }

const TSQL_STATEMENT_HEAD = /^\s*(?:alter|backup|begin|break|close|commit|create|deallocate|declare|delete|deny|drop|exec(?:ute)?|fetch|go|grant|if|insert|merge|open|print|raiserror|reconfigure|restore|return|revoke|rollback|save|select|set|throw|truncate|update|use|waitfor|while|with)\b/i

// DECLARE has no required terminator in T-SQL. Read only its declaration list,
// stopping when a later line starts another statement; scanning every @pN up to
// the next semicolon mistakes parameters in that following statement for locals.
function sqlServerDeclaredParameters(masked: string): Set<number> {
  const declared = new Set<number>()
  for (const declaration of masked.matchAll(/\bdeclare\b/gi)) {
    const tail = masked.slice((declaration.index ?? 0) + declaration[0].length)
    const lines = tail.split(/\r?\n/)
    const body: string[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      if (index > 0 && TSQL_STATEMENT_HEAD.test(line)) break
      const semicolon = line.indexOf(';')
      body.push(semicolon < 0 ? line : line.slice(0, semicolon))
      if (semicolon >= 0) break
    }

    const text = body.join('\n')
    let depth = 0
    let expectName = true
    for (let index = 0; index < text.length;) {
      const char = text[index]!
      if (expectName) {
        if (/\s/.test(char)) {
          index += 1
          continue
        }
        const name = /^@([A-Za-z_][\w@$#]*)/.exec(text.slice(index))
        if (!name) break
        const parameter = /^p(\d+)$/i.exec(name[1]!)
        if (parameter) declared.add(Number(parameter[1]) - 1)
        index += name[0].length
        expectName = false
        continue
      }
      if (depth === 0 && /[A-Za-z]/.test(char) && TSQL_STATEMENT_HEAD.test(text.slice(index))) break
      if (char === '(') depth += 1
      else if (char === ')') depth = Math.max(0, depth - 1)
      else if (char === ',' && depth === 0) expectName = true
      index += 1
    }
  }
  return declared
}

/** Finds native driver placeholders while ignoring strings, identifiers, and comments. */
export function queryParameters(sql: string, engine: Engine): QueryParameter[] {
  const masked = maskSql(sql, engine)
  if (engine === 'mysql') {
    return [...masked.matchAll(/\?\?|\?/g)].map((match, index) => ({
      label: `${match[0]} (${index + 1})`,
      position: index,
    }))
  }
  if (engine === 'sqlite') {
    const parameters: QueryParameter[] = []
    const seen = new Set<number>()
    let next = 0
    for (const match of masked.matchAll(/\?(\d+)?/g)) {
      const position = match[1] ? Math.max(0, Number(match[1]) - 1) : next
      next = Math.max(next + (match[1] ? 0 : 1), position + 1)
      if (seen.has(position)) continue
      seen.add(position)
      parameters.push({ label: match[1] ? `?${match[1]}` : `? (${position + 1})`, position })
    }
    return parameters
  }
  const pattern = engine === 'postgresql' ? /\$(\d+)/g : /@p(\d+)\b/gi
  // T-SQL @pN names introduced by DECLARE are script variables, not driver parameters.
  const declared = engine === 'sqlserver' ? sqlServerDeclaredParameters(masked) : new Set<number>()
  const positions = new Set<number>()
  for (const match of masked.matchAll(pattern)) {
    const position = Number(match[1]) - 1
    if (position >= 0 && !declared.has(position)) positions.add(position)
  }
  return [...positions].sort((a, b) => a - b).map((position) => ({
    label: engine === 'postgresql' ? `$${position + 1}` : `@p${position + 1}`,
    position,
  }))
}

export function bindParameterValues(parameters: QueryParameter[], values: string[]): unknown[] {
  const bound = Array.from<unknown>({ length: Math.max(0, ...parameters.map((parameter) => parameter.position + 1)) }).fill(null)
  parameters.forEach((parameter, index) => {
    const value = values[index] ?? ''
    bound[parameter.position] = value.trim().toUpperCase() === 'NULL' ? null : value
  })
  return bound
}
