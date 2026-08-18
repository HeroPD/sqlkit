import { describe, expect, it } from 'vitest'
import type { Engine, TableRef } from './electron'
import { buildInspectOperation, canDropInspectObject, isInspectOperation, type InspectDropTarget } from './inspect-operations'

const users: TableRef = { schema: 'app', name: 'users', kind: 'table' }
const drop = (engine: Engine, target: InspectDropTarget, name: string) =>
  buildInspectOperation(users, { kind: 'drop', target, name }, engine)

describe('inspect object drops', () => {
  it('builds PostgreSQL drops with the correct object scope', () => {
    expect(drop('postgresql', 'index', 'users_email_idx')).toBe('DROP INDEX "app"."users_email_idx"')
    expect(drop('postgresql', 'trigger', 'audit_users')).toBe('DROP TRIGGER "audit_users" ON "app"."users"')
    expect(drop('postgresql', 'constraint', 'users_age_check')).toBe(
      'ALTER TABLE "app"."users" DROP CONSTRAINT "users_age_check"',
    )
    expect(drop('postgresql', 'foreignKey', 'users_team_fk')).toBe(
      'ALTER TABLE "app"."users" DROP CONSTRAINT "users_team_fk"',
    )
  })

  it('uses MySQL DROP INDEX, DROP CHECK, and DROP FOREIGN KEY forms', () => {
    expect(drop('mysql', 'index', 'users_email_idx')).toBe('ALTER TABLE `app`.`users` DROP INDEX `users_email_idx`')
    expect(drop('mysql', 'constraint', 'users_age_check')).toBe('ALTER TABLE `app`.`users` DROP CHECK `users_age_check`')
    expect(drop('mysql', 'foreignKey', 'users_team_fk')).toBe('ALTER TABLE `app`.`users` DROP FOREIGN KEY `users_team_fk`')
    expect(drop('mysql', 'trigger', 'audit_users')).toBe('DROP TRIGGER `app`.`audit_users`')
  })

  it('uses SQL Server index and schema-object forms', () => {
    expect(drop('sqlserver', 'index', 'users_email_idx')).toBe('DROP INDEX [users_email_idx] ON [app].[users]')
    expect(drop('sqlserver', 'trigger', 'audit_users')).toBe('DROP TRIGGER [app].[audit_users]')
    expect(drop('sqlserver', 'foreignKey', 'users_team_fk')).toBe(
      'ALTER TABLE [app].[users] DROP CONSTRAINT [users_team_fk]',
    )
  })

  it('allows standalone SQLite indexes and triggers but rejects table constraints', () => {
    const sqliteTable: TableRef = { schema: null, name: 'users', kind: 'table' }
    expect(buildInspectOperation(sqliteTable, { kind: 'drop', target: 'index', name: 'users_email_idx' }, 'sqlite'))
      .toBe('DROP INDEX "users_email_idx"')
    expect(buildInspectOperation(sqliteTable, { kind: 'drop', target: 'trigger', name: 'audit_users' }, 'sqlite'))
      .toBe('DROP TRIGGER "audit_users"')
    expect(canDropInspectObject('foreignKey', 'sqlite')).toBe(false)
    expect(() => buildInspectOperation(sqliteTable, { kind: 'drop', target: 'foreignKey', name: 'fk' }, 'sqlite'))
      .toThrow(/rebuilding the table/i)
  })
})

