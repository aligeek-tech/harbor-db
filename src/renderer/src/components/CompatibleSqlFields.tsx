import type { ConnectionProfile } from '@shared/contracts'
import { compatibleSqlPolicies, isCompatibleSqlEngine } from '@shared/compatible-sql'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'

export function CompatibleSqlFields({
  profile,
  update,
}: {
  profile: ConnectionProfile
  update: (change: Partial<ConnectionProfile>) => void
}) {
  if (!isCompatibleSqlEngine(profile.engine)) return null
  const policy = compatibleSqlPolicies[profile.engine]
  return (
    <div className="full-field space-y-3" aria-label="Compatible product settings">
      <p className="field-note">
        {policy.limitation} The selected product is checked on every new session. One explicit database or
        keyspace is required.
      </p>
      {profile.engine === 'redshift' && (
        <>
          <Field>
            <FieldLabel htmlFor="redshift-deployment">Redshift deployment</FieldLabel>
            <select
              id="redshift-deployment"
              value={profile.redshift.deployment}
              onChange={(event) =>
                update({
                  redshift: {
                    ...profile.redshift,
                    deployment: event.target.value as 'provisioned' | 'serverless',
                  },
                })
              }
            >
              <option value="provisioned">Provisioned warehouse</option>
              <option value="serverless">Serverless workgroup</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="redshift-authentication">Redshift database credential</FieldLabel>
            <select
              id="redshift-authentication"
              value={profile.redshift.authentication}
              onChange={(event) =>
                update({
                  redshift: {
                    ...profile.redshift,
                    authentication: event.target.value as 'password' | 'temporary-password',
                    expiresAt: '',
                  },
                })
              }
            >
              <option value="password">Database username and password</option>
              <option value="temporary-password">Cloud-issued database credentials already obtained</option>
            </select>
          </Field>
          {profile.redshift.authentication === 'temporary-password' && (
            <Field>
              <FieldLabel htmlFor="redshift-expiry">
                Credential expiry (UTC ISO timestamp ending in Z)
              </FieldLabel>
              <Input
                id="redshift-expiry"
                value={profile.redshift.expiresAt}
                placeholder="2026-09-18T18:00:00Z"
                onChange={(event) =>
                  update({ redshift: { ...profile.redshift, expiresAt: event.target.value } })
                }
              />
            </Field>
          )}
          <p className="field-note">
            Use the username and password fields for already-issued database credentials. AWS IAM login and
            credential renewal are unavailable. Running queries or exports can consume warehouse/serverless
            resources. Harbor does not resize or provision compute.
          </p>
        </>
      )}
    </div>
  )
}

export function CompatibleSqlContext({ profile }: { profile: ConnectionProfile }) {
  if (!isCompatibleSqlEngine(profile.engine)) return null
  return (
    <div
      className="px-3 py-1 text-xs text-muted-foreground"
      role="note"
      aria-label="Compatible product query context"
    >
      {compatibleSqlPolicies[profile.engine].name} · {profile.host}:{profile.port} · {profile.database}
      {profile.engine === 'redshift'
        ? ` · ${profile.redshift.deployment === 'serverless' ? 'Serverless workgroup' : 'Provisioned warehouse'} · Queries consume compute; IAM login unavailable`
        : ' · No statement or transaction is replayed automatically'}
    </div>
  )
}
