import type { QueryDraft } from '@shared/query-target'
import type { SavedQuery } from '@shared/contracts'
import type { ReportDefinition } from '@shared/reports'
import { emptyHistoryFilters, historyMatches, updateQueryMetadata } from '@shared/query-library'
import { useDeferredValue, useState } from 'react'
import {
  CheckCircle2,
  Clock3,
  BarChart3,
  Download,
  FileCode2,
  FolderOpen,
  History,
  Pencil,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { useApp } from '../store'
import { api, isDesktop } from '../lib/api'
import { errorText } from '../lib/utils'
import { shortcutHint } from '../lib/shortcuts'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Badge } from './ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty'
import { EngineIcon, ErrorPanel, IconButton, useConfirm } from './common'

interface LibraryProps {
  section: 'queries' | 'history'
  onOpenQuery: (query: QueryDraft) => void
  onOpenReport?: (report: ReportDefinition) => void
  onImportSql: () => void
}

export function Library({ section, onOpenQuery, onOpenReport, onImportSql }: LibraryProps) {
  const savedQueries = useApp((state) => state.savedQueries)
  const reports = useApp((state) => state.reports)
  const history = useApp((state) => state.history)
  const profiles = useApp((state) => state.profiles)
  const settings = useApp((state) => state.workspace.settings)
  const [search, setSearch] = useState('')
  const term = useDeferredValue(search.trim().toLowerCase())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [connection, setConnection] = useState('')
  const [folder, setFolder] = useState('')
  const [tag, setTag] = useState('')
  const [historyFilters, setHistoryFilters] = useState(emptyHistoryFilters)
  const [retention, setRetention] = useState(String(settings.historyRetentionDays))
  const [editing, setEditing] = useState<{
    query: SavedQuery
    name: string
    folder: string
    tags: string
  } | null>(null)
  const confirm = useConfirm()
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]))
  const queries = savedQueries.filter(
    (query) =>
      (!connection || (connection === 'unbound' ? !query.connectionId : query.connectionId === connection)) &&
      (!folder || (folder === 'unfiled' ? !query.folder : query.folder === folder)) &&
      (!tag || query.tags.includes(tag)) &&
      [
        query.name,
        query.sql,
        query.engine,
        query.database,
        query.folder,
        ...query.tags,
        profileMap.get(query.connectionId || '')?.name || '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(term),
  )
  const reportEntries = reports.filter(
    (report) =>
      !folder &&
      !tag &&
      (!connection ||
        (connection === 'unbound' ? !report.connectionId : report.connectionId === connection)) &&
      [
        report.name,
        report.sql,
        report.engine,
        report.database,
        report.view.kind,
        ...report.filters.map((filter) => `${filter.operator} ${filter.value}`),
        profileMap.get(report.connectionId || '')?.name || '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(term),
  )
  const entries = history.filter(
    (entry) =>
      historyMatches(entry, historyFilters) &&
      [
        entry.sql,
        entry.database,
        profileMap.get(entry.connectionId)?.name || '',
        profileMap.get(entry.connectionId)?.engine || '',
        entry.success ? 'success' : entry.error?.startsWith('Cancelled:') ? 'cancelled' : 'failed',
        entry.error || '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(term),
  )
  const count = section === 'queries' ? queries.length + reportEntries.length : entries.length
  const hasFilters =
    !!term ||
    (section === 'queries' ? !!(connection || folder || tag) : Object.values(historyFilters).some(Boolean))

  async function saveMetadata() {
    if (!editing) return
    setBusy(editing.query.id)
    setError('')
    try {
      // Refresh the base by ID so concurrent SQL/parameter changes are not overwritten by metadata edits.
      const current = useApp.getState().savedQueries.find((query) => query.id === editing.query.id)
      if (!current) throw new Error('This query was removed. Close this editor and refresh the library.')
      await api.saveQuery(updateQueryMetadata(current, editing.name, editing.folder, editing.tags))
      await useApp.getState().refreshMetadata()
      setEditing(null)
      toast.success('Query metadata saved. SQL and target unchanged.')
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  async function applyRetention() {
    const days = Number(retention)
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setError('Retention must be between 1 and 365 whole days.')
      return
    }
    if (
      days < settings.historyRetentionDays &&
      !(await confirm({
        title: 'Shorten history retention?',
        description: `Entries older than ${days} days will be removed immediately. Saved queries and open drafts are unaffected.`,
        label: 'Apply retention',
        danger: true,
      }))
    )
      return
    setBusy('retention')
    setError('')
    try {
      const workspace = useApp.getState().workspace
      await api.saveWorkspace({
        ...workspace,
        settings: { ...workspace.settings, historyRetentionDays: days },
      })
      useApp.getState().setSettings({ historyRetentionDays: days })
      await useApp.getState().refreshMetadata()
      toast.success('History retention updated')
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  async function removeQuery(id: string, name: string) {
    if (
      !(await confirm({
        title: `Delete ${name}?`,
        description:
          'Remove this named query from your saved library. Text already open in an editor stays available.',
        label: 'Delete query',
        danger: true,
      }))
    )
      return
    setBusy(id)
    setError('')
    try {
      await api.deleteQuery(id)
      await useApp.getState().refreshMetadata()
      toast.success('Saved query removed')
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  async function removeReport(id: string, name: string) {
    if (
      !(await confirm({
        title: `Delete ${name}?`,
        description:
          'Remove this local report definition. Open query drafts and database contents are unaffected.',
        label: 'Delete report',
        danger: true,
      }))
    )
      return
    setBusy(id)
    setError('')
    try {
      await api.deleteReport(id)
      await useApp.getState().refreshMetadata()
      toast.success('Report definition removed')
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  async function clearHistory() {
    if (
      !(await confirm({
        title: 'Clear query history?',
        description:
          'Remove the retained SQL and Redis command history from this application. Database contents and named saved queries are unaffected.',
        label: 'Clear history',
        danger: true,
      }))
    )
      return
    setBusy('clear')
    setError('')
    try {
      await api.clearHistory()
      await useApp.getState().refreshMetadata()
      toast.success('Query history cleared')
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="library" aria-label={section === 'queries' ? 'Saved queries' : 'Query history'}>
      <div className="library-header">
        <div>
          <h1>{section === 'queries' ? 'Your query library' : 'Query history'}</h1>
          <p>
            {section === 'queries'
              ? 'Useful work, ready when you need it. Opening a query never runs it.'
              : `Local command history, not an audit log. Retained for ${settings.historyRetentionDays} days; filters cover the newest 500 retained entries.`}
          </p>
        </div>
        <div className="toolbar-spacer" />
        {section === 'queries' ? (
          <Button variant="outline" onClick={onImportSql} disabled={!isDesktop}>
            <FolderOpen data-icon="inline-start" />
            Open .sql file
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={!history.length || !!busy || !isDesktop}
            onClick={() => {
              void clearHistory()
            }}
          >
            <Trash2 data-icon="inline-start" />
            Clear history
          </Button>
        )}
      </div>
      <label className="flex items-center gap-2" htmlFor={`library-search-${section}`}>
        <Search aria-hidden="true" />
        <Input
          id={`library-search-${section}`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={
            section === 'queries'
              ? 'Find queries or reports by name, engine, folder, filter, or SQL…'
              : 'Find commands, connections, or errors…'
          }
        />
      </label>
      <div className="flex flex-wrap items-end gap-3" aria-label="Library filters">
        {section === 'queries' ? (
          <>
            <label className="field-note">
              Connection
              <select
                aria-label="Query connection filter"
                value={connection}
                onChange={(event) => setConnection(event.target.value)}
              >
                <option value="">All connections</option>
                <option value="unbound">No bound connection</option>
                {[
                  ...new Set(
                    [...savedQueries, ...reports]
                      .map((item) => item.connectionId)
                      .filter((id): id is string => !!id),
                  ),
                ].map((id) => (
                  <option key={id} value={id}>
                    {profileMap.get(id)?.name || `Unavailable connection (${id})`}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-note">
              Folder
              <select
                aria-label="Query folder filter"
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
              >
                <option value="">All folders</option>
                <option value="unfiled">Unfiled</option>
                {[...new Set(savedQueries.map((query) => query.folder).filter(Boolean))]
                  .sort()
                  .map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field-note">
              Tag
              <select
                aria-label="Query tag filter"
                value={tag}
                onChange={(event) => setTag(event.target.value)}
              >
                <option value="">All tags</option>
                {[...new Set(savedQueries.flatMap((query) => query.tags))].sort().map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <label className="field-note">
              Connection
              <select
                aria-label="History connection filter"
                value={historyFilters.connectionId}
                onChange={(event) =>
                  setHistoryFilters({ ...historyFilters, connectionId: event.target.value })
                }
              >
                <option value="">All connections</option>
                {[...new Set(history.map((entry) => entry.connectionId))].map((id) => (
                  <option key={id} value={id}>
                    {profileMap.get(id)?.name || `Unavailable connection (${id})`}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-note">
              Outcome
              <select
                aria-label="History outcome filter"
                value={historyFilters.outcome}
                onChange={(event) =>
                  setHistoryFilters({
                    ...historyFilters,
                    outcome: event.target.value as typeof historyFilters.outcome,
                  })
                }
              >
                <option value="">All outcomes</option>
                <option value="success">Succeeded</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            {(['after', 'before'] as const).map((key) => (
              <label className="field-note" key={key}>
                {key === 'after' ? 'From date' : 'Through date'} (local)
                <Input
                  type="date"
                  aria-label={`History ${key} date`}
                  value={historyFilters[key]}
                  onChange={(event) => setHistoryFilters({ ...historyFilters, [key]: event.target.value })}
                />
              </label>
            ))}
            {(
              [
                ['minDuration', 'Minimum duration (ms)'],
                ['maxDuration', 'Maximum duration (ms)'],
                ['minRows', 'Minimum loaded rows'],
                ['maxRows', 'Maximum loaded rows'],
              ] as const
            ).map(([key, label]) => (
              <label className="field-note" key={key}>
                {label}
                <Input
                  type="number"
                  min={0}
                  aria-label={label}
                  className="w-36"
                  value={historyFilters[key]}
                  onChange={(event) => setHistoryFilters({ ...historyFilters, [key]: event.target.value })}
                />
              </label>
            ))}
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={!hasFilters}
          onClick={() => {
            setSearch('')
            setConnection('')
            setFolder('')
            setTag('')
            setHistoryFilters(emptyHistoryFilters)
          }}
        >
          Clear filters
        </Button>
        <span className="field-note" role="status">
          {count} matching {section === 'queries' ? 'saved items' : 'retained entries'}
        </span>
      </div>
      {section === 'history' && (
        <details>
          <summary>History retention</summary>
          <div className="flex items-end gap-3 py-3">
            <label className="field-note">
              Keep history for (days)
              <Input
                aria-label="History retention days"
                type="number"
                min={1}
                max={365}
                value={retention}
                onChange={(event) => setRetention(event.target.value)}
              />
            </label>
            <Button
              variant="outline"
              disabled={!!busy || !isDesktop || retention === String(settings.historyRetentionDays)}
              onClick={() => void applyRetention()}
            >
              Apply retention
            </Button>
          </div>
          <p className="field-note">
            Shortening retention removes older local entries. History recording and private session controls
            are in Settings.
          </p>
        </details>
      )}
      {error ? <ErrorPanel message={error} /> : null}
      {section === 'history' && (settings.privateSession || !settings.historyEnabled) ? (
        <p className="field-note">
          <History className="inline" />{' '}
          {settings.privateSession
            ? 'Private session is active. New commands will not be added to history.'
            : 'Query history is disabled. Previously saved entries remain until you clear them.'}
        </p>
      ) : null}
      {count === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">{section === 'queries' ? <FileCode2 /> : <Clock3 />}</EmptyMedia>
            <EmptyTitle>
              {hasFilters
                ? 'No matching entries'
                : section === 'queries'
                  ? 'Keep your best queries close'
                  : 'Your work will appear here'}
            </EmptyTitle>
            <EmptyDescription>
              {hasFilters
                ? 'Try a connection name, engine, or a phrase from the command.'
                : section === 'queries'
                  ? `Save a query from the editor with ${shortcutHint('save-query')}, or open a SQL file to get started.`
                  : 'Executed commands are remembered when history is enabled. Opening an entry creates an editor draft without executing it.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {section === 'queries' &&
        reportEntries.map((report) => {
          const profile = profileMap.get(report.connectionId || '')
          return (
            <div className="library-row" key={report.id}>
              <BarChart3 aria-label="Analytics report" />
              <button
                className="library-row-content border-0 bg-transparent p-0 text-left"
                disabled={!onOpenReport}
                onClick={() => onOpenReport?.(report)}
                aria-label={`Open report ${report.name} without executing`}
              >
                <span className="library-row-title">
                  {report.name}
                  <Badge variant="outline">report</Badge>
                  <Badge variant="outline">{report.view.kind}</Badge>
                </span>
                <small>
                  {[
                    profile?.name || 'Choose DuckDB connection when opening',
                    report.database,
                    `${report.filters.length} filters`,
                    `limit ${report.view.maxPoints}`,
                  ]
                    .filter(Boolean)
                    .join(' / ')}
                </small>
                <pre>{report.sql}</pre>
              </button>
              <IconButton
                label={`Delete report ${report.name}`}
                disabled={!!busy || !isDesktop}
                onClick={() => void removeReport(report.id, report.name)}
              >
                <Trash2 />
              </IconButton>
            </div>
          )
        })}
      {section === 'queries'
        ? queries.map((query) => {
            const profile = profileMap.get(query.connectionId || '')
            return (
              <div className="library-row" key={query.id}>
                <EngineIcon engine={query.engine} />
                <button
                  className="library-row-content border-0 bg-transparent p-0 text-left"
                  onClick={() =>
                    onOpenQuery({
                      name: query.name,
                      engine: query.engine,
                      schema: query.schema,
                      parameterDefinitions: query.parameterDefinitions,
                      savedQueryId: query.id,
                      sql: query.sql,
                      connectionId: query.connectionId,
                      database: query.database,
                      collection: query.collection,
                      mongoMode: query.mongoMode,
                      searchIndex: query.searchIndex,
                      searchPageSize: query.searchPageSize,
                    })
                  }
                  aria-label={`Open saved query ${query.name} without executing`}
                >
                  <span className="library-row-title">
                    {query.name}
                    <Badge variant="outline">{query.engine}</Badge>
                  </span>
                  <small>
                    {[
                      profile?.name || 'Choose connection when opening',
                      query.database,
                      query.folder,
                      query.tags.length ? query.tags.join(' · ') : '',
                    ]
                      .filter(Boolean)
                      .join(' / ')}
                  </small>
                  <pre>{query.sql || 'Empty query'}</pre>
                </button>
                <IconButton
                  label={`Edit metadata for ${query.name}`}
                  disabled={!!busy || !isDesktop}
                  onClick={() => {
                    setError('')
                    setEditing({ query, name: query.name, folder: query.folder, tags: query.tags.join(', ') })
                  }}
                >
                  <Pencil />
                </IconButton>
                <IconButton
                  label={`Export ${query.name} as SQL`}
                  disabled={!isDesktop}
                  onClick={() => {
                    void api
                      .exportSql({ name: query.name, sql: query.sql })
                      .catch((cause) => setError(errorText(cause)))
                  }}
                >
                  <Download />
                </IconButton>
                <IconButton
                  label={`Delete ${query.name}`}
                  disabled={!!busy || !isDesktop}
                  onClick={() => {
                    void removeQuery(query.id, query.name)
                  }}
                >
                  <Trash2 />
                </IconButton>
              </div>
            )
          })
        : entries.map((entry) => {
            const profile = profileMap.get(entry.connectionId)
            const occurred = new Date(entry.executedAt)
            const cancelled = entry.error?.startsWith('Cancelled:')
            const outcome = entry.success ? 'Succeeded' : cancelled ? 'Cancelled' : 'Failed'
            return (
              <div className="library-row" key={entry.id}>
                {entry.success ? (
                  <CheckCircle2 aria-label="Succeeded" />
                ) : cancelled ? (
                  <Clock3 aria-label="Cancelled" />
                ) : (
                  <XCircle aria-label="Failed" />
                )}
                <button
                  className="library-row-content border-0 bg-transparent p-0 text-left"
                  disabled={entry.sql === '[Credential-bearing command omitted]'}
                  onClick={() =>
                    onOpenQuery({
                      name: `History · ${occurred.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
                      sql: entry.sql,
                      engine: profile?.engine,
                      connectionId: entry.connectionId,
                      database: entry.database,
                    })
                  }
                  aria-label={`Open command from ${profile?.name || 'connection'} without executing`}
                >
                  <span className="library-row-title">
                    {profile?.name || 'Connection unavailable'}
                    {entry.database && <Badge variant="outline">{entry.database}</Badge>}
                    <Badge variant="outline">{outcome}</Badge>
                  </span>
                  <small>
                    {occurred.toLocaleString()} · {Math.round(entry.durationMs)} ms ·{' '}
                    {entry.rowCount.toLocaleString()} loaded rows
                  </small>
                  <pre>{entry.sql}</pre>
                  {entry.error ? <small>{entry.error}</small> : null}
                </button>
              </div>
            )
          })}
      {editing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setEditing(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit saved-query metadata</DialogTitle>
              <DialogDescription>
                SQL, parameters, engine and connection target stay unchanged. Opening this query never runs
                it.
              </DialogDescription>
            </DialogHeader>
            <p className="field-note">
              {editing.query.engine} ·{' '}
              {profileMap.get(editing.query.connectionId || '')?.name || 'Connection chosen when opening'} ·{' '}
              {editing.query.database || 'No saved database'}
              {editing.query.schema ? ` / ${editing.query.schema}` : ''}
            </p>
            <label>
              Name
              <Input
                aria-label="Saved query name"
                maxLength={255}
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              />
            </label>
            <label>
              Folder
              <Input
                aria-label="Saved query folder"
                maxLength={100}
                value={editing.folder}
                onChange={(event) => setEditing({ ...editing, folder: event.target.value })}
              />
            </label>
            <label>
              Tags (comma separated)
              <Input
                aria-label="Saved query tags"
                value={editing.tags}
                onChange={(event) => setEditing({ ...editing, tags: event.target.value })}
              />
            </label>
            {error && (
              <p role="alert" className="danger">
                {error}
              </p>
            )}
            <Button disabled={!!busy || !editing.name.trim()} onClick={() => void saveMetadata()}>
              Save metadata
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
