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

  // MySQL prints a single cost per node; the `first..total` range in the fixture
  // above is Postgres's shape, and reading only that dropped every row estimate.
  it('reads the single per-node cost the MySQL tree actually prints', () => {
    const tree = `-> Nested loop inner join  (cost=0.7 rows=1) (actual time=0.02..0.03 rows=1 loops=1)
    -> Table scan on a  (cost=0.45 rows=2) (actual time=0.011..0.013 rows=2 loops=1)
    -> Index lookup on b using author_id  (cost=0.35 rows=3) (actual time=0.002..0.004 rows=3 loops=2)`
    const plan = parseExecutionPlan('mysql', 'explain analyze select * from authors', result(['EXPLAIN'], [[tree]]))

    expect(plan?.nodes.map((node) => node.estimatedRows)).toEqual([1, 2, 3])
    // Rows are per loop in the tree format too.
    expect(plan?.nodes[2]?.actualRows).toBe(6)
  })

  // Without timings the same single cost is all a tree plan has to measure by.
  it('measures a tree plan with no timings by its costs', () => {
    const tree = `-> Sort: b.title  (cost=1.2 rows=4)
    -> Table scan on b  (cost=0.45 rows=4)`
    const plan = parseExecutionPlan('mysql', 'explain format=tree select * from books', result(['EXPLAIN'], [[tree]]))

    expect(plan?.metric).toBe('cost')
    expect(plan?.nodes[0]).toMatchObject({ operation: 'Sort: b.title', estimatedRows: 4, metric: 0.75 })
    expect(percentTotal(plan!)).toBe(100)
  })

  // MySQL 8.3 added EXPLAIN FORMAT=JSON schema 2.0 and 9.0 made it the default:
  // query_block/cost_info give way to an operation tree under query_plan, whose
  // metrics live under different names. Read as v1 it yielded metric 'none' and
  // dropped every row estimate.
  it('parses MySQL EXPLAIN FORMAT=JSON schema 2.0 costs and row estimates', () => {
    const plan = parseExecutionPlan('mysql', 'explain format=json select * from customers', result(['EXPLAIN'], [[JSON.stringify({
      query: '/* select#1 */ select ...',
      query_plan: {
        operation: 'Sort: b.title',
        access_type: 'sort',
        sort_fields: ['b.title'],
        inputs: [{
          operation: 'Nested loop inner join',
          access_type: 'join',
          estimated_rows: 1.0,
          estimated_total_cost: 0.7,
          inputs: [
            {
              alias: 'a',
              operation: 'Table scan on a',
              table_name: 'authors',
              access_type: 'table',
              schema_name: 'shop',
              used_columns: ['id', 'name'],
              estimated_rows: 2.0,
              estimated_total_cost: 0.35,
            },
            {
              alias: 'b',
              operation: 'Index lookup on b using author_id (author_id = a.id)',
              index_name: 'author_id',
              table_name: 'books',
              access_type: 'index',
              estimated_rows: 1.0,
              estimated_total_cost: 0.35,
            },
          ],
        }],
      },
      query_type: 'select',
      json_schema_version: '2.0',
    })]]))

    expect(plan?.metric).toBe('cost')
    expect(plan?.nodes.map((node) => node.operation)).toEqual([
      'Sort: b.title', 'Nested loop inner join', 'Table scan on a', 'Index lookup on b using author_id (author_id = a.id)',
    ])
    // The label names the alias, so the table it stands for becomes the detail.
    expect(plan?.nodes[2]).toMatchObject({ detail: 'authors', estimatedRows: 2, metric: 0.35 })
    expect(plan?.nodes[3]).toMatchObject({ detail: 'books', estimatedRows: 1, metric: 0.35 })
    expect(percentTotal(plan!)).toBe(100)
  })

  it('parses schema 2.0 timings, multiplying the per-loop figures out', () => {
    const plan = parseExecutionPlan('mysql', 'explain analyze format=json select * from customers', result(['EXPLAIN'], [[JSON.stringify({
      query_plan: {
        operation: 'Nested loop inner join',
        access_type: 'join',
        actual_rows: 6.0,
        actual_loops: 1,
        estimated_rows: 6.0,
        actual_last_row_ms: 0.9,
        estimated_total_cost: 2.2,
        inputs: [
          {
            operation: 'Table scan on a',
            table_name: 'authors',
            access_type: 'table',
            actual_rows: 2.0,
            actual_loops: 1,
            actual_last_row_ms: 0.1,
            estimated_rows: 2.0,
          },
          {
            operation: 'Index lookup on b using author_id',
            table_name: 'books',
            access_type: 'index',
            actual_rows: 3.0,
            actual_loops: 2,
            actual_last_row_ms: 0.2,
            estimated_rows: 3.0,
          },
        ],
      },
      json_schema_version: '2.0',
    })]]))

    expect(plan?.metric).toBe('duration')
    // Rows and time are reported per loop, as in the tree format.
    expect(plan?.nodes[2]).toMatchObject({ operation: 'Index lookup on b using author_id', actualRows: 6, metric: 0.4 })
    expect(plan?.nodes[1]).toMatchObject({ actualRows: 2, metric: 0.1 })
    // The join's own share is what is left after its two inputs.
    expect(plan?.nodes[0]?.metric).toBeCloseTo(0.4)
    expect(percentTotal(plan!)).toBe(100)
  })

  // The tree reader only looks for `->`, which a JSON plan carries whenever the
  // query holds one in a literal. JSON is tried first so it cannot be misread.
  it('reads a schema 2.0 plan whose condition contains a tree arrow', () => {
    const plan = parseExecutionPlan('mysql', 'explain format=json select * from authors', result(['EXPLAIN'], [[JSON.stringify({
      query: "select `id` from `authors` where (`name` = 'a->b')",
      query_plan: {
        operation: "Filter: (authors.`name` = 'a->b')",
        access_type: 'filter',
        estimated_rows: 1.0,
        estimated_total_cost: 0.35,
        inputs: [{
          operation: 'Table scan on authors',
          table_name: 'authors',
          access_type: 'table',
          estimated_rows: 2.0,
          estimated_total_cost: 0.35,
        }],
      },
      json_schema_version: '2.0',
    })]]))

    expect(plan?.metric).toBe('cost')
    expect(plan?.nodes.map((node) => node.operation)).toEqual(["Filter: (authors.`name` = 'a->b')", 'Table scan on authors'])
  })

  // A correlated subquery hangs off inputs_from_select_list rather than inputs.
  it('follows every schema 2.0 input list, not just the one named inputs', () => {
    const plan = parseExecutionPlan('mysql', 'explain format=json select * from authors', result(['EXPLAIN'], [[JSON.stringify({
      query_plan: {
        operation: 'Covering index scan on a using PRIMARY',
        table_name: 'authors',
        access_type: 'index',
        estimated_rows: 2.0,
        estimated_total_cost: 0.45,
        inputs_from_select_list: [{
          operation: 'Aggregate: count(0)',
          access_type: 'aggregate',
          estimated_rows: 1.0,
          estimated_total_cost: 0.58,
          inputs: [{
            operation: 'Covering index lookup on b using author_id (author_id = a.id)',
            table_name: 'books',
            access_type: 'index',
            estimated_rows: 1.0,
            estimated_total_cost: 0.35,
          }],
        }],
      },
      json_schema_version: '2.0',
    })]]))

    expect(plan?.nodes.map((node) => node.depth)).toEqual([0, 1, 2])
    expect(plan?.nodes[2]?.detail).toBe('books')
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
