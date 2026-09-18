import neo4j from 'neo4j-driver'
import { parse, isLosslessNumber } from 'lossless-json'
import type { NeoParameter, NeoCell, NeoNode, NeoRelationship } from '../../shared/neo4j'
export class NeoInputError extends Error {}
export function cypherQuery(source: string, mode: 'read' | 'mutation'): string {
  const query = source.trim().replace(/;\s*$/, '')
  let visible = '',
    quote = '',
    line = false,
    block = false
  for (let i = 0; i < query.length; i++) {
    const ch = query[i]!,
      next = query[i + 1]
    if (line) {
      if (ch === '\n') {
        line = false
        visible += ' '
      }
      continue
    }
    if (block) {
      if (ch === '*' && next === '/') {
        block = false
        i++
      }
      continue
    }
    if (quote) {
      if (ch === '\\' && quote !== '`') {
        i++
        continue
      }
      if (ch === quote) {
        if (next === quote) {
          i++
          continue
        }
        quote = ''
        visible += ' '
      }
      continue
    }
    if (ch === '/' && next === '/') {
      line = true
      i++
      visible += ' '
      continue
    }
    if (ch === '/' && next === '*') {
      block = true
      i++
      visible += ' '
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      visible += ' '
      continue
    }
    visible += ch
  }
  if (quote || block) throw new NeoInputError('Complete the quoted value or comment before running Cypher.')
  if (visible.includes(';')) throw new NeoInputError('Run one Cypher statement at a time.')
  if (!/^\s*(MATCH|OPTIONAL\s+MATCH|RETURN|UNWIND|WITH|CREATE|MERGE)\b/i.test(visible))
    throw new NeoInputError('Use one graph MATCH, RETURN, UNWIND, WITH, CREATE or MERGE statement.')
  if (/\b(CALL|LOAD|CSV|USE|SHOW|DROP|ALTER|GRANT|DENY|REVOKE|TERMINATE|START|STOP)\b/i.test(visible))
    throw new NeoInputError(
      'Procedures, external loading, database switching and administration are unavailable in this Cypher workspace.',
    )
  if (mode === 'read' && /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|FOREACH)\b/i.test(visible))
    throw new NeoInputError(
      'This Cypher can mutate graph data. Select mutation mode and review the exact target.',
    )
  return query
}
function integer(source: string) {
  if (!/^-?(0|[1-9]\d*)$/.test(source))
    throw new NeoInputError('Integer parameters require signed decimal text.')
  const value = BigInt(source)
  if (value < -(1n << 63n) || value > (1n << 63n) - 1n)
    throw new NeoInputError('Neo4j integers are signed 64-bit values.')
  return neo4j.int(source)
}
export function neoParameters(inputs: NeoParameter[]): Record<string, unknown> {
  if (inputs.reduce((sum, input) => sum + Buffer.byteLength(input.value), 0) > 1000000)
    throw new NeoInputError('Combined parameter values exceed 1 MB.')
  const parameters: Record<string, unknown> = {}
  let nodes = 0
  const convert = (value: unknown, depth = 0): unknown => {
    if (++nodes > 50000 || depth > 32) throw new NeoInputError('Parameter JSON is too complex.')
    if (isLosslessNumber(value)) {
      if (/^-?\d+$/.test(value.value)) return integer(value.value)
      const number = Number(value.value)
      if (!Number.isFinite(number)) throw new NeoInputError('Floating point parameter must be finite.')
      return number
    }
    if (Array.isArray(value)) return value.map((x) => convert(x, depth + 1))
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key))
          throw new NeoInputError('Reserved JSON parameter key.')
        result[key] = convert(child, depth + 1)
      }
      return result
    }
    return value
  }
  for (const input of inputs) {
    if (
      Object.hasOwn(parameters, input.name) ||
      ['__proto__', 'constructor', 'prototype'].includes(input.name)
    )
      throw new NeoInputError('Parameter names must be unique and non-reserved.')
    try {
      parameters[input.name] =
        input.type === 'string'
          ? input.value
          : input.type === 'integer'
            ? integer(input.value)
            : input.type === 'null'
              ? null
              : input.type === 'boolean'
                ? input.value === 'true'
                  ? true
                  : input.value === 'false'
                    ? false
                    : (() => {
                        throw new NeoInputError('Use true or false')
                      })()
                : input.type === 'date'
                  ? neo4j.types.Date.fromString(input.value)
                  : input.type === 'datetime'
                    ? neo4j.types.DateTime.fromString(input.value)
                    : input.type === 'duration'
                      ? neo4j.types.Duration.fromString(input.value)
                      : input.type === 'json'
                        ? convert(
                            parse(input.value, undefined, {
                              onDuplicateKey: () => {
                                throw new NeoInputError('Duplicate key')
                              },
                            }),
                          )
                        : (() => {
                            if (!input.value.trim() || !Number.isFinite(Number(input.value)))
                              throw new NeoInputError('Use a finite number')
                            return Number(input.value)
                          })()
    } catch {
      throw new NeoInputError(
        `Parameter ${input.name} is not a valid ${input.type} value. Its contents were not logged.`,
      )
    }
  }
  return parameters
}
export class NeoValues {
  nodes = new Map<string, NeoNode>()
  relationships = new Map<string, NeoRelationship>()
  truncated = false
  private visited = 0
  private value(value: unknown, depth = 0): unknown {
    if (++this.visited > 50000 || depth > 32)
      throw new NeoInputError('Neo4j result complexity exceeds the local bound.')
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') return { $type: 'Float', value: String(value) }
    if (neo4j.isInt(value)) return { $type: 'Integer', value: value.toString() }
    if (value instanceof Uint8Array) return { $type: 'Bytes', base64: Buffer.from(value).toString('base64') }
    if (neo4j.isNode(value)) {
      const properties = JSON.stringify(this.value(value.properties, depth + 1))
      const node = { id: value.elementId, labels: value.labels, properties }
      if (this.nodes.size < 200 || this.nodes.has(node.id)) this.nodes.set(node.id, node)
      else this.truncated = true
      return { $type: 'Node', ...node }
    }
    if (neo4j.isRelationship(value)) {
      const properties = JSON.stringify(this.value(value.properties, depth + 1))
      const relationship = {
        id: value.elementId,
        type: value.type,
        start: value.startNodeElementId,
        end: value.endNodeElementId,
        properties,
      }
      if (this.relationships.size < 400 || this.relationships.has(relationship.id))
        this.relationships.set(relationship.id, relationship)
      else this.truncated = true
      return { $type: 'Relationship', ...relationship }
    }
    if (neo4j.isPath(value))
      return {
        $type: 'Path',
        start: this.value(value.start, depth + 1),
        segments: value.segments.map((segment) => ({
          start: this.value(segment.start, depth + 1),
          relationship: this.value(segment.relationship, depth + 1),
          end: this.value(segment.end, depth + 1),
        })),
      }
    if (neo4j.isPoint(value))
      return {
        $type: 'Point',
        srid: String(value.srid),
        x: value.x,
        y: value.y,
        ...(value.z === undefined ? {} : { z: value.z }),
      }
    for (const [type, test] of [
      ['Date', neo4j.isDate],
      ['DateTime', neo4j.isDateTime],
      ['LocalDateTime', neo4j.isLocalDateTime],
      ['Time', neo4j.isTime],
      ['LocalTime', neo4j.isLocalTime],
      ['Duration', neo4j.isDuration],
    ] as const)
      if (test(value)) return { $type: type, value: String(value) }
    if (Array.isArray(value)) return value.map((item) => this.value(item, depth + 1))
    if (value && typeof value === 'object') {
      const object: Record<string, unknown> = Object.create(null)
      for (const [key, child] of Object.entries(value)) object[key] = this.value(child, depth + 1)
      return object
    }
    throw new NeoInputError('Unsupported Neo4j result type; project an explicitly supported value.')
  }
  cell(value: unknown): NeoCell {
    this.visited = 0
    const converted = this.value(value),
      encoded = value === null ? null : typeof converted === 'string' ? converted : JSON.stringify(converted)
    if (encoded && Buffer.byteLength(encoded) > 1000000)
      throw new NeoInputError('A Neo4j value exceeds the 1 MB cell bound. Project smaller properties.')
    return {
      type:
        value === null
          ? 'Null'
          : neo4j.isInt(value)
            ? 'Integer'
            : neo4j.isNode(value)
              ? 'Node'
              : neo4j.isRelationship(value)
                ? 'Relationship'
                : neo4j.isPath(value)
                  ? 'Path'
                  : Array.isArray(value)
                    ? 'List'
                    : typeof value === 'object'
                      ? 'Typed value'
                      : typeof value,
      value: encoded,
    }
  }
}
