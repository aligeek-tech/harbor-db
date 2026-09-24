import { parse } from 'lossless-json'
import { useEffect, useRef, useState } from 'react'
import { CircleStop, Database, RefreshCw, Search, ShieldAlert } from 'lucide-react'
import type { ConnectionProfile, WorkspaceTab } from '@shared/contracts'
import { vectorConfirmation, type VectorCollection, type VectorSearchResult } from '@shared/vector'
import { api } from '../lib/api'
import { errorText, uid } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { ErrorPanel } from './common'

export function VectorBrowser({ profile, tab }: { profile: ConnectionProfile; tab: WorkspaceTab }) {
  const [collections, setCollections] = useState<VectorCollection[]>([])
  const [collection, setCollection] = useState(tab.searchIndex || '')
  const [namespace, setNamespace] = useState('')
  const [vector, setVector] = useState('[0.1, 0.2, 0.3]')
  const [filter, setFilter] = useState('{}')
  const [includeVectors, setIncludeVectors] = useState(false)
  const [result, setResult] = useState<VectorSearchResult>()
  const [requestId, setRequestId] = useState('')
  const [error, setError] = useState('')
  const [mutationId, setMutationId] = useState('')
  const [payload, setPayload] = useState('{}')
  const [confirm, setConfirm] = useState('')
  const mutationInFlight = useRef(false)
  const [mutating, setMutating] = useState(false)

  async function refresh() {
    setError('')
    try {
      const values = await api.vectorCollections(profile.id)
      setCollections(values)
      if (!collection && values[0]) setCollection(values[0].name)
    } catch (cause) { setError(errorText(cause)) }
  }
  useEffect(() => { void refresh() }, [profile.id])

  async function search() {
    const id = uid(); setRequestId(id); setError(''); setResult(undefined)
    try {
      const parsedVector = JSON.parse(vector) as unknown
      const parsedFilter = parse(filter) as unknown
      if (!Array.isArray(parsedVector) || !parsedFilter || typeof parsedFilter !== 'object' || Array.isArray(parsedFilter)) throw new Error('Enter a JSON vector array and JSON filter object.')
      setResult(await api.vectorSearch({ connectionId: profile.id, collection, ...(namespace ? { namespace } : {}), requestId: id, vector: parsedVector as number[], filterJson: filter, limit: 50, includeVectors }))
    } catch (cause) { setError(errorText(cause)) } finally { setRequestId('') }
  }

  async function mutate(action: 'upsert' | 'delete') {
    if (mutationInFlight.current) return
    mutationInFlight.current = true
    setMutating(true)
    setError('')
    try {
      const id = mutationId
      const common = { connectionId: profile.id, collection, ...(namespace ? { namespace } : {}), id, confirm }
      if (action === 'delete') await api.vectorMutate({ ...common, action })
      else await api.vectorMutate({ ...common, action, vector: JSON.parse(vector), payload: {}, payloadJson: payload })
      setConfirm(''); setMutationId(''); await refresh()
    } catch (cause) { setError(errorText(cause)) } finally {
      mutationInFlight.current = false
      setMutating(false)
      setConfirm('')
    }
  }

  const target = vectorConfirmation({ connectionId: profile.id, collection, namespace })
  return <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4">
    <div className="flex flex-wrap items-center gap-2"><Database /><strong>{profile.name} vector workspace</strong><Button variant="outline" onClick={() => void refresh()}><RefreshCw /> Refresh collections</Button></div>
    <p className="text-sm text-muted-foreground">Results are bounded to 50. Vectors are hidden by default. Provider capabilities and record visibility differ; Pinecone enumeration is not simulated.</p>
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <label>Collection/index<select className="mt-1 w-full" value={collection} onChange={(event) => setCollection(event.target.value)}>{collections.map((item) => <option key={item.name}>{item.name}</option>)}</select></label>
      <label>Namespace (optional)<Input value={namespace} onChange={(event) => setNamespace(event.target.value)} /></label>
      <label className="flex items-end gap-2"><input type="checkbox" checked={includeVectors} onChange={(event) => setIncludeVectors(event.target.checked)} /> Include bounded vectors</label>
    </div>
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><label>Query vector<textarea rows={4} value={vector} onChange={(event) => setVector(event.target.value)} /></label><label>Provider filter JSON<textarea rows={4} value={filter} onChange={(event) => setFilter(event.target.value)} /></label></div>
    <div className="flex gap-2">{requestId ? <Button variant="destructive" onClick={() => void api.vectorCancel({ connectionId: profile.id, requestId })}><CircleStop /> Cancel</Button> : <Button disabled={!collection} onClick={() => void search()}><Search /> Bounded search</Button>}</div>
    {error && <ErrorPanel message={error} />}
    {result && <div className="space-y-2"><p>{result.hits.length} hits · {result.durationMs} ms{result.truncated ? ' · limit reached' : ''}</p>{result.warnings.map((warning) => <p className="text-xs" key={warning}>{warning}</p>)}<pre className="max-h-80 overflow-auto rounded border p-3 text-xs">{JSON.stringify(result.hits, null, 2)}</pre></div>}
    <details className="rounded border p-3"><summary className="cursor-pointer"><ShieldAlert className="inline" /> Reviewed point mutation</summary><p className="text-xs">No conflict token is available across all four providers. Use guarded browsing and least-privilege credentials; refresh after the acknowledged mutation.</p><div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2"><label>Point/object ID<Input value={mutationId} onChange={(event) => setMutationId(event.target.value)} /></label><label>Payload/metadata JSON<textarea rows={3} value={payload} onChange={(event) => setPayload(event.target.value)} /></label><label className="sm:col-span-2">Type exact target: <code>{target}</code><Input value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label></div><div className="mt-2 flex gap-2"><Button disabled={mutating || profile.readOnly || confirm !== target || !mutationId} onClick={() => void mutate('upsert')}>Upsert one point</Button><Button variant="destructive" disabled={mutating || profile.readOnly || confirm !== target || !mutationId} onClick={() => void mutate('delete')}>Delete one point</Button></div></details>
    <div className="grid gap-2 sm:grid-cols-2">{collections.map((item) => <div className="rounded border p-2 text-sm" key={item.name}><strong>{item.name}</strong><p>{item.dimension ? `${item.dimension} dimensions` : 'dimension not reported'} · {item.metric || 'metric not reported'} · {item.records ?? 'unknown'} records</p><pre className="overflow-auto text-xs">{JSON.stringify(item.details, null, 2)}</pre></div>)}</div>
  </div>
}
