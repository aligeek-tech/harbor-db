import { AssistanceDialog } from './AssistanceDialog'
import { Db2Context } from './Db2Context'
import { CompatibleSqlContext } from './CompatibleSqlFields'
import { BigQueryTools } from './BigQueryTools'
import type { ReportDefinition } from '@shared/reports'
import { AnalyticsReports } from './AnalyticsReports'
import { hasDatabaseContext } from '@shared/capabilities'
import { TrinoProgress } from './TrinoProgress'
import { isKeyValueEngine } from '@shared/key-value'
import { engineSupports } from '@shared/capabilities'
import { PlanInspector } from './PlanInspector'
import { LocalAnalytics } from './LocalAnalytics'
import { FullExport } from './FullExport'
import { DatabaseTransfer } from './DatabaseTransfer'
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
import {
  conf as tsqlConfiguration,
  language as tsqlLanguage,
} from 'monaco-editor/languages/definitions/sql/sql'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import { format } from 'sql-formatter'
import {
  AlignLeft,
  CircleStop,
  Columns2,
  Rows2,
  Code2,
  FileCode2,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ConnectionProfile, QueryInput, TableStructure, WorkspaceTab } from '@shared/contracts'
import { shortcutBinding, type ShortcutAction } from '@shared/shortcuts'
import {
  currentStatement,
  qualifiedName,
  quoteIdentifier,
  requiredSqlConfirmation,
  splitStatements,
  sqlDialect,
} from '@shared/sql'
import { api } from '../lib/api'
import { uid, errorText } from '../lib/utils'
import { platform, shortcutHint } from '../lib/shortcuts'
import { useApp } from '../store'
import { DataGrid } from './DataGrid'
import { QueryParameters } from './QueryParameters'
import { parameterValue } from '@shared/parameters'
import { QueryDatabasePicker } from './QueryDatabasePicker'
import { Button } from './ui/button'
import { ErrorPanel, IconButton, useConfirm } from './common'

