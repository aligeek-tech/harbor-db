import { useDeferredValue, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  Download,
  FileCode2,
  FolderOpen,
  LockKeyhole,
  Moon,
  Plus,
  Search,
  Settings2,
  Table2,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ConnectionProfile, ObjectInfo } from '@shared/contracts'
import { useApp } from '../store'
import { errorText, cn } from '../lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { EngineIcon } from './common'

interface PaletteProps {
  onClose: () => void
  onAction: (action: string) => void
  onConnect: (profile: ConnectionProfile) => Promise<void>
  onOpenQuery: (query: {
    name: string
    sql: string
    connectionId?: string
    database?: string
    collection?: string
    mongoMode?: 'find' | 'aggregate'
  }) => void
  onOpenObject: (profile: ConnectionProfile, object: ObjectInfo) => void
}
interface Item {
  id: string
  label: string
  detail: string
  keywords: string
  icon: ReactNode
  choose: () => void
}
const actions = [
  {
    id: 'new-connection',
    label: 'Add a connection',
    detail: 'Action',
    icon: Plus,
    keywords: 'postgres postgresql mariadb redis database server',
  },
  {
    id: 'new-query',
    label: 'New query tab',
    detail: 'Ctrl/Cmd+T',
    icon: FileCode2,
    keywords: 'sql editor command console',
  },
  {
    id: 'settings',
    label: 'Open settings',
    detail: 'Action',
    icon: Settings2,
    keywords: 'appearance density zoom password history privacy retention',
  },
  {
    id: 'import-sql',
    label: 'Open SQL file',
    detail: 'Open without executing',
    icon: FolderOpen,
    keywords: 'import query script',
  },
  {
    id: 'import-connections',
    label: 'Import connection metadata',
    detail: 'Preview before adding',
    icon: Upload,
    keywords: 'profiles restore json',
  },
  {
    id: 'export-connections',
    label: 'Export connection metadata',
    detail: 'Passwords excluded',
    icon: Download,
    keywords: 'profiles backup json',
  },
  {
    id: 'toggle-theme',
    label: 'Switch light / dark theme',
    detail: 'Appearance',
    icon: Moon,
    keywords: 'system color appearance',
  },
  {
    id: 'private-session',
    label: 'Manage private session',
    detail: 'Workspace privacy',
    icon: LockKeyhole,
    keywords: 'drafts history sensitive values',
  },
]

export function CommandPalette({ onClose, onAction, onConnect, onOpenQuery, onOpenObject }: PaletteProps) {
  const profiles = useApp((state) => state.profiles)
  const savedQueries = useApp((state) => state.savedQueries)
  const objects = useApp((state) => state.objects)
  const statuses = useApp((state) => state.statuses)
  const [search, setSearch] = useState('')
  const term = useDeferredValue(search.trim().toLowerCase())
  const [highlighted, setHighlighted] = useState(0)
  const listId = useId()
  const items = useMemo(() => {
    const all: Item[] = actions.map((action) => ({
      id: action.id,
      label: action.label,
      detail: action.detail,
      keywords: action.keywords,
      icon: <action.icon />,
      choose: () => onAction(action.id),
    }))
    for (const profile of profiles) {
      all.push({
        id: `connection:${profile.id}`,
        label: profile.name,
        detail: `${profile.engine} · ${profile.environment} · ${statuses[profile.id]?.state || 'disconnected'}`,
        keywords: `${profile.host} ${profile.database} ${profile.folder} ${profile.tags.join(' ')}`,
        icon: <EngineIcon engine={profile.engine} />,
        choose: () => {
          void onConnect(profile).catch((error) => toast.error(errorText(error)))
        },
      })
      for (const object of objects[profile.id] || [])
        all.push({
          id: JSON.stringify([
            'object',
            profile.id,
            object.database,
            object.kind,
            object.schema,
            object.name,
          ]),
          label: `${object.schema ? `${object.schema}.` : ''}${object.name}`,
          detail: `${profile.name}${object.database ? ` · ${object.database}` : ''} · ${object.kind}`,
          keywords: profile.engine,
          icon: <Table2 />,
          choose: () => onOpenObject(profile, object),
        })
    }
    for (const query of savedQueries)
      all.push({
        id: `query:${query.id}`,
        label: query.name,
        detail: `Saved query · ${query.engine}${query.database ? ` · ${query.database}` : ''}`,
        keywords: `${query.folder} ${query.tags.join(' ')} ${query.sql}`,
        icon: <FileCode2 />,
        choose: () =>
          onOpenQuery({
            name: query.name,
            sql: query.sql,
            connectionId: query.connectionId,
            database: query.database,
            collection: query.collection,
            mongoMode: query.mongoMode,
          }),
      })
    const words = term.split(/\s+/).filter(Boolean)
    return all
      .filter((item) =>
        words.every((word) => `${item.label} ${item.detail} ${item.keywords}`.toLowerCase().includes(word)),
      )
      .slice(0, 80)
  }, [profiles, savedQueries, objects, statuses, term, onAction, onConnect, onOpenQuery, onOpenObject])
  const activeIndex = Math.min(highlighted, Math.max(0, items.length - 1))
  useEffect(() => {
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, listId])
  function select(item: Item) {
    onClose()
    item.choose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="palette" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>
            Find actions, connections, saved queries, and loaded database objects. Use arrow keys and Enter to
            choose.
          </DialogDescription>
        </DialogHeader>
        <div className="palette-search">
          <Search aria-hidden="true" />
          <input
            autoFocus
            aria-label="Search actions and database objects"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={items.length ? `${listId}-${activeIndex}` : undefined}
            autoComplete="off"
            spellCheck={false}
            value={search}
            placeholder="Where would you like to go?"
            onChange={(event) => {
              setSearch(event.target.value)
              setHighlighted(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setHighlighted((index) => (items.length ? (index + 1) % items.length : 0))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setHighlighted((index) =>
                  items.length ? (Math.min(index, items.length - 1) - 1 + items.length) % items.length : 0,
                )
              }
              if (event.key === 'Enter' && items[activeIndex]) {
                event.preventDefault()
                select(items[activeIndex])
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-results" id={listId} role="listbox" aria-label="Matching actions and objects">
          {items.length ? (
            items.map((item, index) => (
              <button
                type="button"
                id={`${listId}-${index}`}
                key={item.id}
                role="option"
                aria-selected={index === activeIndex}
                tabIndex={-1}
                className={cn('palette-item', index === activeIndex && 'bg-accent')}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => select(item)}
              >
                {item.icon}
                <span className="truncate">{item.label}</span>
                <small>{item.detail}</small>
              </button>
            ))
          ) : (
            <p className="center-empty" role="status">
              No matches. Objects become searchable after loading a connection’s explorer.
            </p>
          )}
        </div>
        <div className="palette-footer">
          <kbd>↑</kbd> <kbd>↓</kbd> Navigate &nbsp; <kbd>Enter</kbd> Open &nbsp; <kbd>Esc</kbd> Close ·{' '}
          {items.length} matches{items.length === 80 ? ' shown; refine your search' : ''}
        </div>
      </DialogContent>
    </Dialog>
  )
}
