import { describe, expect, it } from 'vitest'
import type { Engine, TableRef } from './electron'
import { editSourceRefusal, inferEditableTable, sqlSourceTables, tableReferencedTwice } from './sql-edit-context'

const tables: TableRef[] = [
  { schema: 'public', name: 'users', kind: 'table' },
  { schema: 'public', name: 'orders', kind: 'table' },
  { schema: 'audit', name: 'users', kind: 'table' },
  { schema: null, name: 'notes', kind: 'table' },
]

describe('inferEditableTable', () => {
  it('infers an unambiguous single-table select', () => {
    expect(inferEditableTable('  select id, body from notes where id = 1', tables)).toEqual({
      schema: null,
      name: 'notes',
      kind: 'table',
    })
  })

  it('infers a quoted schema-qualified table', () => {
    expect(inferEditableTable('SELECT * FROM "public"."users" LIMIT 20', tables)).toEqual({
      schema: 'public',
      name: 'users',
      kind: 'table',
    })
  })

  it('ignores FROM inside strings and comments', () => {
    expect(inferEditableTable("select 'from nowhere' as label -- from fake\nfrom notes", tables)?.name).toBe('notes')
  })

  it('rejects joins, comma sources and set operations', () => {
    expect(inferEditableTable('select * from users join orders on orders.user_id = users.id', tables)).toBeNull()
    expect(inferEditableTable('select * from users, orders', tables)).toBeNull()
    expect(inferEditableTable('select * from notes union select * from notes', tables)).toBeNull()
  })

  it('rejects ambiguous unqualified table names and subquery sources', () => {
    expect(inferEditableTable('select * from users', tables)).toBeNull()
    expect(inferEditableTable('select * from (select * from notes) n', tables)).toBeNull()
  })
})

describe('tableReferencedTwice', () => {
  const notes: TableRef = { schema: null, name: 'notes', kind: 'table' }
  const users: TableRef = { schema: 'public', name: 'users', kind: 'table' }
  const twice = (sql: string, table = notes) => tableReferencedTwice(sql, table, 'postgresql')

  it('reads every source the statement names, in order', () => {
    expect(sqlSourceTables('select * from public.users u join orders o on o.user_id = u.id')).toEqual([
      { schema: 'public', name: 'users' },
      { schema: null, name: 'orders' },
    ])
  })

  it('accepts a table read once', () => {
    expect(twice('select * from notes')).toBe(false)
    expect(twice('select n.id from notes n order by n.id limit 10')).toBe(false)
    expect(twice('select n.id, o.id from notes n join orders o on o.note_id = n.id')).toBe(false)
  })

  it('flags a self-join, however it is written', () => {
    expect(twice('select a.id, b.id from notes a join notes b on b.id = a.parent_id')).toBe(true)
    expect(twice('select a.id, b.id from notes a, notes b where b.id = a.parent_id')).toBe(true)
    expect(twice('select a.id, b.id from notes a left outer join notes b on b.id = a.parent_id')).toBe(true)
  })

  it('flags a derived table or CTE over the same table, whose columns reach the result', () => {
    expect(twice('select n.id, d.body from notes n join (select id, body from notes) d on d.id = n.parent_id')).toBe(true)
    expect(twice('with c as (select id, body from notes) select n.id, c.body from notes n join c on c.id = n.parent_id')).toBe(true)
    expect(twice('select n.id from notes n cross join lateral (select 1 from notes) z')).toBe(true)
  })

  // Nothing an expression subquery selects is projected, so re-reading the
  // table there leaves every origin in the result unambiguous.
  it('ignores subqueries in expression position', () => {
    expect(twice('select n.id from notes n where n.id in (select parent_id from notes)')).toBe(false)
    expect(twice('select n.id, (select count(*) from notes x) as total from notes n')).toBe(false)
  })

  it('ignores names inside strings and comments, and separates schemas', () => {
    expect(twice("select * from notes where body = 'from notes x'")).toBe(false)
    expect(twice('select * from notes /* join notes b */')).toBe(false)
    expect(twice('select * from public.users a join audit.users b on b.id = a.id', users)).toBe(false)
    expect(twice('select * from users a join users b on b.id = a.id', users)).toBe(true)
  })
})


describe('quoted and CTE source safety', () => {
  const table: TableRef = { schema: 'public', name: 'employees', kind: 'table' }
  it.each<[Engine, string]>([
    ['postgresql', '"public"."employees"'],
    ['mysql', '`public`.`employees`'],
    ['sqlserver', '[public].[employees]'],
  ])('detects quoted self-joins for %s', (engine, name) => {
    expect(tableReferencedTwice(`select a.id, b.name from /* source */ ${name} a join ${name} b on b.id=a.manager_id`, table, engine)).toBe(true)
    expect(sqlSourceTables(`select * from ${name}`, engine)).toEqual([{ schema: 'public', name: 'employees' }])
  })
  it('refuses CTE provenance, including repeated and chained references', () => {
    for (const sql of [
      'with c as (select * from employees) select a.id, b.name from c a join c b on b.id=a.manager_id',
      'with "c" as (select * from employees), d as (select * from "c") select a.id, b.name from d a join d b on b.id=a.manager_id',
      'with recursive c as (select * from employees union all select e.* from employees e join c on c.id=e.manager_id) select * from c',
    ]) expect(tableReferencedTwice(sql, table, 'postgresql')).toBe(true)
  })
})


