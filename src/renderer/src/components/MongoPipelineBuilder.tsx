import { useState } from 'react'
import { parseMongoPipeline, renderMongoPipeline, type MongoPipelineStage } from '@shared/mongo-pipeline'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ErrorPanel } from './common'
import { errorText } from '../lib/utils'

export function MongoPipelineBuilder({
  source,
  disabled,
  onApply,
  onPending,
}: {
  source: string
  disabled: boolean
  onApply: (query: string) => void
  onPending: (pending: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [stages, setStages] = useState<MongoPipelineStage[]>([])
  const [error, setError] = useState('')
  let preview = '',
    invalid = ''
  try {
    preview = renderMongoPipeline(stages)
  } catch (failure) {
    invalid = errorText(failure)
  }
  function close() {
    setOpen(false)
    onPending(false)
  }
  function change(index: number, patch: Partial<MongoPipelineStage>) {
    setStages((current) => current.map((stage, at) => (at === index ? { ...stage, ...patch } : stage)))
  }
  function move(index: number, direction: -1 | 1) {
    setStages((current) => {
      const next = [...current]
      ;[next[index], next[index + direction]] = [next[index + direction], next[index]]
      return next
    })
  }
  return (
    <>
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setError('')
          try {
            setStages(parseMongoPipeline(source))
            setOpen(true)
            onPending(true)
          } catch (failure) {
            setError(errorText(failure))
          }
        }}
      >
        Build pipeline
      </Button>
      {error && <ErrorPanel message={error} />}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close()
        }}
      >
        <DialogContent className="mongo-tools-dialog">
          <DialogHeader>
            <DialogTitle>Aggregation pipeline builder</DialogTitle>
            <DialogDescription>
              Ordered read-only stages. Apply changes the query draft; Run query explicitly executes it.
              Disabled stages are omitted from the applied draft.
            </DialogDescription>
          </DialogHeader>
          <div className="mongo-tools-scroll">
            {stages.map((stage, index) => (
              <fieldset className="mongo-pipeline-stage" key={index}>
                <legend>Stage {index + 1}</legend>
                <div className="mongo-tools-row">
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`Enable stage ${index + 1}`}
                      checked={stage.enabled}
                      onChange={(event) => change(index, { enabled: event.target.checked })}
                    />{' '}
                    Enabled
                  </label>
                  <Input
                    aria-label={`Stage ${index + 1} operator`}
                    list="mongo-stage-operators"
                    value={stage.operator}
                    onChange={(event) => change(index, { operator: event.target.value })}
                  />
                  <Button
                    variant="ghost"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    aria-label={`Move stage ${index + 1} up`}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={index === stages.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={`Move stage ${index + 1} down`}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setStages((current) => current.filter((_, at) => at !== index))}
                    aria-label={`Remove stage ${index + 1}`}
                  >
                    Remove
                  </Button>
                </div>
                <textarea
                  className="mono"
                  rows={4}
                  spellCheck={false}
                  aria-label={`Stage ${index + 1} body`}
                  value={stage.body}
                  onChange={(event) => change(index, { body: event.target.value })}
                />
              </fieldset>
            ))}
            <datalist id="mongo-stage-operators">
              {[
                '$match',
                '$project',
                '$group',
                '$sort',
                '$limit',
                '$skip',
                '$unwind',
                '$lookup',
                '$addFields',
                '$set',
                '$unset',
                '$count',
                '$facet',
                '$replaceRoot',
              ].map((operator) => (
                <option key={operator} value={operator} />
              ))}
            </datalist>
            <Button
              variant="outline"
              disabled={stages.length >= 100}
              onClick={() =>
                setStages((current) => [...current, { operator: '$match', body: '{}', enabled: true }])
              }
            >
              Add stage
            </Button>
            <p className="field-note">
              At most 100 stages / 1 MB. Writes, change streams and server-side JavaScript are unavailable.
              The server validates other stages; disk spilling stays disabled and the query timeout applies.
            </p>
            {invalid ? (
              <ErrorPanel message={invalid} />
            ) : (
              <>
                <h4>Pipeline preview</h4>
                <pre className="mongo-tools-preview" aria-label="Pipeline preview">
                  {preview}
                </pre>
              </>
            )}
          </div>
          <div className="dialog-actions">
            <Button variant="outline" onClick={close}>
              Discard builder changes
            </Button>
            <Button
              disabled={!!invalid}
              onClick={() => {
                onApply(preview)
                close()
              }}
            >
              Apply pipeline draft
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