describe('inspect object renames', () => {
  it('builds native PostgreSQL rename statements', () => {
    expect(buildInspectOperation(users, { kind: 'rename', target: 'index', from: 'old_idx', to: 'new_idx' }, 'postgresql'))
      .toBe('ALTER INDEX "app"."old_idx" RENAME TO "new_idx"')
    expect(buildInspectOperation(users, { kind: 'rename', target: 'trigger', from: 'old_trg', to: 'new_trg' }, 'postgresql'))
      .toBe('ALTER TRIGGER "old_trg" ON "app"."users" RENAME TO "new_trg"')
    expect(buildInspectOperation(users, { kind: 'rename', target: 'foreignKey', from: 'old_fk', to: 'new_fk' }, 'postgresql'))
      .toBe('ALTER TABLE "app"."users" RENAME CONSTRAINT "old_fk" TO "new_fk"')
  })

  it('renames only indexes on MySQL/MariaDB', () => {
    expect(buildInspectOperation(users, { kind: 'rename', target: 'index', from: 'old_idx', to: 'new_idx' }, 'mysql'))
      .toBe('ALTER TABLE `app`.`users` RENAME INDEX `old_idx` TO `new_idx`')
    expect(() => buildInspectOperation(users, { kind: 'rename', target: 'trigger', from: 'old', to: 'new' }, 'mysql'))
      .toThrow(/cannot rename/i)
  })

  it('builds SQL Server sp_rename calls for indexes and constraints', () => {
    expect(buildInspectOperation(users, { kind: 'rename', target: 'index', from: 'old_idx', to: 'new_idx' }, 'sqlserver'))
      .toBe("EXEC sp_rename N'[app].[users].[old_idx]', N'new_idx', N'INDEX'")
    expect(buildInspectOperation(users, { kind: 'rename', target: 'constraint', from: 'old_ck', to: 'new_ck' }, 'sqlserver'))
      .toBe("EXEC sp_rename N'[app].[old_ck]', N'new_ck', N'OBJECT'")
    expect(() => buildInspectOperation(users, { kind: 'rename', target: 'trigger', from: 'old', to: 'new' }, 'sqlserver'))
      .toThrow(/cannot rename/i)
  })

  it('rejects SQLite object renames', () => {
    expect(() => buildInspectOperation(users, { kind: 'rename', target: 'index', from: 'old', to: 'new' }, 'sqlite'))
      .toThrow(/cannot rename/i)
  })
})

// Staged operations restored from a session file are only as trustworthy as the
// file: a spec short of what the inspect view renders crashes it outright.
describe('isInspectOperation', () => {
  it('accepts the operations the inspect view builds', () => {
    expect(isInspectOperation({ kind: 'index', spec: { name: 'i', columns: ['a'], unique: false } })).toBe(true)
    expect(isInspectOperation({ kind: 'trigger', spec: { name: 't', timing: 'BEFORE', events: ['INSERT'], level: 'ROW' } })).toBe(true)
    expect(isInspectOperation({ kind: 'partition', spec: { name: 'p', bounds: 'FROM (1) TO (2)' } })).toBe(true)
    expect(isInspectOperation({ kind: 'foreignKey', spec: { name: 'fk', columns: ['a'], refTable: 'b', refColumns: ['id'] } })).toBe(true)
    expect(isInspectOperation({ kind: 'constraint', spec: { name: 'c', type: 'CHECK', expression: 'a > 0' } })).toBe(true)
    expect(isInspectOperation({ kind: 'constraint', spec: { name: 'c', type: 'UNIQUE', columns: ['a'] } })).toBe(true)
    expect(isInspectOperation({ kind: 'drop', target: 'index', name: 'i' })).toBe(true)
    expect(isInspectOperation({ kind: 'rename', target: 'index', from: 'i', to: 'j' })).toBe(true)
  })

  it('rejects anything the view would then fail to render', () => {
    expect(isInspectOperation({ kind: 'index', spec: { name: 'i' } })).toBe(false)
    expect(isInspectOperation({ kind: 'index', spec: { name: 'i', columns: [1], unique: false } })).toBe(false)
    expect(isInspectOperation({ kind: 'constraint', spec: { name: 'c', type: 'UNIQUE' } })).toBe(false)
    expect(isInspectOperation({ kind: 'constraint', spec: { name: 'c', type: 'EXCLUDE', columns: ['a'] } })).toBe(false)
    expect(isInspectOperation({ kind: 'drop', target: 'table', name: 'users' })).toBe(false)
    expect(isInspectOperation({ kind: 'notebook' })).toBe(false)
    expect(isInspectOperation(null)).toBe(false)
    expect(isInspectOperation([])).toBe(false)
  })
})