describe('CTE declaration detection', () => {
  const notes: TableRef = { schema: null, name: 'notes', kind: 'table' }
  it.each([
    'select id, row_number() over w from notes window w as (partition by kind)',
    'select id from notes cross join json_to_record(payload) as (col int)',
  ])('does not mistake another AS clause for a CTE: %s', (sql) => {
    expect(editSourceRefusal(sql, notes, 'postgresql')).toBeNull()
  })
  it.each([
    'with c as (select * from notes) select * from c',
    '; /* comment */ with c as (select * from notes) select * from c',
    'select * from (with c as (select * from notes) select * from c) d',
    'with c as not materialized (select * from notes), d as (select * from c) select * from d',
  ])('keeps actual CTEs refused: %s', (sql) => {
    expect(editSourceRefusal(sql, notes, 'postgresql')).toBe('cte')
  })
})


describe('grouped joins and script boundaries', () => {
  const table: TableRef = { schema: 'public', name: 'employees', kind: 'table' }
  it.each<[Engine, string]>([
    ['postgresql', '"public"."employees"'],
    ['mysql', '`public`.`employees`'],
    ['sqlserver', '[public].[employees]'],
  ])('counts the first source in nested join groups for %s', (engine, name) => {
    for (const from of [
      `(${name} e join ${name} m on m.id=e.manager_id)`,
      `((${name} e join ${name} m on m.id=e.manager_id))`,
      `(${name} e, ${name} m)`,
      `(/* first source */ ${name} e join (select * from ${name}) m on m.id=e.manager_id)`,
    ]) {
      const sql = `select e.id, m.id, m.name from ${from}`
      expect(sqlSourceTables(sql, engine).filter(source => source.name === 'employees')).toHaveLength(2)
      expect(editSourceRefusal(sql, table, engine)).toBe('repeated-table')
    }
  })
  it('keeps unambiguous grouped tables and nested subqueries usable', () => {
    for (const from of ['(employees e)', '((select * from employees)) e', '(employees e join departments d on d.id=e.department_id)']) {
      expect(editSourceRefusal(`select e.id from ${from}`, table, 'postgresql')).toBeNull()
    }
  })
  it.each<[Engine, string]>([
    ['postgresql', "select '; with fake as (select 1)'; /* next */"],
    ['postgresql', 'select $$; with fake as (select 1)$$;'],
    ['mysql', 'select 0; # next statement\n'],
    ['sqlserver', 'select 0\ngo\n'],
  ])('finds later CTEs using %s statement boundaries', (engine, prefix) => {
    const cte = 'with c as (select * from employees) select e.id, m.id, m.name from c e join c m on m.id=e.manager_id'
    expect(editSourceRefusal(`${prefix} ${cte}`, table, engine)).toBe('cte')
  })
  it('does not mistake a later named window for a CTE', () => {
    expect(editSourceRefusal('select 0; select id, row_number() over w from employees window w as (partition by manager_id)', table, 'postgresql')).toBeNull()
  })
})


describe('query operands and independent results', () => {
  const table: TableRef = { schema: 'public', name: 'employees', kind: 'table' }
  it.each([
    'table employees',
    'table only employees',
    'table /* source */ "public"."employees"',
    '(table employees)',
  ])('counts TABLE query sources: %s', operand => {
    const sql = `select e.id, m.name from (${operand}) e join employees m on m.id=e.manager_id`
    expect(sqlSourceTables(sql, 'postgresql')).toHaveLength(2)
    expect(editSourceRefusal(sql, table, 'postgresql')).toBe('repeated-table')
    expect(editSourceRefusal(operand, table, 'postgresql')).toBeNull()
  })
  it.each(['union all', 'intersect', 'except'])('walks parenthesized %s operands', operator => {
    const sql = `select * from ((select * from employees) ${operator} ((table employees))) u`
    expect(sqlSourceTables(sql, 'postgresql').map(source => source.name)).toEqual(['employees', 'employees'])
    expect(editSourceRefusal(sql, table, 'postgresql')).toBe('repeated-table')
  })
  it.each<Engine>(['postgresql', 'mysql', 'sqlserver'])('counts references separately for %s statements', engine => {
    const separator = engine === 'sqlserver' ? '\nGO\n' : ';'
    const single = 'select id, name from employees'
    expect(editSourceRefusal(`${single}${separator}${single}`, table, engine)).toBeNull()
    const ambiguous = 'select e.id, m.name from employees e join employees m on m.id=e.manager_id'
    for (const sql of [`${single}${separator}${ambiguous}`, `${ambiguous}${separator}${single}`]) {
      expect(editSourceRefusal(sql, table, engine)).toBe('repeated-table')
    }
  })
})
