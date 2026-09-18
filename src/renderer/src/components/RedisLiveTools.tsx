import { useEffect, useRef, useState } from 'react'
import type { ConnectionProfile, RedisKey } from '@shared/contracts'
import type { RedisStreamGroups, RedisSubscription } from '@shared/redis-tools'
import { api } from '../lib/api'
import { displayCell, errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ErrorPanel } from './common'

export function RedisLiveTools({
  profile,
  selected,
  onClose,
}: {
  profile: ConnectionProfile
  selected: RedisKey | null
  onClose: () => void
}) {
  const [channel, setChannel] = useState('')
  const [seconds, setSeconds] = useState(30)
  const [capture, setCapture] = useState<RedisSubscription>()
  const [groups, setGroups] = useState<RedisStreamGroups>()
  const [group, setGroup] = useState('')
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const active = useRef<string | undefined>(undefined),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (active.current) void api.redisStopSubscription(active.current).catch(() => {})
    }
  }, [])
  useEffect(() => {
    if (capture?.state !== 'running') return
    let waiting = false
    const timer = setInterval(async () => {
      if (waiting) return
      waiting = true
      try {
        const next = await api.redisSubscription(capture.id)
        if (mounted.current) setCapture(next)
      } catch (cause) {
        if (mounted.current) setError(errorText(cause))
      } finally {
        waiting = false
      }
    }, 500)
    return () => clearInterval(timer)
  }, [capture?.id, capture?.state])
  const inspect = async (consumers: boolean) => {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      setGroups(
        await api.redisStreamGroups({
          connectionId: profile.id,
          keyBase64: selected.keyBase64,
          ...(consumers ? { group } : {}),
        }),
      )
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="dialog-wide">
        <DialogHeader>
          <DialogTitle>{profile.engine === 'valkey' ? 'Valkey' : 'Redis'} stream and live tools</DialogTitle>
          <DialogDescription>
            {profile.name} · {profile.redis.mode} · database {profile.redisDb}. Inspection does not
            acknowledge, claim, or publish messages.
          </DialogDescription>
        </DialogHeader>
        <ErrorPanel message={error} />
        <h3>Consumer groups</h3>
        <p>{selected?.type === 'stream' ? selected.key : 'Select a stream in the key browser first.'}</p>
        <div className="toolbar">
          <Button disabled={busy || selected?.type !== 'stream'} onClick={() => void inspect(false)}>
            Inspect groups
          </Button>
          <Input aria-label="Consumer group name" value={group} onChange={(e) => setGroup(e.target.value)} />
          <Button disabled={busy || !group || selected?.type !== 'stream'} onClick={() => void inspect(true)}>
            Inspect consumers
          </Button>
        </div>
        {groups && (
          <>
            <p>
              {groups.rows.length} {groups.kind}
              {groups.truncated ? ' · limited to 500' : ''}
            </p>
            <div style={{ maxHeight: 180, overflow: 'auto' }}>
              {groups.rows.map((row, index) => (
                <pre key={index} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {row.map((cell) => displayCell(cell)).join(' · ')}
                </pre>
              ))}
            </div>
          </>
        )}
        <h3>Bounded channel capture</h3>
        <p className="field-note">
          Explicit opt-in, one channel, maximum 60 seconds, 500 messages, 2 MiB. A message over 64 KiB stops
          capture before its full payload is read. Messages stay in memory. Disconnects and failover stop the
          capture; missed messages cannot be recovered. Closing this view stops it.
        </p>
        <div className="toolbar">
          <Input
            aria-label="Channel to capture"
            placeholder="channel-name"
            disabled={capture?.state === 'running'}
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          />
          <Input
            aria-label="Capture seconds"
            type="number"
            min={1}
            max={60}
            disabled={capture?.state === 'running'}
            value={seconds}
            onChange={(e) => setSeconds(Number(e.target.value))}
          />
          <Button
            disabled={busy || capture?.state === 'running' || !channel || seconds < 1 || seconds > 60}
            onClick={async () => {
              setBusy(true)
              setError('')
              try {
                const next = await api.redisSubscribe({ connectionId: profile.id, channel, seconds })
                if (!mounted.current) {
                  await api.redisStopSubscription(next.id)
                  return
                }
                active.current = next.id
                setCapture(next)
              } catch (cause) {
                if (mounted.current) setError(errorText(cause))
              } finally {
                if (mounted.current) setBusy(false)
              }
            }}
          >
            Start capture
          </Button>
          <Button
            disabled={capture?.state !== 'running'}
            onClick={async () => {
              if (capture) {
                try {
                  setCapture(await api.redisStopSubscription(capture.id))
                } catch (cause) {
                  setError(errorText(cause))
                }
              }
            }}
          >
            Stop capture
          </Button>
        </div>
        {capture && (
          <>
            <p role="status">
              {capture.state} · {capture.messages.length} messages · {capture.bytes} bytes. {capture.reason}
            </p>
            <div style={{ maxHeight: 240, overflow: 'auto' }}>
              {capture.messages.map((message) => (
                <pre key={message.sequence} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {message.sequence} · {message.at} · {displayCell(message.value)}
                </pre>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
