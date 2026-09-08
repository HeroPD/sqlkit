import type { Engine, QueryResult, QueryResultSet } from './electron'
import { isExplainStatement } from './sql-explain'

export type ExecutionPlanMetric = 'duration' | 'cost' | 'none'

export type ExecutionPlanNode = {
  flow: number
  depth: number
  operation: string
  detail?: string
  actualRows?: number
  estimatedRows?: number
  metric?: number
  percent?: number
  hot?: boolean
}

export type ExecutionPlan = {
  metric: ExecutionPlanMetric
  nodes: ExecutionPlanNode[]
  executionMs?: number
  planningMs?: number
}

type RawNode = {
  operation: string
  detail?: string
  actualRows?: number
  estimatedRows?: number
  inclusive?: number
  children: RawNode[]
}

type XmlElement = {
  localName: string
  children: ArrayLike<XmlElement>
  getAttribute(name: string): string | null
  getElementsByTagName(name: string): ArrayLike<XmlElement>
}

type XmlDocument = {
  querySelector(selector: string): XmlElement | null
  getElementsByTagName(name: string): ArrayLike<XmlElement>
}

type XmlParser = { parseFromString(value: string, mimeType: string): XmlDocument }

const number = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const text = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
  return ''
}

const resultSets = (result: QueryResult): QueryResultSet[] => result.resultSets?.length ? result.resultSets : [result]

const planSet = (result: QueryResult, column: (name: string) => boolean): QueryResultSet | undefined =>
  [...resultSets(result)].reverse().find((set) => set.columns.some(column))

const firstCell = (set: QueryResultSet): unknown => set.rows[0]?.[0]

const jsonValue = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}

const cleanIdentifier = (value: string): string => value.replace(/^\[|\]$/g, '').replace(/^"|"$/g, '')

const directChildren = (nodes: RawNode[], parents: Array<string | number | null>, ids: Array<string | number>): RawNode[] => {
  const byId = new Map(ids.map((id, index) => [String(id), nodes[index]!]))
  const roots: RawNode[] = []
  nodes.forEach((node, index) => {
    const parent = parents[index]
    const owner = parent === null || parent === undefined ? undefined : byId.get(String(parent))
    if (owner && owner !== node) owner.children.push(node)
    else roots.push(node)
  })
  return roots
}

const fromIndented = (entries: Array<{ indent: number; node: RawNode }>): RawNode[] => {
  const roots: RawNode[] = []
  const stack: Array<{ indent: number; node: RawNode }> = []
  for (const entry of entries) {
    while (stack.length && stack.at(-1)!.indent >= entry.indent) stack.pop()
    const parent = stack.at(-1)?.node
    if (parent) parent.children.push(entry.node)
    else roots.push(entry.node)
    stack.push(entry)
  }
  return roots
}

const selfMetric = (node: RawNode): number | undefined => {
  if (node.inclusive === undefined) return undefined
  const children = node.children.reduce((sum, child) => sum + (child.inclusive ?? 0), 0)
  return Math.max(0, node.inclusive - children)
}

