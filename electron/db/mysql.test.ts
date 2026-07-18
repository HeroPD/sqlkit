import { describe, expect, it } from 'vitest'
import { mysqlVersion, writeTargetTable } from './mysql'

describe('mysqlVersion', () => {
  it('labels plain MySQL versions', () => {
    expect(mysqlVersion('9.3.0')).toBe('MySQL 9.3.0')
    expect(mysqlVersion('8.0.36')).toBe('MySQL 8.0.36')
  })

  it('recognizes MariaDB version strings', () => {
    expect(mysqlVersion('11.4.2-MariaDB-1:11.4.2+maria~ubu2404')).toBe('MariaDB 11.4.2')
  })
})

describe('writeTargetTable', () => {
  it('parses the sql-write statement shapes', () => {
    expect(writeTargetTable('UPDATE `books` SET `title` = ? WHERE `id` = ?')).toEqual({ schema: null, name: 'books' })
    expect(writeTargetTable('INSERT INTO `books` (`title`) VALUES (?)')).toEqual({ schema: null, name: 'books' })
    expect(writeTargetTable('DELETE FROM `books` WHERE `id` = ?')).toEqual({ schema: null, name: 'books' })
  })

  it('parses schema-qualified and bare targets', () => {
    expect(writeTargetTable('UPDATE `shop`.`books` SET `x` = ?')).toEqual({ schema: 'shop', name: 'books' })
    expect(writeTargetTable('update `a``b` . `c``d` set `x` = ?')).toEqual({ schema: 'a`b', name: 'c`d' })
    expect(writeTargetTable('update books set x = 1')).toEqual({ schema: null, name: 'books' })
    expect(writeTargetTable('delete from shop.books where id = 1')).toEqual({ schema: 'shop', name: 'books' })
  })

  it('returns null for anything else, so the engine guard fails closed', () => {
    expect(writeTargetTable('SELECT * FROM `books`')).toBeNull()
    expect(writeTargetTable('REPLACE INTO `books` VALUES (1)')).toBeNull()
    expect(writeTargetTable('')).toBeNull()
  })
})
