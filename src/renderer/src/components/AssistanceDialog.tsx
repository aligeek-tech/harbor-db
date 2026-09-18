import { useState } from 'react'
import { CircleStop, Sparkles } from 'lucide-react'
import type {
  AssistancePreview,
  AssistanceResult,
  AssistanceTask,
} from '@shared/assistance'
import { assistanceEngineSchema } from '@shared/assistance'
import type { ConnectionProfile } from '@shared/contracts'
import { api } from '../lib/api'
import { errorText, uid } from '../lib/utils'
import { useApp } from '../store'
import { ErrorPanel, IconButton } from './common'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'

export function AssistanceDialog({
  profile,
  getQuery,
  onUseDraft,
}: {
  profile: ConnectionProfile
  getQuery: () => string
  onUseDraft: (sql: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [task, setTask] = useState<AssistanceTask>('explain')
  const [provider, setProvider] = useState<'ollama-local' | 'ollama-cloud'>('ollama-local')
  const [model, setModel] = useState('qwen2.5-coder:7b')
  const [preview, setPreview] = useState<AssistancePreview>()
  const [result, setResult] = useState<AssistanceResult>()
  const [apiKey, setApiKey] = useState('')
  const [remoteConsent, setRemoteConsent] = useState(false)
  const [requestId, setRequestId] = useState('')
  const [error, setError] = useState('')
  const objects = useApp((state) => state.objects[profile.id])
  const supportedEngine = assistanceEngineSchema.safeParse(profile.engine).success

  async function review() {
    setError('')
    setResult(undefined)
    try {
      setPreview(
        await api.previewAssistance({
          task,
          provider,
          model,
          engine: assistanceEngineSchema.parse(profile.engine),
          query: getQuery(),
          schemaFacts: (objects || []).slice(0, 200).map((object) => ({
            kind:
              object.kind === 'table' || object.kind === 'view'
                ? object.kind
                : object.kind === 'function'
                  ? 'routine'
                  : 'table',
            name: [object.schema, object.name].filter(Boolean).join('.'),
          })),
        }),
      )
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  async function run() {
    if (!preview) return
    const id = uid()
    setRequestId(id)
    setError('')
    setResult(undefined)
    try {
      setResult(
        await api.startAssistance({
          token: preview.token,
          requestId: id,
          ...(provider === 'ollama-cloud'
            ? { consentRemote: remoteConsent ? true : undefined, apiKey }
            : {}),
        }),
      )
      setPreview(undefined)
    } catch (failure) {
      setError(errorText(failure))
      setPreview(undefined)
    } finally {
      setRequestId('')
      setApiKey('')
    }
  }

  function reset() {
    setPreview(undefined)
    setResult(undefined)
    setApiKey('')
    setRemoteConsent(false)
    setError('')
  }

  if (!supportedEngine) return null

  return (
    <>
      <IconButton
        label="Review opt-in database assistance"
        onClick={() => {
          reset()
          setOpen(true)
        }}
      >
        <Sparkles />
      </IconButton>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!requestId) {
            setOpen(next)
            if (!next) reset()
          }
        }}
      >
        <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Opt-in database assistance</DialogTitle>
            <DialogDescription>
              Review the exact outbound request before sending it to Ollama. Harbor excludes row data,
              parameter values, credentials, local paths, and query results as separate attachments. SQL
              and schema text may itself contain sensitive literals, comments, identifiers, or paths;
              inspect the exact preview. Suggestions are inert drafts and are never executed automatically.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="text-sm">
              Task
              <select
                className="mt-1 w-full"
                value={task}
                disabled={!!requestId}
                onChange={(event) => {
                  setTask(event.target.value as AssistanceTask)
                  setPreview(undefined)
                }}
              >
                <option value="explain">Explain SQL</option>
                <option value="generate">Generate SQL draft</option>
                <option value="diagnose">Diagnose SQL</option>
              </select>
            </label>
            <label className="text-sm">
              Provider
              <select
                className="mt-1 w-full"
                value={provider}
                disabled={!!requestId}
                onChange={(event) => {
                  setProvider(event.target.value as typeof provider)
                  setPreview(undefined)
                  setApiKey('')
                  setRemoteConsent(false)
                }}
              >
                <option value="ollama-local">Local Ollama</option>
                <option value="ollama-cloud">Ollama cloud</option>
              </select>
            </label>
            <label className="text-sm">
              Model
              <Input
                className="mt-1"
                value={model}
                disabled={!!requestId}
                onChange={(event) => {
                  setModel(event.target.value)
                  setPreview(undefined)
                }}
              />
            </label>
          </div>

          {!preview && !result && (
            <div className="flex items-center gap-2">
              <Button disabled={!!requestId} onClick={() => void review()}>
                Review exact request
              </Button>
              <span className="text-xs text-muted-foreground">
                Local uses 127.0.0.1:11434. Cloud is sent directly to ollama.com only after consent.
              </span>
            </div>
          )}

          {preview && (
            <div className="min-h-0 flex-1 space-y-3 overflow-auto">
              <div className="rounded border p-3 text-sm">
                <strong>Destination:</strong> {preview.endpoint}
                <br />
                <strong>Scope:</strong> {preview.scope.queryCharacters} query/prompt characters and{' '}
                {preview.scope.schemaItems} schema items; no separate row, parameter, credential, path, or
                result attachments. SQL/schema text is included exactly as previewed after best-effort
                redaction.
                <br />
                <strong>Preview expires:</strong> {new Date(preview.expiresAt).toLocaleString()}
              </div>
              {preview.warnings.map((warning) => (
                <p className="text-xs" key={warning}>
                  {warning}
                </p>
              ))}
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border p-3 text-xs">
                {JSON.stringify(preview.request, null, 2)}
              </pre>
              {provider === 'ollama-cloud' && (
                <div className="space-y-2 rounded border p-3">
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={remoteConsent}
                      onChange={(event) => setRemoteConsent(event.target.checked)}
                    />
                    Send this exact reviewed request to Ollama cloud. Database content will leave this
                    device under Ollama's terms and retention controls.
                  </label>
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder="Session-only Ollama API key"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  disabled={!!requestId || (provider === 'ollama-cloud' && (!remoteConsent || !apiKey))}
                  onClick={() => void run()}
                >
                  Send reviewed request
                </Button>
                <Button variant="outline" disabled={!!requestId} onClick={() => setPreview(undefined)}>
                  Change scope
                </Button>
                {!!requestId && (
                  <Button
                    variant="destructive"
                    onClick={() => void api.cancelAssistance({ requestId })}
                  >
                    <CircleStop /> Cancel assistance
                  </Button>
                )}
              </div>
            </div>
          )}

          {error && <ErrorPanel message={error} />}
          {result && (
            <div className="min-h-0 flex-1 space-y-3 overflow-auto">
              <div className="rounded border p-3 text-sm">{result.suggestion.summary}</div>
              {!!result.suggestion.risks.length && (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {result.suggestion.risks.map((risk) => <li key={risk}>{risk}</li>)}
                </ul>
              )}
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border p-3 text-xs">
                {result.suggestion.sql || '-- The provider did not suggest SQL.'}
              </pre>
              <div className="flex gap-2">
                <Button
                  disabled={!result.suggestion.sql}
                  onClick={() => {
                    onUseDraft(result.suggestion.sql)
                    setOpen(false)
                    reset()
                  }}
                >
                  Replace editor with inert draft
                </Button>
                <Button variant="outline" onClick={reset}>Start another review</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
