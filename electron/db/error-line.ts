// Maps a failed query's driver error to a 1-based line number in the submitted
// SQL, when the engine reports one. Postgres attaches `position` (a 1-based
// character offset); SQL Server attaches `lineNumber` (1-based, but per GO
// batch, so skipped when the script has batches); MySQL only says "at line N"
// at the end of the message. SQLite reports nothing usable.

const countLine = (sql: string, offset: number) => {
  let line = 1
  for (let i = 0; i < offset && i < sql.length; i += 1) {
    if (sql.charCodeAt(i) === 10) line += 1
  }
  return line
}

export function queryErrorLine(error: unknown, sql: string): number | undefined {
  const raw = (error ?? {}) as { position?: unknown; lineNumber?: unknown; message?: unknown }

  const position = Number(raw.position)
  if (Number.isInteger(position) && position >= 1 && position <= sql.length + 1) {
    return countLine(sql, position - 1)
  }

  const lineNumber = raw.lineNumber
  if (
    typeof lineNumber === 'number' &&
    Number.isInteger(lineNumber) &&
    lineNumber >= 1 &&
    !/^\s*GO\b/im.test(sql)
  ) {
    return Math.min(lineNumber, countLine(sql, sql.length))
  }

  const message = typeof raw.message === 'string' ? raw.message : ''
  const match = /\bat line (\d+)\s*$/.exec(message)
  if (match) {
    const line = Number(match[1])
    return line >= 1 ? Math.min(line, countLine(sql, sql.length)) : undefined
  }

  return undefined
}
