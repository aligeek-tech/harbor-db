import type { Engine } from './contracts'
/** Workflow reuse is independent of verified server-product identity. */
export function isKeyValueEngine(engine: Engine): engine is 'redis' | 'valkey' {
  return engine === 'redis' || engine === 'valkey'
}
