import { useCallback, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Braces,
  Check,
  Clock3,
  KeyRound,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  Cell,
  ConnectionProfile,
  RedisKey,
  RedisMutateInput,
  RedisValue,
  WorkspaceTab,
} from '@shared/contracts'
import { api } from '../lib/api'
import { cn, displayCell, errorText } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Field, FieldGroup, FieldLabel } from './ui/field'
import { CopyButton, ErrorPanel, IconButton, Loading, useConfirm } from './common'

type RedisType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream'
type Mutation = RedisMutateInput['action']
interface EditDialog {
  create: boolean
  type: RedisType
  action: Mutation
  keyName: string
  value: string
  field: string
  index: string
  score: string
  binary: boolean
  fieldBinary: boolean
}
interface Draft {
  key: RedisKey
  data: RedisValue
  value: string
  base: string
  binary: boolean
}
const drafts = new Map<string, Draft>()
const MAX_KEYS = 10000
const firstAction: Record<RedisType, Mutation> = {
  string: 'set',
  hash: 'hset',
  list: 'rpush',
  set: 'sadd',
  zset: 'zadd',
  stream: 'xadd',
}
const actions: Record<RedisType, Mutation[]> = {
  string: ['set'],
  hash: ['hset', 'hdel'],
  list: ['lpush', 'rpush', 'lset'],
  set: ['sadd', 'srem'],
  zset: ['zadd', 'zrem'],
  stream: ['xadd', 'xdel'],
}
const actionNames: Partial<Record<Mutation, string>> = {
  set: 'Set value',
  hset: 'Set field',
  hdel: 'Remove field',
  lpush: 'Prepend item',
  rpush: 'Append item',
  lset: 'Replace at index',
  sadd: 'Add member',
  srem: 'Remove member',
  zadd: 'Set member and score',
  zrem: 'Remove member',
  xadd: 'Append event',
  xdel: 'Delete event by ID',
}
function utf8Base64(value: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte)
  return btoa(binary)
}
function ttlLabel(ttl: number): string {
  return ttl === -2
    ? 'Key no longer exists'
    : ttl === -1
      ? 'No expiration'
      : `${ttl.toLocaleString()}s remaining`
}
function cellInput(cell: Cell | undefined): { text: string; binary: boolean } {
  return cell && typeof cell === 'object'
    ? { text: cell.base64, binary: true }
    : { text: cell === null || cell === undefined ? '' : String(cell), binary: false }
}
function blankDialog(create: boolean, type: RedisType = 'string', keyName = ''): EditDialog {
  return {
    create,
    type,
    action: firstAction[type],
    keyName,
    value: '',
    field: '',
    index: '0',
    score: '0',
    binary: false,
    fieldBinary: false,
  }
}

