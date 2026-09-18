import type { ParameterDefinition } from '@shared/parameters'
import { Button } from './ui/button'
import { Input } from './ui/input'

export function QueryParameters({
  definitions,
  values,
  onDefinitions,
  onValue,
  postgres,
  mssql = false,
  clickhouse = false,
  oracle = false,
  disabled,
}: {
  definitions: ParameterDefinition[]
  values: string[]
  onDefinitions: (definitions: ParameterDefinition[]) => void
  onValue: (index: number, value: string) => void
  postgres: boolean
  mssql?: boolean
  clickhouse?: boolean
  oracle?: boolean
  disabled: boolean
}) {
  return (
    <details className="border-b px-3 py-2">
      <summary className="cursor-pointer">Parameters ({definitions.length})</summary>
      <p className="field-note">
        Use{' '}
        {oracle ? ':name placeholders matching parameter names' : clickhouse
          ? '{name:Type}, such as {amount:Decimal(38, 9)}; the SQL type must match the value. For binary use base64 text with base64Decode({value:String}).'
          : postgres
            ? '$1, $2, …'
            : mssql
              ? '@name placeholders matching parameter names'
              : '? placeholders in order'}{' '}
        for values. Identifiers stay in SQL. Values remain in this tab’s memory and are never saved. Private
        values also suppress driver error details.
      </p>
      {definitions.map((definition, index) => (
        <div className="flex flex-wrap items-center gap-2 my-2" key={index}>
          <span>
            {oracle ? `:${definition.name.replace(/^:/, '')}` : clickhouse
              ? `{${definition.name}:Type}`
              : postgres
                ? `$${index + 1}`
                : mssql
                  ? `@${definition.name.replace(/^@/, '')}`
                  : `? ${index + 1}`}
          </span>
          <Input
            className="w-36"
            aria-label={`Parameter ${index + 1} name`}
            value={definition.name}
            disabled={disabled}
            onChange={(event) =>
              onDefinitions(definitions.map((p, i) => (i === index ? { ...p, name: event.target.value } : p)))
            }
          />
          <select
            aria-label={`Parameter ${index + 1} type`}
            value={definition.type}
            disabled={disabled}
            onChange={(event) =>
              onDefinitions(
                definitions.map((p, i) =>
                  i === index ? { ...p, type: event.target.value as ParameterDefinition['type'] } : p,
                ),
              )
            }
          >
            {['text', 'integer', 'decimal', 'boolean', 'null', 'json', 'timestamp', 'binary'].map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
          <Input
            className="min-w-48 flex-1"
            type={definition.secret ? 'password' : 'text'}
            autoComplete="off"
            aria-label={`Parameter ${index + 1} value`}
            placeholder={
              definition.type === 'binary'
                ? 'Base64'
                : definition.type === 'timestamp'
                  ? 'ISO timestamp with timezone'
                  : 'Value'
            }
            value={values[index] || ''}
            disabled={disabled || definition.type === 'null'}
            onChange={(event) => onValue(index, event.target.value)}
          />
          <label className="flex gap-1">
            <input
              type="checkbox"
              checked={definition.secret}
              disabled={disabled}
              onChange={(event) =>
                onDefinitions(
                  definitions.map((p, i) => (i === index ? { ...p, secret: event.target.checked } : p)),
                )
              }
            />
            Private
          </label>
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => onDefinitions(definitions.filter((_, i) => i !== index))}
          >
            Remove {index + 1}
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        disabled={disabled || definitions.length >= 100}
        onClick={() =>
          onDefinitions([
            ...definitions,
            { name: `value_${definitions.length + 1}`, type: 'text', secret: false },
          ])
        }
      >
        Add parameter
      </Button>
    </details>
  )
}
