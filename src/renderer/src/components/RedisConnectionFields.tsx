import type { ConnectionProfile } from '@shared/contracts'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'
import { Button } from './ui/button'

export function RedisConnectionFields({
  profile,
  update,
  sentinelPassword,
  setSentinelPassword,
}: {
  profile: ConnectionProfile
  update: (value: Partial<ConnectionProfile>) => void
  sentinelPassword: string
  setSentinelPassword: (value: string) => void
}) {
  const config = profile.redis
  const change = (value: Partial<ConnectionProfile['redis']>) => update({ redis: { ...config, ...value } })
  return (
    <>
      <Field>
        <FieldLabel htmlFor="redis-mode">Deployment</FieldLabel>
        <select
          id="redis-mode"
          value={config.mode}
          onChange={(e) =>
            update({
              redis: { ...config, mode: e.target.value as typeof config.mode },
              ...(e.target.value === 'cluster' ? { redisDb: 0 } : {}),
            })
          }
        >
          <option value="standalone">Standalone</option>
          <option value="cluster" disabled={profile.engine === 'valkey'}>
            Redis Cluster
          </option>
          <option value="sentinel" disabled={profile.engine === 'valkey'}>
            Redis Sentinel
          </option>
        </select>
        {profile.engine === 'valkey' && (
          <p className="field-note">
            Valkey standalone is available. Cluster and Sentinel need separate Valkey verification.
          </p>
        )}
      </Field>
      <Field>
        <FieldLabel htmlFor="connection-db">Logical database</FieldLabel>
        <Input
          id="connection-db"
          type="number"
          min={0}
          max={1024}
          disabled={config.mode === 'cluster'}
          value={profile.redisDb}
          onChange={(e) => update({ redisDb: Number(e.target.value) })}
        />
        {config.mode === 'cluster' && (
          <p className="field-note">Cluster uses database 0. Multi-key operations require one hash slot.</p>
        )}
      </Field>
      {config.mode !== 'standalone' && (
        <div className="full-field">
          <p className="field-note">
            Host and port above are the seed when this list is empty. Discovery connects to advertised nodes
            with this profile’s data credentials and TLS settings. Use endpoints you trust. Each node must be
            reachable directly; single-host SSH tunnels are unavailable.
          </p>
          {config.seeds.map((seed, index) => (
            <div className="toolbar" key={index}>
              <Input
                aria-label={`Discovery host ${index + 1}`}
                value={seed.host}
                onChange={(e) =>
                  change({
                    seeds: config.seeds.map((entry, i) =>
                      i === index ? { ...entry, host: e.target.value } : entry,
                    ),
                  })
                }
              />
              <Input
                aria-label={`Discovery port ${index + 1}`}
                type="number"
                value={seed.port}
                onChange={(e) =>
                  change({
                    seeds: config.seeds.map((entry, i) =>
                      i === index ? { ...entry, port: Number(e.target.value) } : entry,
                    ),
                  })
                }
              />
              <Button
                variant="ghost"
                onClick={() => change({ seeds: config.seeds.filter((_entry, i) => i !== index) })}
              >
                Remove seed {index + 1}
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            disabled={config.seeds.length >= 10}
            onClick={() => change({ seeds: [...config.seeds, { host: profile.host, port: profile.port }] })}
          >
            Add discovery seed
          </Button>
          <details>
            <summary>Node address mappings</summary>
            <p className="field-note">
              Map an advertised host:port to a reachable endpoint. TLS verifies the mapped hostname or IP, so
              its certificate must cover that identity.
            </p>
            {config.addressMap.map((entry, index) => (
              <div className="toolbar" key={index}>
                <Input
                  aria-label={`Advertised address ${index + 1}`}
                  placeholder="node.internal:6379"
                  value={entry.discovered}
                  onChange={(e) =>
                    change({
                      addressMap: config.addressMap.map((row, i) =>
                        i === index ? { ...row, discovered: e.target.value } : row,
                      ),
                    })
                  }
                />
                <Input
                  aria-label={`Mapped host ${index + 1}`}
                  value={entry.host}
                  onChange={(e) =>
                    change({
                      addressMap: config.addressMap.map((row, i) =>
                        i === index ? { ...row, host: e.target.value } : row,
                      ),
                    })
                  }
                />
                <Input
                  aria-label={`Mapped port ${index + 1}`}
                  type="number"
                  value={entry.port}
                  onChange={(e) =>
                    change({
                      addressMap: config.addressMap.map((row, i) =>
                        i === index ? { ...row, port: Number(e.target.value) } : row,
                      ),
                    })
                  }
                />
                <Button
                  variant="ghost"
                  onClick={() => change({ addressMap: config.addressMap.filter((_row, i) => i !== index) })}
                >
                  Remove mapping {index + 1}
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              disabled={config.addressMap.length >= 100}
              onClick={() =>
                change({
                  addressMap: [...config.addressMap, { discovered: '', host: 'localhost', port: 6379 }],
                })
              }
            >
              Add address mapping
            </Button>
          </details>
        </div>
      )}
      {config.mode === 'sentinel' && (
        <>
          <Field>
            <FieldLabel htmlFor="sentinel-service">Sentinel service name</FieldLabel>
            <Input
              id="sentinel-service"
              value={config.serviceName}
              onChange={(e) => change({ serviceName: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="sentinel-user">Sentinel ACL username</FieldLabel>
            <Input
              id="sentinel-user"
              value={config.sentinelUsername}
              onChange={(e) => change({ sentinelUsername: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="sentinel-password">
              Sentinel password {profile.hasSentinelPassword ? '· Saved' : ''}
            </FieldLabel>
            <Input
              id="sentinel-password"
              type="password"
              autoComplete="new-password"
              value={sentinelPassword}
              placeholder={
                profile.hasSentinelPassword
                  ? 'Leave blank to keep saved credential'
                  : 'Separate from the data-node password'
              }
              onChange={(e) => setSentinelPassword(e.target.value)}
            />
          </Field>
          <p className="field-note">
            Sentinel credentials authenticate discovery only. The regular username and password authenticate
            data nodes. Failed writes are never replayed after failover.
          </p>
        </>
      )}
    </>
  )
}