const finalize = (
  roots: RawNode[],
  metric: ExecutionPlanMetric,
  timing: { executionMs?: number; planningMs?: number } = {},
): ExecutionPlan | null => {
  if (!roots.length) return null
  const own = new Map<RawNode, number>()
  const measured: RawNode[] = []
  const collect = (node: RawNode) => {
    const value = selfMetric(node)
    if (value !== undefined) {
      own.set(node, value)
      measured.push(node)
    }
    node.children.forEach(collect)
  }
  roots.forEach(collect)
  const total = measured.reduce((sum, node) => sum + (own.get(node) ?? 0), 0)
  const tenths = new Map<RawNode, number>()
  if (total > 0) {
    const shares = measured.map((node) => {
      const exact = (own.get(node)! / total) * 1000
      return { node, floor: Math.floor(exact), remainder: exact - Math.floor(exact) }
    })
    let left = 1000 - shares.reduce((sum, share) => sum + share.floor, 0)
    shares.sort((a, b) => b.remainder - a.remainder)
    for (const share of shares) {
      tenths.set(share.node, share.floor + (left > 0 ? 1 : 0))
      if (left > 0) left -= 1
    }
  }
  let flow = 0
  const flows = new Map<RawNode, number>()
  const numberFlow = (node: RawNode) => {
    node.children.forEach(numberFlow)
    flows.set(node, ++flow)
  }
  roots.forEach(numberFlow)
  const flattened: Array<{ raw: RawNode; node: ExecutionPlanNode }> = []
  const flatten = (node: RawNode, depth: number) => {
    const value = own.get(node)
    flattened.push({
      raw: node,
      node: {
        flow: flows.get(node)!,
        depth,
        operation: node.operation,
        ...(node.detail ? { detail: node.detail } : {}),
        ...(node.actualRows !== undefined ? { actualRows: node.actualRows } : {}),
        ...(node.estimatedRows !== undefined ? { estimatedRows: node.estimatedRows } : {}),
        ...(value !== undefined ? { metric: value } : {}),
        ...(tenths.has(node) ? { percent: tenths.get(node)! / 10 } : {}),
      },
    })
    node.children.forEach((child) => flatten(child, depth + 1))
  }
  roots.forEach((root) => flatten(root, 0))
  const useful = flattened.filter(({ node }) => !/^(?:limit|result|gather)$/i.test(node.operation))
  const hottest = (useful.length ? useful : flattened).reduce<typeof flattened[number] | null>(
    (best, entry) => (entry.node.metric ?? -1) > (best?.node.metric ?? -1) ? entry : best,
    null,
  )
  if (hottest && (hottest.node.metric ?? 0) > 0) hottest.node.hot = true
  const inferredExecutionMs = metric === 'duration'
    ? roots.reduce((largest, root) => Math.max(largest, root.inclusive ?? 0), 0)
    : 0
  return {
    metric,
    nodes: flattened.map(({ node }) => node),
    ...timing,
    ...(timing.executionMs === undefined && inferredExecutionMs > 0 ? { executionMs: inferredExecutionMs } : {}),
  }
}

const postgresJson = (value: unknown): ExecutionPlan | null => {
  const parsed = jsonValue(value)
  const payload: unknown = Array.isArray(parsed) ? parsed[0] as unknown : parsed
  if (!payload || typeof payload !== 'object') return null
  const top = payload as Record<string, unknown>
  const rawPlan = top.Plan
  if (!rawPlan || typeof rawPlan !== 'object') return null
  const convert = (source: Record<string, unknown>): RawNode => {
    const loops = number(source['Actual Loops']) ?? 1
    const actualTotal = number(source['Actual Total Time'])
    const relation = text(source['Relation Name'])
    const index = text(source['Index Name'])
    const detail = [relation, index].filter(Boolean).join(' · ')
    return {
      operation: text(source['Node Type']) || 'Operation',
      ...(detail ? { detail } : {}),
      ...(number(source['Actual Rows']) !== undefined ? { actualRows: number(source['Actual Rows'])! * loops } : {}),
      ...(number(source['Plan Rows']) !== undefined ? { estimatedRows: number(source['Plan Rows'])! } : {}),
      ...(actualTotal !== undefined ? { inclusive: actualTotal * loops } : number(source['Total Cost']) !== undefined ? { inclusive: number(source['Total Cost'])! } : {}),
      children: Array.isArray(source.Plans) ? source.Plans.map((child) => convert(child as Record<string, unknown>)) : [],
    }
  }
  const root = convert(rawPlan as Record<string, unknown>)
  const actual = number(top['Execution Time']) !== undefined || root.actualRows !== undefined
  return finalize([root], actual ? 'duration' : 'cost', {
    ...(number(top['Execution Time']) !== undefined ? { executionMs: number(top['Execution Time']) } : {}),
    ...(number(top['Planning Time']) !== undefined ? { planningMs: number(top['Planning Time']) } : {}),
  })
}

