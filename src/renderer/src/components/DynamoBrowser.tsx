import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile, WorkspaceTab } from '@shared/contracts'
import { dynamoConfirmation, type DynamoTable, type DynamoPage, type DynamoRead } from '@shared/dynamodb'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { useApp } from '../store'
import { ErrorPanel } from './common'
import { Button } from './ui/button'
import { Input } from './ui/input'
export function DynamoBrowser({ profile, tab }: { profile: ConnectionProfile; tab: WorkspaceTab }) {
  const [tables, setTables] = useState<string[]>([]),
    [after, setAfter] = useState<string>(),
    [tableName, setTableName] = useState(''),
    [table, setTable] = useState<DynamoTable>(),
    [index, setIndex] = useState(''),
    [mode, setMode] = useState<'query' | 'scan'>('query'),
    [partition, setPartition] = useState('{"S":""}'),
    [sortOperator, setSortOperator] = useState<DynamoRead['sortOperator']>('none'),
    [sortValues, setSortValues] = useState('[]'),
    [consistent, setConsistent] = useState(false),
    [descending, setDescending] = useState(false),
    [consent, setConsent] = useState(false),
    [page, setPage] = useState<DynamoPage>(),
    [busy, setBusy] = useState(false),
    [request, setRequest] = useState<string>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [writeMode, setWriteMode] = useState<'create' | 'patch' | 'delete'>('create'),
    [key, setKey] = useState('{}'),
    [item, setItem] = useState('{}'),
    [expected, setExpected] = useState('{}'),
    [remove, setRemove] = useState('[]'),
    [absent, setAbsent] = useState('[]'),
    [confirm, setConfirm] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void api
      .dynamoTables({ connectionId: profile.id })
      .then((result) => {
        if (mounted.current) {
          setTables(result.tables)
          setAfter(result.after)
        }
      })
      .catch((error) => setError(errorText(error)))
    return () => {
      mounted.current = false
      void api.closeSession({ connectionId: profile.id, sessionId: tab.id }).catch(() => {})
    }
  }, [profile.id, tab.id])
  useEffect(() => {
    useApp.getState().setRuntime(tab.id, { running: busy })
    return () => useApp.getState().setRuntime(tab.id, { running: false })
  }, [busy, tab.id])
  const invoke = async (work: (requestId: string) => Promise<void>) => {
    const id = crypto.randomUUID()
    setRequest(id)
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work(id)
    } catch (error) {
      if (mounted.current) setError(errorText(error))
    } finally {
      if (mounted.current) {
        setBusy(false)
        setRequest(undefined)
      }
    }
  }
  const close = () => api.closeSession({ connectionId: profile.id, sessionId: tab.id })
  const load = () =>
    void invoke(async () => {
      await close()
      setPage(undefined)
      setTable(undefined)
      setConfirm('')
      setKey('{}')
      setExpected('{}')
      setItem('{}')
      const result = await api.dynamoTable({ connectionId: profile.id, table: tableName })
      setTable(result)
      setIndex('')
      setConsistent(false)
      setConsent(false)
    })
  const locked = busy || !!page?.cursor,
    target = table?.indexes.find((value) => value.name === index) || table
  return (
    <div
      className="space-y-3 [&_label]:block [&_label]:my-3 [&_select]:ml-2"
      style={{ padding: 16, overflow: 'auto', height: '100%', width: '100%' }}
    >
      <h2>DynamoDB item workspace</h2>
      <p>
        {profile.name} ·{' '}
        {profile.dynamo.local ? 'Local emulator' : `Expected account ${profile.dynamo.accountId}`} ·{' '}
        {profile.dynamo.region} · {profile.readOnly ? 'Read-only safeguard' : 'Writes enabled'}
      </p>
      <p>
        Choose a table and run a partition Query explicitly. Scan requires consent. Pages are not a snapshot;
        writes never retry automatically.
      </p>
      <label>
        Table
        <Input
          aria-label="DynamoDB table"
          list={'dynamo-tables-' + tab.id}
          value={tableName}
          disabled={locked}
          onChange={(event) => {
            setTableName(event.target.value)
            setTable(undefined)
            setPage(undefined)
            setConfirm('')
          }}
        />
      </label>
      <datalist id={'dynamo-tables-' + tab.id}>
        {tables.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <Button disabled={locked || !tableName} onClick={load}>
        Inspect DynamoDB table
      </Button>
      {after && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void invoke(async () => {
              const result = await api.dynamoTables({ connectionId: profile.id, after })
              setTables(result.tables)
              setAfter(result.after)
            })
          }
        >
          Next table names
        </Button>
      )}
      {table && (
        <>
          <p>
            {table.arn} · {table.status} · {table.capacityMode} · read{' '}
            {table.capacityMode === 'PAY_PER_REQUEST' ? 'on demand' : (table.readCapacity ?? 'unknown')} /
            write{' '}
            {table.capacityMode === 'PAY_PER_REQUEST' ? 'on demand' : (table.writeCapacity ?? 'unknown')}
          </p>
          <p>
            {table.local
              ? 'Emulator capacity and authentication do not verify AWS billing or IAM.'
              : 'Account and region verified from the table ARN.'}
          </p>
          <label>
            Table or index
            <select
              aria-label="DynamoDB index"
              value={index}
              disabled={locked}
              onChange={(event) => {
                setIndex(event.target.value)
                setConsistent(false)
                setPage(undefined)
              }}
            >
              <option value="">Base table</option>
              {table.indexes.map((value) => (
                <option key={value.name} value={value.name}>
                  {value.name} ({value.global ? 'GSI, eventual only' : 'LSI'})
                </option>
              ))}
            </select>
          </label>
          <p>
            Partition key: {target?.partition.name} ({target?.partition.type})
            {target?.sort && ` · Sort key: ${target.sort.name} (${target.sort.type})`}
          </p>
          <label>
            Read operation
            <select
              aria-label="DynamoDB read mode"
              disabled={locked}
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as typeof mode)
                setConsent(false)
                setPage(undefined)
              }}
            >
              <option value="query">Query by partition key</option>
              <option value="scan">Scan table or index</option>
            </select>
          </label>
          {mode === 'query' ? (
            <>
              <label>
                Exact typed partition value
                <textarea
                  aria-label="DynamoDB partition value"
                  className="w-full font-mono"
                  rows={2}
                  disabled={locked}
                  value={partition}
                  onChange={(event) => setPartition(event.target.value)}
                />
              </label>
              {target?.sort && (
                <>
                  <label>
                    Sort condition
                    <select
                      aria-label="DynamoDB sort condition"
                      value={sortOperator}
                      disabled={locked}
                      onChange={(event) => setSortOperator(event.target.value as typeof sortOperator)}
                    >
                      {['none', 'eq', 'lt', 'lte', 'gt', 'gte', 'between', 'begins_with'].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  {sortOperator !== 'none' && (
                    <label>
                      Typed sort values (JSON array)
                      <textarea
                        aria-label="DynamoDB sort values"
                        className="w-full font-mono"
                        value={sortValues}
                        disabled={locked}
                        onChange={(event) => setSortValues(event.target.value)}
                      />
                    </label>
                  )}
                </>
              )}
            </>
          ) : (
            <label>
              <input
                type="checkbox"
                aria-label="Allow DynamoDB Scan"
                checked={consent}
                disabled={locked}
                onChange={(event) => setConsent(event.target.checked)}
              />
              I consent to a bounded Scan that can consume capacity across the table or index.
            </label>
          )}
          <label>
            <input
              type="checkbox"
              aria-label="DynamoDB strong consistency"
              checked={consistent}
              disabled={locked || !!table.indexes.find((value) => value.name === index)?.global}
              onChange={(event) => setConsistent(event.target.checked)}
            />
            Strong consistency (unavailable on GSI; still no snapshot across pages)
          </label>
          {mode === 'query' && (
            <label>
              <input
                type="checkbox"
                aria-label="DynamoDB descending"
                checked={descending}
                disabled={locked}
                onChange={(event) => setDescending(event.target.checked)}
              />
              Descending sort order
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || (mode === 'scan' && !consent)}
              onClick={() =>
                void invoke(async (requestId) => {
                  await close()
                  setPage(undefined)
                  setPage(
                    await api.dynamoRead({
                      connectionId: profile.id,
                      sessionId: tab.id,
                      requestId,
                      table: table.name,
                      index,
                      mode,
                      partition,
                      sortOperator,
                      sortValues,
                      consistent,
                      descending,
                      allowScan: consent,
                      limit: 25,
                    }),
                  )
                })
              }
            >
              Run DynamoDB read
            </Button>
            <Button
              variant="outline"
              disabled={busy || !page?.cursor}
              onClick={() =>
                void invoke(async (requestId) =>
                  setPage(
                    await api.dynamoNext({
                      connectionId: profile.id,
                      sessionId: tab.id,
                      requestId,
                      cursor: page!.cursor!,
                    }),
                  ),
                )
              }
            >
              Next DynamoDB page
            </Button>
            <Button
              variant="outline"
              disabled={busy || !page?.cursor}
              onClick={() =>
                void invoke(async () => {
                  await close()
                  setPage((current) => (current ? { ...current, cursor: undefined } : current))
                  setNotice('Cursor closed. Start another read explicitly.')
                })
              }
            >
              Close DynamoDB cursor
            </Button>
          </div>
          {page && (
            <>
              <p role="status">
                {page.count} items returned · {page.evaluated} evaluated on page · {page.totalEvaluated}{' '}
                evaluated total · page {page.pages} ·{' '}
                {page.cursor ? 'More results available' : 'Traversal complete'}
              </p>
              <p>{page.warning}</p>
              <pre aria-label="DynamoDB consumed capacity">{page.capacity}</pre>
              <p>
                Native AttributeValue JSON retains number strings, binary base64, sets, maps and lists.
                Selecting an item only prepares an editable draft.
              </p>
              <div aria-label="DynamoDB items">
                {page.items.map((value, idx) => (
                  <section key={idx}>
                    <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>{value}</pre>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        const parsed = JSON.parse(value),
                          keys = Object.fromEntries(
                            [table.partition.name, ...(table.sort ? [table.sort.name] : [])].map((name) => [
                              name,
                              parsed[name],
                            ]),
                          ),
                          fields = Object.fromEntries(
                            Object.entries(parsed).filter(
                              ([name]) => !Object.prototype.hasOwnProperty.call(keys, name),
                            ),
                          )
                        setKey(JSON.stringify(keys, null, 2))
                        setItem(JSON.stringify(fields, null, 2))
                        setExpected(JSON.stringify(fields, null, 2))
                        setWriteMode('patch')
                        setConfirm('')
                        setNotice(
                          'Prepared a patch draft. Conditions protect only the attributes listed below; review before writing.',
                        )
                      }}
                    >
                      Prepare item {idx + 1} for review
                    </Button>
                  </section>
                ))}
              </div>
            </>
          )}
          <details>
            <summary>Reviewed conditional item mutation</summary>
            <p>
              One primary-key item per operation. Create refuses an existing key. Patch and delete require
              expected attribute values or expected absences; these conditions protect only named attributes.
              Delete removes the whole item if those conditions match, including any other current attributes.
              Use an application version attribute for whole-item concurrency control.
            </p>
            <label>
              Mutation
              <select
                aria-label="DynamoDB mutation mode"
                value={writeMode}
                disabled={busy || profile.readOnly}
                onChange={(event) => {
                  setWriteMode(event.target.value as typeof writeMode)
                  setConfirm('')
                }}
              >
                <option value="create">Create if absent</option>
                <option value="patch">Conditional attribute patch</option>
                <option value="delete">Conditional item delete</option>
              </select>
            </label>
            {[
              ['Primary key', key, setKey],
              ['Item or attributes to set', item, setItem],
              ['Expected attributes', expected, setExpected],
              ['Expected absent attribute names', absent, setAbsent],
              ['Attribute names to remove', remove, setRemove],
            ].map(([label, value, setter]) => (
              <label key={label as string}>
                {label as string}
                <textarea
                  className="w-full font-mono"
                  aria-label={'DynamoDB ' + label}
                  rows={3}
                  value={value as string}
                  disabled={busy || profile.readOnly}
                  onChange={(event) => {
                    ;(setter as (value: string) => void)(event.target.value)
                    setConfirm('')
                  }}
                />
              </label>
            ))}
            <p>
              Type: <code>{dynamoConfirmation(profile.id, table.name)}</code>
            </p>
            <Input
              aria-label="Confirm DynamoDB mutation"
              value={confirm}
              disabled={busy || profile.readOnly}
              onChange={(event) => setConfirm(event.target.value)}
            />
            <Button
              disabled={busy || profile.readOnly || confirm !== dynamoConfirmation(profile.id, table.name)}
              onClick={() =>
                void invoke(async (requestId) => {
                  await close()
                  setPage(undefined)
                  const result = await api.dynamoMutate({
                    connectionId: profile.id,
                    sessionId: tab.id,
                    requestId,
                    table: table.name,
                    mode: writeMode,
                    key,
                    item,
                    expected,
                    absent: JSON.parse(absent),
                    remove: JSON.parse(remove),
                    confirm,
                  })
                  setConfirm('')
                  setNotice(result.message + ' Capacity: ' + result.capacity)
                })
              }
            >
              Apply conditional DynamoDB mutation
            </Button>
          </details>
        </>
      )}
      {busy && request && (
        <Button
          variant="outline"
          onClick={() =>
            void api
              .dynamoCancel({ connectionId: profile.id, sessionId: tab.id, requestId: request })
              .then((result) => setNotice(result.message))
              .catch((error) => setError(errorText(error)))
          }
        >
          Cancel DynamoDB request
        </Button>
      )}
      {error && <ErrorPanel message={error} />} {notice && <p role="status">{notice}</p>}
    </div>
  )
}
