import { useEffect, useMemo, useRef, useState } from 'react'
import { FileUp, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type { ConnectionProfile, TableStructure, WorkspaceTab } from '@shared/contracts'
import { parseCsv, prepareCsvInserts } from '@shared/csv'
import { api } from '../lib/api'
import { displayCell, errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Field, FieldGroup, FieldLabel } from './ui/field'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ErrorPanel, useConfirm } from './common'

interface CsvImportProps {
  tab: WorkspaceTab
  profile: ConnectionProfile
  structure: TableStructure
  onClose: () => void
  onImported: () => void
  onBusyChange?: (busy: boolean) => void
}

export function CsvImportDialog({
  tab,
  profile,
  structure,
  onClose,
  onImported,
  onBusyChange,
}: CsvImportProps) {
  const [source, setSource] = useState('')
  const [fileName, setFileName] = useState('')
  const [delimiter, setDelimiter] = useState(',')
  const [header, setHeader] = useState(true)
  const [mapping, setMapping] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const importLock = useRef(false)
  const confirm = useConfirm()
  const schema = tab.schema || profile.schema
  const target = `${schema}.${tab.table}`
  const parsed = useMemo(() => {
    if (!source) return { data: null, error: '' }
    try {
      return { data: parseCsv(source, { delimiter, header, maxRows: 200 }), error: '' }
    } catch (cause) {
      return { data: null, error: errorText(cause) }
    }
  }, [source, delimiter, header])

  useEffect(() => {
    if (!parsed.data) {
      setMapping([])
      return
    }
    setMapping(
      parsed.data.headers.map((name, index) => {
        if (!header) return structure.columns[index]?.name || ''
        return (
          structure.columns.find((column) => column.name === name)?.name ||
          structure.columns.find((column) => column.name.toLowerCase() === name.trim().toLowerCase())?.name ||
          ''
        )
      }),
    )
  }, [parsed.data, header, structure.columns])

  const prepared = useMemo(() => {
    if (!parsed.data) return { changes: null, error: '' }
    try {
      return { changes: prepareCsvInserts(parsed.data, mapping, structure.columns), error: '' }
    } catch (cause) {
      return { changes: null, error: errorText(cause) }
    }
  }, [parsed.data, mapping, structure.columns])

  const importRows = async () => {
    if (!prepared.changes || !tab.table || busy || profile.readOnly || importLock.current) return
    importLock.current = true
    try {
      const changes = prepared.changes
      const approved = await confirm({
        title: `Import ${changes.length} rows?`,
        description: `${profile.name} · ${tab.database || profile.database} · ${target} · ${profile.environment}. Every row will be inserted in one transaction. Existing rows are not updated or replaced. A failed insert rolls back this import.`,
        detail: `Destination: ${target}\nBehavior: INSERT ONLY\nRows: ${changes.length}\nColumns: ${mapping.filter(Boolean).join(', ')}\nSource: ${fileName || 'Pasted CSV'}\nNULL token: unquoted \\N`,
        typed: profile.environment === 'production' ? tab.table : undefined,
        label: `Import ${changes.length} rows`,
      })
      if (approved === false) return
      setBusy(true)
      setError('')
      onBusyChange?.(true)
      let succeeded = false
      try {
        const outcome = await api.applyEdits({
          connectionId: tab.connectionId,
          database: tab.database,
          sessionId: tab.id,
          schema,
          table: tab.table,
          changes,
        })
        toast.success(`${outcome.affectedRows} rows imported into ${target}.`)
        succeeded = true
      } catch (cause) {
        setError(errorText(cause))
      } finally {
        setBusy(false)
        onBusyChange?.(false)
      }
      if (succeeded) {
        onImported()
        onClose()
      }
    } finally {
      importLock.current = false
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="connection-dialog">
        <DialogHeader>
          <DialogTitle>Import CSV into {tab.table}</DialogTitle>
          <DialogDescription>
            {profile.name} · {profile.database} · {target} · {profile.environment}. Preview and map columns
            before inserting any data.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup className="form-grid">
          <Field className="full-field">
            <FieldLabel htmlFor="csv-source-file">
              <FileUp />
              Choose a UTF-8 CSV file
            </FieldLabel>
            <Input
              id="csv-source-file"
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (!file) return
                if (file.size > 2 * 1024 * 1024) {
                  setError('CSV imports are limited to 2 MiB. Split this file before importing.')
                  event.target.value = ''
                  return
                }
                setError('')
                void file
                  .text()
                  .then((text) => {
                    setSource(text)
                    setFileName(file.name)
                  })
                  .catch((cause) => setError(errorText(cause)))
              }}
            />
            <p className="field-note">
              Up to 2 MiB and 200 data rows per import. The selected file is read locally.
            </p>
          </Field>
          <Field className="full-field">
            <FieldLabel htmlFor="csv-source-text">Or paste CSV text</FieldLabel>
            <textarea
              id="csv-source-text"
              aria-label="CSV text"
              className="mono min-h-28 w-full rounded-md border p-3"
              rows={5}
              spellCheck={false}
              disabled={busy}
              value={source}
              placeholder={'id,name\n1,"Example value"'}
              onChange={(event) => {
                setSource(event.target.value)
                setFileName('')
                setError('')
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="csv-delimiter">Delimiter</FieldLabel>
            <select
              id="csv-delimiter"
              disabled={busy}
              value={delimiter}
              onChange={(event) => setDelimiter(event.target.value)}
            >
              <option value=",">Comma (,)</option>
              <option value=";">Semicolon (;)</option>
              <option value={'\t'}>Tab</option>
              <option value="|">Pipe (|)</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="csv-header">Header handling</FieldLabel>
            <label className="check-row">
              <input
                id="csv-header"
                type="checkbox"
                disabled={busy}
                checked={header}
                onChange={(event) => setHeader(event.target.checked)}
              />
              First row contains column names
            </label>
          </Field>
        </FieldGroup>
        {parsed.data ? (
          <>
            <div className="flex items-center gap-2">
              <strong>Map destination columns</strong>
              <Badge variant="secondary">{parsed.data.rows.length} rows</Badge>
            </div>
            <FieldGroup className="form-grid max-h-44 overflow-auto">
              {parsed.data.headers.map((name, index) => (
                <Field key={index}>
                  <FieldLabel htmlFor={`csv-map-${index}`}>
                    {index + 1}. {name}
                  </FieldLabel>
                  <select
                    id={`csv-map-${index}`}
                    disabled={busy}
                    value={mapping[index] || ''}
                    onChange={(event) =>
                      setMapping((previous) =>
                        previous.map((column, position) =>
                          position === index ? event.target.value : column,
                        ),
                      )
                    }
                  >
                    <option value="">Skip this column</option>
                    {structure.columns.map((column) => (
                      <option key={column.name} value={column.name}>
                        {column.name} · {column.type}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </FieldGroup>
            <div className="flex items-center gap-2">
              <strong>Preview</strong>
              <span className="field-note">
                First {Math.min(5, parsed.data.rows.length)} of {parsed.data.rows.length} rows · INSERT only
              </span>
            </div>
            <div className="max-h-48 overflow-auto rounded-md border">
              <table className="data-grid">
                <thead>
                  <tr>
                    <th>CSV line</th>
                    {parsed.data.headers.map((name, index) => (
                      <th key={index}>
                        {mapping[index] || name}
                        <small>{mapping[index] ? 'Mapped destination' : 'Skipped'}</small>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.data.rows.slice(0, 5).map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      <td>{parsed.data!.lineNumbers[rowIndex]}</td>
                      {row.map((cell, column) => (
                        <td
                          key={column}
                          className={cell === null ? 'cell-null' : 'mono'}
                          title={displayCell(cell)}
                          style={{ maxWidth: 220 }}
                        >
                          {cell === '' ? '(empty string)' : displayCell(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="field-note">
              Unquoted <code>\N</code> becomes NULL. Empty fields remain empty strings; quoted{' '}
              <code>"\N"</code> remains text. Numbers, decimals, and JSON keep their source text. Unmapped
              columns use database defaults. The server validates constraints and remaining type rules in the
              transaction.
            </p>
          </>
        ) : null}
        {error || parsed.error || prepared.error ? (
          <ErrorPanel message={error || parsed.error || prepared.error} />
        ) : null}
        <div className="dialog-actions">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!prepared.changes?.length || busy || profile.readOnly}
            onClick={() => void importRows()}
          >
            <Upload data-icon="inline-start" />
            {busy ? 'Importing…' : 'Review & import'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
