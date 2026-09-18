import { useState } from 'react'
import type { ConnectionProfile } from '@shared/contracts'
import type { RedisTopologySnapshot } from '@shared/redis-topology'
import { api } from '../lib/api'
import { errorText } from '../lib/utils'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { ErrorPanel } from './common'

export function RedisTopologyPanel({
  profile,
  onClose,
}: {
  profile: ConnectionProfile
  onClose: () => void
}) {
  const [data, setData] = useState<RedisTopologySnapshot>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="dialog-wide">
        <DialogHeader>
          <DialogTitle>
            {profile.engine === 'valkey' ? 'Valkey' : 'Redis'} topology · {profile.name}
          </DialogTitle>
          <DialogDescription>
            Refresh explicitly to check the connected deployment. No keys or values are read by this view.
          </DialogDescription>
        </DialogHeader>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError('')
            try {
              setData(await api.redisTopology(profile.id))
            } catch (cause) {
              setError(errorText(cause))
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Checking…' : 'Refresh topology'}
        </Button>
        <ErrorPanel message={error} />
        {data && (
          <>
            <p>
              {data.mode} {data.serviceName ? `· ${data.serviceName}` : ''} · checked{' '}
              {new Date(data.checkedAt).toLocaleTimeString()}
            </p>
            <table className="structure-table">
              <thead>
                <tr>
                  <th>Advertised node</th>
                  <th>Role</th>
                  <th>Client ready</th>
                  <th>Slots</th>
                </tr>
              </thead>
              <tbody>
                {data.nodes.map((node) => (
                  <tr key={`${node.role}:${node.address}`}>
                    <td>{node.address}</td>
                    <td>{node.role}</td>
                    <td>{node.ready ? 'Yes' : 'No / not probed'}</td>
                    <td>{node.slots ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.limitations.map((text) => (
              <p className="field-note" key={text}>
                {text}
              </p>
            ))}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
