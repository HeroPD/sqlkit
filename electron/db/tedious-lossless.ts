import { createRequire } from 'node:module'
import { t } from '../../src/i18n'

type Metadata = { type?: { name?: string }; precision?: number; scale?: number }
type ParserResult = { value: unknown; offset: number }
type ValueParser = {
  readValue(buffer: Buffer, offset: number, metadata: Metadata, options: unknown): ParserResult
}
type Helpers = { NotEnoughDataError: new (byteCount: number) => Error }

const require = createRequire(import.meta.url)
const PATCHED = Symbol.for('sqlkit.tedious.lossless-values')

const requireBytes = (buffer: Buffer, offset: number, count: number, helpers: Helpers) => {
  if (buffer.length < offset + count) throw new helpers.NotEnoughDataError(offset + count)
}

const unsignedLittleEndian = (buffer: Buffer, offset: number, count: number): bigint => {
  let value = 0n
  for (let index = count - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(buffer[offset + index]!)
  return value
}

const fixedText = (signed: bigint, scale: number): string => {
  const negative = signed < 0n
  const magnitude = negative ? -signed : signed
  if (scale === 0) return `${negative ? '-' : ''}${magnitude}`
  const digits = magnitude.toString().padStart(scale + 1, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

export function decodeDecimalPayload(
  buffer: Buffer,
  offset: number,
  scale: number,
  helpers: Helpers,
): ParserResult {
  requireBytes(buffer, offset, 1, helpers)
  const length = buffer[offset]!
  offset += 1
  if (length === 0) return { value: null, offset }
  requireBytes(buffer, offset, length, helpers)
  const positive = buffer[offset] === 1
  const magnitude = unsignedLittleEndian(buffer, offset + 1, length - 1)
  return { value: fixedText(positive ? magnitude : -magnitude, scale), offset: offset + length }
}

const decodeMoneyPayload = (
  buffer: Buffer,
  offset: number,
  bytes: 4 | 8,
  helpers: Helpers,
): ParserResult => {
  requireBytes(buffer, offset, bytes, helpers)
  const raw = bytes === 4
    ? BigInt(buffer.readInt32LE(offset))
    : (BigInt(buffer.readInt32LE(offset)) << 32n) + BigInt(buffer.readUInt32LE(offset + 4))
  return { value: fixedText(raw, 4), offset: offset + bytes }
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

export function decodeDateTimeOffsetPayload(
  buffer: Buffer,
  offset: number,
  scale: number,
  helpers: Helpers,
): ParserResult {
  requireBytes(buffer, offset, 1, helpers)
  const length = buffer[offset]!
  offset += 1
  if (length === 0) return { value: null, offset }
  requireBytes(buffer, offset, length, helpers)
  const timeBytes = length - 5
  const ticks = unsignedLittleEndian(buffer, offset, timeBytes)
  const units = 10n ** BigInt(scale)
  const wholeSeconds = ticks / units
  const fraction = scale ? `.${(ticks % units).toString().padStart(scale, '0')}` : ''
  const days = buffer.readUIntLE(offset + timeBytes, 3)
  const zoneMinutes = buffer.readInt16LE(offset + timeBytes + 3)
  const utcDate = new Date(Date.UTC(2000, 0, days - 730_118) + Number(wholeSeconds) * 1_000)
  const localDate = new Date(utcDate.getTime() + zoneMinutes * 60_000)
  const date = `${pad(localDate.getUTCFullYear(), 4)}-${pad(localDate.getUTCMonth() + 1)}-${pad(localDate.getUTCDate())}`
  const time = `${pad(localDate.getUTCHours())}:${pad(localDate.getUTCMinutes())}:${pad(localDate.getUTCSeconds())}${fraction}`
  const sign = zoneMinutes < 0 ? '-' : '+'
  const absoluteZone = Math.abs(zoneMinutes)
  return {
    value: `${date} ${time} ${sign}${pad(Math.floor(absoluteZone / 60))}:${pad(absoluteZone % 60)}`,
    offset: offset + length,
  }
}

/**
 * Tedious decodes exact numerics through Number and discards datetimeoffset's
 * zone. Its row-token parser calls this exported function dynamically, so a
 * narrow adapter can preserve those wire values without forking the driver.
 * The dependency is pinned and this shape is asserted at startup and in tests.
 */
export function installLosslessTediousParsers() {
  const parser = require('tedious/lib/value-parser.js') as ValueParser & { [PATCHED]?: boolean }
  if (parser[PATCHED]) return
  const helpers = require('tedious/lib/token/helpers.js') as Helpers
  if (typeof parser.readValue !== 'function' || typeof helpers.NotEnoughDataError !== 'function') {
    throw new Error(t('connection.tediousIncompatible'))
  }
  const original = parser.readValue.bind(parser)
  parser.readValue = (buffer, offset, metadata, options) => {
    const type = metadata.type?.name
    if (type === 'NumericN' || type === 'DecimalN') {
      return decodeDecimalPayload(buffer, offset, metadata.scale ?? 0, helpers)
    }
    if (type === 'SmallMoney') return decodeMoneyPayload(buffer, offset, 4, helpers)
    if (type === 'Money') return decodeMoneyPayload(buffer, offset, 8, helpers)
    if (type === 'MoneyN') {
      requireBytes(buffer, offset, 1, helpers)
      const length = buffer[offset]!
      offset += 1
      if (length === 0) return { value: null, offset }
      if (length === 4 || length === 8) return decodeMoneyPayload(buffer, offset, length, helpers)
      throw new Error(`Unsupported SQL Server money payload length ${length}.`)
    }
    if (type === 'DateTimeOffset') {
      return decodeDateTimeOffsetPayload(buffer, offset, metadata.scale ?? 7, helpers)
    }
    return original(buffer, offset, metadata, options)
  }
  Object.defineProperty(parser, PATCHED, { value: true })
}
