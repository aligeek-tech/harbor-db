import { useState } from 'react'
import type { ConnectionProfile, WorkspaceTab } from '@shared/contracts'
import type { BigQueryEstimate } from '@shared/bigquery'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { Button } from './ui/button'

export function BigQueryTools({ profile, tab, disabled }: { profile: ConnectionProfile; tab: WorkspaceTab; disabled: boolean }) {
  const [estimate, setEstimate] = useState<BigQueryEstimate | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  if (profile.engine !== 'bigquery') return null
  return <div className="field-note flex flex-wrap items-center gap-3 px-3 py-2">
    <span>Billing project: {tab.database || profile.database} · Location: {profile.bigQuery.location} · Byte cap: {profile.bigQuery.maximumBytesBilled}</span>
    <Button variant="outline" size="sm" disabled={disabled || busy || !tab.sql.trim()} onClick={async () => { setBusy(true); setEstimate(null); setError(''); try { setEstimate(await api.bigQueryEstimate({ connectionId: profile.id, database: tab.database || profile.database, sql: tab.sql })) } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) } }}>Dry run / estimate full draft</Button>
    {estimate && <span role="status">Dry-run estimate: {estimate.processedBytes} processed bytes. {estimate.cacheCaveat}</span>}
    {error && <span role="alert">{error}</span>}
    <span>No table query runs on open. Execution and full export can incur charges; a row limit is not a scan-cost limit. This draft estimate does not include parameter values; omit placeholders or use a non-parameterized draft to estimate.</span>
  </div>
}
