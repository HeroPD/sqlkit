// Turns a thrown value into the string the renderer shows. Reading `.message`
// directly is not enough: Node's dual-stack connect (happy eyeballs) rejects
// with an AggregateError whose own message is empty, and every useful detail —
// the errno, and which address was tried — lives only in `errors`. `pg` and
// `mysql2` propagate that error verbatim, so a refused or firewall-blocked
// connection reported just "". `cause` is deliberately not followed: the
// wrappers that set it already fold the inner message into their own text.

import { t } from '../../src/i18n'

// Enough for both legs of a dual-stack attempt plus headroom; a hostname with
// many A records would otherwise build an unbounded status string.
const MAX_PARTS = 4

// Duck-typed rather than `instanceof AggregateError`: the error may cross a
// worker or realm boundary, and some drivers attach `errors` to a plain Error.
const nestedErrors = (error: Error) => {
  const { errors } = error as { errors?: unknown }
  return Array.isArray(errors) ? errors : null
}

const errno = (error: Error) => {
  const { code } = error as { code?: unknown }
  return typeof code === 'string' && code.trim() ? code : null
}

// Objects are excluded: without a message they stringify to "[object Object]",
// which tells the user less than naming the failure generically.
const primitiveText = (value: unknown) => {
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'bigint':
    case 'boolean':
    case 'symbol':
    case 'undefined':
      return String(value)
    default:
      return null
  }
}

export function errorMessage(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<object>()

  const push = (text: string) => {
    const trimmed = text.trim()
    if (trimmed && !parts.includes(trimmed)) parts.push(trimmed)
  }

  const visit = (value: unknown) => {
    if (value === null || value === undefined) return
    if (typeof value === 'object') {
      if (seen.has(value)) return
      seen.add(value)
    }
    if (!(value instanceof Error)) {
      const message = (value as { message?: unknown }).message
      const text = typeof message === 'string' ? message : primitiveText(value)
      if (text !== null) push(text)
      return
    }
    push(value.message)
    const nested = nestedErrors(value)
    if (nested?.length) nested.forEach(visit)
    // A leaf that says nothing still has an errno worth reporting.
    else if (!value.message.trim()) push(errno(value) ?? value.name)
  }

  visit(error)

  if (!parts.length) {
    if (error instanceof Error) return error.name
    return primitiveText(error) ?? t('common.unknownError')
  }
  if (parts.length > MAX_PARTS) {
    return `${parts.slice(0, MAX_PARTS).join('; ')} (+${parts.length - MAX_PARTS} more)`
  }
  return parts.join('; ')
}

// Every code a failure carries, nested dual-stack legs and one level of cause included:
// Node errnos (ECONNREFUSED), SQLSTATEs (28P01), mysql2 codes, tedious codes.
function failureCodes(error: unknown): Set<string> {
  const codes = new Set<string>()
  const seen = new Set<object>()
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 3) return
    seen.add(value)
    const { code, errno, number, errors, cause } = value as { code?: unknown; errno?: unknown; number?: unknown; errors?: unknown; cause?: unknown }
    if (typeof code === 'string' && code) codes.add(code)
    if (typeof errno === 'number') codes.add(String(errno))
    // SQL Server's own error number: tedious files every login refusal under one code, ELOGIN.
    if (typeof number === 'number') codes.add(`mssql:${number}`)
    if (Array.isArray(errors)) for (const nested of errors) visit(nested, depth + 1)
    visit(cause, depth + 1)
  }
  visit(error, 0)
  return codes
}

const CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID',
])

/** A failed connect, led by what it means and what to try; the driver's own text
 * follows on the next line, so nothing it said is lost. `target` is the host the
 * user typed, not a tunnel's local end. */
export function connectionErrorMessage(error: unknown, target: { host: string; port: string }): string {
  const raw = errorMessage(error)
  const codes = failureCodes(error)
  const has = (...wanted: string[]) => wanted.some((code) => codes.has(code))
  const where = target.port ? `${target.host}:${target.port}` : target.host
  let hint: string | null = null
  if (has('ECONNREFUSED')) hint = t('connection.hintRefused', { where })
  else if (has('ENOTFOUND', 'EAI_AGAIN')) hint = t('connection.hintNotFound', { host: target.host })
  else if (has('ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEOUT')) hint = t('connection.hintTimeout', { where })
  // Only codes that mean the credentials: Postgres 28000 is also a pg_hba refusal, and tedious ELOGIN also a missing database.
  else if (has('28P01', 'ER_ACCESS_DENIED_ERROR', '1045', 'mssql:18456')) hint = t('connection.hintAuth')
  else if (has('3D000', 'ER_BAD_DB_ERROR', '1049', 'mssql:4060')) hint = t('connection.hintNoDatabase')
  else if ([...codes].some((code) => CERTIFICATE_CODES.has(code))) hint = t('connection.hintCertificate')
  return hint ? `${hint}\n${raw}` : raw
}
