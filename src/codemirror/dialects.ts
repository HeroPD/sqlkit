import { MSSQL, MySQL, PostgreSQL, SQLite, SQLDialect } from '@codemirror/lang-sql'
import { dialectFor } from '../dialect'
import type { Engine } from '../electron'

export type SqlDialectName = 'postgres' | 'mssql' | 'sqlite' | 'mysql'

/** The editor dialect (highlighting, parsing, completion) for a connection's engine. */
export const dialectForEngine: Record<Engine, SqlDialectName> = {
  postgresql: 'postgres',
  sqlite: 'sqlite',
  mysql: 'mysql',
  sqlserver: 'mssql',
}

export type SqlDialectConfig = {
  dialect: SQLDialect
  /** Keywords offered by autocomplete. Extend per dialect as needed. */
  keywords: readonly string[]
  /** Engine-correct identifier quoting, for completing names that can't appear bare. */
  quoteIdent: (name: string) => string
}

/** ANSI core shared by every dialect; dialect-specific keywords go in SQL_DIALECTS. */
const COMMON_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'CROSS JOIN',
  'ON',
  'GROUP BY',
  'ORDER BY',
  'HAVING',

  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',

  'WITH',
  'AS',
  'DISTINCT',

  'UNION',
  'UNION ALL',
  'EXCEPT',
  'INTERSECT',

  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',

  'AND',
  'OR',
  'NOT',
  'NULL',
  'IS NULL',
  'IS NOT NULL',
  'IN',
  'NOT IN',
  'LIKE',
  'BETWEEN',
  'EXISTS',

  'TRUE',
  'FALSE',

  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'COALESCE',
  'NULLIF',
  'CURRENT_DATE',
  'CURRENT_TIMESTAMP',

  'CREATE',
  'ALTER',
  'DROP',
  'TABLE',
  'INDEX',
  'VIEW',
  'PRIMARY KEY',
  'FOREIGN KEY',
  'REFERENCES',
] as const

// Completion.boost is documented as -99..99; keep every value in range.
export const KEYWORD_BOOSTS: Record<string, number> = {
  SELECT: 99,
  FROM: 95,
  WHERE: 90,
  JOIN: 85,
  'LEFT JOIN': 80,
  'ORDER BY': 75,
  'GROUP BY': 75,
  LIMIT: 70,
  TOP: 70,
  INSERT: 65,
  UPDATE: 65,
  DELETE: 65,
}

export const SQL_DIALECTS: Record<SqlDialectName, SqlDialectConfig> = {
  postgres: {
    dialect: SQLDialect.define({
      ...PostgreSQL.spec, 
      doubleDollarQuotedStrings: false
    }),
    keywords: [...COMMON_KEYWORDS, 'LIMIT', 'OFFSET', 'ILIKE', 'RETURNING', 'NOW'],
    quoteIdent: dialectFor('postgresql').quoteIdent,
  },
  mssql: {
    dialect: MSSQL,
    keywords: [...COMMON_KEYWORDS, 'TOP', 'OUTPUT', 'IDENTITY', 'GETDATE'],
    quoteIdent: dialectFor('sqlserver').quoteIdent,
  },
  sqlite: {
    dialect: SQLite,
    keywords: [...COMMON_KEYWORDS, 'LIMIT', 'OFFSET', 'RETURNING', 'PRAGMA', 'AUTOINCREMENT'],
    quoteIdent: dialectFor('sqlite').quoteIdent,
  },
  mysql: {
    dialect: MySQL,
    keywords: [...COMMON_KEYWORDS, 'LIMIT', 'OFFSET', 'SHOW', 'AUTO_INCREMENT'],
    quoteIdent: dialectFor('mysql').quoteIdent,
  },
}

export const resolveDialect = (name: string | null | undefined): SqlDialectConfig =>
  SQL_DIALECTS[name as SqlDialectName] ?? SQL_DIALECTS.postgres
