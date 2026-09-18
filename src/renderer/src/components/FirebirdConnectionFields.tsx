import type { ConnectionProfile } from '@shared/contracts'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'

export function FirebirdConnectionFields({ profile, update }: { profile: ConnectionProfile; update: (value: Partial<ConnectionProfile>) => void }) {
  return <>
    <Field><FieldLabel htmlFor="firebird-mode">Firebird connection mode</FieldLabel><select id="firebird-mode" value={profile.firebird.mode} onChange={event => update({ firebird: { ...profile.firebird, mode: event.target.value as 'server' | 'local-file' }, ...(event.target.value === 'local-file' ? { host: '127.0.0.1', ssh: { ...profile.ssh, enabled: false } } : {}) })}><option value="server">Server database path or alias</option><option value="local-file">Local file served by loopback Firebird</option></select></Field>
    <Field><FieldLabel htmlFor="firebird-role">Firebird role (optional)</FieldLabel><Input id="firebird-role" value={profile.firebird.role} onChange={event => update({ firebird: { ...profile.firebird, role: event.target.value } })} /></Field>
    <p className="field-note full-field">Firebird 5.x with a pinned experimental pure Node wire driver. Database is an existing server path or alias; local-file mode still requires your local Firebird server. Harbor does not create, overwrite or open files through an embedded server. Direct connections are loopback only; remote connections require SSH with verified host trust. Native wire authentication is distinct from TLS.</p>
    <p className="field-note full-field">Catalogs, exact typed queries, per-tab transactions and bounded streaming export are supported. Fixed numbers and temporal fields are fetched as native server text to avoid driver rounding. No grid editing or parameter binding is advertised. Review writes explicitly; uncertain commit outcomes are never replayed.</p>
  </>
}
