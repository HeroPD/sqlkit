// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { QueryResult } from './electron'
import { parseExecutionPlan } from './execution-plan'

const result = (columns: string[], rows: unknown[][], durationMs = 1): QueryResult => ({
  columns,
  rows,
  rowCount: rows.length,
  durationMs,
})

const percentTotal = (plan: NonNullable<ReturnType<typeof parseExecutionPlan>>) =>
  plan.nodes.reduce((sum, node) => sum + (node.percent ?? 0), 0)

describe('parseExecutionPlan', () => {
  it('normalizes PostgreSQL JSON actual plans into post-order flow and self duration', () => {
    const plan = parseExecutionPlan('postgresql', 'explain (analyze, buffers, format json) select * from users', result(['QUERY PLAN'], [[[
      {
        Plan: {
          'Node Type': 'Limit',
          'Plan Rows': 10,
          'Actual Rows': 4,
          'Actual Loops': 1,
          'Actual Total Time': 0.027,
          Plans: [{
            'Node Type': 'Seq Scan',
            'Relation Name': 'users',
            'Plan Rows': 610,
            'Actual Rows': 4,
            'Actual Loops': 1,
            'Actual Total Time': 0.011,
          }],
        },
        'Planning Time': 0.063,
        'Execution Time': 0.042,
      },
    ]]]))

    expect(plan).not.toBeNull()
    expect(plan?.metric).toBe('duration')
    expect(plan?.executionMs).toBe(0.042)
    expect(plan?.planningMs).toBe(0.063)
    expect(plan?.nodes.map((node) => ({ flow: node.flow, depth: node.depth, operation: node.operation }))).toEqual([
      { flow: 2, depth: 0, operation: 'Limit' },
      { flow: 1, depth: 1, operation: 'Seq Scan' },
    ])
    expect(plan?.nodes[0]?.metric).toBeCloseTo(0.016)
    expect(plan?.nodes[1]?.detail).toBe('users')
    expect(percentTotal(plan!)).toBe(100)
  })

  it('normalizes PostgreSQL estimate plans as cost rather than milliseconds', () => {
    const plan = parseExecutionPlan('postgresql', 'explain (format json) select * from users', result(['QUERY PLAN'], [[[
      { Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'users', 'Plan Rows': 610, 'Total Cost': 16.1 } },
    ]]]))

    expect(plan?.metric).toBe('cost')
    expect(plan?.nodes[0]).toMatchObject({ operation: 'Seq Scan', estimatedRows: 610, metric: 16.1, percent: 100 })
  })

  it('parses the PostgreSQL text plan a row per line, leaving a never-executed node unmeasured', () => {
    // psql prints one line per node with the detail lines between them, and the
    // grid hands them over a row each.
    const lines = [
      'Nested Loop  (cost=0.58..15.08 rows=10 width=13) (actual time=0.022..0.027 rows=0.00 loops=1)',
      '  Buffers: shared hit=2',
      "  ->  Index Scan using customers_pkey on customers c  (cost=0.29..2.51 rows=1 width=13) (actual time=0.022..0.022 rows=0.00 loops=1)",
      "        Index Cond: (id = '-1'::integer)",
      "  ->  Index Scan using orders_customer on orders o  (cost=0.29..12.48 rows=10 width=8) (never executed)",
      "        Index Cond: (customer_id = '-1'::integer)",
      'Planning Time: 0.853 ms',
      'Execution Time: 0.150 ms',
    ]
    const plan = parseExecutionPlan('postgresql', 'explain (analyze, buffers) select * from customers', result(['QUERY PLAN'], lines.map((line) => [line])))

    expect(plan?.metric).toBe('duration')
    expect(plan?.executionMs).toBe(0.15)
    expect(plan?.planningMs).toBe(0.853)
    expect(plan?.nodes.map((node) => ({ flow: node.flow, depth: node.depth, operation: node.operation }))).toEqual([
      { flow: 3, depth: 0, operation: 'Nested Loop' },
      { flow: 1, depth: 1, operation: 'Index Scan using customers_pkey on customers c' },
      { flow: 2, depth: 1, operation: 'Index Scan using orders_customer on orders o' },
    ])
    expect(plan?.nodes[1]?.metric).toBeCloseTo(0.022)
    // Its cost is not a duration, so the node the query never ran carries none.
    expect(plan?.nodes[2]?.metric).toBeUndefined()
    expect(plan?.nodes[2]?.estimatedRows).toBe(10)
    expect(percentTotal(plan!)).toBe(100)
  })

  it('reads the PostgreSQL text estimate plan as cost', () => {
    const lines = [
      'Sort  (cost=1.12..1.13 rows=610 width=13)',
      '  Sort Key: name',
      '  ->  Seq Scan on users  (cost=0.00..16.10 rows=610 width=13)',
    ]
    const plan = parseExecutionPlan('postgresql', 'explain select * from users', result(['QUERY PLAN'], lines.map((line) => [line])))

    expect(plan?.metric).toBe('cost')
    expect(plan?.nodes.map((node) => node.operation)).toEqual(['Sort', 'Seq Scan on users'])
    expect(plan?.nodes[1]?.metric).toBeCloseTo(16.1)
    expect(percentTotal(plan!)).toBe(100)
  })

  it('parses the MySQL EXPLAIN ANALYZE tree and makes self-duration shares total 100%', () => {
    const tree = `-> Limit: 10 row(s)  (cost=10..10 rows=10) (actual time=0.055..0.0555 rows=10 loops=1)
    -> Sort: total_spent DESC  (cost=9..9 rows=19) (actual time=0.0549..0.0552 rows=10 loops=1)
        -> Table scan on customers  (cost=2..4 rows=19) (actual time=0.00383..0.0349 rows=19 loops=1)`
    const plan = parseExecutionPlan('mysql', 'explain analyze select * from customers', result(['EXPLAIN'], [[tree]]))

    expect(plan?.metric).toBe('duration')
    expect(plan?.nodes.map((node) => node.flow)).toEqual([3, 2, 1])
    expect(plan?.nodes[1]?.operation).toBe('Sort: total_spent DESC')
    expect(plan?.nodes[1]?.metric).toBeCloseTo(0.0203)
    expect(percentTotal(plan!)).toBe(100)
  })

  it('parses MariaDB ANALYZE FORMAT=JSON table timing', () => {
    const plan = parseExecutionPlan('mysql', 'analyze format=json select * from customers', result(['ANALYZE'], [[JSON.stringify({
      query_block: {
        table: {
          table_name: 'customers',
          access_type: 'ALL',
          rows: 19,
          r_rows: 19,
          r_loops: 1,
          r_total_time_ms: 0.12,
        },
      },
    })]]))

    expect(plan?.metric).toBe('duration')
    expect(plan?.nodes.find((node) => node.detail === 'customers')).toMatchObject({ actualRows: 19, estimatedRows: 19 })
    expect(percentTotal(plan!)).toBe(100)
  })

  it('parses SQL Server actual Showplan XML without borrowing child counters', () => {
    const xml = `<?xml version="1.0"?><ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple><QueryPlan><QueryTimeStats ElapsedTime="17" CpuTime="17"/><RelOp NodeId="0" PhysicalOp="Sort" EstimateRows="10" EstimatedTotalSubtreeCost="2"><RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="10" ActualElapsedms="15"/></RunTimeInformation><Sort><RelOp NodeId="1" PhysicalOp="Clustered Index Scan" EstimateRows="15" EstimatedTotalSubtreeCost="1"><RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="15" ActualElapsedms="4"/></RunTimeInformation><IndexScan><Object Table="[customers]" Index="[PK_customers]"/></IndexScan></RelOp></Sort></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`
    const plan = parseExecutionPlan('sqlserver', 'set statistics xml on; select * from customers; set statistics xml off', result(['Microsoft SQL Server 2005 XML Showplan'], [[xml]], 20))

    expect(plan?.metric).toBe('duration')
    expect(plan?.executionMs).toBe(17)
    expect(plan?.nodes[0]).toMatchObject({ operation: 'Sort', actualRows: 10, metric: 11 })
    expect(plan?.nodes[1]).toMatchObject({ operation: 'Clustered Index Scan', actualRows: 15, metric: 4, detail: 'customers · PK_customers' })
    expect(percentTotal(plan!)).toBe(100)
  })

  it('parses SQLite query plans and ignores ordinary query results', () => {
    const sqlite = parseExecutionPlan('sqlite', 'explain query plan select * from users', result(
      ['id', 'parent', 'notused', 'detail'],
      [[2, 0, 0, 'SCAN users']],
    ))
    expect(sqlite?.metric).toBe('none')
    expect(sqlite?.nodes[0]).toMatchObject({ operation: 'SCAN', detail: 'users' })
    expect(parseExecutionPlan('postgresql', 'select * from users', result(['id'], [[1]]))).toBeNull()
  })
})

describe('parseExecutionPlan statement detection', () => {
  it('leaves ANALYZE TABLE to the raw grid, sharing one owner with the explain builder', () => {
    const maintenance = result(['Table', 'Op', 'Msg_type', 'Msg_text'], [['books', 'analyze', 'status', 'OK']])
    expect(parseExecutionPlan('mysql', 'analyze table books', maintenance)).toBeNull()
    expect(parseExecutionPlan('postgresql', 'ANALYZE users', result([], []))).toBeNull()
  })

  it('ignores an ordinary query that merely mentions explain', () => {
    expect(parseExecutionPlan('sqlite', 'select explain from t', result(['explain'], [['x']]))).toBeNull()
  })
})
