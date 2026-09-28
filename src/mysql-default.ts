// MySQL defaults as SQL: literals quoted, expressions parenthesized (bare CURRENT_TIMESTAMP only outside SET DEFAULT).

const LITERAL = /^(?:null|true|false|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|0x[0-9a-f]*|0b[01]*|[xb]'[0-9a-f]*'|(?:_\w+\s*|n)?'(?:[^'\\]|''|\\.)*'|"(?:[^"\\]|""|\\.)*")$/is
const CURRENT_TIMESTAMP = /^(?:(?:current_timestamp|localtime|localtimestamp)(?:\s*\(\s*\d*\s*\))?|now\s*\(\s*\d*\s*\))$/i
const BARE_WORD = /^[a-z_][\w$]*$/i
// Niladic functions MySQL spells without parentheses; a bare word is otherwise a string.
const NILADIC = new Set(['current_date', 'current_time', 'current_user', 'current_role', 'utc_date', 'utc_time', 'utc_timestamp'])
const NUMERIC_TYPE = /^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|dec|numeric|fixed|float|double|real|year|bool|boolean|bit)\b/i
const BINARY_TYPE = /^(?:binary|varbinary|tinyblob|blob|mediumblob|longblob)\b/i

// Whether one pair of parentheses encloses the whole value (so `(a) + (b)` is not).
export function wrappedInParens(value: string): boolean {
  if (!value.startsWith('(') || !value.endsWith(')')) return false
  let depth = 0
  let quote: string | null = null
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0 && index < value.length - 1) return false
    }
  }
  return depth === 0
}

// The DEFAULT operand for a typed value; `alter` is ALTER … SET DEFAULT, which rejects a bare CURRENT_TIMESTAMP.
export function mysqlDefaultOperand(value: string, form: 'column' | 'alter'): string {
  const trimmed = value.trim()
  if (LITERAL.test(trimmed) || wrappedInParens(trimmed)) return trimmed
  if (CURRENT_TIMESTAMP.test(trimmed)) return form === 'alter' ? `(${trimmed})` : trimmed
  if (BARE_WORD.test(trimmed) && !NILADIC.has(trimmed.toLowerCase())) return `'${trimmed}'`
  return `(${trimmed})`
}

// COLUMN_DEFAULT as SHOW CREATE TABLE spells it: MySQL returns literals unquoted and DEFAULT_GENERATED
// expressions escaped once more than SQL; MariaDB 10.2.7+ already returns SQL.
export function mysqlCatalogDefault(
  raw: string | null,
  extra: string,
  columnType: string,
  options: { mariadb?: boolean; noBackslashEscapes?: boolean } = {},
): string | null {
  if (raw === null || options.mariadb) return raw
  if (/\bDEFAULT_GENERATED\b/i.test(extra)) {
    const expression = raw.replace(/\\(.)/gs, '$1')
    return CURRENT_TIMESTAMP.test(expression) || wrappedInParens(expression) ? expression : `(${expression})`
  }
  if (NUMERIC_TYPE.test(columnType) && LITERAL.test(raw)) return raw
  if (BINARY_TYPE.test(columnType) && /^0x[0-9a-f]*$/i.test(raw)) return raw
  const escaped = options.noBackslashEscapes ? raw : raw.replaceAll('\\', '\\\\')
  return `'${escaped.replaceAll("'", "''")}'`
}
