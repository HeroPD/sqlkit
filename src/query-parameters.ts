import type { Engine } from './electron'
import { maskSql } from './sql-mask'

export type QueryParameter = { label: string; position: number }

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
  const declared = new Set<number>()
  if (engine === 'sqlserver') {
    for (const statement of masked.matchAll(/\bdeclare\b([^;]*)/gi)) {
      for (const name of statement[1]!.matchAll(/@p(\d+)\b/gi)) declared.add(Number(name[1]) - 1)
    }
  }
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
