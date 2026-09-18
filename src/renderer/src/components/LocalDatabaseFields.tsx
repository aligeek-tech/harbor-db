import type { ConnectionProfile } from '@shared/contracts'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'

export function LocalDatabaseFields({
  profile,
  update,
  onError,
}: {
  profile: ConnectionProfile
  update: (partial: Partial<ConnectionProfile>) => void
  onError: (message: string) => void
}) {
  const duck = profile.engine === 'duckdb'
  const options = duck ? profile.duckdb : profile.sqlite
  const change = (partial: { mode?: 'open' | 'create' | 'memory'; path?: string }) =>
    update(
      duck
        ? { duckdb: { ...profile.duckdb, ...partial } }
        : {
            sqlite: {
              ...profile.sqlite,
              ...partial,
              mode: partial.mode === 'memory' ? 'open' : partial.mode || profile.sqlite.mode,
            },
          },
    )
  return (
    <div className="full-field flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor="local-database-mode">Database file operation</FieldLabel>
        <select
          id="local-database-mode"
          value={options.mode}
          onChange={(event) => {
            const mode = event.target.value as 'open' | 'create' | 'memory'
            change({ mode, path: '' })
            update({ readOnly: mode === 'open', autoReconnect: false })
          }}
        >
          <option value="open">Open an existing database</option>
          <option value="create">Create a new database</option>
          {duck && <option value="memory">Temporary in-memory database</option>}
        </select>
      </Field>
      {options.mode !== 'memory' && (
        <Field>
          <FieldLabel htmlFor="local-database-path">{duck ? 'DuckDB' : 'SQLite'} database file</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="local-database-path"
              value={options.path}
              placeholder="Choose an absolute local file path"
              onChange={(event) => change({ path: event.target.value })}
            />
            <Button
              variant="outline"
              onClick={() =>
                void api
                  .chooseDatabaseFile(options.mode === 'create' ? 'create' : 'open')
                  .then((path) => {
                    if (path) change({ path })
                  })
                  .catch((error) => onError(errorText(error)))
              }
            >
              Browse…
            </Button>
          </div>
        </Field>
      )}
      {!duck && (
        <Field>
          <FieldLabel htmlFor="sqlite-timeout">Lock wait timeout (ms)</FieldLabel>
          <Input
            id="sqlite-timeout"
            type="number"
            min={0}
            max={30000}
            value={profile.sqlite.busyTimeoutMs}
            onChange={(event) =>
              update({ sqlite: { ...profile.sqlite, busyTimeoutMs: Number(event.target.value) } })
            }
          />
        </Field>
      )}
      <p className="field-note">
        {options.mode === 'memory'
          ? 'Temporary data is lost on disconnect or exit. Restoring tabs never restores in-memory data.'
          : options.mode === 'create'
            ? 'Only Save and create creates the file, after your review. An existing file is never overwritten.'
            : 'Opening requires an existing file. Read-only mode is recommended for inspection.'}{' '}
        {duck
          ? 'DuckDB editor sessions cannot download extensions or access external files or the network. Use the reviewed file explorer to grant one file at a time. Other processes may hold a conflicting database lock.'
          : 'Other applications can hold locks. Keep WAL/SHM files together with the SQLite file; a copied database alone may omit recent changes.'}{' '}
        Harbor’s own workspace database cannot be opened here.
      </p>
    </div>
  )
}
