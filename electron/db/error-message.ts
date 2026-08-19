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