export function RedisBrowser({ tab, profile }: { tab: WorkspaceTab; profile: ConnectionProfile }) {
  const confirm = useConfirm()
  const connected = useApp((state) => state.statuses[profile.id]?.state === 'connected')
  const demo = profile.id.startsWith('demo-')
  const writable = connected && !profile.readOnly && !demo
  const restored = drafts.get(tab.id)
  const [keys, setKeys] = useState<RedisKey[]>([])
  const [pattern, setPattern] = useState('*')
  const [batch, setBatch] = useState(200)
  const [scanCursor, setScanCursor] = useState('0')
  const [scanned, setScanned] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [selected, setSelected] = useState<RedisKey | null>(restored?.key ?? null)
  const [data, setData] = useState<RedisValue | null>(restored?.data ?? null)
  const [value, setValue] = useState(restored?.value ?? '')
  const [base, setBase] = useState(restored?.base ?? '')
  const [binary, setBinary] = useState(restored?.binary ?? false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ttl, setTtl] = useState('3600')
  const [dialog, setDialog] = useState<EditDialog | null>(null)
  const [dialogError, setDialogError] = useState('')
  const scanEpoch = useRef(0)
  const inspectEpoch = useRef(0)
  const currentPattern = useRef('*')
  const mounted = useRef(true)
  const listRef = useRef<HTMLDivElement>(null)
  const dirty = value !== base
  const virtual = useVirtualizer({
    count: keys.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 58,
    overscan: 8,
  })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      scanEpoch.current++
      inspectEpoch.current++
      if (!useApp.getState().workspace.tabs.some((item) => item.id === tab.id)) drafts.delete(tab.id)
    }
  }, [tab.id])

  useEffect(() => {
    if (dirty && selected && data) drafts.set(tab.id, { key: selected, data, value, base, binary })
    else drafts.delete(tab.id)
    useApp.getState().setRuntime(tab.id, { pendingEdits: dirty })
  }, [tab.id, dirty, selected, data, value, base, binary])

  useEffect(() => {
    useApp.getState().setRuntime(tab.id, { running: busy })
  }, [busy, tab.id])

  const loadScan = useCallback(
    async (reset = false) => {
      if (!connected || demo) return
      const epoch = ++scanEpoch.current
      const nextPattern = reset ? pattern || '*' : currentPattern.current
      currentPattern.current = nextPattern
      setScanning(true)
      setStopped(false)
      setError('')
      try {
        const page = await api.redisScan({
          connectionId: profile.id,
          cursor: reset ? '0' : scanCursor,
          pattern: nextPattern,
          count: batch,
        })
        if (!mounted.current || epoch !== scanEpoch.current) return
        setKeys((previous) => {
          const combined = new Map((reset ? [] : previous).map((key) => [key.keyBase64, key]))
          for (const key of page.keys) combined.set(key.keyBase64, key)
          return [...combined.values()].slice(0, MAX_KEYS)
        })
        setScanCursor(page.cursor)
        setScanned(true)
      } catch (cause) {
        if (mounted.current && epoch === scanEpoch.current) setError(errorText(cause))
      } finally {
        if (mounted.current && epoch === scanEpoch.current) setScanning(false)
      }
    },
    [connected, demo, pattern, profile.id, scanCursor, batch],
  )

  useEffect(() => {
    if (connected && !demo) void loadScan(true)
    // One initial discovery page for this immutable tab connection; subsequent pages are explicit.
  }, [connected, profile.id])

  const permitDiscard = async (): Promise<boolean> => {
    if (!dirty) return true
    const accepted = await confirm({
      title: 'Discard the staged value?',
      description: 'The edited value has not reached Redis. Apply it first, or discard this local change.',
      label: 'Discard local change',
      danger: true,
    })
    return accepted !== false
  }

  const readKey = async (key: RedisKey, cursor = '0', append = false) => {
    const epoch = ++inspectEpoch.current
    setLoading(true)
    setError('')
    try {
      const offset = ['list', 'zset'].includes(key.type) ? Number(cursor) : 0
      const result = await api.redisInspect({
        connectionId: profile.id,
        keyBase64: key.keyBase64,
        cursor: ['list', 'zset'].includes(key.type) ? '0' : cursor,
        offset,
        count: 100,
      })
      if (!mounted.current || epoch !== inspectEpoch.current) return
      setSelected(result.key)
      setData((previous) =>
        append && previous?.key.keyBase64 === key.keyBase64
          ? {
              ...result,
              entries: [...previous.entries, ...result.entries],
              truncated: previous.truncated || result.truncated,
            }
          : result,
      )
      if (!append) {
        const initial = cellInput(result.value)
        setValue(initial.text)
        setBase(initial.text)
        setBinary(initial.binary)
        setTtl(result.key.ttl > 0 ? String(result.key.ttl) : '3600')
      }
      setKeys((previous) => previous.map((item) => (item.keyBase64 === key.keyBase64 ? result.key : item)))
    } catch (cause) {
      if (mounted.current && epoch === inspectEpoch.current) setError(errorText(cause))
    } finally {
      if (mounted.current && epoch === inspectEpoch.current) setLoading(false)
    }
  }

  const chooseKey = async (key: RedisKey) => {
    if (!(await permitDiscard())) return
    setValue(base)
    setSelected(key)
    setData(null)
    await readKey(key)
  }

  const refresh = async () => {
    if (!(await permitDiscard())) return
    if (selected) await readKey(selected)
    await loadScan(true)
  }

  const applyString = async () => {
    if (!selected || !data || !writable || data.truncated) return
    setBusy(true)
    setError('')
    try {
      await api.redisMutate({
        connectionId: profile.id,
        keyBase64: selected.keyBase64,
        action: 'set',
        ...(binary ? { valueBase64: value } : { value }),
        expectedBase64: data.rawBase64,
      })
      drafts.delete(tab.id)
      await readKey(selected)
      toast.success('Value updated. Existing expiration preserved.')
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const mutateKey = async (input: Omit<RedisMutateInput, 'connectionId' | 'keyBase64'>, success: string) => {
    if (!selected || !writable) return
    if (!(await permitDiscard())) return
    const target = selected
    setBusy(true)
    setError('')
    try {
      await api.redisMutate({ connectionId: profile.id, keyBase64: target.keyBase64, ...input })
      if (input.action === 'delete' || input.action === 'rename') {
        setKeys((previous) => previous.filter((item) => item.keyBase64 !== target.keyBase64))
        setSelected(null)
        setData(null)
        setValue('')
        setBase('')
        await loadScan(true)
      } else await readKey(target)
      toast.success(success)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const openEdit = (row?: Cell[]) => {
    if (!selected || !data || data.key.type === 'none') return
    const type = data.key.type as RedisType
    const next = blankDialog(false, type, selected.key)
    if (row) {
      if (type === 'hash') {
        const field = cellInput(row[0])
        const entry = cellInput(row[1])
        next.field = field.text
        next.fieldBinary = field.binary
        next.value = entry.text
        next.binary = entry.binary
      } else if (type === 'list') {
        const entry = cellInput(row[1])
        next.action = 'lset'
        next.index = String(row[0])
        next.value = entry.text
        next.binary = entry.binary
      } else if (type === 'set' || type === 'zset') {
        const entry = cellInput(row[0])
        next.value = entry.text
        next.binary = entry.binary
        if (type === 'zset') next.score = String(row[1])
        else next.action = 'srem'
      } else if (type === 'stream') {
        next.action = 'xdel'
        next.field = String(row[0])
      }
    }
    setDialogError('')
    setDialog(next)
  }

  const applyDialog = async () => {
    if (!dialog || !writable) return
    setDialogError('')
    const target = dialog.create ? utf8Base64(dialog.keyName) : selected?.keyBase64
    if (!target || (dialog.create && !dialog.keyName.trim())) {
      setDialogError('Enter a key name.')
      return
    }
    if (
      ['hset', 'hdel', 'xadd', 'xdel'].includes(dialog.action) &&
      !dialog.field &&
      !['hset', 'hdel'].includes(dialog.action)
    ) {
      setDialogError('Enter a field name or stream entry ID.')
      return
    }
    const score = Number(dialog.score),
      index = Number(dialog.index)
    if (dialog.action === 'zadd' && !Number.isFinite(score)) {
      setDialogError('Enter a finite score.')
      return
    }
    if (dialog.action === 'lset' && !Number.isInteger(index)) {
      setDialogError('Enter a whole-number list index.')
      return
    }
    if (['hdel', 'srem', 'zrem', 'xdel'].includes(dialog.action)) {
      const accepted = await confirm({
        title: 'Apply removal?',
        description: `${actionNames[dialog.action]} in ${dialog.keyName}, database ${profile.redisDb} on ${profile.name}. This change takes effect immediately.`,
        danger: true,
        label: 'Apply removal',
      })
      if (accepted === false) return
    }
    setBusy(true)
    try {
      await api.redisMutate({
        connectionId: profile.id,
        keyBase64: target,
        action: dialog.action,
        ...(dialog.binary ? { valueBase64: dialog.value } : { value: dialog.value }),
        ...(dialog.fieldBinary ? { fieldBase64: dialog.field } : { field: dialog.field }),
        ...(dialog.action === 'zadd' ? { score } : {}),
        ...(dialog.action === 'lset' ? { index } : {}),
        ...(dialog.create ? { createOnly: true } : {}),
      })
      setDialog(null)
      const key: RedisKey = { key: dialog.keyName, keyBase64: target, type: dialog.type, ttl: -1 }
      await readKey(key)
      await loadScan(true)
      toast.success(dialog.create ? 'Key created.' : 'Change applied. Existing expiration preserved.')
    } catch (cause) {
      setDialogError(errorText(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const formatJson = () => {
    try {
      // Token-aware indentation retains every number and string literal verbatim.
      JSON.parse(value)
      let level = 0,
        quoted = false,
        escaped = false,
        output = ''
      for (const char of value) {
        if (quoted) {
          output += char
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') quoted = false
          continue
        }
        if (char === '"') {
          quoted = true
          output += char
        } else if (char === '{' || char === '[') {
          level++
          output += `${char}\n${'  '.repeat(level)}`
        } else if (char === '}' || char === ']') {
          level--
          output += `\n${'  '.repeat(level)}${char}`
        } else if (char === ',') output += `,\n${'  '.repeat(level)}`
        else if (char === ':') output += ': '
        else if (!/\s/.test(char)) output += char
      }
      setValue(output)
    } catch {
      toast.error('The raw string is not valid JSON.')
    }
  }

  if (demo)
    return (
      <div className="center-empty">
        <Layers />
        <h3>Redis key workspace</h3>
        <p>
          This is a labeled design demo. Add and connect a real Redis profile to scan keys, inspect values,
          and manage expiration.
        </p>
      </div>
    )
  if (!connected)
    return (
      <div className="center-empty">
        <KeyRound />
        <h3>Connect to browse Redis</h3>
        <p>
          {profile.name} · database {profile.redisDb}. Connect from the sidebar. Your key browser will keep
          its connection target.
        </p>
      </div>
    )

  const columns =
    data?.key.type === 'hash'
      ? ['Field', 'Value']
      : data?.key.type === 'list'
        ? ['Index', 'Value']
        : data?.key.type === 'zset'
          ? ['Member', 'Score']
          : data?.key.type === 'stream'
            ? ['Entry ID', 'Field', 'Value']
            : ['Member']

  return (
    <div className="query-workspace">
      <div className="toolbar">
        <span className="toolbar-title">
          <Layers />
          Keys <Badge variant="secondary">DB {profile.redisDb}</Badge>
        </span>
        <span className="toolbar-spacer" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            useApp
              .getState()
              .openTab({ connectionId: profile.id, kind: 'query', title: 'Redis console', sql: 'PING' })
          }
        >
          <Terminal data-icon="inline-start" />
          Console
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!writable || busy}
          onClick={() => {
            setDialogError('')
            setDialog(blankDialog(true))
          }}
        >
          <Plus data-icon="inline-start" />
          New key
        </Button>
        <IconButton
          label="Refresh Redis keys and selected value"
          disabled={scanning || loading || busy}
          onClick={() => void refresh()}
        >
          <RefreshCw />
        </IconButton>
      </div>
      {error ? <ErrorPanel message={error} /> : null}
      <div className="redis-layout">
        <aside className="redis-list" aria-label="Redis key browser">
          <form
            className="flex flex-col gap-2 border-b p-3"
            onSubmit={(event) => {
              event.preventDefault()
              void loadScan(true)
            }}
          >
            <div className="flex gap-2">
              <Input
                aria-label="Redis key pattern"
                value={pattern}
                placeholder="Filter with a pattern, e.g. user:*"
                onChange={(event) => setPattern(event.target.value)}
              />
              <Button
                type="submit"
                size="icon"
                variant="outline"
                disabled={scanning}
                aria-label="Scan matching keys"
              >
                <Search />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor={`scan-count-${tab.id}`} className="field-note">
                Batch hint
              </label>
              <select
                id={`scan-count-${tab.id}`}
                value={batch}
                onChange={(event) => setBatch(Number(event.target.value))}
              >
                <option value={100}>100 keys</option>
                <option value={200}>200 keys</option>
                <option value={500}>500 keys</option>
                <option value={1000}>1,000 keys</option>
              </select>
            </div>
          </form>
          <div className="redis-list-scroll" ref={listRef}>
            {keys.length ? (
              <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
                {virtual.getVirtualItems().map((item) => {
                  const key = keys[item.index]!
                  return (
                    <button
                      key={key.keyBase64}
                      type="button"
                      className={cn('redis-key', selected?.keyBase64 === key.keyBase64 && 'active')}
                      aria-pressed={selected?.keyBase64 === key.keyBase64}
                      disabled={busy}
                      onClick={() => void chooseKey(key)}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        transform: `translateY(${item.start}px)`,
                        height: item.size,
                      }}
                    >
                      <KeyRound />
                      <span>
                        <strong title={key.key}>{key.key || '(empty key name)'}</strong>
                        <small>
                          <span>{key.type}</span>
                          <span>{ttlLabel(key.ttl)}</span>
                        </small>
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : scanning ? (
              <Loading text="Scanning this batch…" />
            ) : (
              <div className="center-empty">
                <Search />
                <p>
                  {scanned
                    ? 'No keys in this batch. Continue scanning or change the pattern.'
                    : 'Scan to discover keys.'}
                </p>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2 border-t p-3">
            <span className="field-note" role="status">
              {keys.length.toLocaleString()} unique keys loaded
              {stopped ? ' · Stopped' : scanned && scanCursor === '0' ? ' · Scan complete' : ''}
            </span>
            {scanning ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  scanEpoch.current++
                  setScanning(false)
                  setStopped(true)
                }}
              >
                <Square data-icon="inline-start" />
                Stop loading
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadScan(!scanned)}
                disabled={keys.length >= MAX_KEYS || (scanned && scanCursor === '0')}
              >
                {scanned ? 'Scan next batch' : 'Scan keys'}
              </Button>
            )}
            <span className="field-note">
              {keys.length >= MAX_KEYS
                ? '10,000-key view limit reached. Narrow the pattern to continue.'
                : 'SCAN is incremental. Keys may repeat or change; batch size is a hint.'}
            </span>
          </div>
        </aside>
        <section className="redis-detail" aria-label="Redis key inspector">
          {!selected ? (
            <div className="center-empty">
              <KeyRound />
              <h3>Inspect a key</h3>
              <p>
                Select a key to view its type, value, and expiration. Values stay local to this workspace.
              </p>
            </div>
          ) : loading && !data ? (
            <Loading text="Reading a bounded value preview…" />
          ) : data ? (
            <>
              <div className="redis-meta">
                <KeyRound />
                <h2 title={selected.key}>{selected.key || '(empty key name)'}</h2>
                <CopyButton value={selected.key} label="Copy key name" />
                <Badge variant="secondary">{data.key.type}</Badge>
                <span className="toolbar-spacer" />
                <span className="field-note">
                  {data.size.toLocaleString()} {data.key.type === 'string' ? 'bytes' : 'entries'}
                </span>
              </div>
              {data.key.type === 'none' ? (
                <div className="center-empty">
                  <Clock3 />
                  <h3>This key no longer exists</h3>
                  <p>It may have expired or been removed by another client. Refresh the key browser.</p>
                </div>
              ) : (
                <>
                  {data.truncated ? (
                    <div className="hint-bar warning">
                      This is a bounded preview. One or more values were clipped; editing this preview is
                      disabled.
                    </div>
                  ) : null}
                  {dirty ? (
                    <div className="pending-bar">
                      <Pencil />1 value change ready to apply
                      <span className="toolbar-spacer" />
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setValue(base)}>
                        <X data-icon="inline-start" />
                        Discard
                      </Button>
                      <Button
                        size="sm"
                        disabled={!writable || busy || data.truncated}
                        onClick={() => void applyString()}
                      >
                        <Check data-icon="inline-start" />
                        Apply
                      </Button>
                    </div>
                  ) : null}
                  <div className="redis-value">
                    {data.key.type === 'string' ? (
                      <FieldGroup>
                        <Field>
                          <div className="flex items-center gap-2">
                            <FieldLabel htmlFor={`redis-value-${tab.id}`}>
                              {binary ? 'Binary value · base64' : 'Raw string value'}
                            </FieldLabel>
                            <span className="toolbar-spacer" />
                            <CopyButton
                              value={value}
                              label={binary ? 'Copy base64 value' : 'Copy raw value'}
                            />
                            {!binary ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={!writable || busy || data.truncated}
                                onClick={formatJson}
                              >
                                <Braces data-icon="inline-start" />
                                Format JSON
                              </Button>
                            ) : null}
                          </div>
                          <textarea
                            id={`redis-value-${tab.id}`}
                            spellCheck={false}
                            value={value}
                            readOnly={!writable || data.truncated || busy}
                            onChange={(event) => setValue(event.target.value)}
                          />
                        </Field>
                        <p className="field-note">
                          {profile.readOnly
                            ? 'Read-only safeguards are active. Enable writes in connection settings to edit.'
                            : 'Changes are staged locally. Applying compares the original bytes atomically and preserves the existing expiration.'}
                        </p>
                      </FieldGroup>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 pb-3">
                          <span className="field-note">
                            {data.entries.length.toLocaleString()} rows loaded
                          </span>
                          <span className="toolbar-spacer" />
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!writable || busy || data.truncated}
                            onClick={() => openEdit()}
                          >
                            <Plus data-icon="inline-start" />
                            Change {data.key.type === 'stream' ? 'stream' : 'collection'}
                          </Button>
                        </div>
                        <div className="overflow-auto">
                          <table className="data-grid">
                            <thead>
                              <tr>
                                {columns.map((column) => (
                                  <th key={column}>{column}</th>
                                ))}
                                <th aria-label="Entry actions" style={{ width: 74 }} />
                              </tr>
                            </thead>
                            <tbody>
                              {data.entries.map((row, index) => (
                                <tr key={index}>
                                  {row.map((cell, column) => (
                                    <td
                                      key={column}
                                      className="mono"
                                      title={displayCell(cell)}
                                      style={{ maxWidth: 320 }}
                                    >
                                      {displayCell(cell)}
                                    </td>
                                  ))}
                                  <td>
                                    <div className="flex">
                                      <CopyButton
                                        value={row.map(displayCell).join('\t')}
                                        label="Copy entry"
                                      />
                                      <IconButton
                                        label={
                                          data.key.type === 'stream' || data.key.type === 'set'
                                            ? 'Remove entry'
                                            : 'Edit entry'
                                        }
                                        disabled={!writable || busy || data.truncated}
                                        onClick={() => openEdit(row)}
                                      >
                                        <Pencil />
                                      </IconButton>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {data.cursor !== '0' ? (
                          <Button
                            className="mt-3"
                            size="sm"
                            variant="outline"
                            disabled={loading || data.entries.length >= 2000}
                            onClick={() => void readKey(selected, data.cursor, true)}
                          >
                            {loading
                              ? 'Loading…'
                              : data.entries.length >= 2000
                                ? '2,000-row view limit reached'
                                : 'Load next 100 entries'}
                          </Button>
                        ) : null}
                        <p className="field-note mt-3">
                          {data.key.type === 'list'
                            ? 'List changes use actual push or index replacement operations. Concurrent inserts may shift indexes.'
                            : data.key.type === 'stream'
                              ? 'Events are appended with server-generated IDs. Delete removes the entire event by ID.'
                              : 'Collection operations apply immediately after review. Concurrent changes remain possible; refresh before modifying a shared collection.'}
                        </p>
                      </>
                    )}
                  </div>
                  <div className="redis-actions">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!writable || busy}
                      onClick={() =>
                        void (async () => {
                          const name = await confirm({
                            title: 'Rename key',
                            description: `Rename ${selected.key} in ${profile.name}, database ${profile.redisDb}. An existing destination will never be replaced.`,
                            input: true,
                            defaultValue: selected.key.startsWith('base64:') ? '' : selected.key,
                            label: 'Rename',
                          })
                          if (name !== false)
                            await mutateKey(
                              { action: 'rename', value: name },
                              'Key renamed. Existing expiration preserved.',
                            )
                        })()
                      }
                    >
                      <Pencil data-icon="inline-start" />
                      Rename
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!writable || busy}
                      onClick={() =>
                        void (async () => {
                          const accepted = await confirm({
                            title: 'Delete this Redis key?',
                            description: `${profile.name} · database ${profile.redisDb} · ${profile.environment}. This permanently removes the entire ${data.key.type} value.`,
                            typed: selected.key || '(empty key name)',
                            danger: true,
                            label: 'Delete key',
                          })
                          if (accepted !== false) await mutateKey({ action: 'delete' }, 'Key deleted.')
                        })()
                      }
                    >
                      <Trash2 data-icon="inline-start" />
                      Delete key
                    </Button>
                  </div>
                  <div className="redis-ttl flex-wrap">
                    <Clock3 />
                    <span>{ttlLabel(data.key.ttl)}</span>
                    <span className="toolbar-spacer" />
                    <Input
                      aria-label="Expiration in seconds"
                      type="number"
                      min={0}
                      max={2147483647}
                      value={ttl}
                      disabled={!writable || busy}
                      onChange={(event) => setTtl(event.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!writable || busy || !/^\d+$/.test(ttl) || Number(ttl) > 2147483647}
                      onClick={() =>
                        void (async () => {
                          if (Number(ttl) === 0) {
                            const accepted = await confirm({
                              title: 'Expire this key now?',
                              description: 'An expiration of zero seconds immediately deletes the key.',
                              typed: selected.key || '(empty key name)',
                              danger: true,
                              label: 'Expire now',
                            })
                            if (accepted === false) return
                          }
                          await mutateKey({ action: 'expire', ttl: Number(ttl) }, 'Expiration updated.')
                        })()
                      }
                    >
                      Set TTL
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!writable || busy || data.key.ttl < 0}
                      onClick={() => void mutateKey({ action: 'persist' }, 'Expiration removed.')}
                    >
                      Persist
                    </Button>
                  </div>
                </>
              )}
            </>
          ) : null}
        </section>
      </div>
      <Dialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null)
        }}
      >
        <DialogContent className="connection-dialog">
          <DialogHeader>
            <DialogTitle>{dialog?.create ? 'Create Redis key' : 'Change collection'}</DialogTitle>
            <DialogDescription>
              {profile.name} · database {profile.redisDb} · {profile.environment}.{' '}
              {dialog?.create
                ? 'An existing key will never be overwritten.'
                : 'Review this operation before applying it to Redis.'}
            </DialogDescription>
          </DialogHeader>
          {dialog ? (
            <FieldGroup className="form-grid">
              {dialog.create ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="new-redis-key">Key name</FieldLabel>
                    <Input
                      id="new-redis-key"
                      autoFocus
                      value={dialog.keyName}
                      onChange={(event) => setDialog({ ...dialog, keyName: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-redis-type">Type</FieldLabel>
                    <select
                      id="new-redis-type"
                      value={dialog.type}
                      onChange={(event) => {
                        const type = event.target.value as RedisType
                        setDialog({ ...dialog, type, action: firstAction[type] })
                      }}
                    >
                      {Object.keys(firstAction).map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              ) : (
                <Field className="full-field">
                  <FieldLabel htmlFor="redis-operation">Operation</FieldLabel>
                  <select
                    id="redis-operation"
                    value={dialog.action}
                    onChange={(event) => setDialog({ ...dialog, action: event.target.value as Mutation })}
                  >
                    {actions[dialog.type].map((action) => (
                      <option key={action} value={action}>
                        {action.toUpperCase()} · {actionNames[action]}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {['hset', 'hdel', 'xadd', 'xdel'].includes(dialog.action) ? (
                <Field className="full-field">
                  <FieldLabel htmlFor="redis-field">
                    {dialog.action === 'xdel'
                      ? 'Stream entry ID'
                      : `Field${dialog.fieldBinary ? ' · base64' : ''}`}
                  </FieldLabel>
                  <Input
                    id="redis-field"
                    value={dialog.field}
                    onChange={(event) => setDialog({ ...dialog, field: event.target.value })}
                  />
                  {dialog.action !== 'xdel' ? (
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={dialog.fieldBinary}
                        onChange={(event) => setDialog({ ...dialog, fieldBinary: event.target.checked })}
                      />
                      Field is base64-encoded binary
                    </label>
                  ) : null}
                </Field>
              ) : null}
              {dialog.action === 'lset' ? (
                <Field>
                  <FieldLabel htmlFor="redis-list-index">List index</FieldLabel>
                  <Input
                    id="redis-list-index"
                    type="number"
                    value={dialog.index}
                    onChange={(event) => setDialog({ ...dialog, index: event.target.value })}
                  />
                </Field>
              ) : null}
              {dialog.action === 'zadd' ? (
                <Field>
                  <FieldLabel htmlFor="redis-score">Score</FieldLabel>
                  <Input
                    id="redis-score"
                    type="number"
                    step="any"
                    value={dialog.score}
                    onChange={(event) => setDialog({ ...dialog, score: event.target.value })}
                  />
                </Field>
              ) : null}
              {!['hdel', 'xdel'].includes(dialog.action) ? (
                <Field className="full-field">
                  <FieldLabel htmlFor="redis-entry-value">
                    {['sadd', 'srem', 'zadd', 'zrem'].includes(dialog.action) ? 'Member' : 'Value'}
                    {dialog.binary ? ' · base64' : ''}
                  </FieldLabel>
                  <textarea
                    id="redis-entry-value"
                    className="mono min-h-28 w-full rounded-md border p-3"
                    spellCheck={false}
                    value={dialog.value}
                    onChange={(event) => setDialog({ ...dialog, value: event.target.value })}
                  />
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={dialog.binary}
                      onChange={(event) => setDialog({ ...dialog, binary: event.target.checked })}
                    />
                    Value is base64-encoded binary
                  </label>
                </Field>
              ) : null}
              <p className="field-note full-field">
                {dialog.action.toUpperCase()} affects this key only.{' '}
                {dialog.create
                  ? 'New keys start without an expiration; manage TTL after creation.'
                  : 'Existing expiration is preserved. Collection changes do not include a concurrency comparison.'}
              </p>
            </FieldGroup>
          ) : null}
          {dialogError ? <ErrorPanel message={dialogError} /> : null}
          <div className="dialog-actions">
            <Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button disabled={busy || !writable} onClick={() => void applyDialog()}>
              {busy ? 'Applying…' : dialog?.create ? 'Create key' : 'Apply change'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
