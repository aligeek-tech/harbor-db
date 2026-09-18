import type { ConnectionProfile } from '@shared/contracts'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'

export function OracleConnectionFields({
  profile,
  update,
}: {
  profile: ConnectionProfile
  update: (value: Partial<ConnectionProfile>) => void
}) {
  return (
    <>
      <Field className="full-field">
        <FieldLabel htmlFor="oracle-schema">Default schema (optional, exact case)</FieldLabel>
        <Input
          id="oracle-schema"
          value={profile.schema}
          onChange={(event) => update({ schema: event.target.value })}
          placeholder="Authenticated user's schema"
        />
      </Field>
      <p className="field-note full-field">
        Oracle Thin uses database username/password and one service per connection. SYSDBA, external
        authentication and Thick mode are unavailable. DDL commits implicitly; complete PL/SQL units require
        target confirmation.
      </p>
      <p className="field-note full-field">
        Table browsing preserves exact dates and nanoseconds with server text projections. In custom SQL, raw
        DATE/TIMESTAMP results require explicit TO_CHAR projections to preserve precision and timezone
        identity.
      </p>
    </>
  )
}
