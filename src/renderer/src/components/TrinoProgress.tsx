import { useEffect, useState } from 'react'
import type { TrinoProgress as Progress } from '@shared/trino'
import { api } from '../lib/api'

/** Observes only this already-submitted operation; polling never creates or retries work. */
export function TrinoProgress({ connectionId, sessionId, requestId, running, engine = 'trino' }: { engine?: 'trino' | 'bigquery' | 'snowflake' | 'databricks' | 'athena'; connectionId: string; sessionId: string; requestId?: string; running: boolean }) {
  const [progress, setProgress] = useState<Progress | null>(null)
  useEffect(() => {
    setProgress(null)
    if (!requestId) return
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try { const value = await (engine === 'athena' ? api.athenaProgress : engine === 'bigquery' ? api.bigQueryProgress : engine === 'trino' ? api.trinoProgress : api.warehouseProgress)({ connectionId, sessionId, requestId }); if (alive) setProgress(value) } catch { /* execution owns the user-visible failure */ }
      if (alive && running) timer = setTimeout(poll, 500)
    }
    void poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [connectionId, sessionId, requestId, running, engine])
  if (!progress) return null
  return <div className="field-note flex flex-wrap gap-3 px-3 py-2" role="status" aria-label={engine === 'trino' ? 'Trino query progress' : `${engine} job progress`}>
    <span>{progress.phase} · {progress.queryId || 'Awaiting coordinator'}</span>
    <span>{progress.pages} pages · {progress.rowsReceived} received rows</span>
    {progress.processedRows !== undefined && <span>{progress.processedRows} processed rows</span>}
    {progress.processedBytes !== undefined && <span>{progress.processedBytes} processed bytes</span>}
    {progress.cancellation !== 'none' && <span>Cancellation: {progress.cancellation}</span>}
  </div>
}
