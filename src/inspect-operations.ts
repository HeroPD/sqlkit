import type { Engine, TableRef } from './electron'
import { dialectFor } from './dialect'
import {
  buildAddConstraint,
  buildAddForeignKey,
  buildAddPartition,
  buildCreateIndex,
  buildCreateConstraintDefinition,
  buildCreateForeignKeyDefinition,
  buildCreateTrigger,
  quoteLiteral,
  quoteQualified,
  type ConstraintSpec,
  type ForeignKeySpec,
  type IndexSpec,
  type PartitionSpec,
  type TriggerSpec,
} from './sql-write'

export type InspectDropTarget = 'index' | 'trigger' | 'foreignKey' | 'constraint'

export type InspectOperation =
  | { kind: 'index'; spec: IndexSpec }
  | { kind: 'trigger'; spec: TriggerSpec }
  | { kind: 'partition'; spec: PartitionSpec }
  | { kind: 'foreignKey'; spec: ForeignKeySpec }
  | { kind: 'constraint'; spec: ConstraintSpec }
  | { kind: 'drop'; target: InspectDropTarget; name: string }
  | { kind: 'rename'; target: InspectDropTarget; from: string; to: string }

const targetSection = (target: InspectDropTarget): string => {
  if (target === 'index') return 'Indexes'
  if (target === 'trigger') return 'Triggers'
  if (target === 'foreignKey') return 'Foreign Keys'
  return 'Constraints'
}

export const operationSection = (operation: InspectOperation): string => {
  if (operation.kind === 'drop' || operation.kind === 'rename') return targetSection(operation.target)
  if (operation.kind === 'index') return 'Indexes'
  if (operation.kind === 'trigger') return 'Triggers'
  if (operation.kind === 'partition') return 'Partitions'
  if (operation.kind === 'foreignKey') return 'Foreign Keys'
  return 'Constraints'
}

export const operationName = (operation: InspectOperation): string =>
  operation.kind === 'drop' ? operation.name.trim() : operation.kind === 'rename' ? operation.to.trim() : operation.spec.name.trim()

export const operationSourceName = (operation: InspectOperation): string =>
  operation.kind === 'rename' ? operation.from.trim() : operationName(operation)

export const canDropInspectObject = (target: InspectDropTarget, engine: Engine): boolean =>
  engine !== 'sqlite' || target === 'index' || target === 'trigger'

export const canRenameInspectObject = (target: InspectDropTarget, engine: Engine): boolean => {
  if (engine === 'postgresql') return true
  if (engine === 'mysql') return target === 'index'
  if (engine === 'sqlserver') return target !== 'trigger'
  return false
}

function buildDropInspectObject(table: TableRef, target: InspectDropTarget, name: string, engine: Engine): string {
  if (!canDropInspectObject(target, engine)) throw new Error(`SQLite cannot drop a ${target} without rebuilding the table`)
  const dialect = dialectFor(engine)
  const tableName = quoteQualified(table, dialect)
  const objectName = quoteQualified({ schema: table.schema, name, kind: 'table' }, dialect)

  if (target === 'index') {
    if (engine === 'mysql') return `ALTER TABLE ${tableName} DROP INDEX ${dialect.quoteIdent(name)}`
    if (engine === 'sqlserver') return `DROP INDEX ${dialect.quoteIdent(name)} ON ${tableName}`
    return `DROP INDEX ${objectName}`
  }
  if (target === 'trigger') {
    if (engine === 'postgresql') return `DROP TRIGGER ${dialect.quoteIdent(name)} ON ${tableName}`
    return `DROP TRIGGER ${objectName}`
  }
  if (engine === 'mysql') {
    const keyword = target === 'foreignKey' ? 'FOREIGN KEY' : 'CHECK'
    return `ALTER TABLE ${tableName} DROP ${keyword} ${dialect.quoteIdent(name)}`
  }
  return `ALTER TABLE ${tableName} DROP CONSTRAINT ${dialect.quoteIdent(name)}`
}

function buildRenameInspectObject(
  table: TableRef,
  target: InspectDropTarget,
  from: string,
  to: string,
  engine: Engine,
): string {
  if (!canRenameInspectObject(target, engine)) throw new Error(`${engine} cannot rename a ${target} without recreating it`)
  const dialect = dialectFor(engine)
  const tableName = quoteQualified(table, dialect)
  if (engine === 'postgresql') {
    if (target === 'index') {
      const indexName = quoteQualified({ schema: table.schema, name: from, kind: 'table' }, dialect)
      return `ALTER INDEX ${indexName} RENAME TO ${dialect.quoteIdent(to)}`
    }
    if (target === 'trigger') return `ALTER TRIGGER ${dialect.quoteIdent(from)} ON ${tableName} RENAME TO ${dialect.quoteIdent(to)}`
    return `ALTER TABLE ${tableName} RENAME CONSTRAINT ${dialect.quoteIdent(from)} TO ${dialect.quoteIdent(to)}`
  }
  if (engine === 'mysql') {
    return `ALTER TABLE ${tableName} RENAME INDEX ${dialect.quoteIdent(from)} TO ${dialect.quoteIdent(to)}`
  }
  const oldParts = target === 'index'
    ? [table.schema, table.name, from]
    : [table.schema, from]
  const oldName = oldParts.filter((part): part is string => !!part).map((part) => dialect.quoteIdent(part)).join('.')
  const objectType = target === 'index' ? 'INDEX' : 'OBJECT'
  return `EXEC sp_rename N${quoteLiteral(oldName)}, N${quoteLiteral(to)}, N${quoteLiteral(objectType)}`
}

export function buildInspectOperation(table: TableRef, operation: InspectOperation, engine: Engine, creating = false): string {
  switch (operation.kind) {
    case 'drop': return buildDropInspectObject(table, operation.target, operation.name.trim(), engine)
    case 'rename': return buildRenameInspectObject(table, operation.target, operation.from.trim(), operation.to.trim(), engine)
    case 'index': return buildCreateIndex(table, operation.spec, engine)
    case 'trigger': return buildCreateTrigger(table, operation.spec, engine)
    case 'partition': return buildAddPartition(table, operation.spec, engine)
    case 'foreignKey': return creating
      ? buildCreateForeignKeyDefinition(operation.spec, engine)
      : buildAddForeignKey(table, operation.spec, engine)
    case 'constraint': return creating
      ? buildCreateConstraintDefinition(operation.spec, engine)
      : buildAddConstraint(table, operation.spec, engine)
  }
}
