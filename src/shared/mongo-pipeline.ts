import { parse, stringify, isLosslessNumber } from 'lossless-json'

export interface MongoPipelineStage {
  operator: string
  body: string
  enabled: boolean
}
const blocked = new Set(['$out', '$merge', '$where', '$function', '$accumulator', '$changeStream'])
function inspect(value: unknown, state = { nodes: 0 }, depth = 0): void {
  if (++state.nodes > 50000 || depth > 100)
    throw new Error('Pipeline nesting or complexity exceeds the local bound.')
  if (!value || typeof value !== 'object' || isLosslessNumber(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (blocked.has(key)) throw new Error(`${key} is unavailable in read-only pipelines.`)
    inspect(child, state, depth + 1)
  }
}
function json(source: string): unknown {
  if (new TextEncoder().encode(source).byteLength > 1000000) throw new Error('Pipeline JSON exceeds 1 MB.')
  try {
    return parse(source)
  } catch {
    throw new Error('Enter valid Extended JSON without duplicate object keys.')
  }
}
export function parseMongoPipeline(source: string): MongoPipelineStage[] {
  const value = json(source)
  if (!Array.isArray(value) || value.length > 100)
    throw new Error('A pipeline must be an array with at most 100 stages.')
  inspect(value)
  return value.map((stage) => {
    if (
      !stage ||
      Array.isArray(stage) ||
      typeof stage !== 'object' ||
      isLosslessNumber(stage) ||
      Object.keys(stage).length !== 1
    )
      throw new Error('Each pipeline stage must contain one stage operator.')
    const operator = Object.keys(stage)[0]
    if (!/^\$[a-zA-Z][a-zA-Z0-9]*$/.test(operator)) throw new Error('Use a MongoDB $stage operator.')
    return { operator, body: stringify(Object.values(stage)[0], undefined, 2)!, enabled: true }
  })
}
export function renderMongoPipeline(stages: MongoPipelineStage[]): string {
  if (stages.length > 100) throw new Error('A pipeline may contain at most 100 stages.')
  const values = stages
    .filter((stage) => stage.enabled)
    .map((stage) => {
      if (!/^\$[a-zA-Z][a-zA-Z0-9]*$/.test(stage.operator)) throw new Error('Use a MongoDB $stage operator.')
      return { [stage.operator]: json(stage.body) }
    })
  inspect(values)
  const source = stringify(values, undefined, 2)!
  if (new TextEncoder().encode(source).byteLength > 1000000) throw new Error('Pipeline JSON exceeds 1 MB.')
  return source
}
