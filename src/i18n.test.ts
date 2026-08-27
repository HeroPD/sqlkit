import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE, formatBytes, formatDecimal, formatInteger, getLocale, rowWord, setLocale, SUPPORTED_LOCALES, t } from './i18n'

describe('i18n', () => {
  it('uses en-US as the initial and only supported locale', () => {
    expect(DEFAULT_LOCALE).toBe('en-US')
    expect(SUPPORTED_LOCALES).toEqual(['en-US'])
    setLocale('en-US')
    expect(getLocale()).toBe('en-US')
  })

  it('interpolates named values and leaves missing values visible', () => {
    expect(t('status.manyConnected', { count: 3 })).toBe('3 connected')
    expect(t('status.manyConnected')).toBe('{count} connected')
  })

  it('provides locale-aware number and plural helpers', () => {
    expect(formatInteger(12_345)).toBe('12,345')
    expect(rowWord(1)).toBe('row')
    expect(rowWord(2)).toBe('rows')
  })

  it('groups and rounds decimals through the active locale', () => {
    expect(formatDecimal(1_234.5)).toBe('1,234.5')
    expect(formatDecimal(0.12345)).toBe('0.12')
    expect(formatDecimal(0.12345, 4)).toBe('0.1235')
    expect(formatDecimal(7)).toBe('7')
  })

  it('formats allocated byte counts for compact metadata labels', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1_024)).toBe('1 KB')
    expect(formatBytes(12.4 * 1_024 * 1_024)).toBe('12.4 MB')
    expect(formatBytes(-1)).toBe('—')
  })
})
