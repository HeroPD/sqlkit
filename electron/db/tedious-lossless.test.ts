import { describe, expect, it } from 'vitest'
import { decodeDateTimeOffsetPayload, decodeDecimalPayload, installLosslessTediousParsers } from './tedious-lossless'

class NeedMoreData extends Error {
  constructor(byteCount: number) {
    super(`need ${byteCount} bytes`)
  }
}
const helpers = { NotEnoughDataError: NeedMoreData }

const littleEndian = (value: bigint, bytes: number) => {
  const result = Buffer.alloc(bytes)
  let remaining = value
  for (let index = 0; index < bytes; index += 1) {
    result[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return result
}

describe('lossless Tedious value decoding', () => {
  it('decodes a precision-38 decimal directly from its integer payload', () => {
    const magnitude = 12_345_678_901_234_567_890n
    const payload = Buffer.concat([Buffer.from([17, 1]), littleEndian(magnitude, 16)])
    expect(decodeDecimalPayload(payload, 0, 2, helpers)).toEqual({
      value: '123456789012345678.90',
      offset: payload.length,
    })
  })

  it('preserves datetimeoffset fractional precision and original zone', () => {
    const scale = 7
    const utcSeconds = BigInt((4 * 60 * 60) + (34 * 60) + 56)
    const ticks = utcSeconds * (10n ** BigInt(scale)) + 1_234_567n
    // TDS day 730_119 = 2000-01-01 (days since 0001-01-01 proleptic Gregorian).
    const days = 730_119 + Math.floor((Date.UTC(2026, 6, 10) - Date.UTC(2000, 0, 1)) / 86_400_000)
    const payload = Buffer.alloc(1 + 10)
    payload[0] = 10
    littleEndian(ticks, 5).copy(payload, 1)
    payload.writeUIntLE(days, 6, 3)
    payload.writeInt16LE(8 * 60, 9)
    expect(decodeDateTimeOffsetPayload(payload, 0, scale, helpers)).toEqual({
      value: '2026-07-10 12:34:56.1234567 +08:00',
      offset: payload.length,
    })
  })

  it('asserts and installs the pinned Tedious adapter idempotently', () => {
    expect(() => installLosslessTediousParsers()).not.toThrow()
    expect(() => installLosslessTediousParsers()).not.toThrow()
  })
})
