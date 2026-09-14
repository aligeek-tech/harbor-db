import { useState } from 'react'
import { Database } from 'lucide-react'
import type { ConnectionProfile, WorkspaceTab } from '@shared/contracts'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { useApp } from '../store'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Field, FieldGroup, FieldLabel } from './ui/field'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ErrorPanel, Loading } from './common'

export function QueryDatabasePicker({ tab, profile }: { tab: WorkspaceTab; profile: ConnectionProfile }) {
  const [open, setOpen] = useState(false)
  const [databases, setDatabases] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  async function show() {
    setOpen(true)
    setError('')
    if (useApp.getState().statuses[profile.id]?.state !== 'connected') return
    setLoading(true)
    try {
      setDatabases(await api.listDatabases(profile.id))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setLoading(false)
    }
  }
  function choose(database: string) {
    const current = useApp.getState().workspace.tabs.find((item) => item.id === tab.id)
    if (!current || current.database || !database.trim()) return
    useApp.getState().updateTab(tab.id, { database })
    setOpen(false)
  }
  return (
    <>
      <Button variant="outline" onClick={() => void show()}>
        <Database data-icon="inline-start" />
        Choose database
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose database</DialogTitle>
            <DialogDescription>
              Choose the database for this query tab on {profile.name}. Open another tab to query a different
              database.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`query-database-${tab.id}`}>Database</FieldLabel>
              <Input
                id={`query-database-${tab.id}`}
                value={name}
                maxLength={255}
                placeholder="Enter a database name or select one below"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Button disabled={!name.trim()} onClick={() => choose(name)}>
              Use database
            </Button>
          </FieldGroup>
          {loading && <Loading text="Loading databases…" />}
          {error && <ErrorPanel message={error} />}
          <div className="flex max-h-64 flex-col gap-1 overflow-auto">
            {databases
              .filter((database) => database.toLowerCase().includes(name.toLowerCase()))
              .map((database) => (
                <Button
                  key={database}
                  variant="ghost"
                  className="justify-start"
                  onClick={() => choose(database)}
                >
                  <Database data-icon="inline-start" />
                  <span className="truncate">{database}</span>
                </Button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
