import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, Check, Copy, LoaderCircle, X } from 'lucide-react'
import { toast } from 'sonner'
import type { Engine } from '@shared/contracts'
import { api } from '../lib/api'
import { engineLogos } from '../lib/engine-logos'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
export function EngineIcon({ engine }: { engine: Engine }) {
  return (
    <img
      className={`engine-icon ${engine}`}
      src={engineLogos[engine]}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
export function IconButton({
  label,
  children,
  onClick,
  disabled,
  className = '',
}: {
  label: string
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}
export function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="error-panel" role="alert">
      <AlertCircle />
      <p>{message}</p>
    </div>
  )
}
export function Loading({ text = 'Loading…' }: { text?: string }) {
  return (
    <div className="center-empty" role="status">
      <LoaderCircle className="spin" />
      <p>{text}</p>
    </div>
  )
}
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <IconButton
      label={label}
      onClick={() =>
        void api
          .copyText(value)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1300)
          })
          .catch(() => toast.error('Clipboard is unavailable. Select and copy the value.'))
      }
    >
      {copied ? <Check /> : <Copy />}
    </IconButton>
  )
}
interface ConfirmOptions {
  title: string
  description: string
  label?: string
  typed?: string
  input?: boolean
  defaultValue?: string
  danger?: boolean
  detail?: string
}
const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<string | false>>(async () => false)
export const useConfirm = () => useContext(ConfirmContext)
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const [value, setValue] = useState('')
  const resolveRef = useRef<(value: string | false) => void>(() => {})
  const finish = (v: string | false) => {
    resolveRef.current(v)
    setOptions(null)
  }
  return (
    <ConfirmContext.Provider
      value={(o) =>
        new Promise((resolve) => {
          resolveRef.current = resolve
          setValue(o.defaultValue || '')
          setOptions(o)
        })
      }
    >
      {children}
      <Dialog
        open={!!options}
        onOpenChange={(open) => {
          if (!open) finish(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{options?.title}</DialogTitle>
            <DialogDescription>{options?.description}</DialogDescription>
          </DialogHeader>
          {options?.detail && (
            <pre className="mono max-h-48 overflow-auto whitespace-pre-wrap rounded-md border p-3">
              {options.detail}
            </pre>
          )}
          {(options?.typed || options?.input) && (
            <label className="flex flex-col gap-2">
              <span className="field-note">
                {options.typed ? `Type ${options.typed} to confirm` : 'Name'}
              </span>
              <Input
                autoFocus
                aria-label={options.typed ? 'Confirmation' : 'Name'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (!options.typed || value === options.typed))
                    finish(value || 'confirmed')
                }}
              />
            </label>
          )}
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => finish(false)}>
              <X />
              Cancel
            </Button>
            <Button
              variant={options?.danger ? 'destructive' : 'default'}
              disabled={options?.typed ? value !== options.typed : options?.input ? !value.trim() : false}
              onClick={() => finish(value || 'confirmed')}
            >
              {options?.label || 'Confirm'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  )
}
