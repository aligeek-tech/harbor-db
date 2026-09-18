import { describe, expect, it } from 'vitest'
import { capabilitiesFor, engineDefinitions } from '../src/shared/capabilities'
import { engineSchema, profileSchema } from '../src/shared/contracts'

describe('explicit engine capabilities', () => {
  it('registers every engine and distinguishes supported, unavailable, denied and guarded states', () => {
    expect(Object.keys(engineDefinitions).sort()).toEqual([...engineSchema.options].sort())
    const profile = profileSchema.parse({ id: 'p', name: 'p', engine: 'postgres', host: 'localhost', port: 5432 })
    expect(capabilitiesFor(profile, { state: 'disconnected' }).sql.state).toBe('disconnected')
    const connected = capabilitiesFor(profile, { state: 'connected' }, { catalog: 'Restricted role' }, { transactions: 'Pool mode' })
    expect(connected.catalog).toEqual({ state: 'permission-denied', reason: 'Restricted role' })
    expect(connected.transactions.state).toBe('topology-unavailable')
    expect(connected.rowEdits.state).toBe('guarded')
    expect(connected.sql.state).toBe('supported')
    expect(connected.documents.state).toBe('unsupported')
    expect(connected.streamExport.state).toBe('supported')
    const analytical = capabilitiesFor({ ...profile, engine: 'clickhouse' }, { state: 'connected' })
    expect(analytical.transactions.state).toBe('unsupported')
    expect(analytical.rowEdits.state).toBe('unsupported')
  })
})
