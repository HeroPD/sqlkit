import { describe, expect, it } from 'vitest'
import { dialectFor } from '../../src/dialect'
import { foreignKeyTargets } from '../../src/foreign-keys'
import { quoteQualified } from '../../src/sql-write'
import type { TableRef } from '../../src/electron'
import { createPostgresDriver } from './postgres'
import { endpointFor, profileFromUrl, testDatabaseUrl } from './test-db'

const url = testDatabaseUrl()
// Walks the whole path the UI walks: browse a table, work out which cell is
// followable, build the navigation query the way the workbench does, run it.
;(url ? describe : describe.skip)('follow a foreign key end to end', () => {
  it('navigates from a child row to the parent row it references', async () => {
    const profile = profileFromUrl(url!)
    const driver = createPostgresDriver(profile, endpointFor(profile), { onError: () => {} })
    await driver.connect()
    try {
      await driver.query('drop table if exists e2e_books, e2e_authors cascade')
      await driver.query('create table e2e_authors (id serial primary key, name text not null)')
      await driver.query('create table e2e_books (id serial primary key, title text, author_id int references e2e_authors(id))')
      await driver.query("insert into e2e_authors (name) values ('Le Guin'), ('Herbert')")
      await driver.query("insert into e2e_books (title, author_id) values ('The Dispossessed', 1), ('Dune', 2)")

      const dialect = dialectFor('postgresql')
      const books: TableRef = { schema: 'public', name: 'e2e_books', kind: 'table' }
      const browse = await driver.query(dialect.browseTable(quoteQualified(books, dialect), 200))
      const columns = await driver.listColumns()

      // The grid's affordance comes from exactly this map.
      const targets = foreignKeyTargets(browse, columns)
      const authorCol = browse.columns.indexOf('author_id')
      const target = targets.get(authorCol)
      expect(target).toMatchObject({ table: 'e2e_authors', column: 'id' })
      // title is not a foreign key, so it offers no destination.
      expect(targets.get(browse.columns.indexOf('title'))).toBeUndefined()

      // The value is bound, exactly as the workbench does it.
      const duneRow = browse.rows.find((row) => row[browse.columns.indexOf('title')] === 'Dune')!
      const value = duneRow[authorCol]
      const parent: TableRef = { schema: target!.schema, name: target!.table, kind: 'table' }
      const sql = dialect.browseTableWhere(
        quoteQualified(parent, dialect),
        dialect.quoteIdent(target!.column),
        dialect.placeholder(1),
        200,
      )
      const followed = await driver.query(sql, [value])

      expect(followed.rows).toHaveLength(1)
      expect(followed.rows[0]![followed.columns.indexOf('name')]).toBe('Herbert')
      // The followed result reports its own source, so the trail entry that
      // stores it can be edited against the parent table.
      expect(followed.columnSources?.[followed.columns.indexOf('name')]).toMatchObject({ table: 'e2e_authors', column: 'name' })
    } finally {
      await driver.query('drop table if exists e2e_books, e2e_authors cascade').catch(() => {})
      await driver.disconnect()
    }
  })
})
