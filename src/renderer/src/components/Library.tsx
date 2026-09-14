import { useDeferredValue, useState } from 'react'
import {
  CheckCircle2,
  Clock3,
  Download,
  FileCode2,
  FolderOpen,
  History,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { useApp } from '../store'
import { api, isDesktop } from '../lib/api'
import { errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty'
import { EngineIcon, ErrorPanel, IconButton, useConfirm } from './common'

interface LibraryProps {
  section: 'queries' | 'history'
  onOpenQuery: (query: { name: string; sql: string; connectionId?: string; database?: string }) => void
  onImportSql: () => void
}

export function Library({ section, onOpenQuery, onImportSql }: LibraryProps) {
  const savedQueries = useApp((state) => state.savedQueries)
  const history = useApp((state) => state.history)
  const profiles = useApp((state) => state.profiles)
  const settings = useApp((state) => state.workspace.settings)
  const [search, setSearch] = useState('')
  const term = useDeferredValue(search.trim().toLowerCase())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const confirm = useConfirm()
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]))
  const queries = savedQueries.filter((query) =>
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
  const entries = history.filter((entry) =>
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
  const count = section === 'queries' ? queries.length : entries.length

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
              : `Revisit previous SQL and Redis commands. Retained for ${settings.historyRetentionDays} days; newest 500 shown.`}
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
              ? 'Find queries by name, engine, folder, tag, or SQL…'
              : 'Find commands, connections, or errors…'
          }
        />
      </label>
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
              {term
                ? 'No matching entries'
                : section === 'queries'
                  ? 'Keep your best queries close'
                  : 'Your work will appear here'}
            </EmptyTitle>
            <EmptyDescription>
              {term
                ? 'Try a connection name, engine, or a phrase from the command.'
                : section === 'queries'
                  ? 'Save a query from the editor with Ctrl/Cmd+S, or open a SQL file to get started.'
                  : 'Executed commands are remembered when history is enabled. Opening an entry creates an editor draft without executing it.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
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
                      sql: query.sql,
                      connectionId: query.connectionId,
                      database: query.database,
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
    </section>
  )
}
