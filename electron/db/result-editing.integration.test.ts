import { expect, it } from 'vitest'
import { editSourceRefusal } from '../../src/sql-edit-context'
import { createPostgresDriver } from './postgres'
import { endpointFor, profileFromUrl, testDatabaseUrl } from './test-db'

const url = testDatabaseUrl()

it.skipIf(!url).each([
  'select e.id, m.id, m.name from (table edit_safety_staff) e join edit_safety_staff m on m.id=e.manager_id',
  'select e.id, m.id, m.name from (edit_safety_staff e join edit_safety_staff m on m.id=e.manager_id)',
  'select 0; with c as (select * from edit_safety_staff) select e.id, m.id, m.name from c e join c m on m.id=e.manager_id',
])('refuses ambiguous writes using real PostgreSQL origins: %s', async (sql) => {
  const profile = profileFromUrl(url!)
  const driver = createPostgresDriver(profile, endpointFor(profile), { onError() {} })
  try {
    await driver.connect()
    await driver.query(`begin;
      create temporary table edit_safety_staff (id integer primary key, manager_id integer, name text);
      insert into edit_safety_staff values (1, 2, 'Alex'), (2, null, 'Alex')`)
    const result = await driver.query(sql)
    expect(result.rows).toEqual([[1, 2, 'Alex']])
    const origin = result.columnSources?.[0]
    expect(origin?.table).toBe('edit_safety_staff')
    expect(result.columnSources?.[2]).toEqual({ ...origin, column: 'name' })
    const table = { schema: origin!.schema, name: origin!.table!, kind: 'table' as const }
    // Both aliases have the same base origin; the source guard must refuse it.
    expect(editSourceRefusal(sql, table, 'postgresql')).not.toBeNull()
  } finally {
    // Disconnect rolls back the fixture transaction and removes the temporary table.
    await driver.disconnect()
  }
})

it.skipIf(!url)('checks set operands and independent PostgreSQL result sets', async () => {
  const profile = profileFromUrl(url!)
  const driver = createPostgresDriver(profile, endpointFor(profile), { onError() {} })
  try {
    await driver.connect()
    await driver.query(`begin;
      create temporary table edit_safety_staff (id integer primary key, name text);
      insert into edit_safety_staff values (2, 'Grace')`)
    const script = 'select * from edit_safety_staff; select id, name from edit_safety_staff'
    const result = await driver.query(script)
    expect(result.rows).toEqual([[2, 'Grace']])
    const origin = result.columnSources?.[0]
    expect(origin?.table).toBe('edit_safety_staff')
    const table = { schema: origin!.schema, name: origin!.table!, kind: 'table' as const }
    expect(editSourceRefusal(script, table, 'postgresql')).toBeNull()

    const union = 'select * from ((select id, name from edit_safety_staff) union all (table edit_safety_staff)) u'
    const combined = await driver.query(union)
    expect(combined.rows).toEqual([[2, 'Grace'], [2, 'Grace']])
    expect(combined.columnSources).toBeUndefined()
    expect(editSourceRefusal(union, table, 'postgresql')).toBe('repeated-table')
  } finally {
    await driver.disconnect()
  }
})
