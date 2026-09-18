import type { ConnectionProfile } from '@shared/contracts'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'
import { Button } from './ui/button'

export function MongoConnectionFields({
  profile,
  update,
}: {
  profile: ConnectionProfile
  update: (patch: Partial<ConnectionProfile>) => void
}) {
  const mongo = profile.mongo
  const patch = (value: Partial<ConnectionProfile['mongo']>) => update({ mongo: { ...mongo, ...value } })
  return (
    <>
      <Field>
        <FieldLabel>Authentication database</FieldLabel>
        <Input
          aria-label="MongoDB authentication database"
          value={mongo.authSource}
          onChange={(event) => patch({ authSource: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel>Replica set (optional)</FieldLabel>
        <Input
          aria-label="MongoDB replica set"
          value={mongo.replicaSet}
          onChange={(event) => patch({ replicaSet: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="mongo-mechanism">Authentication mechanism</FieldLabel>
        <select
          id="mongo-mechanism"
          value={mongo.authMechanism}
          onChange={(event) => patch({ authMechanism: event.target.value as typeof mongo.authMechanism })}
        >
          <option value="DEFAULT">Negotiate SCRAM</option>
          <option>SCRAM-SHA-256</option>
          <option>SCRAM-SHA-1</option>
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="mongo-read-preference">Read preference</FieldLabel>
        <select
          id="mongo-read-preference"
          value={mongo.readPreference}
          onChange={(event) => patch({ readPreference: event.target.value as typeof mongo.readPreference })}
        >
          {['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </Field>
      <label className="check-row">
        <input
          type="checkbox"
          checked={mongo.srv}
          onChange={(event) =>
            update({
              mongo: {
                ...mongo,
                srv: event.target.checked,
                directConnection: false,
                ...(event.target.checked ? { seeds: [] } : {}),
              },
              ...(event.target.checked
                ? { port: 27017, tls: { ...profile.tls, enabled: true, rejectUnauthorized: true } }
                : {}),
            })
          }
        />
        Use SRV discovery (MongoDB Atlas)
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          disabled={mongo.srv || mongo.seeds.length > 0}
          checked={mongo.directConnection}
          onChange={(event) => patch({ directConnection: event.target.checked })}
        />
        Direct connection to this host
      </label>
      {!mongo.srv && (
        <div className="full-field flex flex-col gap-2">
          <strong className="text-xs">Additional replica-set seeds</strong>
          {mongo.seeds.map((seed, index) => (
            <div className="flex items-center gap-2" key={index}>
              <Input
                aria-label={`MongoDB seed ${index + 1} host`}
                placeholder="replica.example.net"
                value={seed.host}
                onChange={(event) =>
                  patch({
                    seeds: mongo.seeds.map((item, i) =>
                      i === index ? { ...item, host: event.target.value } : item,
                    ),
                  })
                }
              />
              <Input
                aria-label={`MongoDB seed ${index + 1} port`}
                type="number"
                min={1}
                max={65535}
                value={seed.port}
                onChange={(event) =>
                  patch({
                    seeds: mongo.seeds.map((item, i) =>
                      i === index ? { ...item, port: Number(event.target.value) } : item,
                    ),
                  })
                }
              />
              <Button
                variant="ghost"
                aria-label={`Remove MongoDB seed ${index + 1}`}
                onClick={() => patch({ seeds: mongo.seeds.filter((_, i) => i !== index) })}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            disabled={mongo.seeds.length >= 10 || mongo.directConnection || profile.ssh.enabled}
            onClick={() => patch({ seeds: [...mongo.seeds, { host: '', port: 27017 }] })}
          >
            Add MongoDB seed
          </Button>
        </div>
      )}
      <p className="field-note full-field">
        {mongo.srv
          ? 'Use the SRV DNS hostname without a custom port. DNS discovers members; verified TLS remains required. Atlas is a MongoDB deployment, not another engine.'
          : 'The main Host/Port is the first seed. Discovered member addresses must be reachable from this laptop. Multiple seeds or discovery cannot traverse one SSH tunnel.'}{' '}
        {mongo.readPreference !== 'primary'
          ? 'Secondary reads can be stale. Writes still require a writable primary.'
          : 'Reads prefer the writable primary.'}{' '}
        Harbor does not replay reads or writes after failover. X.509, IAM, OIDC and managed Atlas
        administration are not available.
      </p>
    </>
  )
}
