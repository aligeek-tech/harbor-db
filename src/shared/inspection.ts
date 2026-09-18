import type { Engine, ResultSet, TableStructure } from './contracts'
import type { QueryParameter } from './parameters'

export interface ObjectInspectionInput {
  connectionId: string
  database?: string
  schema: string
  name: string
  kind: 'table' | 'view' | 'function' | 'trigger'
  identity?: string
}
export interface ObjectInspection {
  properties: { name: string; value: string }[]
  definition?: { text: string; source: 'server' | 'summary' }
  structure?: TableStructure
  details?: ResultSet[]
  choices?: { identity: string; label: string }[]
  warnings: string[]
}
export interface ExplainInput {
  connectionId: string
  sessionId: string
  requestId: string
  database?: string
  sql: string
  parameters?: QueryParameter[]
  mode: 'estimate' | 'analyze'
  consentAnalyze?: true
}
export interface ExplainResult {
  engine: Engine
  mode: 'estimate' | 'analyze'
  format: 'json' | 'text'
  raw: string
  durationMs: number
  warnings: string[]
  cancelled?: boolean
}
export type DiagnosticKind = 'activity' | 'locks' | 'indexes' | 'permissions' | 'extensions' | 'timescale'
export interface DiagnosticInput {
  connectionId: string
  database?: string
  kind: DiagnosticKind
  schema?: string
  table?: string
  includeQueryText?: boolean
}
export interface DiagnosticResult {
  kind: DiagnosticKind
  available: boolean
  sets: ResultSet[]
  durationMs: number
  warnings: string[]
}