const postgresText = (set: QueryResultSet): ExecutionPlan | null => {
  const lines = set.rows.flatMap((row) => text(row[0]).split('\n'))
  const entries: Array<{ indent: number; node: RawNode; cost?: number; actual?: number }> = []
  let executionMs: number | undefined
  let planningMs: number | undefined
  for (const line of lines) {
    executionMs ??= number(/Execution Time:\s*([\d.]+)\s*ms/i.exec(line)?.[1])
    planningMs ??= number(/Planning Time:\s*([\d.]+)\s*ms/i.exec(line)?.[1])
    const cost = /\(cost=[\d.]+\.\.([\d.]+)\s+rows=([\d.]+)/i.exec(line)
    if (!cost) continue
    const actual = /\(actual time=[\d.]+\.\.([\d.]+)\s+rows=([\d.]+)\s+loops=([\d.]+)/i.exec(line)
    // The prefix already names the relation and index the way psql prints them,
    // so it stands as the whole operation.
    const prefix = line.slice(0, line.indexOf('(cost=')).trim().replace(/^->\s*/, '')
    const loops = number(actual?.[3]) ?? 1
    entries.push({
      indent: line.search(/\S/),
      cost: number(cost[1]),
      ...(actual ? { actual: number(actual[1])! * loops } : {}),
      node: {
        operation: prefix,
        ...(number(actual?.[2]) !== undefined ? { actualRows: number(actual?.[2])! * loops } : {}),
        estimatedRows: number(cost[2]),
        children: [],
      },
    })
  }
  // A never-executed node reports its estimate and no time, so on a timed plan
  // its cost stays out of the metric rather than counting as milliseconds.
  const timed = entries.some((entry) => entry.actual !== undefined)
  for (const entry of entries) {
    const inclusive = timed ? entry.actual : entry.cost
    if (inclusive !== undefined) entry.node.inclusive = inclusive
  }
  return finalize(fromIndented(entries), timed ? 'duration' : 'cost', { executionMs, planningMs })
}

const mysqlTree = (set: QueryResultSet): ExecutionPlan | null => {
  const source = set.rows.map((row) => text(row[0])).join('\n')
  if (!source.includes('->')) return null
  const entries: Array<{ indent: number; node: RawNode }> = []
  for (const line of source.split('\n')) {
    const arrow = line.indexOf('->')
    if (arrow < 0) continue
    const actual = /\(actual time=[\d.]+\.\.([\d.]+)\s+rows=([\d.]+)\s+loops=([\d.]+)/i.exec(line)
    // MySQL prints one cost per node, not the `first..total` range Postgres uses
    // — the range stays optional so a plan that carries one still reads.
    const estimate = /\(cost=([\d.]+)(?:\.\.([\d.]+))?\s+rows=([\d.]+)/i.exec(line)
    const estimatedCost = number(estimate?.[2] ?? estimate?.[1])
    const end = [line.indexOf('(cost='), line.indexOf('(actual time=')].filter((at) => at >= 0).sort((a, b) => a - b)[0] ?? line.length
    const label = line.slice(arrow + 2, end).trim().replace(/:\s*$/, '')
    const loops = number(actual?.[3]) ?? 1
    entries.push({
      indent: arrow,
      node: {
        operation: label || 'Operation',
        ...(number(actual?.[2]) !== undefined ? { actualRows: number(actual?.[2])! * loops } : {}),
        ...(number(estimate?.[3]) !== undefined ? { estimatedRows: number(estimate?.[3]) } : {}),
        ...(actual ? { inclusive: number(actual[1])! * loops } : estimatedCost !== undefined ? { inclusive: estimatedCost } : {}),
        children: [],
      },
    })
  }
  return finalize(fromIndented(entries), entries.some(({ node }) => node.actualRows !== undefined) ? 'duration' : 'cost')
}

// Schema 2.0's children hang off `inputs`, and off `inputs_from_select_list`
// for a correlated subquery. Recognised by shape rather than by key name, so a
// child list this release has not seen still lands in the tree.
const mysqlV2Inputs = (source: Record<string, unknown>): Array<Record<string, unknown>> =>
  Object.values(source)
    .flatMap((value): unknown[] => (Array.isArray(value) ? value as unknown[] : [value]))
    .filter((entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      && ('operation' in entry || 'access_type' in entry))

const mysqlV2Node = (source: Record<string, unknown>): RawNode => {
  const loops = number(source.actual_loops) ?? 1
  const actualRows = number(source.actual_rows)
  // Per loop, like the tree format's `actual time=…`, so both multiply out.
  const duration = number(source.actual_last_row_ms)
  const cost = number(source.estimated_total_cost)
  const operation = text(source.operation) || `${text(source.access_type) || 'Operation'} access`
  // The label names the alias ("Table scan on a"); the table behind it is worth
  // showing whenever the label does not already say it.
  const table = text(source.table_name)
  return {
    operation,
    ...(table && !operation.includes(table) ? { detail: table } : {}),
    ...(actualRows !== undefined ? { actualRows: actualRows * loops } : {}),
    ...(number(source.estimated_rows) !== undefined ? { estimatedRows: number(source.estimated_rows) } : {}),
    // Both are totals over the node's own subtree, which is what finalize
    // subtracts children from to get each node's share.
    ...(duration !== undefined ? { inclusive: duration * loops } : cost !== undefined ? { inclusive: cost } : {}),
    children: mysqlV2Inputs(source).map(mysqlV2Node),
  }
}

// EXPLAIN FORMAT=JSON schema 2.0 — MySQL 8.3 and later, and the default from
// 9.0 (explain_json_format_version). It replaces query_block/cost_info with a
// plain operation tree: one labelled node per step, the same steps the tree
// format prints, carrying estimated_total_cost or, under ANALYZE, real timings.
const mysqlJsonV2 = (root: Record<string, unknown>): ExecutionPlan | null => {
  const node = mysqlV2Node(root)
  const some = (candidate: RawNode, predicate: (entry: RawNode) => boolean): boolean =>
    predicate(candidate) || candidate.children.some((child) => some(child, predicate))
  const metric = some(node, (entry) => entry.actualRows !== undefined)
    ? 'duration'
    : some(node, (entry) => entry.inclusive !== undefined) ? 'cost' : 'none'
  return finalize([node], metric)
}

const mysqlJson = (value: unknown): ExecutionPlan | null => {
  const parsed = jsonValue(value)
  if (!parsed || typeof parsed !== 'object') return null
  const v2Root = (parsed as Record<string, unknown>).query_plan
  // Only schema 2.0 has a query_plan; MariaDB and older MySQL keep query_block.
  if (v2Root && typeof v2Root === 'object' && !Array.isArray(v2Root)) return mysqlJsonV2(v2Root as Record<string, unknown>)
  const visit = (value: unknown, label?: string): RawNode[] => {
    if (Array.isArray(value)) {
      const children = value.flatMap((item) => visit(item))
      if (label === 'nested_loop') return [{ operation: 'Nested Loop', children }]
      return children
    }
    if (!value || typeof value !== 'object') return []
    const source = value as Record<string, unknown>
    if (source.table_name !== undefined) {
      const cost = source.cost_info && typeof source.cost_info === 'object' ? source.cost_info as Record<string, unknown> : {}
      const loops = number(source.r_loops) ?? 1
      const actualRows = number(source.r_rows)
      const duration = number(source.r_total_time_ms)
      const detail = [text(source.table_name), text(source.key)].filter(Boolean).join(' · ')
      return [{
        operation: `${text(source.access_type || 'Table')} access`,
        ...(detail ? { detail } : {}),
        ...(actualRows !== undefined ? { actualRows: actualRows * loops } : {}),
        ...(number(source.rows_produced_per_join ?? source.rows_examined_per_scan ?? source.rows) !== undefined
          ? { estimatedRows: number(source.rows_produced_per_join ?? source.rows_examined_per_scan ?? source.rows) }
          : {}),
        ...(duration !== undefined ? { inclusive: duration } : number(cost.prefix_cost ?? cost.query_cost ?? cost.read_cost) !== undefined
          ? { inclusive: number(cost.prefix_cost ?? cost.query_cost ?? cost.read_cost) }
          : {}),
        children: Object.entries(source).flatMap(([key, child]) => key === 'cost_info' ? [] : visit(child, key)),
      }]
    }
    const keys: Record<string, string> = {
      ordering_operation: 'Sort', grouping_operation: 'Aggregate', duplicates_removal: 'Distinct',
      nested_loop: 'Nested Loop', union_result: 'Union', query_block: 'Query',
    }
    const children = Object.entries(source).flatMap(([key, child]) => visit(child, key))
    if (!label || !keys[label]) return children
    const cost = source.cost_info && typeof source.cost_info === 'object' ? source.cost_info as Record<string, unknown> : {}
    const inclusive = number(source.r_total_time_ms ?? cost.query_cost ?? cost.prefix_cost)
    return [{ operation: keys[label], ...(inclusive !== undefined ? { inclusive } : {}), children }]
  }
  const roots = visit(parsed)
  const someNode = (node: RawNode, predicate: (candidate: RawNode) => boolean): boolean => predicate(node) || node.children.some((child) => someNode(child, predicate))
  const actual = roots.some((root) => someNode(root, (node) => node.actualRows !== undefined)) || JSON.stringify(parsed).includes('r_total_time_ms')
  return finalize(roots, actual ? 'duration' : roots.some((root) => root.inclusive !== undefined) ? 'cost' : 'none')
}

const sqlServerXml = (value: unknown): ExecutionPlan | null => {
  if (typeof value !== 'string' || !value.includes('<ShowPlanXML')) return null
  const Parser = (globalThis as unknown as { DOMParser?: new () => XmlParser }).DOMParser
  if (!Parser) return null
  const document = new Parser().parseFromString(value, 'application/xml')
  if (document.querySelector('parsererror')) return null
  const queryPlan = document.getElementsByTagName('QueryPlan')[0]
  if (!queryPlan) return null
  const childRelOps = (element: XmlElement): XmlElement[] => {
    const found: XmlElement[] = []
    for (const child of Array.from(element.children)) {
      if (child.localName === 'RelOp') found.push(child)
      else found.push(...childRelOps(child))
    }
    return found
  }
  const ownedElements = (element: XmlElement, localName: string): XmlElement[] => {
    const found: XmlElement[] = []
    for (const child of Array.from(element.children)) {
      if (child.localName === 'RelOp') continue
      if (child.localName === localName) found.push(child)
      found.push(...ownedElements(child, localName))
    }
    return found
  }
  const convert = (element: XmlElement): RawNode => {
    const counters = ownedElements(element, 'RunTimeCountersPerThread')
    const actualRows = counters.reduce((sum, counter) => sum + (number(counter.getAttribute('ActualRows')) ?? 0), 0)
    const elapsed = counters.reduce((max, counter) => Math.max(max, number(counter.getAttribute('ActualElapsedms')) ?? 0), 0)
    const object = ownedElements(element, 'Object')[0]
    const detail = object
      ? [object.getAttribute('Table'), object.getAttribute('Index')].filter((part): part is string => !!part).map(cleanIdentifier).join(' · ')
      : ''
    return {
      operation: element.getAttribute('PhysicalOp') ?? element.getAttribute('LogicalOp') ?? 'Operation',
      ...(detail ? { detail } : {}),
      ...(counters.length ? { actualRows } : {}),
      ...(number(element.getAttribute('EstimateRows')) !== undefined ? { estimatedRows: number(element.getAttribute('EstimateRows')) } : {}),
      ...(counters.length ? { inclusive: elapsed } : number(element.getAttribute('EstimatedTotalSubtreeCost')) !== undefined
        ? { inclusive: number(element.getAttribute('EstimatedTotalSubtreeCost')) }
        : {}),
      children: childRelOps(element).map(convert),
    }
  }
  const roots = childRelOps(queryPlan).map(convert)
  const timing = document.getElementsByTagName('QueryTimeStats')[0]
  const executionMs = number(timing?.getAttribute('ElapsedTime'))
  return finalize(roots, roots.some((root) => root.actualRows !== undefined) ? 'duration' : 'cost', { executionMs })
}

const sqlServerTable = (set: QueryResultSet): ExecutionPlan | null => {
  const index = (name: string) => set.columns.findIndex((column) => column.toLowerCase() === name.toLowerCase())
  const nodeCol = index('NodeId')
  const textCol = index('StmtText')
  if (nodeCol < 0 || textCol < 0) return null
  const parentCol = index('Parent')
  const operationCol = index('PhysicalOp')
  const rowsCol = index('Rows')
  const estimateRowsCol = index('EstimateRows')
  const costCol = index('TotalSubtreeCost')
  const nodes: RawNode[] = set.rows.map((row) => ({
    operation: text(row[operationCol] ?? row[textCol]).trim().replace(/^\|--/, '') || 'Operation',
    ...(number(row[rowsCol]) !== undefined ? { actualRows: number(row[rowsCol]) } : {}),
    ...(number(row[estimateRowsCol]) !== undefined ? { estimatedRows: number(row[estimateRowsCol]) } : {}),
    ...(number(row[costCol]) !== undefined ? { inclusive: number(row[costCol]) } : {}),
    children: [],
  }))
  const roots = directChildren(nodes, set.rows.map((row) => parentCol >= 0 ? row[parentCol] as string | number | null : null), set.rows.map((row, index) => row[nodeCol] as string | number ?? index))
  return finalize(roots, 'cost')
}

const sqlitePlan = (set: QueryResultSet): ExecutionPlan | null => {
  const lower = set.columns.map((column) => column.toLowerCase())
  const idCol = lower.indexOf('id')
  const parentCol = lower.indexOf('parent')
  const detailCol = lower.indexOf('detail')
  if (idCol < 0 || parentCol < 0 || detailCol < 0) return null
  const nodes = set.rows.map((row) => {
    const label = text(row[detailCol])
    const [operation = 'Operation', ...rest] = label.split(/\s+/)
    return { operation, detail: rest.join(' '), children: [] } satisfies RawNode
  })
  return finalize(directChildren(nodes, set.rows.map((row) => row[parentCol] as string | number | null), set.rows.map((row, index) => row[idCol] as string | number ?? index)), 'none')
}

/** Turns an engine-native EXPLAIN result into the compact result-grid model.
 * Returns null for ordinary queries and unfamiliar plan formats, which keeps
 * the raw result grid as the safe fallback. */
export function parseExecutionPlan(engine: Engine, sql: string | undefined, result: QueryResult): ExecutionPlan | null {
  if (!sql || !isExplainStatement(sql)) return null
  if (engine === 'postgresql') {
    const set = planSet(result, (column) => /query plan/i.test(column) || /json/i.test(column)) ?? result
    return postgresJson(firstCell(set)) ?? postgresText(set)
  }
  if (engine === 'mysql') {
    const set = planSet(result, (column) => /explain|query_block|json/i.test(column)) ?? result
    // JSON first: a plan that parses as JSON is JSON, while the tree reader only
    // looks for `->` — which a JSON plan can carry inside a quoted literal.
    return mysqlJson(firstCell(set)) ?? mysqlTree(set)
  }
  if (engine === 'sqlserver') {
    const set = planSet(result, (column) => /showplan|stmttext/i.test(column)) ?? result
    return sqlServerXml(firstCell(set)) ?? sqlServerTable(set)
  }
  return sqlitePlan(result)
}
