import { describe, expect, it } from 'vitest'
import { bindParameterValues, queryParameters } from './query-parameters'

describe('queryParameters', () => {
  it('deduplicates and orders PostgreSQL positions while ignoring inert text', () => {
    expect(queryParameters("select $2, '$1', $1, $2 -- $3", 'postgresql')).toEqual([
      { label: '$1', position: 0 }, { label: '$2', position: 1 },
    ])
  })

  it('counts MySQL placeholders in occurrence order', () => {
    expect(queryParameters("select ?? from t where note = '?' and id = ?", 'mysql')).toEqual([
      { label: '?? (1)', position: 0 }, { label: '? (2)', position: 1 },
    ])
  })

  it('recognizes SQL Server native parameter names case-insensitively', () => {
    expect(queryParameters('select * from t where a = @P2 or b = @p1', 'sqlserver')).toEqual([
      { label: '@p1', position: 0 }, { label: '@p2', position: 1 },
    ])
  })

  it('ignores SQL Server @pN names declared as script variables', () => {
    expect(queryParameters('declare @p1 int; set @p1 = 5; select @p1, @p2', 'sqlserver')).toEqual([
      { label: '@p2', position: 1 },
    ])
  })
})

it('binds text verbatim and treats an explicit NULL token as SQL null', () => {
  expect(bindParameterValues([{ label: '$1', position: 0 }, { label: '$2', position: 1 }], [' 42 ', 'NULL']))
    .toEqual([' 42 ', null])
})
