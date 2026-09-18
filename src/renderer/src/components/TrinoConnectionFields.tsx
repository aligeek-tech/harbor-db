import type { ConnectionProfile } from '@shared/contracts'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'

export function TrinoConnectionFields({ profile, update }: { profile: ConnectionProfile; update: (profile: Partial<ConnectionProfile>) => void }) {
  return <>
    <Field><FieldLabel htmlFor="trino-auth">Trino authentication</FieldLabel><select id="trino-auth" value={profile.trino.auth} onChange={(event) => update({ trino: { ...profile.trino, auth: event.target.value as ConnectionProfile['trino']['auth'] } })}>
      <option value="none">No authentication (local coordinator)</option><option value="basic">Username and password</option><option value="bearer">Bearer token</option>
    </select></Field>
    <Field><FieldLabel htmlFor="trino-timezone">Session time zone</FieldLabel><Input id="trino-timezone" value={profile.trino.timeZone} onChange={(event) => update({ trino: { ...profile.trino, timeZone: event.target.value } })} /></Field>
    <p className="field-note full-field">Choose a coordinator, session user and catalog. Passwords and tokens require verified TLS. Queries show native progress and stream direct result pages. Each connector controls permissions, costs and write semantics. Every write requires review; interactive transactions, row editing, browser OAuth and result spooling are unavailable. Use a restricted server account for read-only access.</p>
  </>
}