self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === 'json' ? new JsonWorker() : new EditorWorker()),
}
loader.config({ monaco })
function editorShortcut(action: ShortcutAction) {
  const binding = shortcutBinding(action, platform)
  const key = binding.key.length === 1 ? `Key${binding.key.toUpperCase()}` : binding.key
  const code = monaco.KeyCode[key as keyof typeof monaco.KeyCode]
  if (typeof code !== 'number') throw new Error(`Unsupported editor shortcut: ${action}`)
  const modifier =
    binding.modifier === 'primary' || platform !== 'darwin' ? monaco.KeyMod.CtrlCmd : monaco.KeyMod.WinCtrl
  return modifier | (binding.shift ? monaco.KeyMod.Shift : 0) | code
}
const editorLanguages = {
  db2: 'harbor-db2',
  postgres: 'harbor-pgsql',
  cockroachdb: 'harbor-pgsql', yugabytedb: 'harbor-pgsql', redshift: 'harbor-pgsql', tidb: 'harbor-mysql', vitess: 'harbor-mysql',
  mariadb: 'harbor-mysql',
  mysql: 'harbor-mysql',
  sqlite: 'harbor-sqlite',
  duckdb: 'harbor-duckdb',
  mssql: 'harbor-tsql',
  oracle: 'harbor-plsql',
  trino: 'harbor-trino',
  bigquery: 'harbor-bigquery',
  snowflake: 'harbor-snowflake',
  databricks: 'harbor-databricks',
  athena: 'harbor-athena',
  firebird: 'harbor-firebird',
  hana: 'harbor-pgsql',
  couchdb: 'json',
  dynamodb: 'json',
  cassandra: 'sql',
  neo4j: 'cypher',
  clickhouse: 'harbor-mysql',
  redis: 'harbor-redis',
  valkey: 'harbor-redis',
  mongodb: 'json',
  elasticsearch: 'json',
  opensearch: 'json',
  qdrant: 'json', milvus: 'json', weaviate: 'json', pinecone: 'json', influxdb: 'plaintext', questdb: 'sql',
} as const
// Eager local registration makes the first model independent of Monaco's lazy
// language contributions, both in the Electron bundle and the browser preview.
for (const [id, configuration, language] of [
  [editorLanguages.postgres, postgresConfiguration, postgresLanguage],
  [editorLanguages.mariadb, mariaConfiguration, mariaLanguage],
  [editorLanguages.redis, redisConfiguration, redisLanguage],
  [editorLanguages.sqlite, postgresConfiguration, postgresLanguage],
  [editorLanguages.duckdb, postgresConfiguration, postgresLanguage],
  [editorLanguages.mssql, tsqlConfiguration, tsqlLanguage],
  [editorLanguages.oracle, tsqlConfiguration, tsqlLanguage],
  [editorLanguages.db2, tsqlConfiguration, tsqlLanguage],
  [editorLanguages.trino, postgresConfiguration, postgresLanguage],
  [editorLanguages.bigquery, mariaConfiguration, mariaLanguage],
  [editorLanguages.snowflake, postgresConfiguration, postgresLanguage],
  [editorLanguages.databricks, mariaConfiguration, mariaLanguage],
  [editorLanguages.athena, postgresConfiguration, postgresLanguage],
  [editorLanguages.firebird, postgresConfiguration, postgresLanguage],
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
    'scrollbarSlider.background': '#566475',
    'scrollbarSlider.hoverBackground': '#8091A8',
    'scrollbarSlider.activeBackground': '#7C9CFF',
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
    'scrollbarSlider.background': '#A0AAB8',
    'scrollbarSlider.hoverBackground': '#77879A',
    'scrollbarSlider.activeBackground': '#3C5AC1',
  },
})
export function QueryEditor({
  tab,
  profile,
  visible,
  onSave,
  onOpenReport,
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
  onOpenReport?: (report: ReportDefinition) => void
  resultView?: ReactNode
  beforeExecute?: () => boolean
  onExecute?: () => void
  toolbarActions?: ReactNode
  disableExecute?: boolean
}) {
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const runtime = useApp((s) => s.runtime[tab.id])
  const reports = useApp((s) => s.reports)
  const settings = useApp((s) => s.workspace.settings)
  const connected = useApp((s) => s.statuses[profile.id]?.state === 'connected')
  const database = hasDatabaseContext(profile.engine)
    ? tab.database || profile.database || undefined
    : undefined
  const databaseRequired = hasDatabaseContext(profile.engine) && !database
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
  const [parameterValues, setParameterValues] = useState<string[]>([])
  const [completionEpoch, setCompletionEpoch] = useState(0)
  useEffect(() => {
    if (!connected) setParameterValues([])
  }, [connected])
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
    instance.addCommand(editorShortcut('run-current'), () => void executeRef.current('current'))
    instance.addCommand(editorShortcut('run-script'), () => void executeRef.current('script'))
    instance.addCommand(editorShortcut('save-query'), () => saveRef.current())
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
          (object) =>
            !hasDatabaseContext(profile.engine) ||
            (object.database || profile.database) === database,
        )
        if (engineSupports(profile.engine, 'sql')) {
          const dialect = sqlDialect(profile.engine)
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
            isKeyValueEngine(profile.engine)
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
                    insertText: qualifiedName(o.schema, o.name, sqlDialect(profile.engine)),
                    kind: monaco.languages.CompletionItemKind.Struct,
                    detail: o.kind,
                    range,
                  })),
        }
      },
    })
    return () => completion.dispose()
  }, [
    completionEpoch,
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
    if (profile.engine === 'mongodb') return
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
    let statementOffset = 0
    let generatedPrefixLength = 0
    if (model) monaco.editor.setModelMarkers(model, 'harbor-query', [])
    dispatching.current = true
    try {
      if (scope !== 'script' && !isKeyValueEngine(profile.engine)) {
        const selection = instance?.getSelection()
        const selected = selection && model?.getValueInRange(selection)
        const statement = selected?.trim()
          ? undefined
          : currentStatement(
              contents,
              model && instance?.getPosition() ? model.getOffsetAt(instance.getPosition()!) : 0,
              sqlDialect(profile.engine),
            )
        sql = selected?.trim() ? selected : statement?.text || ''
        statementOffset =
          selected?.trim() && selection && model
            ? model.getOffsetAt(selection.getStartPosition())
            : statement?.start || 0
      } else if (scope === 'current' && isKeyValueEngine(profile.engine)) {
        const selection = instance?.getSelection()
        sql =
          (selection && model?.getValueInRange(selection)) ||
          model?.getLineContent(instance?.getPosition()?.lineNumber || 1) ||
          contents
      }
      if (!sql.trim()) throw new Error('Select a command or place the cursor inside a statement.')
      if (scope === 'explain') {
        if (isKeyValueEngine(profile.engine) || splitStatements(sql, sqlDialect(profile.engine)).length !== 1)
          throw new Error(
            'Explain requires exactly one SQL statement. Select a single statement before explaining it.',
          )
        sql = `EXPLAIN ${sql}`
        generatedPrefixLength = 'EXPLAIN '.length
      }
      let confirmed = explicitConfirm
      const sqlConfirmation =
        isKeyValueEngine(profile.engine) ? undefined : requiredSqlConfirmation(sql, sqlDialect(profile.engine), profile)
      if (!confirmed && (sqlConfirmation || /\b(FLUSHALL|FLUSHDB)\b/i.test(sql))) {
        const target =
          isKeyValueEngine(profile.engine)
            ? /\bFLUSHALL\b/i.test(sql)
              ? `All Redis databases on ${profile.host}:${profile.port}`
              : `Redis database ${profile.redisDb} on ${profile.host}:${profile.port}`
            : sqlConfirmation || profile.name
        const value = await confirm({
          title: profile.engine === 'athena' ? 'Review Athena job and storage scope' : profile.engine === 'bigquery' ? 'Review BigQuery job and billing limit' : ['snowflake', 'databricks'].includes(profile.engine) ? 'Review warehouse query and compute cost' : 'Review consequential operation',
          description: profile.engine === 'athena' ? `Region: ${profile.athena.region} · Catalog: ${profile.athena.catalog} · Database: ${database || profile.database} · Workgroup: ${profile.athena.workgroup} · S3 output: ${profile.athena.outputLocation} · Owner: ${profile.athena.expectedBucketOwner} · Scan cutoff at most ${profile.athena.maximumScannedBytes} bytes. SQL is sent to AWS and may incur charges. Cancellation does not reverse writes or output.` : profile.engine === 'bigquery' ? `Billing project: ${database || profile.database} · Location: ${profile.bigQuery.location} · Maximum billed bytes: ${profile.bigQuery.maximumBytesBilled}. This submits SQL to Google Cloud and may incur charges. Cancellation does not reverse completed writes or billing.` : ['snowflake', 'databricks'].includes(profile.engine) ? `Warehouse: ${profile.warehouse.warehouse} · Catalog/database: ${database || profile.database} · Role: ${profile.warehouse.role || 'token role'}. This sends SQL to the provider and may incur compute charges; row limits do not cap cost. Writes and charges can complete before cancellation.` : `Target: ${profile.name} · ${isKeyValueEngine(profile.engine) ? `Redis DB ${profile.redisDb}` : database || profile.database || 'No default database'} · ${profile.environment}. This command may permanently change data.`,
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
      const parameters = (tab.parameterDefinitions || []).map((definition, index) => ({
        ...definition,
        value: parameterValues[index] || '',
      }))
      for (const parameter of parameters) parameterValue(parameter)
      const input: QueryInput = {
        connectionId: tab.connectionId,
        database,
        sessionId: tab.id,
        requestId,
        sql,
        maxRows: 1000,
        privateSession: settings.privateSession,
        ...(parameters.length ? { parameters } : {}),
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
        if (session?.errorLocation && model && !model.isDisposed() && model.getValue() === contents) {
          const offset = statementOffset + session.errorLocation.position - 1 - generatedPrefixLength
          if (offset >= 0 && offset <= contents.length) {
            const start = model.getPositionAt(offset)
            const end = model.getPositionAt(Math.min(contents.length, offset + 1))
            monaco.editor.setModelMarkers(model, 'harbor-query', [
              {
                severity: monaco.MarkerSeverity.Error,
                message: 'The database reported an error here. See query messages for details.',
                startLineNumber: start.lineNumber,
                startColumn: start.column,
                endLineNumber: end.lineNumber,
                endColumn: end.column,
              },
            ])
            instance?.revealPositionInCenter(start)
          }
        }
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
  function selectedReadStatement() {
    const instance = editor.current,
      model = instance?.getModel(),
      selection = instance?.getSelection()
    const selected = selection && model?.getValueInRange(selection)
    const contents = model?.getValue() || tab.sql
    const sql = selected?.trim()
      ? selected
      : currentStatement(
          contents,
          model && instance?.getPosition() ? model.getOffsetAt(instance.getPosition()!) : 0,
          sqlDialect(profile.engine),
        )?.text || ''
    if (!sql.trim()) throw new Error('Select one read-only SQL statement first.')
    const parameters = (tab.parameterDefinitions || []).map((definition, index) => ({
      ...definition,
      value: parameterValues[index] || '',
    }))
    parameters.forEach(parameterValue)
    return { sql, parameters }
  }
  const result = runtime?.result
  const activeSet = result?.sets[resultIndex]
  const transactionState = runtime?.transaction || 'idle'
  const sideBySide = settings.editorLayout === 'side-by-side'
  return (
    <div className="query-workspace">
      <CompatibleSqlContext profile={profile} />
      <Db2Context profile={profile} />
      {!isKeyValueEngine(profile.engine) && (
        <QueryParameters
          definitions={tab.parameterDefinitions || []}
          values={parameterValues}
          postgres={['postgres', 'cockroachdb', 'yugabytedb', 'redshift'].includes(profile.engine)}
          mssql={profile.engine === 'mssql'}
          clickhouse={profile.engine === 'clickhouse'}
          oracle={profile.engine === 'oracle'}
          disabled={!!runtime?.running}
          onDefinitions={(definitions) => {
            const previous = tab.parameterDefinitions || []
            setParameterValues((values) => definitions.map((definition) => {
              // Keep untouched fields attached to their definition when another field
              // is added/removed. Changed names or types require a fresh value.
              let index = previous.indexOf(definition)
              if (index < 0) {
                const matches = previous.flatMap((item, i) => item.name === definition.name && item.type === definition.type ? [i] : [])
                if (matches.length === 1) index = matches[0]
              }
              return index < 0 ? '' : values[index] || ''
            }))
            useApp.getState().updateTab(tab.id, { parameterDefinitions: definitions })
          }}
          onValue={(index, value) =>
            setParameterValues((previous) => {
              const next = [...previous]
              next[index] = value
              return next
            })
          }
        />
      )}
      <div
        className="query-panels"
        data-layout={settings.editorLayout}
        style={{
          display: 'flex',
          flexDirection: sideBySide ? 'row' : 'column',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: 'auto',
        }}
      >
        <div
          className="editor-region"
          style={{
            height: sideBySide ? undefined : settings.editorHeight,
            width: sideBySide ? `${settings.editorWidthPercent}%` : undefined,
            minWidth: 0,
            flexShrink: sideBySide ? 0 : 1,
            maxHeight: sideBySide ? 'none' : undefined,
          }}
        >
          <div className="toolbar" style={{ flexWrap: sideBySide ? 'wrap' : undefined }}>
            <span className="toolbar-title">
              {isKeyValueEngine(profile.engine) ? <Code2 /> : <FileCode2 />}
              {tab.title}
            </span>
            <div className="toolbar-spacer" />
            <IconButton
              label={sideBySide ? 'Stack editor above results' : 'Show editor and results side by side'}
              onClick={() =>
                useApp.getState().setSettings({ editorLayout: sideBySide ? 'stacked' : 'side-by-side' })
              }
            >
              {sideBySide ? <Rows2 /> : <Columns2 />}
            </IconButton>
            <LocalAnalytics
              profile={profile}
              tab={tab}
              disabled={!connected || !!runtime?.running || !!runtime?.pendingEdits || demo}
            />
            {onOpenReport && (
              <AnalyticsReports
                profile={profile}
                tab={tab}
                set={runtime?.result?.sets[resultIndex]}
                reports={reports}
                activeReportId={tab.reportId}
                onOpen={onOpenReport}
                onSave={async (report) => {
                  const saved = await api.saveReport(report)
                  useApp.getState().updateTab(tab.id, { reportId: saved.id })
                  await useApp.getState().refreshMetadata()
                  return saved
                }}
                onDelete={async (id) => {
                  await api.deleteReport(id)
                  if (tab.reportId === id) useApp.getState().updateTab(tab.id, { reportId: undefined })
                  await useApp.getState().refreshMetadata()
                }}
              />
            )}
            <FullExport
              profile={profile}
              database={database}
              disabled={
                !connected || !!runtime?.running || !!runtime?.pendingEdits || executionDisabled || demo
              }
              getStatement={selectedReadStatement}
            />
            <DatabaseTransfer
              key={`${profile.id}/${database ?? ''}`}
              profile={profile}
              database={database}
              disabled={
                !connected || !!runtime?.running || !!runtime?.pendingEdits || executionDisabled || demo
              }
              getStatement={selectedReadStatement}
            />
            {toolbarActions}
            {databaseRequired && <QueryDatabasePicker tab={tab} profile={profile} />}
            {!isKeyValueEngine(profile.engine) && (
              <>
                <IconButton
                  label="Format SQL"
                  onClick={() => {
                    try {
                      const instance = editor.current
                      const model = instance?.getModel()
                      const selection = instance?.getSelection()
                      if (!instance || !model) return
                      const range = selection && !selection.isEmpty() ? selection : model.getFullModelRange()
                      const text = format(model.getValueInRange(range), {
                        language: profile.engine === 'db2' ? 'db2' : ['postgres', 'duckdb'].includes(profile.engine)
                          ? 'postgresql'
                          : profile.engine === 'oracle' ? 'plsql' : profile.engine === 'mssql'
                            ? 'transactsql'
                            : profile.engine === 'clickhouse'
                              ? 'clickhouse'
                              : profile.engine === 'sqlite'
                                ? 'sqlite'
                                : profile.engine === 'mysql'
                                  ? 'mysql'
                                  : 'mariadb',
                        keywordCase: 'upper',
                      })
                      instance.pushUndoStop()
                      instance.executeEdits('harbor-format', [{ range, text }])
                      instance.pushUndoStop()
                    } catch (e) {
                      toast.error(errorText(e))
                    }
                  }}
                >
                  <AlignLeft />
                </IconButton>
                <IconButton
                  label="Refresh completion metadata"
                  onClick={() => {
                    setCompletionEpoch((value) => value + 1)
                    toast.info('Completion metadata will refresh on the next qualified suggestion.')
                  }}
                >
                  <RefreshCw />
                </IconButton>
                <select
                  aria-label="Insert SQL snippet"
                  value=""
                  onChange={(event) => {
                    const instance = editor.current
                    const selection = instance?.getSelection()
                    if (!instance || !selection || !event.target.value) return
                    const target = qualifiedName(
                      tab.schema || profile.schema || '',
                      tab.table || 'table_name',
                      sqlDialect(profile.engine),
                    )
                    const snippets: Record<string, string> = {
                      select:
                        profile.engine === 'oracle' ? `SELECT * FROM ${target}\nFETCH FIRST 100 ROWS ONLY;` : profile.engine === 'mssql'
                          ? `SELECT TOP (100) * FROM ${target};`
                          : `SELECT * FROM ${target}\nLIMIT 100;`,
                      transaction: `${profile.engine === 'mssql' ? 'BEGIN TRANSACTION' : 'BEGIN'};\n-- Add statements here and review before running.\nROLLBACK;`,
                    }
                    instance.pushUndoStop()
                    instance.executeEdits('harbor-snippet', [
                      { range: selection, text: snippets[event.target.value] },
                    ])
                    instance.pushUndoStop()
                    instance.focus()
                  }}
                >
                  <option value="">Snippets</option>
                  <option value="select">Bounded SELECT</option>
                  {engineSupports(profile.engine, 'transactions') && profile.engine !== 'oracle' && <option value="transaction">Transaction with rollback</option>}
                </select>
                <PlanInspector
                  profile={profile}
                  tab={tab}
                  database={database}
                  disabled={
                    !connected || !!runtime?.running || !!runtime?.pendingEdits || executionDisabled || demo
                  }
                  getStatement={selectedReadStatement}
                />
                <AssistanceDialog
                  profile={profile}
                  getQuery={() => editor.current?.getValue() || tab.sql}
                  onUseDraft={(sql) => {
                    const instance = editor.current
                    const model = instance?.getModel()
                    if (!instance || !model) {
                      useApp.getState().updateTab(tab.id, { sql })
                      return
                    }
                    instance.pushUndoStop()
                    instance.executeEdits('harbor-assistance-draft', [
                      { range: model.getFullModelRange(), text: sql },
                    ])
                    instance.pushUndoStop()
                    instance.focus()
                  }}
                />
              </>
            )}
            <IconButton label={`Save query · ${shortcutHint('save-query')}`} onClick={onSave}>
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
                Run <kbd>{shortcutHint('run-current')}</kbd>
              </Button>
            )}
            <Button
              variant="outline"
              disabled={
                !connected || !!runtime?.running || !!runtime?.pendingEdits || executionDisabled || demo || profile.engine === 'db2'
              }
              onClick={() => void run('script')}
            >
              <FileCode2 />
              Run script
            </Button>
          </div>
          <BigQueryTools profile={profile} tab={tab} disabled={!connected || !!runtime?.running} />
          <div className="editor-host">
            <Editor
              path={`inmemory://harbor/${tab.id}`}
              language={editorLanguages[profile.engine]}
              value={tab.sql}
              onChange={(value) => {
                const model = editor.current?.getModel()
                if (model) monaco.editor.setModelMarkers(model, 'harbor-query', [])
                useApp.getState().updateTab(tab.id, { sql: value || '' })
              }}
              onMount={mount}
              theme={theme}
              options={{
                fontFamily: 'JetBrains Mono',
                fontSize: settings.editorFontSize,
                lineHeight: 24,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                scrollbar: {
                  vertical: 'visible',
                  horizontal: 'visible',
                  verticalScrollbarSize: 8,
                  horizontalScrollbarSize: 8,
                  verticalSliderSize: 4,
                  horizontalSliderSize: 4,
                  useShadows: false,
                },
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
                ariaLabel: isKeyValueEngine(profile.engine) ? 'Redis command console' : 'SQL query editor',
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
          aria-orientation={sideBySide ? 'vertical' : 'horizontal'}
          aria-valuemin={sideBySide ? 25 : 140}
          aria-valuemax={sideBySide ? 75 : 600}
          aria-valuenow={sideBySide ? settings.editorWidthPercent : settings.editorHeight}
          style={
            sideBySide
              ? {
                  width: 5,
                  height: 'auto',
                  cursor: 'col-resize',
                  borderTop: 0,
                  borderLeft: '1px solid var(--line)',
                }
              : undefined
          }
          tabIndex={0}
          onKeyDown={(event) => {
            const previous = sideBySide ? 'ArrowLeft' : 'ArrowUp'
            const next = sideBySide ? 'ArrowRight' : 'ArrowDown'
            if (event.key !== previous && event.key !== next) return
            event.preventDefault()
            useApp.getState().setSettings(
              sideBySide
                ? {
                    editorWidthPercent: Math.max(
                      25,
                      Math.min(75, settings.editorWidthPercent + (event.key === next ? 5 : -5)),
                    ),
                  }
                : {
                    editorHeight: Math.max(
                      140,
                      Math.min(600, settings.editorHeight + (event.key === next ? 20 : -20)),
                    ),
                  },
            )
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            const start = sideBySide ? event.clientX : event.clientY
            const initial = sideBySide ? settings.editorWidthPercent : settings.editorHeight
            const target = event.currentTarget
            const width = target.parentElement?.clientWidth || 1
            const move = (pointer: PointerEvent) =>
              useApp.getState().setSettings(
                sideBySide
                  ? {
                      editorWidthPercent: Math.max(
                        25,
                        Math.min(75, initial + (100 * (pointer.clientX - start)) / width),
                      ),
                    }
                  : {
                      editorHeight: Math.max(
                        140,
                        Math.min(600, window.innerHeight - 290, initial + pointer.clientY - start),
                      ),
                    },
              )
            const stop = () => {
              target.removeEventListener('pointermove', move)
              target.removeEventListener('pointerup', stop)
              target.removeEventListener('pointercancel', stop)
            }
            target.addEventListener('pointermove', move)
            target.addEventListener('pointerup', stop)
            target.addEventListener('pointercancel', stop)
          }}
        />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minWidth: 0,
            minHeight: sideBySide ? 0 : customResults ? 400 : 280,
            overflow: 'auto',
          }}
        >
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
                <button
                  className={`result-tab ${!messages ? 'active' : ''}`}
                  onClick={() => setMessages(false)}
                >
                  Results {activeSet && <span className="number">{activeSet.rows.length}</span>}
                </button>
                <button
                  className={`result-tab ${messages ? 'active' : ''}`}
                  onClick={() => setMessages(true)}
                >
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
                {engineSupports(profile.engine, 'transactions') && (
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
                          !connected ||
                          demo ||
                          !!runtime?.running ||
                          !!runtime?.pendingEdits ||
                          executionDisabled
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
                      : profile.engine === 'db2'
                        ? `Run one guarded statement with ${shortcutHint('run-current')}. Open the Db2 context above for supported result types.`
                      : `Run a selection or the statement at your cursor with ${shortcutHint('run-current')}. Use Run script for the complete editor.`}
                  </p>
                </div>
              )}
              {(profile.engine === 'trino' || profile.engine === 'bigquery' || profile.engine === 'snowflake' || profile.engine === 'databricks' || profile.engine === 'athena') && <TrinoProgress engine={profile.engine} connectionId={profile.id} sessionId={tab.id} requestId={runtime?.requestId} running={!!runtime?.running} />}
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
      </div>
    </div>
  )
}
