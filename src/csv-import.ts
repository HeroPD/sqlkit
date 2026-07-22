const BYTE_ORDER_MARK = '\uFEFF'

export type ParsedCsv = { rows: string[][] }

// Small RFC-4180 parser kept in the renderer so a selected file never needs to
// cross IPC. Quoted delimiters, escaped quotes, and embedded newlines survive.
export function parseCsv(text: string, delimiter = ','): ParsedCsv {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\r' || delimiter === '\n') {
    throw new Error('CSV delimiter must be one character')
  }
  const input = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let fieldStarted = false

  const finishField = () => {
    row.push(field)
    field = ''
    fieldStarted = false
  }
  const finishRow = () => {
    finishField()
    rows.push(row)
    row = []
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quoted) {
      if (char !== '"') {
        field += char
        continue
      }
      if (input[index + 1] === '"') {
        field += '"'
        index += 1
      } else {
        quoted = false
      }
      continue
    }
    if (char === '"' && !fieldStarted && field === '') {
      quoted = true
      fieldStarted = true
      continue
    }
    if (char === delimiter) {
      finishField()
      continue
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] === '\n') index += 1
      finishRow()
      continue
    }
    field += char
    fieldStarted = true
  }

  if (quoted) throw new Error('CSV contains an unterminated quoted field')
  if (fieldStarted || field !== '' || row.length > 0) finishRow()
  return { rows }
}

export function csvShapeError(rows: string[][]): string | null {
  const width = rows[0]?.length ?? 0
  if (!width) return 'The file does not contain any columns.'
  const mismatch = rows.findIndex((row) => row.length !== width)
  return mismatch < 0
    ? null
    : `CSV row ${mismatch + 1} has ${rows[mismatch]?.length ?? 0} fields; expected ${width}.`
}

