import { describe, expect, it } from 'vitest'
import { abbreviateType, stripExplain } from './sql-types'

describe('abbreviateType', () => {
  it('shortens verbose postgres names', () => {
    expect(abbreviateType('character varying(255)', 'postgresql')).toBe('varchar(255)')
    expect(abbreviateType('character varying', 'postgresql')).toBe('varchar')
    expect(abbreviateType('character(8)', 'postgresql')).toBe('char(8)')
    expect(abbreviateType('bit varying(16)', 'postgresql')).toBe('varbit(16)')
    expect(abbreviateType('double precision', 'postgresql')).toBe('float8')
    expect(abbreviateType('integer', 'postgresql')).toBe('int')
    expect(abbreviateType('boolean', 'postgresql')).toBe('bool')
  })

  it('handles time zone variants, keeping precision', () => {
    expect(abbreviateType('timestamp without time zone', 'postgresql')).toBe('timestamp')
    expect(abbreviateType('timestamp with time zone', 'postgresql')).toBe('timestamptz')
    expect(abbreviateType('timestamp(3) with time zone', 'postgresql')).toBe('timestamptz(3)')
    expect(abbreviateType('time without time zone', 'postgresql')).toBe('time')
    expect(abbreviateType('time with time zone', 'postgresql')).toBe('timetz')
  })

  it('preserves array suffixes', () => {
    expect(abbreviateType('character varying(255)[]', 'postgresql')).toBe('varchar(255)[]')
    expect(abbreviateType('integer[]', 'postgresql')).toBe('int[]')
    expect(abbreviateType('integer[][]', 'postgresql')).toBe('int[][]')
  })

  it('passes unknown postgres types through unchanged', () => {
    expect(abbreviateType('text', 'postgresql')).toBe('text')
    expect(abbreviateType('numeric(10,2)', 'postgresql')).toBe('numeric(10,2)')
    expect(abbreviateType('uuid', 'postgresql')).toBe('uuid')
    expect(abbreviateType('jsonb', 'postgresql')).toBe('jsonb')
  })

  it('leaves other engines untouched', () => {
    expect(abbreviateType('INTEGER', 'sqlite')).toBe('INTEGER')
    expect(abbreviateType('CHARACTER VARYING(255)', 'sqlite')).toBe('CHARACTER VARYING(255)')
    expect(abbreviateType('any', 'sqlite')).toBe('any')
    expect(abbreviateType('int(11) unsigned', 'mysql')).toBe('int(11) unsigned')
    expect(abbreviateType('nvarchar(50)', 'sqlserver')).toBe('nvarchar(50)')
    expect(abbreviateType('integer', null)).toBe('integer')
  })
})

describe('stripExplain', () => {
  it('strips plain and modified explains', () => {
    expect(stripExplain('explain select 1')).toBe('select 1')
    expect(stripExplain('EXPLAIN ANALYZE select 1')).toBe('select 1')
    expect(stripExplain('explain analyze verbose select 1')).toBe('select 1')
    expect(stripExplain('explain (analyze, buffers) select 1')).toBe('select 1')
    expect(stripExplain('explain query plan select 1')).toBe('select 1')
    expect(stripExplain('  EXPLAIN  select 1')).toBe('select 1')
  })

  it('leaves non-explain queries untouched', () => {
    expect(stripExplain('select 1')).toBe('select 1')
    expect(stripExplain('select explain from t')).toBe('select explain from t')
    expect(stripExplain('-- explain\nselect 1')).toBe('-- explain\nselect 1')
  })
})
