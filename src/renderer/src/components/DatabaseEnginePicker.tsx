import { useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { Popover } from 'radix-ui'
import { engineDefinitions, type DataModel } from '@shared/capabilities'
import type { Engine } from '@shared/contracts'
import { engineNames } from '../lib/utils'
import { EngineIcon } from './common'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

const groups: [DataModel, string][] = [
  ['relational', 'SQL databases'],
  ['document', 'Document databases'],
  ['key-value', 'Key-value stores'],
  ['search', 'Search engines'],
  ['vector', 'Vector databases'],
  ['time-series', 'Time-series databases'],
  ['wide-column', 'Wide-column databases'],
  ['graph', 'Graph databases'],
]
const engines = (Object.keys(engineNames) as Engine[]).sort((a, b) =>
  engineNames[a].localeCompare(engineNames[b]),
)

export function DatabaseEnginePicker({
  value,
  onChange,
  disabled,
}: {
  value: Engine
  onChange: (engine: Engine) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null)
  const results = useRef<HTMLDivElement>(null)
  const query = search.trim().toLocaleLowerCase()
  const visible = groups
    .map(([model, label]) => ({
      model,
      label,
      engines: engines.filter(
        (engine) =>
          engineDefinitions[engine].model === model &&
          `${engineNames[engine]} ${engine} ${label}`.toLocaleLowerCase().includes(query),
      ),
    }))
    .filter((group) => group.engines.length)

  return (
    <div className="database-engine-picker" ref={setPortalContainer}>
      <span className="database-engine-label">Database engine</span>
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          setSearch('')
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className="database-engine-trigger"
            disabled={disabled}
            aria-label={`Database engine: ${engineNames[value]}`}
          >
            <span className="database-engine-icon">
              <EngineIcon engine={value} />
            </span>
            <span className="database-engine-name">{engineNames[value]}</span>
            <ChevronDown aria-hidden="true" className="database-engine-chevron" />
          </button>
        </Popover.Trigger>
        {/* Keep wheel events inside the parent dialog's scroll-lock boundary. */}
        <Popover.Portal container={portalContainer}>
          <Popover.Content
            className="database-engine-popup"
            align="start"
            sideOffset={6}
            collisionPadding={16}
            aria-label="Choose a database engine"
          >
            <label className="database-engine-search">
              <Search aria-hidden="true" />
              <input
                aria-label="Search databases"
                placeholder="Search databases…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    const options = results.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                    const option = event.key === 'ArrowUp' ? options?.[options.length - 1] : options?.[0]
                    option?.focus()
                  } else if (
                    event.key === 'Enter' &&
                    visible.reduce((n, group) => n + group.engines.length, 0) === 1
                  ) {
                    event.preventDefault()
                    onChange(visible[0].engines[0])
                    setOpen(false)
                  }
                }}
              />
            </label>
            <div className="database-engine-results" ref={results}>
              <ToggleGroup
                type="single"
                orientation="vertical"
                value={value}
                className="database-engine-options"
                aria-label="Available database engines"
                onValueChange={(engine) => {
                  if (engine) {
                    onChange(engine as Engine)
                    setOpen(false)
                  }
                }}
              >
                {visible.map((group) => (
                  <div
                    key={group.model}
                    className="database-engine-group"
                    role="group"
                    aria-label={group.label}
                  >
                    <div className="database-engine-group-label">{group.label}</div>
                    {group.engines.map((engine) => (
                      <ToggleGroupItem
                        key={engine}
                        value={engine}
                        className="database-engine-option"
                        aria-label={engineNames[engine]}
                        onClick={() => {
                          if (engine === value) setOpen(false)
                        }}
                      >
                        <span className="database-engine-icon">
                          <EngineIcon engine={engine} />
                        </span>
                        <span className="database-engine-name">{engineNames[engine]}</span>
                        {engine === value && <Check aria-hidden="true" className="database-engine-check" />}
                      </ToggleGroupItem>
                    ))}
                  </div>
                ))}
              </ToggleGroup>
              {!visible.length && (
                <p className="database-engine-empty" role="status">
                  No databases match “{search}”.
                </p>
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}
