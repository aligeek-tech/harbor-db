import { useState } from 'react'
import type { ConnectionProfile, TableStructure } from '@shared/contracts'
import {
  schemaOperationSchema,
  schemaTypeSql,
  schemaEngineSchema,
  type SchemaColumn,
  type SchemaColumnType,
  type SchemaConstraint,
  type SchemaOperation,
  type SchemaChangePreview,
  type SchemaChangeResult,
  type SchemaComparison,
  type SchemaTarget,
  type CompareSchemasInput,
} from '@shared/schema-changes'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { CopyButton, ErrorPanel } from './common'

const kinds: { value: SchemaOperation['kind']; label: string }[] = [
  { value: 'add-column', label: 'Add column' },
  { value: 'create-table', label: 'Create table' },
  { value: 'rename-table', label: 'Rename table' },
  { value: 'rename-column', label: 'Rename column' },
  { value: 'alter-column', label: 'Change column type / nullability' },
  { value: 'drop-column', label: 'Drop column' },
  { value: 'create-index', label: 'Create index' },
  { value: 'drop-index', label: 'Drop index' },
  { value: 'add-constraint', label: 'Add constraint' },
  { value: 'drop-constraint', label: 'Drop constraint' },
]
const newColumn = (name = ''): SchemaColumn => ({ name, type: { kind: 'text' }, nullable: true })
const split = (value: string) => value.split(',').map((name) => name.trim())
function TypeFields({
  value,
  onChange,
  prefix,
}: {
  value: SchemaColumnType
  onChange: (value: SchemaColumnType) => void
  prefix: string
}) {
  return (
    <>
      <select
        aria-label={`${prefix} type`}
        value={value.kind}
        onChange={(event) => {
          const kind = event.target.value as SchemaColumnType['kind']
          onChange(
            kind === 'varchar'
              ? { kind, length: 255 }
              : kind === 'decimal'
                ? { kind, precision: 18, scale: 2 }
                : { kind },
          )
        }}
      >
        {['integer', 'bigint', 'decimal', 'varchar', 'text', 'boolean', 'date', 'timestamp', 'binary'].map(
          (kind) => (
            <option key={kind}>{kind}</option>
          ),
        )}
      </select>
      {value.kind === 'varchar' && (
        <Input
          className="w-24"
          type="number"
          min={1}
          max={4000}
          aria-label={`${prefix} length`}
          value={value.length}
          onChange={(event) => onChange({ ...value, length: Number(event.target.value) })}
        />
      )}
      {value.kind === 'decimal' && (
        <>
          <Input
            className="w-24"
            type="number"
            min={1}
            max={38}
            aria-label={`${prefix} precision`}
            value={value.precision}
            onChange={(event) => onChange({ ...value, precision: Number(event.target.value) })}
          />
          <Input
            className="w-24"
            type="number"
            min={0}
            max={38}
            aria-label={`${prefix} scale`}
            value={value.scale}
            onChange={(event) => onChange({ ...value, scale: Number(event.target.value) })}
          />
        </>
      )}
    </>
  )
}
function ColumnFields({
  value,
  onChange,
  prefix,
}: {
  value: SchemaColumn
  onChange: (value: SchemaColumn) => void
  prefix: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border p-2">
      <Input
        className="w-40"
        placeholder="Column name"
        aria-label={`${prefix} name`}
        value={value.name}
        onChange={(event) => onChange({ ...value, name: event.target.value })}
      />
      <TypeFields prefix={prefix} value={value.type} onChange={(type) => onChange({ ...value, type })} />
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value.nullable}
          onChange={(event) => onChange({ ...value, nullable: event.target.checked })}
        />
        Nullable
      </label>
      <select
        aria-label={`${prefix} default kind`}
        value={value.default?.kind || 'none'}
        onChange={(event) => {
          const kind = event.target.value
          onChange({
            ...value,
            default:
              kind === 'none'
                ? undefined
                : kind === 'null'
                  ? { kind }
                  : kind === 'boolean'
                    ? { kind, value: false }
                    : kind === 'number'
                      ? { kind, value: '0' }
                      : { kind: 'text', value: '' },
          })
        }}
      >
        <option value="none">No default</option>
        <option value="null">NULL default</option>
        <option value="text">Text literal</option>
        <option value="number">Numeric literal</option>
        <option value="boolean">Boolean literal</option>
      </select>
      {value.default &&
        value.default.kind !== 'null' &&
        (value.default.kind === 'boolean' ? (
          <select
            aria-label={`${prefix} default value`}
            value={String(value.default.value)}
            onChange={(event) =>
              onChange({ ...value, default: { kind: 'boolean', value: event.target.value === 'true' } })
            }
          >
            <option>false</option>
            <option>true</option>
          </select>
        ) : (
          <Input
            className="w-40"
            aria-label={`${prefix} default value`}
            value={value.default.value}
            onChange={(event) =>
              onChange({
                ...value,
                default: { kind: value.default!.kind as 'number' | 'text', value: event.target.value },
              })
            }
          />
        ))}
    </div>
  )
}
function ConstraintFields({
  value,
  onChange,
  prefix,
  schema,
}: {
  value: SchemaConstraint
  onChange: (value: SchemaConstraint) => void
  prefix: string
  schema: string
}) {
  return (
    <div className="space-y-2 rounded border p-2">
      <div className="flex flex-wrap gap-2">
        <Input
          className="w-48"
          aria-label={`${prefix} name`}
          placeholder="Constraint name"
          value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
        <select
          aria-label={`${prefix} kind`}
          value={value.kind}
          onChange={(event) => {
            const kind = event.target.value as SchemaConstraint['kind']
            onChange(
              kind === 'check'
                ? {
                    kind,
                    name: value.name,
                    column: '',
                    operator: '>=',
                    value: { kind: 'number', value: '0' },
                  }
                : kind === 'foreign-key'
                  ? {
                      kind,
                      name: value.name,
                      columns: [],
                      referencedSchema: schema,
                      referencedTable: '',
                      referencedColumns: [],
                    }
                  : { kind, name: value.name, columns: [] },
            )
          }}
        >
          {['primary-key', 'unique', 'foreign-key', 'check'].map((kind) => (
            <option key={kind}>{kind}</option>
          ))}
        </select>
        {value.kind !== 'check' ? (
          <Input
            className="w-56"
            aria-label={`${prefix} columns`}
            placeholder="Ordered columns: id, category"
            value={value.columns.join(', ')}
            onChange={(event) => onChange({ ...value, columns: split(event.target.value) })}
          />
        ) : (
          <>
            <Input
              className="w-40"
              aria-label={`${prefix} column`}
              placeholder="Column"
              value={value.column}
              onChange={(event) => onChange({ ...value, column: event.target.value })}
            />
            <select
              aria-label={`${prefix} operator`}
              value={value.operator}
              onChange={(event) =>
                onChange({ ...value, operator: event.target.value as typeof value.operator })
              }
            >
              {['=', '<>', '>', '<', '>=', '<='].map((operator) => (
                <option key={operator}>{operator}</option>
              ))}
            </select>
            <select
              aria-label={`${prefix} value kind`}
              value={value.value.kind}
              onChange={(event) =>
                onChange({
                  ...value,
                  value:
                    event.target.value === 'number'
                      ? { kind: 'number', value: '0' }
                      : { kind: 'text', value: '' },
                })
              }
            >
              <option value="number">Numeric literal</option>
              <option value="text">Text literal</option>
            </select>
            {'value' in value.value && (
              <Input
                className="w-40"
                aria-label={`${prefix} value`}
                value={String(value.value.value)}
                onChange={(event) =>
                  onChange({
                    ...value,
                    value: { kind: value.value.kind as 'number' | 'text', value: event.target.value },
                  })
                }
              />
            )}
          </>
        )}
      </div>
      {value.kind === 'foreign-key' && (
        <div className="flex flex-wrap gap-2">
          <Input
            className="w-40"
            aria-label={`${prefix} referenced schema`}
            value={value.referencedSchema}
            onChange={(event) => onChange({ ...value, referencedSchema: event.target.value })}
          />
          <Input
            className="w-40"
            aria-label={`${prefix} referenced table`}
            placeholder="Parent table"
            value={value.referencedTable}
            onChange={(event) => onChange({ ...value, referencedTable: event.target.value })}
          />
          <Input
            className="w-56"
            aria-label={`${prefix} referenced columns`}
            placeholder="Ordered parent primary key"
            value={value.referencedColumns.join(', ')}
            onChange={(event) => onChange({ ...value, referencedColumns: split(event.target.value) })}
          />
          <p className="text-xs muted">
            No cascading actions. Parent columns must match its declared primary key in order.
          </p>
        </div>
      )}
    </div>
  )
}

