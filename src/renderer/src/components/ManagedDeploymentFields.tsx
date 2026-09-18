import type { ConnectionProfile } from '@shared/contracts'
import {
  defaultManagedDeployment,
  managedPresets,
  managedPresetDefaults,
  type ManagedDeployment,
  type ManagedProfile,
  type ManagedProvider,
} from '@shared/managed-deployment'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'

export function ManagedDeploymentFields({
  profile,
  update,
}: {
  profile: ManagedProfile
  update: (change: Partial<ConnectionProfile> & { managed?: ManagedDeployment }) => void
}) {
  if (!['postgres', 'mysql', 'mssql'].includes(profile.engine)) return null
  const managed = profile.managed ?? defaultManagedDeployment
  const preset = managed.provider === 'none' ? undefined : managedPresets[managed.provider]
  const change = (value: Partial<ManagedDeployment>) => update({ managed: { ...managed, ...value } })
  return (
    <div className="full-field space-y-3" aria-label="Managed deployment settings">
      <Field>
        <FieldLabel htmlFor="managed-provider">Deployment preset</FieldLabel>
        <select
          id="managed-provider"
          className="input w-full"
          value={managed.provider}
          onChange={(event) => update(managedPresetDefaults(event.target.value as ManagedProvider, profile))}
        >
          <option value="none">Standard server</option>
          {Object.entries(managedPresets)
            .filter(([, value]) => value.engine === profile.engine)
            .map(([id, value]) => (
              <option key={id} value={id}>
                {value.name}
              </option>
            ))}
        </select>
      </Field>
      {preset && (
        <>
          <p className="text-xs text-muted-foreground">
            {preset.note} This preset is not a verified cloud-support badge.
          </p>
          <Field>
            <FieldLabel htmlFor="managed-endpoint">Endpoint mode</FieldLabel>
            <select
              id="managed-endpoint"
              className="input w-full"
              value={managed.endpoint}
              onChange={(event) => change({ endpoint: event.target.value as ManagedDeployment['endpoint'] })}
            >
              <option value="direct">Direct database endpoint</option>
              <option value="session" disabled={managed.provider !== 'supabase'}>
                Session pooler (Supabase)
              </option>
              <option value="transaction" disabled>
                Transaction pooler — unavailable
              </option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="managed-authentication">Database credential</FieldLabel>
            <select
              id="managed-authentication"
              className="input w-full"
              value={managed.authentication}
              onChange={(event) =>
                change({
                  authentication: event.target.value as ManagedDeployment['authentication'],
                  expiresAt: '',
                })
              }
            >
              <option value="password">Database password</option>
              <option value="temporary-password" disabled={profile.engine === 'mssql'}>
                Temporary database password already issued
              </option>
            </select>
          </Field>
          {managed.authentication === 'temporary-password' && (
            <Field>
              <FieldLabel htmlFor="managed-expiry">
                Credential expiry (UTC ISO timestamp ending in Z)
              </FieldLabel>
              <Input
                id="managed-expiry"
                value={managed.expiresAt}
                placeholder="2026-09-18T18:00:00Z"
                onChange={(event) => change({ expiresAt: event.target.value })}
              />
            </Field>
          )}
          <p className="text-xs text-muted-foreground">
            Enter the credential in the password field. TLS verification and one explicit database are
            required. Harbor does not acquire or refresh cloud identity tokens. Existing authenticated
            sessions may outlive credential expiry; fresh sessions require a valid credential. Reconnect
            explicitly after failover.
          </p>
        </>
      )}
    </div>
  )
}
