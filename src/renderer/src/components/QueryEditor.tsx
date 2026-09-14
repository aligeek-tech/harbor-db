import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Editor, { loader, type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import {
  conf as postgresConfiguration,
  language as postgresLanguage,
} from 'monaco-editor/languages/definitions/pgsql/pgsql'
import {
  conf as mariaConfiguration,
  language as mariaLanguage,
} from 'monaco-editor/languages/definitions/mysql/mysql'
import {
  conf as redisConfiguration,
  language as redisLanguage,
} from 'monaco-editor/languages/definitions/redis/redis'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import { format } from 'sql-formatter'
import {
  AlignLeft,
  CircleStop,
  Code2,
  FileCode2,
  GitBranch,
  LoaderCircle,
  Play,
  Save,
  ShieldCheck,
  Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ConnectionProfile, QueryInput, TableStructure, WorkspaceTab } from '@shared/contracts'
import {
  currentStatement,
  qualifiedName,
  quoteIdentifier,
  requiredSqlConfirmation,
  splitStatements,
} from '@shared/sql'
import { api } from '../lib/api'
import { uid, errorText } from '../lib/utils'
import { useApp } from '../store'
import { DataGrid } from './DataGrid'
import { QueryDatabasePicker } from './QueryDatabasePicker'
import { Button } from './ui/button'
import { ErrorPanel, IconButton, useConfirm } from './common'

self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === 'json' ? new JsonWorker() : new EditorWorker()),
}
loader.config({ monaco })
const editorLanguages = { postgres: 'harbor-pgsql', mariadb: 'harbor-mysql', redis: 'harbor-redis' } as const
// Eager local registration makes the first model independent of Monaco's lazy
// language contributions, both in the Electron bundle and the browser preview.
for (const [id, configuration, language] of [
  [editorLanguages.postgres, postgresConfiguration, postgresLanguage],
  [editorLanguages.mariadb, mariaConfiguration, mariaLanguage],
  [editorLanguages.redis, redisConfiguration, redisLanguage],
] as const) {
  if (!monaco.languages.getLanguages().some((registered) => registered.id === id))
    monaco.languages.register({ id })
  monaco.languages.setLanguageConfiguration(id, configuration)
  monaco.languages.setMonarchTokensProvider(id, language)
}
function tokenRules(palette: Record<string, string>): monaco.editor.ITokenThemeRule[] {
  // SQL's built-in theme includes string.sql, which otherwise overrides the
  // generic string color inherited by this custom theme.
  return Object.entries(palette).flatMap(([token, foreground]) =>
    [token, `${token}.sql`, `${token}.redis`].map((name) => ({ token: name, foreground })),
  )
}
monaco.editor.defineTheme('harbor-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: tokenRules({
    keyword: 'B99AFF',
    string: '8DCEB5',
    'string.double': '8DCEB5',
    number: '8BD4D4',
    comment: '67788E',
    'comment.quote': '67788E',
    predefined: '9EC7F1',
  }),
  colors: {
    'editor.background': '#101318',
    'editor.foreground': '#E8EDF5',
    'editorLineNumber.foreground': '#637389',
    'editorLineNumber.activeForeground': '#A8B4C4',
    'editor.selectionBackground': '#233451',
    'editor.lineHighlightBackground': '#141A23',
    'editorCursor.foreground': '#7C9CFF',
    'editorWidget.background': '#1B222C',
    'editorWidget.border': '#2B3543',
    'editorSuggestWidget.background': '#1B222C',
    'editorSuggestWidget.selectedBackground': '#233451',
  },
})
monaco.editor.defineTheme('harbor-light', {
  base: 'vs',
  inherit: true,
  rules: tokenRules({
    keyword: '7652A0',
    string: '26715A',
    'string.double': '26715A',
    number: '236F8D',
    comment: '778595',
    'comment.quote': '778595',
    predefined: '316BB6',
  }),
  colors: {
    'editor.background': '#F7F8FA',
    'editor.foreground': '#202938',
    'editorLineNumber.foreground': '#8A97A7',
    'editor.lineHighlightBackground': '#F0F3F7',
    'editor.selectionBackground': '#E0E8FC',
  },
})
export function QueryEditor({
  tab,
  profile,
  visible,
  onSave,
  resultView,
  beforeExecute,
  onExecute,
  toolbarActions,
  disableExecute = false,
}: {
  tab: WorkspaceTab
  profile: ConnectionProfile
  visible: boolean
  onSave: () => void
  resultView?: ReactNode
  beforeExecute?: () => boolean
  onExecute?: () => void
  toolbarActions?: ReactNode
  disableExecute?: boolean
}) {
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const runtime = useApp((s) => s.runtime[tab.id])
  const settings = useApp((s) => s.workspace.settings)
  const connected = useApp((s) => s.statuses[profile.id]?.state === 'connected')
  const database = profile.engine === 'postgres' ? tab.database || profile.database || undefined : undefined
  const databaseRequired = profile.engine === 'postgres' && !database
  const executionDisabled = disableExecute || databaseRequired
  const [resultIndex, setResultIndex] = useState(0)
  const [messages, setMessages] = useState(false)
  const [theme, setTheme] = useState(
    document.documentElement.classList.contains('dark') ? 'harbor-dark' : 'harbor-light',
  )
  const confirm = useConfirm()
  const executeRef = useRef<
    (scope: 'current' | 'script' | 'explain', explicitConfirm?: string) => Promise<void>
  >(async () => {})
  const saveRef = useRef(onSave)
  const dispatching = useRef(false)
  const [transactionBusy, setTransactionBusy] = useState(false)
  saveRef.current = onSave
  const demo = profile.id.startsWith('demo-')
  const customResults = resultView !== undefined
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.classList.contains('dark') ? 'harbor-dark' : 'harbor-light'),
    )
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (visible) {
      editor.current?.layout()
      editor.current?.focus()
    }
  }, [visible])
  useEffect(() => {
    if (!connected || demo) return
    let active = true
    const before = useApp.getState().runtime[tab.id]?.requestId
    void api
      .getSessionState({ connectionId: tab.connectionId, sessionId: tab.id })
      .then((session) => {
        const current = useApp.getState().runtime[tab.id]
        if (active && current && !current.running && current.requestId === before)
          useApp.getState().setRuntime(tab.id, { transaction: session.state })
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [connected, demo, tab.connectionId, tab.id])
  const mount: OnMount = (instance) => {
    editor.current = instance
    if (tab.cursor !== undefined) {
      const model = instance.getModel()
      if (model) instance.setPosition(model.getPositionAt(tab.cursor))
    }
    if (tab.scrollTop) instance.setScrollTop(tab.scrollTop)
    instance.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      () => void executeRef.current('current'),
    )
    instance.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
      () => void executeRef.current('script'),
    )
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
    const cursor = instance.onDidChangeCursorPosition((e) => {
      const model = instance.getModel()
      if (model) useApp.getState().updateTab(tab.id, { cursor: model.getOffsetAt(e.position) })
    })
    const scroll = instance.onDidScrollChange((e) =>
      useApp.getState().updateTab(tab.id, { scrollTop: e.scrollTop }),
    )
    const dispose = instance.onDidDispose(() => {
      cursor.dispose()
      scroll.dispose()
      dispose.dispose()
    })
  }
  useEffect(() => {
    // Keep metadata small and local to this tab/provider. Fetch only after a table
    // qualifier or an unambiguous FROM/JOIN alias, never once per keystroke.
    const columns = new Map<string, { at: number; value: Promise<TableStructure> }>()
    const identifier = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|[A-Za-z_][\\w$]*)'
    const parts = (value: string) =>
      (value.match(new RegExp(identifier, 'g')) || []).map((part) =>
        part.startsWith('"')
          ? part.slice(1, -1).replaceAll('""', '"')
          : part.startsWith('`')
            ? part.slice(1, -1).replaceAll('``', '`')
            : part,
      )
    const completion = monaco.languages.registerCompletionItemProvider(editorLanguages[profile.engine], {
      triggerCharacters: ['.'],
      async provideCompletionItems(model, position, _context, token) {
        if (model.uri.toString() !== `inmemory://harbor/${tab.id}`) return { suggestions: [] }
        const word = model.getWordUntilPosition(position)
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        }
        const objects = (useApp.getState().objects[profile.id] || []).filter(
          (object) => profile.engine !== 'postgres' || (object.database || profile.database) === database,
        )
        if (profile.engine !== 'redis') {
          const dialect = profile.engine
          const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
          const qualifier = new RegExp(
            `(${identifier}(?:\\s*\\.\\s*${identifier})?)\\s*\\.\\s*[\\w$]*$`,
          ).exec(before)
          let target = qualifier ? parts(qualifier[1]) : []
          const partial = word.word.toLowerCase()
          if (target.length === 1) {
            const offset = model.getOffsetAt(position)
            const context = model.getValue().slice(Math.max(0, offset - 25000), offset + 25000)
            const aliases = new RegExp(
              `\\b(?:FROM|JOIN)\\s+(${identifier}(?:\\s*\\.\\s*${identifier})?)\\s+(?:AS\\s+)?(${identifier})`,
              'gi',
            )
            const matches = [...context.matchAll(aliases)].filter((match) => parts(match[2])[0] === target[0])
            if (matches.length === 1) target = parts(matches[0][1])
          }
          if (target.length) {
            const matching = objects.filter(
              (object) =>
                ['table', 'view', 'materialized view'].includes(object.kind) &&
                object.name === target.at(-1) &&
                (target.length === 1 || object.schema === target[0]),
            )
            const preferred = matching.filter(
              (object) => object.schema === (tab.schema || profile.schema || profile.database),
            )
            const table =
              matching.length === 1 ? matching[0] : preferred.length === 1 ? preferred[0] : undefined
            if (table && connected && !demo) {
              const key = `${table.schema}.${table.name}`
              let cached = columns.get(key)
              if (!cached || Date.now() - cached.at > 60000) {
                if (columns.size >= 24) columns.delete(columns.keys().next().value!)
                cached = {
                  at: Date.now(),
                  value: api.structure({
                    connectionId: profile.id,
                    database,
                    schema: table.schema,
                    table: table.name,
                  }),
                }
                columns.set(key, cached)
              }
              try {
                const version = model.getVersionId()
                const metadata = await cached.value
                if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version)
                  return { suggestions: [] }
                return {
                  suggestions: metadata.columns
                    .filter((column) => column.name.toLowerCase().startsWith(partial))
                    .slice(0, 300)
                    .map((column) => ({
                      label: column.name,
                      insertText: quoteIdentifier(column.name, dialect),
                      kind: monaco.languages.CompletionItemKind.Field,
                      detail: `${column.type}${column.primaryKey ? ' · primary key' : ''} · ${table.schema}.${table.name}`,
                      range,
                    })),
                }
              } catch {
                columns.delete(key)
                return { suggestions: [] }
              }
            }
            if (target.length === 1 && objects.some((object) => object.schema === target[0]))
              return {
                suggestions: objects
                  .filter(
                    (object) => object.schema === target[0] && object.name.toLowerCase().startsWith(partial),
                  )
                  .slice(0, 300)
                  .map((object) => ({
                    label: object.name,
                    insertText: quoteIdentifier(object.name, dialect),
                    kind: monaco.languages.CompletionItemKind.Struct,
                    detail: object.kind,
                    range,
                  })),
              }
          }
        }
        return {
          suggestions:
            profile.engine === 'redis'
              ? [
                  'GET',
                  'SET',
                  'SCAN',
                  'TYPE',
                  'TTL',
                  'PTTL',
                  'HGET',
                  'HSET',
                  'HSCAN',
                  'LRANGE',
                  'LLEN',
                  'SSCAN',
                  'ZSCAN',
                  'XRANGE',
                  'EXPIRE',
                  'PERSIST',
                  'DEL',
                  'PING',
                ].map((label) => ({
                  label,
                  insertText: label,
                  kind: monaco.languages.CompletionItemKind.Function,
                  range,
                }))
              : objects
                  .filter(
                    (o) =>
                      !word.word || `${o.schema}.${o.name}`.toLowerCase().includes(word.word.toLowerCase()),
                  )
                  .slice(0, 300)
                  .map((o) => ({
                    label: `${o.schema}.${o.name}`,
                    insertText: qualifiedName(
                      o.schema,
                      o.name,
                      profile.engine === 'postgres' ? 'postgres' : 'mariadb',
                    ),
                    kind: monaco.languages.CompletionItemKind.Struct,
                    detail: o.kind,
                    range,
                  })),
        }
      },
    })
    return () => completion.dispose()
  }, [
    profile.engine,
    profile.id,
    profile.database,
    profile.schema,
    tab.id,
    tab.schema,
    database,
    connected,
    demo,
  ])
  async function run(scope: 'current' | 'script' | 'explain', explicitConfirm?: string) {
    if (demo) {
      toast.info('Demo results are examples. Connect a database to execute commands.')
      return
    }
    const currentRuntime = useApp.getState().runtime[tab.id]
    if (
      dispatching.current ||
      executionDisabled ||
      currentRuntime?.running ||
      currentRuntime?.pendingEdits ||
      beforeExecute?.() === false
    )
      return
    if (useApp.getState().statuses[profile.id]?.state !== 'connected') {
      toast.error('Connect this tab’s database before running a query.')
      return
    }
    const instance = editor.current
    const model = instance?.getModel()
    const contents = model?.getValue() || tab.sql
    let sql = contents
    dispatching.current = true
    try {
      if (scope !== 'script' && profile.engine !== 'redis') {
        const selection = instance?.getSelection()
        const selected = selection && model?.getValueInRange(selection)
        sql = selected?.trim()
          ? selected
          : currentStatement(
              contents,
              model && instance?.getPosition() ? model.getOffsetAt(instance.getPosition()!) : 0,
              profile.engine,
            )?.text || ''
      } else if (scope === 'current' && profile.engine === 'redis') {
        const selection = instance?.getSelection()
        sql =
          (selection && model?.getValueInRange(selection)) ||
          model?.getLineContent(instance?.getPosition()?.lineNumber || 1) ||
          contents
      }
      if (!sql.trim()) throw new Error('Select a command or place the cursor inside a statement.')
      if (scope === 'explain') {
        if (profile.engine === 'redis' || splitStatements(sql, profile.engine).length !== 1)
          throw new Error(
            'Explain requires exactly one SQL statement. Select a single statement before explaining it.',
          )
        sql = `EXPLAIN ${sql}`
      }
      let confirmed = explicitConfirm
      const sqlConfirmation =
        profile.engine === 'redis' ? undefined : requiredSqlConfirmation(sql, profile.engine, profile)
      if (!confirmed && (sqlConfirmation || /\b(FLUSHALL|FLUSHDB)\b/i.test(sql))) {
        const target =
          profile.engine === 'redis'
            ? /\bFLUSHALL\b/i.test(sql)
              ? `All Redis databases on ${profile.host}:${profile.port}`
              : `Redis database ${profile.redisDb} on ${profile.host}:${profile.port}`
            : sqlConfirmation || profile.name
        const value = await confirm({
          title: 'Review consequential operation',
          description: `Target: ${profile.name} · ${profile.engine === 'redis' ? `Redis DB ${profile.redisDb}` : database || profile.database || 'No default database'} · ${profile.environment}. This command may permanently change data.`,
          detail: sql,
          typed: target,
          label: 'Execute on this target',
          danger: true,
        })
        if (value === false) return
        confirmed = target
      }
      const latest = useApp.getState()
      if (
        !latest.workspace.tabs.some(
          (current) => current.id === tab.id && current.connectionId === tab.connectionId,
        ) ||
        latest.statuses[profile.id]?.state !== 'connected' ||
        latest.runtime[tab.id]?.running ||
        latest.runtime[tab.id]?.pendingEdits ||
        beforeExecute?.() === false
      )
        return
      const requestId = uid()
      const input: QueryInput = {
        connectionId: tab.connectionId,
        database,
        sessionId: tab.id,
        requestId,
        sql,
        maxRows: 1000,
        privateSession: settings.privateSession,
        ...(confirmed ? { confirm: confirmed } : {}),
      }
      useApp.getState().setRuntime(tab.id, { running: true, requestId, error: undefined })
      setMessages(false)
      try {
        onExecute?.()
        const result = await api.query(input)
        if (useApp.getState().runtime[tab.id]?.requestId !== requestId) return
        useApp
          .getState()
          .setRuntime(tab.id, { running: false, result, transaction: result.transaction, error: undefined })
        setResultIndex(0)
        if (!result.sets.length) setMessages(true)
        void useApp
          .getState()
          .refreshMetadata()
          .catch(() => {})
      } catch (e) {
        if (useApp.getState().runtime[tab.id]?.requestId !== requestId) return
        const session = await api
          .getSessionState({ connectionId: tab.connectionId, sessionId: tab.id })
          .catch(() => undefined)
        if (useApp.getState().runtime[tab.id]?.requestId !== requestId) return
        useApp.getState().setRuntime(tab.id, {
          running: false,
          error: errorText(e),
          ...(session ? { transaction: session.state } : {}),
        })
        setMessages(true)
        void useApp
          .getState()
          .refreshMetadata()
          .catch(() => {})
      }
    } catch (e) {
      useApp.getState().setRuntime(tab.id, { error: errorText(e) })
      setMessages(true)
    } finally {
      dispatching.current = false
    }
  }
  executeRef.current = run
  const cancel = useCallback(async () => {
    if (customResults) return
    const r = useApp.getState().runtime[tab.id]
    if (!r?.requestId) return
    try {
      const outcome = await api.cancel({
        connectionId: tab.connectionId,
        sessionId: tab.id,
        requestId: r.requestId,
      })
      toast.info(outcome.message)
    } catch (e) {
      toast.error(errorText(e))
    }
  }, [customResults, tab.connectionId, tab.id])
  useEffect(() => {
    if (!visible) return
    const handler = (e: Event) => {
      const action = (e as CustomEvent<string>).detail
      if (action === 'run-current') void executeRef.current('current')
      if (action === 'run-script') void executeRef.current('script')
      if (action === 'cancel-query') void cancel()
    }
    window.addEventListener('harbor-action', handler)
    return () => window.removeEventListener('harbor-action', handler)
  }, [visible, cancel])
  async function transaction(action: 'begin' | 'commit' | 'rollback') {
    const currentRuntime = useApp.getState().runtime[tab.id]
    if (
      dispatching.current ||
      executionDisabled ||
      currentRuntime?.running ||
      currentRuntime?.pendingEdits ||
      useApp.getState().statuses[profile.id]?.state !== 'connected'
    )
      return
    dispatching.current = true
    setTransactionBusy(true)
    const requestId = uid()
    useApp.getState().setRuntime(tab.id, { running: true, requestId, error: undefined })
    try {
      const result = await api.transaction({
        connectionId: tab.connectionId,
        database,
        sessionId: tab.id,
        action,
      })
      if (useApp.getState().runtime[tab.id]?.requestId !== requestId) return
      useApp.getState().setRuntime(tab.id, { running: false, transaction: result.state, error: undefined })
      toast.success(
        action === 'begin'
          ? 'Transaction opened on this tab'
          : action === 'commit'
            ? 'Transaction committed'
            : 'Transaction rolled back',
      )
    } catch (e) {
      const session = await api
        .getSessionState({ connectionId: tab.connectionId, sessionId: tab.id })
        .catch(() => undefined)
      if (useApp.getState().runtime[tab.id]?.requestId !== requestId) return
      useApp.getState().setRuntime(tab.id, {
        running: false,
        error: errorText(e),
        ...(session ? { transaction: session.state } : {}),
      })
      setMessages(true)
    } finally {
      dispatching.current = false
      setTransactionBusy(false)
    }
  }
  const result = runtime?.result
  const activeSet = result?.sets[resultIndex]
  const transactionState = runtime?.transaction || 'idle'
  return (
    <div className="query-workspace">
      <div className="editor-region" style={{ height: settings.editorHeight }}>
        <div className="toolbar">
          <span className="toolbar-title">
            {profile.engine === 'redis' ? <Code2 /> : <FileCode2 />}
            {tab.title}
          </span>
          <div className="toolbar-spacer" />
          {toolbarActions}
          {databaseRequired && <QueryDatabasePicker tab={tab} profile={profile} />}
          {profile.engine !== 'redis' && (
            <>
              <IconButton
                label="Format SQL"
                onClick={() => {
                  try {
                    useApp.getState().updateTab(tab.id, {
                      sql: format(editor.current?.getValue() || tab.sql, {
                        language: profile.engine === 'postgres' ? 'postgresql' : 'mariadb',
                        keywordCase: 'upper',
                      }),
                    })
                  } catch (e) {
                    toast.error(errorText(e))
                  }
                }}
              >
                <AlignLeft />
              </IconButton>
              <IconButton
                label="Explain current statement (does not execute it)"
                disabled={
                  !connected || !!runtime?.running || !!runtime?.pendingEdits || executionDisabled || demo
                }
                onClick={() => void run('explain')}
              >
                <GitBranch />
              </IconButton>
            </>
          )}
          <IconButton label="Save query · Ctrl+S" onClick={onSave}>
            <Save />
          </IconButton>
          {runtime?.running ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={transactionBusy || customResults}
              onClick={() => void cancel()}
            >
              <CircleStop />
              Cancel
            </Button>
          ) : (
            <Button
              disabled={!connected || !!runtime?.pendingEdits || executionDisabled || demo}
              onClick={() => void run('current')}
            >
              <Play />
              Run <kbd>Ctrl Enter</kbd>
            </Button>
          )}
          <Button
            variant="outline"
            disabled={
              !connected || !!runtime?.running || !!runtime?.pendingEdits || executionDisabled || demo
            }
            onClick={() => void run('script')}
          >
            <FileCode2 />
            Run script
          </Button>
        </div>
        <div className="editor-host">
          <Editor
            path={`inmemory://harbor/${tab.id}`}
            language={editorLanguages[profile.engine]}
            value={tab.sql}
            onChange={(value) => useApp.getState().updateTab(tab.id, { sql: value || '' })}
            onMount={mount}
            theme={theme}
            options={{
              fontFamily: 'JetBrains Mono',
              fontSize: settings.editorFontSize,
              lineHeight: 24,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: 'on',
              padding: { top: 12, bottom: 12 },
              lineNumbersMinChars: 3,
              renderLineHighlight: 'line',
              glyphMargin: false,
              folding: true,
              tabSize: 2,
              bracketPairColorization: { enabled: true },
              fixedOverflowWidgets: true,
              editContext: false,
              ariaLabel: profile.engine === 'redis' ? 'Redis command console' : 'SQL query editor',
            }}
            loading={
              <div className="center-empty">
                <LoaderCircle className="spin" />
                Loading editor…
              </div>
            }
          />
        </div>
      </div>
      <div
        className="editor-resizer"
        role="separator"
        aria-label="Resize query editor"
        aria-orientation="horizontal"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown')
            useApp.getState().setSettings({
              editorHeight: Math.max(
                140,
                Math.min(600, settings.editorHeight + (e.key === 'ArrowDown' ? 20 : -20)),
              ),
            })
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          const startY = e.clientY,
            height = settings.editorHeight
          const target = e.currentTarget
          const move = (event: PointerEvent) =>
            useApp.getState().setSettings({
              editorHeight: Math.max(
                140,
                Math.min(window.innerHeight - 290, height + event.clientY - startY),
              ),
            })
          const stop = () => {
            target.removeEventListener('pointermove', move)
            target.removeEventListener('pointerup', stop)
          }
          target.addEventListener('pointermove', move)
          target.addEventListener('pointerup', stop)
        }}
      />
      {demo && (
        <div className="hint-bar demo">
          <ShieldCheck />
          Demo workspace · example data. Connect your database to run queries.
        </div>
      )}
      {customResults ? (
        resultView
      ) : (
        <div className="results-area">
          <div className="result-tabs">
            <button className={`result-tab ${!messages ? 'active' : ''}`} onClick={() => setMessages(false)}>
              Results {activeSet && <span className="number">{activeSet.rows.length}</span>}
            </button>
            <button className={`result-tab ${messages ? 'active' : ''}`} onClick={() => setMessages(true)}>
              Messages {runtime?.error && <span className="danger">●</span>}
            </button>
            {result && result.sets.length > 1 && (
              <select
                aria-label="Result set"
                value={resultIndex}
                onChange={(e) => setResultIndex(Number(e.target.value))}
              >
                {result.sets.map((s, i) => (
                  <option key={i} value={i}>
                    Result {i + 1} · {s.command}
                  </option>
                ))}
              </select>
            )}
            <div className="toolbar-spacer" />
            {profile.engine !== 'redis' && (
              <>
                <span className={`text-[10px] ${transactionState === 'failed' ? 'danger' : 'muted'}`}>
                  {transactionState === 'idle'
                    ? 'Autocommit'
                    : transactionState === 'open'
                      ? 'Transaction open'
                      : 'Transaction failed'}
                </span>
                {transactionState === 'idle' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      !connected || demo || !!runtime?.running || !!runtime?.pendingEdits || executionDisabled
                    }
                    onClick={() => void transaction('begin')}
                  >
                    Begin
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={
                        transactionState === 'failed' ||
                        !!runtime?.running ||
                        !!runtime?.pendingEdits ||
                        executionDisabled
                      }
                      onClick={() => void transaction('commit')}
                    >
                      Commit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!!runtime?.running || !!runtime?.pendingEdits || executionDisabled}
                      onClick={() => void transaction('rollback')}
                    >
                      <Undo2 />
                      Rollback
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
          {messages ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {runtime?.error && <ErrorPanel message={runtime.error} />}
              <div className="messages">
                {result?.messages.join('\n') ||
                  (!runtime?.error ? 'Server notices and execution messages appear here.' : '')}
                {result &&
                  `\n${result.cancelled ? 'Cancelled' : `${result.sets.length} result set(s)`} · ${result.durationMs.toFixed(1)} ms`}
              </div>
            </div>
          ) : activeSet ? (
            <DataGrid set={activeSet} tab={tab} />
          ) : (
            <div className="center-empty">
              {runtime?.running ? <LoaderCircle className="spin" /> : <Play />}
              <h3>{runtime?.running ? 'Executing on ' + profile.name : 'Ready when you are'}</h3>
              <p>
                {runtime?.running
                  ? 'You can keep working in another tab.'
                  : 'Run a selection or the statement at your cursor with Ctrl+Enter. Use Run script for the complete editor.'}
              </p>
            </div>
          )}
          <div className="results-footer">
            <span>{activeSet ? `${activeSet.rows.length.toLocaleString()} rows` : 'No results'}</span>
            {activeSet && activeSet.columns.length === 0 && (
              <span>{activeSet.affectedRows.toLocaleString()} affected</span>
            )}
            {result && !demo && <span>{result.durationMs.toFixed(1)} ms</span>}
            <span className={activeSet?.truncated ? 'warning' : 'muted'}>
              {activeSet?.truncated
                ? 'Display limit reached · execution semantics unchanged'
                : demo
                  ? 'Example results'
                  : 'Loaded results · max 1,000 rows / 8 MiB'}
            </span>
            {runtime?.running && (
              <span className="status-item">
                <LoaderCircle className="spin" />
                Running
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
