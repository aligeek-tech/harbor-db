import { useState } from 'react'
import { FolderOpen, Pin, PinOff, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { workspaceSnapshotSchema, type WorkspaceSnapshot } from '@shared/workspaces'
import { useApp } from '../store'
import { errorText, uid } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { useConfirm } from './common'

export function WorkspaceManager() {
  const workspace = useApp((state) => state.workspace)
  const demo = useApp((state) => state.demo)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()
  const privateMode = workspace.settings.privateSession
  async function perform(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  async function switchTo(target: WorkspaceSnapshot) {
    const state = useApp.getState()
    if (Object.values(state.runtime).some((runtime) => runtime.running)) {
      toast.info('Cancel running operations before switching workspaces.')
      return
    }
    const staged = state.workspace.tabs.filter((tab) => state.runtime[tab.id]?.pendingEdits)
    const transactions = state.workspace.tabs.filter((tab) =>
      ['open', 'failed'].includes(state.runtime[tab.id]?.transaction || 'idle'),
    )
    if (
      (staged.length || transactions.length) &&
      !(await confirm({
        title: 'Review workspace switch',
        description: `Switching to ${target.name} discards staged changes in ${staged.map((tab) => tab.title).join(', ') || 'no tabs'} and rolls back open transactions in ${transactions.map((tab) => tab.title).join(', ') || 'no tabs'}. Query drafts are retained; results and runtime state are not.`,
        label: 'Discard changes and switch',
        danger: true,
      }))
    )
      return
    await perform(async () => {
      await useApp.getState().switchWorkspace(target, true)
      setName('')
      setOpen(false)
      toast.success(`Opened ${target.name}. Restored tabs have not executed queries.`)
    })
  }
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <FolderOpen />
        Workspaces
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value)
        }}
      >
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>Workspaces and tabs</DialogTitle>
            <DialogDescription>
              Named workspaces remember local drafts, tab names and layout. SQL text may contain sensitive
              values. Results, parameter values, credentials and transaction state are never included. Up to
              20 workspaces and 10 recently closed tabs per workspace; archived drafts are capped at 20 MiB.
            </DialogDescription>
          </DialogHeader>
          {privateMode && (
            <p className="hint-bar">
              Private session: workspace changes are unavailable. Reopened private tabs remain in memory until
              this private session ends.
            </p>
          )}
          {demo && <p className="hint-bar">Exit the example workspace before managing saved workspaces.</p>}
          <div className="flex items-center gap-2">
            <strong className="flex-1">Current: {workspace.name}</strong>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || privateMode || demo}
              onClick={() =>
                void perform(async () => {
                  const next = await confirm({
                    title: 'Rename workspace',
                    description: 'Change the local workspace name.',
                    input: true,
                    defaultValue: workspace.name,
                    label: 'Rename',
                  })
                  if (next !== false) await useApp.getState().renameWorkspace(next)
                })
              }
            >
              Rename workspace
            </Button>
          </div>
          <div className="max-h-48 overflow-auto divide-y divide-[var(--line)]">
            {workspace.archivedWorkspaces.map((snapshot) => (
              <div key={snapshot.id} className="flex items-center gap-2 py-2">
                <span className="flex-1">
                  {snapshot.name}
                  <small className="block muted">
                    {snapshot.tabs.length} tabs · {new Date(snapshot.updatedAt).toLocaleString()}
                  </small>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || privateMode || demo}
                  onClick={() => void switchTo(snapshot)}
                >
                  Open {snapshot.name}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || privateMode || demo}
                  onClick={() =>
                    void perform(async () => {
                      if (
                        await confirm({
                          title: 'Delete saved workspace?',
                          description: `Delete ${snapshot.name} and its stored drafts. Saved queries, profiles, and database data are unaffected.`,
                          label: 'Delete workspace',
                          danger: true,
                        })
                      )
                        await useApp.getState().deleteWorkspace(snapshot.id)
                    })
                  }
                >
                  Delete {snapshot.name}
                </Button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-label="New workspace name"
              maxLength={100}
              value={name}
              disabled={busy || privateMode || demo}
              onChange={(event) => setName(event.target.value)}
              placeholder="New workspace name"
            />
            <Button
              disabled={
                busy || privateMode || demo || !name.trim() || workspace.archivedWorkspaces.length >= 19
              }
              onClick={() =>
                void switchTo(
                  workspaceSnapshotSchema.parse({
                    id: uid(),
                    name: name.trim(),
                    updatedAt: new Date().toISOString(),
                    tabs: [],
                    activeTabId: null,
                    expanded: [],
                    recentlyClosed: [],
                  }),
                )
              }
            >
              Create and switch
            </Button>
          </div>
          <div className="max-h-60 overflow-auto">
            <h3 className="mb-2 font-medium">Open tabs</h3>
            {workspace.tabs.map((tab) => (
              <div key={tab.id} className="flex items-center gap-2 py-1">
                <Button
                  className="min-w-0 flex-1 justify-start truncate"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    useApp.getState().activate(tab.id)
                    useApp.getState().setSection('connections')
                    setOpen(false)
                  }}
                >
                  {tab.title}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`${tab.pinned ? 'Unpin' : 'Pin'} ${tab.title}`}
                  onClick={() => useApp.getState().updateTab(tab.id, { pinned: !tab.pinned })}
                >
                  {tab.pinned ? <PinOff /> : <Pin />}
                  {tab.pinned ? 'Unpin' : 'Pin'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Rename ${tab.title}`}
                  onClick={() =>
                    void perform(async () => {
                      const title = await confirm({
                        title: 'Rename tab',
                        description: 'Rename this tab without changing its query or database target.',
                        input: true,
                        defaultValue: tab.title,
                        label: 'Rename tab',
                      })
                      if (title !== false && title.trim())
                        useApp.getState().updateTab(tab.id, { title: title.trim().slice(0, 255) })
                    })
                  }
                >
                  Rename
                </Button>
              </div>
            ))}
            <h3 className="mt-3 mb-2 font-medium">Recently closed</h3>
            {!workspace.recentlyClosed.length && (
              <p className="muted text-xs">
                Closed tabs appear here. Reopening never restores a transaction or runs a query.
              </p>
            )}
            {workspace.recentlyClosed.map((tab) => (
              <Button
                className="m-1"
                variant="outline"
                size="sm"
                key={tab.id}
                disabled={busy || workspace.tabs.length >= 100}
                onClick={() => {
                  useApp.getState().reopenTab(tab.id)
                  setOpen(false)
                }}
              >
                <RotateCcw />
                Reopen {tab.title}
              </Button>
            ))}
          </div>
          <div className="dialog-actions">
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              {busy ? 'Saving workspace…' : 'Done'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
