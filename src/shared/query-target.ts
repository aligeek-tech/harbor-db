import type { ConnectionProfile, Engine } from './contracts'
import type { ParameterDefinition } from './parameters'
import { engineSupports } from './capabilities'

/** A draft is never executed as a side effect of resolving its target. */
export interface QueryDraft {
  savedQueryId?: string
  reportId?: string
  name: string
  sql: string
  engine?: Engine
  connectionId?: string
  database?: string
  schema?: string
  collection?: string
  searchIndex?: string
  searchPageSize?: number
  mongoMode?: 'find' | 'aggregate'
  parameterDefinitions?: ParameterDefinition[]
}

export function compatibleQueryTarget(query: QueryDraft, profile: ConnectionProfile): boolean {
  // A SQL file has no declared dialect. It still cannot target a command/document engine.
  return query.engine
    ? query.engine === profile.engine
    : engineSupports(profile.engine, 'sql')
}

export function boundQueryTarget(query: QueryDraft, profiles: ConnectionProfile[]) {
  return profiles.find(
    (profile) => profile.id === query.connectionId && compatibleQueryTarget(query, profile),
  )
}
