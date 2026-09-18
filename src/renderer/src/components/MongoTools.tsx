import { useState } from 'react'
import type { ConnectionProfile } from '@shared/contracts'
import type { MongoIndexCatalog, MongoIndexPreview, MongoIndexSpec, MongoTopology } from '@shared/mongo-tools'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ErrorPanel } from './common'
import './MongoTools.css'

const initial = (): MongoIndexSpec => ({
  name: '',
  keys: [{ field: '', direction: 1 }],
  unique: false,
  sparse: false,
  hidden: false,
})
export function MongoTools({
  profile,
  database,
  collection,
  disabled,
  onPending,
  onBusy,
}: {
  profile: ConnectionProfile
  database: string
  collection: string
  disabled: boolean
  onPending: (pending: boolean) => void
  onBusy: (busy: boolean) => void
}) {
  const [panel, setPanel] = useState<'topology' | 'indexes'>()
  const [topology, setTopology] = useState<MongoTopology>()
  const [catalog, setCatalog] = useState<MongoIndexCatalog>()
  const [spec, setSpec] = useState<MongoIndexSpec>(initial)
  const [review, setReview] = useState<MongoIndexPreview>()
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const target = { connectionId: profile.id, database, collection }
  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    onBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
      onBusy(false)
    }
  }
  function close() {
    if (busy) return
    setPanel(undefined)
    setReview(undefined)
    setConfirmation('')
    onPending(false)
  }
  function patch(value: Partial<MongoIndexSpec>) {
    setSpec((current) => ({ ...current, ...value }))
    setReview(undefined)
    setConfirmation('')
    onPending(true)
  }
  async function loadIndexes() {
    setCatalog(await api.mongoIndexes(target))
  }
  async function prepare(operation: 'create' | 'drop', name?: string) {
    await run(async () => {
      setReview(
        await api.mongoIndexPreview(
          operation === 'create' ? { ...target, operation, spec } : { ...target, operation, name: name! },
        ),
      )
      setConfirmation('')
      onPending(true)
    })
  }
  return (
    <>
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setPanel('topology')
          setTopology(undefined)
          void run(async () => setTopology(await api.mongoTopology(profile.id)))
        }}
      >
        Topology
      </Button>
      <Button
        variant="outline"
        disabled={disabled || !database || !collection}
        onClick={() => {
          setPanel('indexes')
          setCatalog(undefined)
          setSpec(initial())
          setReview(undefined)
          setConfirmation('')
          void run(loadIndexes)
        }}
      >
        Indexes
      </Button>
      <Dialog
        open={!!panel}
        onOpenChange={(value) => {
          if (!value) close()
        }}
      >
        <DialogContent className="mongo-tools-dialog">
          <DialogHeader>
            <DialogTitle>{panel === 'topology' ? 'MongoDB topology' : 'MongoDB indexes'}</DialogTitle>
            <DialogDescription>
              {profile.name} ·{' '}
              {panel === 'topology'
                ? 'Observed driver topology, refreshed by an authenticated read.'
                : `${database}.${collection} · Native primary catalog; changes are not transactional.`}
            </DialogDescription>
          </DialogHeader>
          <div className="mongo-tools-scroll">
            {busy && <p role="status">Waiting for MongoDB…</p>}
            {error && <ErrorPanel message={error} />}
            {notice && <p role="status">{notice}</p>}
            {panel === 'topology' && topology && (
              <>
                <dl className="mongo-topology-summary">
                  <dt>Topology</dt>
                  <dd>{topology.type}</dd>
                  <dt>Replica set</dt>
                  <dd>{topology.setName || 'Not reported'}</dd>
                  <dt>Primary</dt>
                  <dd>{topology.primary || 'No primary observed'}</dd>
                  <dt>Read preference</dt>
                  <dd>{topology.readPreference}</dd>
                  <dt>Write readiness</dt>
                  <dd>
                    {topology.writable ? 'Primary or standalone observed' : 'No writable primary observed'}
                  </dd>
                  <dt>Connection</dt>
                  <dd>
                    {topology.status.state} · {topology.status.transport}
                  </dd>
                  <dt>Observed at</dt>
                  <dd>{topology.observedAt}</dd>
                </dl>
                <table className="mongo-index-table">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Role</th>
                      <th>Round trip</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topology.servers.map((server) => (
                      <tr key={server.address}>
                        <td>{server.address}</td>
                        <td>{server.type}</td>
                        <td>
                          {server.roundTripMs === undefined
                            ? 'Not measured'
                            : `${server.roundTripMs.toFixed(1)} ms`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {topology.warnings.map((warning) => (
                  <p className="field-note" key={warning}>
                    {warning}
                  </p>
                ))}
              </>
            )}
            {panel === 'indexes' && catalog && (
              <>
                <table className="mongo-index-table">
                  <thead>
                    <tr>
                      <th>Name / ordered keys</th>
                      <th>Properties</th>
                      <th>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalog.indexes.map((index) => (
                      <tr key={index.name}>
                        <td>
                          <strong>{index.name}</strong>
                          <div>{index.keys.map((key) => `${key.field}: ${key.direction}`).join(', ')}</div>
                          <details>
                            <summary>Native definition</summary>
                            <pre className="mongo-tools-preview">{index.definitionJson}</pre>
                          </details>
                        </td>
                        <td>
                          {[
                            index.unique && 'Unique',
                            index.sparse && 'Sparse',
                            index.hidden && 'Hidden',
                            index.expireAfterSeconds !== undefined && `TTL ${index.expireAfterSeconds}s`,
                          ]
                            .filter(Boolean)
                            .join(' · ') || 'Ordinary'}
                        </td>
                        <td>
                          <Button
                            variant="outline"
                            disabled={busy || profile.readOnly || index.name === '_id_'}
                            onClick={() => void prepare('drop', index.name)}
                            aria-label={`Review dropping index ${index.name}`}
                          >
                            Drop…
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {catalog.warnings.map((warning) => (
                  <p className="field-note" key={warning}>
                    {warning}
                  </p>
                ))}
                {profile.readOnly ? (
                  <p className="field-note">
                    This profile is read-only. Index creation and removal require explicitly enabled writes.
                  </p>
                ) : (
                  <fieldset disabled={busy} className="mongo-index-form">
                    <legend>Create an index</legend>
                    <label>
                      Exact index name
                      <Input
                        aria-label="MongoDB index name"
                        value={spec.name}
                        onChange={(event) => patch({ name: event.target.value })}
                      />
                    </label>
                    {spec.keys.map((key, index) => (
                      <div className="mongo-tools-row" key={index}>
                        <label>
                          Field {index + 1}
                          <Input
                            aria-label={`Index field ${index + 1}`}
                            value={key.field}
                            onChange={(event) =>
                              patch({
                                keys: spec.keys.map((entry, at) =>
                                  at === index ? { ...entry, field: event.target.value } : entry,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          Type
                          <select
                            aria-label={`Index direction ${index + 1}`}
                            value={String(key.direction)}
                            onChange={(event) =>
                              patch({
                                keys: spec.keys.map((entry, at) =>
                                  at === index
                                    ? {
                                        ...entry,
                                        direction: ['1', '-1'].includes(event.target.value)
                                          ? (Number(event.target.value) as 1 | -1)
                                          : (event.target.value as 'hashed' | 'text' | '2dsphere'),
                                      }
                                    : entry,
                                ),
                              })
                            }
                          >
                            <option value="1">Ascending</option>
                            <option value="-1">Descending</option>
                            <option value="hashed">Hashed</option>
                            <option value="text">Text</option>
                            <option value="2dsphere">2dsphere</option>
                          </select>
                        </label>
                        <Button
                          variant="ghost"
                          disabled={spec.keys.length === 1}
                          onClick={() => patch({ keys: spec.keys.filter((_, at) => at !== index) })}
                          aria-label={`Remove index field ${index + 1}`}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      disabled={spec.keys.length >= 32}
                      onClick={() => patch({ keys: [...spec.keys, { field: '', direction: 1 }] })}
                    >
                      Add ordered field
                    </Button>
                    <div className="mongo-tools-row">
                      {(['unique', 'sparse', 'hidden'] as const).map((field) => (
                        <label key={field}>
                          <input
                            type="checkbox"
                            checked={spec[field]}
                            onChange={(event) => patch({ [field]: event.target.checked })}
                          />{' '}
                          {field[0].toUpperCase() + field.slice(1)}
                        </label>
                      ))}
                    </div>
                    <label>
                      Partial filter (optional Extended JSON)
                      <textarea
                        className="mono"
                        rows={3}
                        aria-label="MongoDB partial index filter"
                        value={spec.partialFilter || ''}
                        onChange={(event) => patch({ partialFilter: event.target.value || undefined })}
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={spec.expireAfterSeconds !== undefined}
                        onChange={(event) =>
                          patch({ expireAfterSeconds: event.target.checked ? 3600 : undefined })
                        }
                      />{' '}
                      Enable TTL automatic document deletion
                    </label>
                    {spec.expireAfterSeconds !== undefined && (
                      <>
                        <label>
                          Expire after seconds
                          <Input
                            type="number"
                            min={0}
                            max={2147483647}
                            aria-label="TTL expiry seconds"
                            value={spec.expireAfterSeconds}
                            onChange={(event) => patch({ expireAfterSeconds: Number(event.target.value) })}
                          />
                        </label>
                        <p className="field-note">
                          TTL can delete existing documents automatically. Read-only mode and hidden indexes
                          do not stop the server TTL policy.
                        </p>
                      </>
                    )}
                    <Button onClick={() => void prepare('create')}>Review index creation</Button>
                  </fieldset>
                )}
              </>
            )}
            {panel === 'indexes' && review && (
              <section className="mongo-index-review">
                <h3>
                  Review {review.operation} index: {review.name}
                </h3>
                <pre className="mongo-tools-preview" aria-label="Index operation preview">
                  {review.command}
                </pre>
                {review.warnings.map((warning) => (
                  <p className="field-note" key={warning}>
                    {warning}
                  </p>
                ))}
                <label>
                  Type exactly <strong>{review.confirmation}</strong>
                  <Input
                    aria-label="Confirm MongoDB index target"
                    value={confirmation}
                    disabled={busy}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
                <Button
                  variant={review.operation === 'drop' ? 'destructive' : 'default'}
                  disabled={busy || profile.readOnly || confirmation !== review.confirmation}
                  onClick={() =>
                    void run(async () => {
                      const current = review
                      setReview(undefined)
                      setConfirmation('')
                      onPending(false)
                      const result = await api.mongoIndexExecute({
                        connectionId: profile.id,
                        token: current.token,
                        confirm: confirmation,
                      })
                      setNotice(result.warnings.join(' '))
                      await loadIndexes()
                    })
                  }
                >
                  Execute reviewed index change
                </Button>
              </section>
            )}
          </div>
          <div className="dialog-actions">
            <Button variant="outline" disabled={busy} onClick={close}>
              Close
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setReview(undefined)
                  setConfirmation('')
                  if (panel === 'topology') setTopology(await api.mongoTopology(profile.id))
                  else await loadIndexes()
                })
              }
            >
              Refresh {panel === 'topology' ? 'topology' : 'indexes'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
