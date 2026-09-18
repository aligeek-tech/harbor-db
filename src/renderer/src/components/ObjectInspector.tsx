import { useEffect, useState } from 'react'
import type { ConnectionProfile, ObjectInfo } from '@shared/contracts'
import type { ObjectInspection } from '@shared/inspection'
import { qualifiedName, quoteIdentifier, sqlDialect } from '@shared/sql'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { CopyButton, ErrorPanel, Loading } from './common'
import { SchemaChangesDialog } from './SchemaChangesDialog'
import { schemaEngineSchema } from '@shared/schema-changes'
import { engineSupports } from '@shared/capabilities'

export function ObjectInspector({
  profile,
  object,
  onClose,
}: {
  profile: ConnectionProfile
  object: ObjectInfo
  onClose: () => void
}) {
  const [result, setResult] = useState<ObjectInspection>(),
    [error, setError] = useState(''),
    [search, setSearch] = useState(''),
    [identity, setIdentity] = useState<string>(),
    [epoch, setEpoch] = useState(0),
    [schemaTool, setSchemaTool] = useState<'edit' | 'compare'>()
  useEffect(() => {
    let current = true
    setResult(undefined)
    setError('')
    void api
      .inspectObject({
        connectionId: profile.id,
        database: object.database,
        schema: object.schema,
        name: object.name,
        kind:
          object.kind === 'materialized view' ? 'view' : object.kind === 'sequence' ? 'table' : object.kind,
        identity,
      })
      .then((value) => {
        if (current) setResult(value)
      })
      .catch((failure) => {
        if (current) setError(errorText(failure))
      })
    return () => {
      current = false
    }
  }, [profile.id, object.database, object.schema, object.name, object.kind, identity, epoch])
  function template(action: 'select' | 'insert' | 'update') {
    const dialect = sqlDialect(profile.engine),
      name = qualifiedName(object.schema, object.name, dialect),
      columns = result?.structure?.columns || [],
      keys = columns
        .filter((column) => column.primaryKey)
        .sort((a, b) => (a.primaryKeyPosition || 0) - (b.primaryKeyPosition || 0))
    const parameters: { name: string; type: 'text'; secret: boolean }[] = []
    const value = (column: string) => {
      parameters.push({
        name: dialect === 'mssql' || dialect === 'oracle' ? `p${parameters.length + 1}` : column,
        type: 'text',
        secret: false,
      })
      return dialect === 'postgres'
        ? `$${parameters.length}`
        : dialect === 'mssql'
          ? `@p${parameters.length}`
          : dialect === 'oracle'
            ? `:p${parameters.length}`
            : '?'
    }
    let sql =
      dialect === 'mssql'
        ? `SELECT TOP (200) * FROM ${name};`
        : dialect === 'oracle'
          ? `SELECT * FROM ${name}\nFETCH FIRST 200 ROWS ONLY;`
          : `SELECT * FROM ${name}\nLIMIT 200;`
    if (action === 'insert')
      sql = columns.length
        ? `INSERT INTO ${name} (${columns.map((column) => quoteIdentifier(column.name, dialect)).join(', ')})\nVALUES (${columns.map((column) => value(column.name)).join(', ')});`
        : `INSERT INTO ${name} DEFAULT VALUES;`
    if (action === 'update') {
      const column = columns.find((column) => !column.primaryKey)
      if (!column || !keys.length) return
      sql = `UPDATE ${name}\nSET ${quoteIdentifier(column.name, dialect)} = ${value(column.name)}\nWHERE ${keys.map((key) => `${quoteIdentifier(key.name, dialect)} = ${value(`key_${key.name}`)}`).join(' AND ')};`
    }
    useApp.getState().openTab({
      connectionId: profile.id,
      database: object.database,
      kind: 'query',
      title: `${action.toUpperCase()} ${object.name}`,
      schema: object.schema,
      sql,
      parameterDefinitions: parameters,
    })
    useApp.getState().setSection('connections')
    onClose()
  }
  const match = (value: string) => value.toLowerCase().includes(search.toLowerCase())
  if (schemaTool && result?.structure)
    return (
      <SchemaChangesDialog
        profile={profile}
        target={{
          connectionId: profile.id,
          database: object.database,
          schema: object.schema,
          table: object.name,
        }}
        structure={result.structure}
        mode={schemaTool}
        onClose={() => {
          setSchemaTool(undefined)
          setEpoch((value) => value + 1)
        }}
      />
    )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle>
            {object.database ? `${object.database}.` : ''}
            {object.schema}.{object.name}
          </DialogTitle>
          <DialogDescription>
            {profile.name} · {object.kind} · {profile.environment}. Catalog inspection does not count or scan
            table rows.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            aria-label="Search object properties"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search properties, columns and constraints"
          />
          <Button variant="outline" onClick={() => setEpoch((value) => value + 1)}>
            Refresh properties
          </Button>
        </div>
        {error ? (
          <ErrorPanel message={error} />
        ) : !result ? (
          <Loading text="Reading live structure…" />
        ) : (
          <div className="min-h-0 overflow-auto space-y-4 text-sm">
            {result.warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
            {result.choices && (
              <label>
                Routine overload
                <select
                  aria-label="Routine overload"
                  value={identity || ''}
                  onChange={(event) => setIdentity(event.target.value || undefined)}
                >
                  <option value="">Choose an exact signature</option>
                  {result.choices.map((choice) => (
                    <option key={choice.identity} value={choice.identity}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <dl>
              {result.properties
                .filter((item) => match(item.name + ' ' + item.value))
                .map((item, index) => (
                  <div key={index} className="flex gap-3 border-b py-1">
                    <dt className="font-semibold">{item.name}</dt>
                    <dd className="break-all">{item.value}</dd>
                  </div>
                ))}
            </dl>
            {result.structure && (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => template('select')}>
                    Open SELECT template
                  </Button>
                  {object.kind === 'table' && schemaEngineSchema.safeParse(profile.engine).success && (
                    <>
                      <Button
                        variant="outline"
                        disabled={profile.id.startsWith('demo-')}
                        onClick={() => setSchemaTool('edit')}
                      >
                        Review schema changes
                      </Button>
                      <Button
                        variant="outline"
                        disabled={profile.id.startsWith('demo-')}
                        onClick={() => setSchemaTool('compare')}
                      >
                        Compare table schemas
                      </Button>
                    </>
                  )}
                  <Button
                    variant="outline"
                    disabled={object.kind !== 'table' || !engineSupports(profile.engine, 'rowEdits')}
                    onClick={() => template('insert')}
                  >
                    Open INSERT template
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      object.kind !== 'table' ||
                      !engineSupports(profile.engine, 'rowEdits') ||
                      !result.structure.columns.some((column) => column.primaryKey) ||
                      !result.structure.columns.some((column) => !column.primaryKey)
                    }
                    onClick={() => template('update')}
                  >
                    Open key-scoped UPDATE template
                  </Button>
                </div>
                <p className="text-xs muted">
                  Templates open without execution. Review generated/default columns, parameter types,
                  permissions and target before running.
                </p>
                <table className="data-grid">
                  <thead>
                    <tr>
                      <th>Column</th>
                      <th>Type</th>
                      <th>Null</th>
                      <th>Default</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.structure.columns
                      .filter((column) => match(column.name + ' ' + column.type))
                      .map((column) => (
                        <tr key={column.name}>
                          <td>
                            {column.primaryKey ? 'Primary key · ' : ''}
                            {column.name}
                          </td>
                          <td>{column.type}</td>
                          <td>{column.nullable ? 'Allowed' : 'Not null'}</td>
                          <td>{column.defaultValue ?? '—'}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                <details open>
                  <summary>Indexes & constraints</summary>
                  {[...result.structure.indexes, ...result.structure.constraints]
                    .filter((item) => match(item.name + ' ' + item.definition))
                    .map((item, index) => (
                      <div key={index}>
                        <strong>{item.name}</strong>
                        <pre className="whitespace-pre-wrap text-xs">{item.definition}</pre>
                      </div>
                    ))}
                </details>
              </>
            )}
            {result.definition && (
              <>
                <div className="flex items-center justify-between">
                  <span>
                    Definition ·{' '}
                    {result.definition.source === 'server'
                      ? 'server-provided'
                      : 'structural summary; not complete migration DDL'}
                  </span>
                  <CopyButton value={result.definition.text} label="Copy object definition" />
                </div>
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded border p-3 text-xs">
                  {result.definition.text}
                </pre>
              </>
            )}
            {result.details?.map((set, index) => (
              <section key={index} className="space-y-2">
                <strong>
                  {set.command || `Catalog details ${index + 1}`} · {set.rows.length} loaded rows
                  {set.truncated ? ' · truncated' : ''}
                </strong>
                <div className="max-h-64 overflow-auto">
                  <table className="data-grid">
                    <thead>
                      <tr>
                        {set.columns.map((column, ordinal) => (
                          <th key={ordinal}>{column.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {set.rows.map((row, position) => (
                        <tr key={position}>
                          {set.columns.map((_, ordinal) => (
                            <td key={ordinal} className="max-w-96 whitespace-pre-wrap break-words">
                              {row[ordinal] === null
                                ? 'NULL'
                                : typeof row[ordinal] === 'object'
                                  ? JSON.stringify(row[ordinal])
                                  : String(row[ordinal] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
