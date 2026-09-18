import type { ConnectionProfile, Engine } from './contracts'
export function isLocalEngine(engine: Engine): boolean { return engine === 'sqlite' || engine === 'duckdb' }
export function localDatabasePath(profile: ConnectionProfile): string {
  return profile.engine === 'duckdb' ? profile.duckdb.mode === 'memory' ? 'Temporary memory' : profile.duckdb.path : profile.sqlite.path
}