export function SchemaChangesDialog({
  profile,
  target,
  structure,
  mode,
  onClose,
}: {
  profile: ConnectionProfile
  target: SchemaTarget
  structure: TableStructure
  mode: 'edit' | 'compare'
  onClose: () => void
}) {
  const profiles = useApp((state) => state.profiles),
    statuses = useApp((state) => state.statuses)
  const [kind, setKind] = useState<SchemaOperation['kind']>('add-column'),
    [table, setTable] = useState(target.table)
  const [name, setName] = useState(structure.columns[0]?.name || ''),
    [newName, setNewName] = useState('')
  const [columns, setColumns] = useState<SchemaColumn[]>([newColumn()]),
    [type, setType] = useState<SchemaColumnType>({ kind: 'text' })
  const [nullable, setNullable] = useState(true),
    [selectedColumns, setSelectedColumns] = useState<string[]>([]),
    [unique, setUnique] = useState(false)
  const [constraints, setConstraints] = useState<SchemaConstraint[]>([
      { kind: 'unique', name: '', columns: [] },
    ]),
    [constraintKind, setConstraintKind] = useState<'primary-key' | 'unique' | 'foreign-key' | 'check'>(
      'unique',
    )
  const [preview, setPreview] = useState<SchemaChangePreview>(),
    [result, setResult] = useState<SchemaChangeResult>(),
    [confirmation, setConfirmation] = useState('')
  const [comparison, setComparison] = useState<SchemaComparison>(),
    [destination, setDestination] = useState<SchemaTarget>({ ...target })
  type SelectedObject = NonNullable<CompareSchemasInput['objects']>[number]
  const [catalog, setCatalog] =
      useState<{ kind: SelectedObject['kind']; name: string; source: boolean; target: boolean }[]>(),
    [selectedObjects, setSelectedObjects] = useState<string[]>([]),
    [objectSearch, setObjectSearch] = useState('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  function changed(action: () => void) {
    action()
    setPreview(undefined)
    setResult(undefined)
    setComparison(undefined)
    setConfirmation('')
    setError('')
  }
  function changeDestination(value: SchemaTarget) {
    changed(() => setDestination(value))
    setCatalog(undefined)
    setSelectedObjects([])
  }
  async function loadCatalogs() {
    setBusy(true)
    setError('')
    setComparison(undefined)
    setSelectedObjects([])
    try {
      // Sequential: both namespaces may share one metadata worker/socket.
      const sourceObjects = await api.listObjects({
        connectionId: target.connectionId,
        database: target.database,
        schema: target.schema,
      })
      const targetObjects = await api.listObjects({
        connectionId: destination.connectionId,
        database: destination.database,
        schema: destination.schema,
      })
      if (sourceObjects.length > 1000 || targetObjects.length > 1000)
        throw new Error(
          'Each catalog is limited to 1,000 visible objects in this picker. Choose a narrower schema.',
        )
      const objects = new Map<
        string,
        { kind: SelectedObject['kind']; name: string; source: boolean; target: boolean }
      >()
      for (const [side, items, schema] of [
        ['source', sourceObjects, target.schema],
        ['target', targetObjects, destination.schema],
      ] as const) {
        for (const object of items) {
          if (
            object.schema !== schema ||
            !['table', 'view', 'materialized view', 'function', 'trigger'].includes(object.kind)
          )
            continue
          const kind = (object.kind === 'materialized view' ? 'view' : object.kind) as SelectedObject['kind'],
            key = `${kind}/${object.name}`
          const item = objects.get(key) || { kind, name: object.name, source: false, target: false }
          item[side] = true
          objects.set(key, item)
        }
      }
      setCatalog(
        [...objects.values()].sort((a, b) => `${a.kind}/${a.name}`.localeCompare(`${b.kind}/${b.name}`)),
      )
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  function operation(): SchemaOperation {
    if (kind === 'create-table') return { kind, columns, constraints }
    if (kind === 'add-column') return { kind, column: columns[0] }
    if (kind === 'rename-table') return { kind, name: newName }
    if (kind === 'rename-column') return { kind, name, newName }
    if (kind === 'alter-column') return { kind, name, type, nullable }
    if (kind === 'drop-column' || kind === 'drop-index') return { kind, name }
    if (kind === 'create-index') return { kind, name: newName, columns: selectedColumns, unique }
    if (kind === 'add-constraint') return { kind, constraint: constraints[0] }
    return { kind: 'drop-constraint', name, constraintKind }
  }
  async function prepare() {
    setBusy(true)
    setError('')
    setResult(undefined)
    try {
      setPreview(
        await api.previewSchemaChange({
          target: { ...target, table: kind === 'create-table' ? table : target.table },
          operation: schemaOperationSchema.parse(operation()),
        }),
      )
      setConfirmation('')
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  async function execute() {
    if (!preview) return
    setBusy(true)
    setError('')
    try {
      setResult(await api.executeSchemaChange({ token: preview.token, confirm: confirmation }))
      useApp.getState().clearObjects(profile.id)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
      setPreview(undefined)
      setConfirmation('')
    }
  }
  async function compare() {
    setBusy(true)
    setError('')
    setComparison(undefined)
    try {
      const objects = catalog
        ?.filter((item) => selectedObjects.includes(`${item.kind}/${item.name}`))
        .map((item) => ({ kind: item.kind, sourceName: item.name, targetName: item.name }))
      setComparison(
        await api.compareSchemas({
          source: target,
          target: destination,
          ...(objects?.length ? { objects } : {}),
        }),
      )
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  const draft =
    comparison &&
    [
      '-- INERT MIGRATION DRAFT. Review dependencies, data loss and unsupported differences.',
      '-- This is not a rollback plan. No statements have been executed.',
      ...comparison.differences
        .filter((item) => !item.supported)
        .map((item) => `-- MANUAL REVIEW: ${item.object.replace(/[\r\n]/g, ' ')}`),
      ...comparison.statements,
    ].join('\n\n')
  const namedOptions =
    kind === 'drop-index'
      ? structure.indexes
      : kind === 'drop-constraint'
        ? structure.constraints
        : structure.columns
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-5xl"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{mode === 'edit' ? 'Review schema changes' : 'Compare table schemas'}</DialogTitle>
          <DialogDescription>
            {profile.name} · {profile.engine} · {profile.environment} · {target.database || '(default)'}/
            {target.schema}/{target.table}. Catalog inspection reads no table rows. Server permissions still
            apply.
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={busy} className="space-y-4">
          {mode === 'edit' ? (
            <>
              <label className="flex gap-2 items-center">
                Operation
                <select
                  aria-label="Schema operation"
                  value={kind}
                  onChange={(event) =>
                    changed(() => {
                      const next = event.target.value as SchemaOperation['kind']
                      setKind(next)
                      setNewName('')
                      setTable(next === 'create-table' ? `${target.table}_new` : target.table)
                      setName(
                        next === 'drop-index'
                          ? structure.indexes[0]?.name || ''
                          : next === 'drop-constraint'
                            ? structure.constraints[0]?.name || ''
                            : structure.columns[0]?.name || '',
                      )
                      if (next === 'create-table') {
                        setColumns([{ name: 'id', type: { kind: 'integer' }, nullable: false }])
                        setConstraints([
                          { kind: 'primary-key', name: `${target.table}_new_pk`, columns: ['id'] },
                        ])
                      } else if (next === 'add-column') setColumns([newColumn()])
                      else if (next === 'add-constraint')
                        setConstraints([{ kind: 'unique', name: '', columns: [] }])
                    })
                  }
                >
                  {kinds.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              {kind === 'create-table' && (
                <label className="block">
                  New table name
                  <Input
                    aria-label="New schema table name"
                    value={table}
                    onChange={(event) => changed(() => setTable(event.target.value))}
                  />
                </label>
              )}
              {['rename-column', 'alter-column', 'drop-column', 'drop-index', 'drop-constraint'].includes(
                kind,
              ) && (
                <label className="flex gap-2 items-center">
                  Existing object
                  <select
                    aria-label="Schema existing object"
                    value={name}
                    onChange={(event) => changed(() => setName(event.target.value))}
                  >
                    {namedOptions.map((item) => (
                      <option key={item.name}>{item.name}</option>
                    ))}
                  </select>
                </label>
              )}
              {['rename-table', 'rename-column', 'create-index'].includes(kind) && (
                <Input
                  aria-label="Schema new name"
                  placeholder={kind === 'create-index' ? 'New index name' : 'New name'}
                  value={newName}
                  onChange={(event) => changed(() => setNewName(event.target.value))}
                />
              )}
              {['create-table', 'add-column'].includes(kind) &&
                columns.map((column, index) => (
                  <div key={index} className="flex gap-2 items-center">
                    <ColumnFields
                      prefix={`Schema column ${index + 1}`}
                      value={column}
                      onChange={(value) =>
                        changed(() =>
                          setColumns(columns.map((item, position) => (position === index ? value : item))),
                        )
                      }
                    />
                    {kind === 'create-table' && columns.length > 1 && (
                      <Button
                        variant="ghost"
                        aria-label={`Remove schema column ${index + 1}`}
                        onClick={() =>
                          changed(() => setColumns(columns.filter((_, position) => position !== index)))
                        }
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                ))}
              {kind === 'create-table' && (
                <Button
                  variant="outline"
                  disabled={columns.length >= 100}
                  onClick={() => changed(() => setColumns([...columns, newColumn()]))}
                >
                  Add table column
                </Button>
              )}
              {kind === 'alter-column' && (
                <div className="flex gap-2 items-center">
                  <TypeFields
                    prefix="Alter column"
                    value={type}
                    onChange={(value) => changed(() => setType(value))}
                  />
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={nullable}
                      onChange={(event) => changed(() => setNullable(event.target.checked))}
                    />
                    Allow NULL
                  </label>
                  <span className="text-xs">
                    {schemaTypeSql(schemaEngineSchema.parse(profile.engine), type)}
                  </span>
                </div>
              )}
              {kind === 'create-index' && (
                <div className="flex gap-2 items-center">
                  <Input
                    aria-label="Schema index columns"
                    placeholder="Ordered columns, separated by commas"
                    value={selectedColumns.join(', ')}
                    onChange={(event) => changed(() => setSelectedColumns(split(event.target.value)))}
                  />
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={unique}
                      onChange={(event) => changed(() => setUnique(event.target.checked))}
                    />
                    Unique
                  </label>
                </div>
              )}
              {['create-table', 'add-constraint'].includes(kind) &&
                constraints.map((constraint, index) => (
                  <div key={index} className="flex gap-2 items-center">
                    <ConstraintFields
                      prefix={`Schema constraint ${index + 1}`}
                      schema={target.schema}
                      value={constraint}
                      onChange={(value) =>
                        changed(() =>
                          setConstraints(
                            constraints.map((item, position) => (position === index ? value : item)),
                          ),
                        )
                      }
                    />
                    {kind === 'create-table' && (
                      <Button
                        variant="ghost"
                        aria-label={`Remove schema constraint ${index + 1}`}
                        onClick={() =>
                          changed(() =>
                            setConstraints(constraints.filter((_, position) => position !== index)),
                          )
                        }
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                ))}
              {kind === 'create-table' && (
                <Button
                  variant="outline"
                  disabled={constraints.length >= 32}
                  onClick={() =>
                    changed(() => setConstraints([...constraints, { kind: 'unique', name: '', columns: [] }]))
                  }
                >
                  Add table constraint
                </Button>
              )}
              {kind === 'drop-constraint' && (
                <label className="flex gap-2 items-center">
                  Constraint kind
                  <select
                    aria-label="Schema drop constraint kind"
                    value={constraintKind}
                    onChange={(event) =>
                      changed(() => setConstraintKind(event.target.value as typeof constraintKind))
                    }
                  >
                    {['primary-key', 'unique', 'foreign-key', 'check'].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
              )}
              <p className="text-xs muted">
                No arbitrary expression SQL, automatic cascade, invented default, online index promise, or
                implicit table rebuild. Unsupported operations are explained in preview. Column lists use
                commas; unusual names containing commas need a manually reviewed SQL draft.
              </p>
              <Button variant="outline" onClick={() => void prepare()}>
                Preview schema change
              </Button>
            </>
          ) : (
            <>
              <p>
                Desired source:{' '}
                <strong>
                  {target.schema}.{target.table}
                </strong>
                . Choose a target table pair, or explicitly load scoped catalogs to select up to 20 tables,
                views, routines and triggers by name. Drafts are inert and never execute automatically.
              </p>
              <label className="block">
                Target connection
                <select
                  className="block"
                  aria-label="Schema comparison connection"
                  value={destination.connectionId}
                  onChange={(event) =>
                    (() => {
                      const selected = profiles.find((item) => item.id === event.target.value)!
                      changeDestination({
                        ...destination,
                        connectionId: selected.id,
                        database: selected.database || undefined,
                        schema: selected.schema || 'main',
                      })
                    })()
                  }
                >
                  {profiles
                    .filter(
                      (item) => item.engine === profile.engine && statuses[item.id]?.state === 'connected',
                    )
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.environment}
                      </option>
                    ))}
                </select>
              </label>
              <div className="grid gap-2 sm:grid-cols-3">
                <label>
                  Database
                  <Input
                    aria-label="Schema comparison database"
                    value={destination.database || ''}
                    onChange={(event) =>
                      changeDestination({ ...destination, database: event.target.value || undefined })
                    }
                  />
                </label>
                <label>
                  Schema
                  <Input
                    aria-label="Schema comparison schema"
                    value={destination.schema}
                    onChange={(event) => changeDestination({ ...destination, schema: event.target.value })}
                  />
                </label>
                <label>
                  Table
                  <Input
                    aria-label="Schema comparison table"
                    value={destination.table}
                    onChange={(event) => changeDestination({ ...destination, table: event.target.value })}
                  />
                </label>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => void loadCatalogs()}>
                  Load scoped comparison catalogs
                </Button>
                <Button
                  variant="outline"
                  disabled={!!catalog && !selectedObjects.length}
                  onClick={() => void compare()}
                >
                  {catalog ? 'Compare selected schema objects' : 'Compare selected tables'}
                </Button>
                {catalog && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setCatalog(undefined)
                      setSelectedObjects([])
                      setComparison(undefined)
                    }}
                  >
                    Use table pair
                  </Button>
                )}
              </div>
              {catalog && (
                <div className="space-y-2 rounded border p-3">
                  <p className="text-xs">
                    {catalog.length} visible objects · {selectedObjects.length}/20 selected. Names match
                    within the two chosen schemas. Target-only objects are removals requiring manual review.
                    Routine overloads are compared together; unsupported definitions are marked.
                  </p>
                  <Input
                    aria-label="Search comparison objects"
                    placeholder="Filter selected schema catalog"
                    value={objectSearch}
                    onChange={(event) => setObjectSearch(event.target.value)}
                  />
                  <div className="max-h-56 overflow-y-auto">
                    {catalog
                      .filter((item) =>
                        `${item.kind} ${item.name}`.toLowerCase().includes(objectSearch.toLowerCase()),
                      )
                      .map((item) => {
                        const key = `${item.kind}/${item.name}`,
                          checked = selectedObjects.includes(key)
                        return (
                          <label className="flex gap-2 py-1" key={key}>
                            <input
                              type="checkbox"
                              aria-label={`Compare ${item.kind} ${item.name}`}
                              checked={checked}
                              disabled={!checked && selectedObjects.length >= 20}
                              onChange={() =>
                                changed(() =>
                                  setSelectedObjects(
                                    checked
                                      ? selectedObjects.filter((value) => value !== key)
                                      : [...selectedObjects, key],
                                  ),
                                )
                              }
                            />
                            <span>
                              {item.kind} · {item.name} ·{' '}
                              {item.source && item.target
                                ? 'both schemas'
                                : item.source
                                  ? 'source only'
                                  : 'target only'}
                            </span>
                          </label>
                        )
                      })}
                  </div>
                </div>
              )}
            </>
          )}
        </fieldset>
        {busy && (
          <p role="status">
            {confirmation
              ? 'Executing reviewed DDL; waiting for the server outcome…'
              : 'Reading live catalogs…'}
          </p>
        )}
        {error && <ErrorPanel message={error} />}
        {preview && (
          <section className="space-y-3 rounded border p-3" aria-label="Schema change preview">
            <strong>
              {preview.target.database || '(default)'}/{preview.target.schema}/{preview.target.table} ·{' '}
              {preview.engine} ·{' '}
              {preview.atomicity === 'transaction'
                ? 'Dedicated transaction'
                : 'Implicit commits; no DDL rollback'}
            </strong>
            {preview.warnings.map((warning, index) => (
              <p key={index} className="text-xs">
                {warning}
              </p>
            ))}
            {!!preview.dependencies.length && (
              <details>
                <summary>{preview.dependencies.length} catalog dependencies to review</summary>
                {preview.dependencies.map((dependency, index) => (
                  <div className="border-b py-2" key={index}>
                    <strong>
                      {dependency.kind}: {dependency.name}
                    </strong>
                    <pre className="whitespace-pre-wrap text-xs">{dependency.detail}</pre>
                  </div>
                ))}
              </details>
            )}
            {!!preview.blockedReasons.length && <ErrorPanel message={preview.blockedReasons.join('\n')} />}
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap border p-3 text-xs">
              {preview.statements.join('\n\n') || 'No executable SQL generated.'}
            </pre>
            {!!preview.statements.length && (
              <CopyButton value={preview.statements.join('\n\n')} label="Copy schema preview SQL" />
            )}
            {!preview.blockedReasons.length && (
              <>
                <label className="block">
                  Type <strong className="select-all">{preview.confirmation}</strong> to execute this exact
                  target.
                  <Input
                    aria-label="Schema execution confirmation"
                    value={confirmation}
                    disabled={busy}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
                <Button
                  variant="destructive"
                  disabled={busy || confirmation !== preview.confirmation}
                  onClick={() => void execute()}
                >
                  Execute reviewed schema change
                </Button>
                <p className="text-xs muted">
                  Preview expires at {new Date(preview.expiresAt).toLocaleTimeString()}. Existing query-tab
                  transactions and staged row edits are not part of this schema transaction.
                </p>
              </>
            )}
          </section>
        )}
        {result && (
          <section aria-label="Schema execution result" className="rounded border p-3 space-y-2">
            <strong>Schema outcome: {result.state}</strong>
            {result.steps.map((step, index) => (
              <div key={index}>
                <span>
                  {index + 1}. {step.status}
                </span>
                <pre className="whitespace-pre-wrap text-xs">{step.sql}</pre>
                {step.error && <p>{step.error}</p>}
              </div>
            ))}
            {result.warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
            <p className="text-xs">
              Refresh the inspector and affected table/query tabs before further work. No statement was
              automatically retried.
            </p>
          </section>
        )}
        {comparison && (
          <section className="space-y-3" aria-label="Schema comparison result">
            {comparison.warnings.map((warning, index) => (
              <p key={index} className="text-xs">
                {warning}
              </p>
            ))}
            {!comparison.differences.length && (
              <p>
                No differences found in the inspected metadata. Unrepresented engine attributes are not proven
                equal.
              </p>
            )}
            {comparison.differences.map((difference, index) => (
              <div key={index} className="rounded border p-2">
                <strong>
                  {difference.change} {difference.object} ·{' '}
                  {difference.supported ? 'Draft statement available' : 'Manual review required'}
                </strong>
                <p className="text-xs whitespace-pre-wrap">{difference.detail}</p>
              </div>
            ))}
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap border p-3 text-xs">{draft}</pre>
            <div className="flex gap-2">
              <CopyButton value={draft || ''} label="Copy migration draft" />
              <Button
                variant="outline"
                disabled={!comparison.statements.length}
                onClick={() => {
                  useApp.getState().openTab({
                    connectionId: destination.connectionId,
                    database: destination.database,
                    schema: destination.schema,
                    kind: 'query',
                    title: `Migration draft: ${destination.table}`,
                    sql: draft || '',
                  })
                  useApp.getState().setSection('connections')
                  onClose()
                }}
              >
                Open inert migration draft
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void api
                    .exportSql({ name: `migration-${destination.table}.sql`, sql: draft || '' })
                    .catch((failure) => setError(errorText(failure)))
                }
              >
                Save migration draft
              </Button>
            </div>
          </section>
        )}
        <div className="flex justify-end">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Back to inspector
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
