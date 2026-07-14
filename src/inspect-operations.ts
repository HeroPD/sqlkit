import type { Engine, TableRef } from './electron'
import {
  buildAddConstraint,
  buildAddForeignKey,
  buildAddPartition,
  buildCreateIndex,
  buildCreateTrigger,
  type ConstraintSpec,
  type ForeignKeySpec,
  type IndexSpec,
  type PartitionSpec,
  type TriggerSpec,
} from './sql-write'

export type InspectOperation =
  | { kind: 'index'; spec: IndexSpec }
  | { kind: 'trigger'; spec: TriggerSpec }
  | { kind: 'partition'; spec: PartitionSpec }
  | { kind: 'foreignKey'; spec: ForeignKeySpec }
  | { kind: 'constraint'; spec: ConstraintSpec }

export const operationSection = (operation: InspectOperation): string => {
  if (operation.kind === 'index') return 'Indexes'
  if (operation.kind === 'trigger') return 'Triggers'
  if (operation.kind === 'partition') return 'Partitions'
  if (operation.kind === 'foreignKey') return 'Foreign Keys'
  return 'Constraints'
}

export const operationName = (operation: InspectOperation): string => operation.spec.name.trim()

export function buildInspectOperation(table: TableRef, operation: InspectOperation, engine: Engine): string {
  switch (operation.kind) {
    case 'index': return buildCreateIndex(table, operation.spec, engine)
    case 'trigger': return buildCreateTrigger(table, operation.spec, engine)
    case 'partition': return buildAddPartition(table, operation.spec, engine)
    case 'foreignKey': return buildAddForeignKey(table, operation.spec, engine)
    case 'constraint': return buildAddConstraint(table, operation.spec, engine)
  }
}
