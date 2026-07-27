import { describe, expect, it } from 'vitest'
import { formatJson, jsonError, jsonProblem, minifyJson } from './json-text'

describe('formatJson', () => {
  it('indents nested objects and arrays two spaces per level', () => {
    expect(formatJson('{"a":[1,2],"b":{"c":true}}')).toBe(
      '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": true\n  }\n}',
    )
  })

  it('keeps empty objects and arrays closed up', () => {
    expect(formatJson('{"a":{},"b":[]}')).toBe('{\n  "a": {},\n  "b": []\n}')
  })

  it('reformats an already-indented document to the same shape', () => {
    const formatted = formatJson('{"a":1}')
    expect(formatJson(formatted)).toBe(formatted)
  })

  it('leaves a top-level scalar alone', () => {
    expect(formatJson('"just a string"')).toBe('"just a string"')
    expect(formatJson('42')).toBe('42')
  })
})

describe('minifyJson', () => {
  it('puts a formatted document back on one line', () => {
    expect(minifyJson('{\n  "a": [\n    1,\n    2\n  ]\n}')).toBe('{"a":[1,2]}')
  })

  it('never emits a newline, whatever the input had', () => {
    expect(minifyJson('{\n\t"a"  :\r\n  "b"\n}')).toBe('{"a":"b"}')
  })
})

describe('literals survive both directions', () => {
  // The reason this module exists: JSON.parse would round the integer to
  // …992 and rewrite 1.10 as 1.1, silently changing a value on its way back
  // to the database.
  it('copies numbers past 2^53 and trailing zeros verbatim', () => {
    const doc = '{"id":9007199254740993,"ratio":1.10,"big":123456789012345678901234567890}'
    expect(minifyJson(formatJson(doc))).toBe(doc)
    expect(formatJson(doc)).toContain('9007199254740993')
    expect(formatJson(doc)).toContain('1.10')
  })

  it('treats braces, commas and escaped quotes inside strings as text', () => {
    const doc = '{"tricky":"a{b}c,d:e \\" f","after":1}'
    expect(minifyJson(formatJson(doc))).toBe(doc)
    expect(formatJson(doc)).toBe('{\n  "tricky": "a{b}c,d:e \\" f",\n  "after": 1\n}')
  })

  it('preserves unicode escapes and empty strings', () => {
    const doc = '{"a":"\\u00e9","b":""}'
    expect(minifyJson(formatJson(doc))).toBe(doc)
  })
})

describe('jsonProblem', () => {
  it('is null for a valid document', () => {
    expect(jsonProblem('{"a":1}')).toBeNull()
    expect(jsonError('{"a":1}')).toBeNull()
  })

  // The thrown messages echo the source and repeat the position, neither of
  // which belongs in a one-line strip. Fed real parse errors, so a change in
  // how the engine words them shows up here rather than in the UI.
  it('keeps the clause that names the problem and drops the rest', () => {
    expect(jsonProblem('{"a": ,}')?.message).toBe("Unexpected token ','")
    expect(jsonProblem('{"a": }')?.message).toBe("Unexpected token '}'")
    expect(jsonProblem('{"a": 1')?.message).toBe("Expected ',' or '}' after property value")
    expect(jsonProblem('{"a" 1}')?.message).toBe("Expected ':' after property name")
    expect(jsonProblem('')?.message).toBe('Unexpected end of JSON input')
  })

  it('reports the position when the message states one', () => {
    expect(jsonProblem('{"a" 1}')?.position).toBe(5)
    // No position in this wording; the caller falls back to the parse tree.
    expect(jsonProblem('{"a": ,}')?.position).toBeNull()
  })
})
