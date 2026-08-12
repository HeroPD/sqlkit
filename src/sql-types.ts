import type { Engine } from './electron'

/** Only Postgres needs renames: format_type() emits the verbose SQL-standard names.
 * SQLite types are free-form DDL text and MySQL/SQL Server already report short names. */
const ENGINE_ALIASES: Partial<Record<Engine, Record<string, string>>> = {
  postgresql: {
    'character varying': 'varchar',
    character: 'char',
    'bit varying': 'varbit',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
    'time without time zone': 'time',
    'time with time zone': 'timetz',
    'double precision': 'float8',
    integer: 'int',
    boolean: 'bool',
  },
}

/** Shorten verbose SQL type names for display ("character varying(255)" → "varchar(255)").
 * Types pass through unchanged for engines without aliases or when unrecognized;
 * modifiers and array suffixes are preserved. */
export function abbreviateType(dataType: string, engine: Engine | null): string {
  const aliases = engine ? ENGINE_ALIASES[engine] : undefined
  if (!aliases) return dataType
  const match = /^(.*?)(\([^)]*\))?( with(?:out)? time zone)?((?:\[\])*)$/i.exec(dataType.trim())
  if (!match) return dataType
  const [, name, mod = '', zone = '', arrays = ''] = match
  const alias = aliases[(name + zone).toLowerCase()]
  return alias ? alias + mod + arrays : dataType
}
