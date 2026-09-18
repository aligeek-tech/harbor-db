import type { ConnectionProfile } from '@shared/contracts'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'

export function BigQueryConnectionFields({ profile, update }: { profile: ConnectionProfile; update: (value: Partial<ConnectionProfile>) => void }) {
  return <>
    <Field><FieldLabel htmlFor="bigquery-location">BigQuery job location</FieldLabel><Input id="bigquery-location" value={profile.bigQuery.location} onChange={(event) => update({ bigQuery: { ...profile.bigQuery, location: event.target.value } })} /></Field>
    <Field><FieldLabel htmlFor="bigquery-bytes">Maximum billed bytes per job</FieldLabel><Input id="bigquery-bytes" inputMode="numeric" value={profile.bigQuery.maximumBytesBilled} onChange={(event) => update({ bigQuery: { ...profile.bigQuery, maximumBytesBilled: event.target.value } })} /></Field>
    <p className="field-note full-field">This workflow uses GoogleSQL and native query jobs. Supply an OAuth access token scoped for BigQuery and the chosen project. Verified TLS is required; no ambient credentials, automatic token refresh, SSH or provisioning. Browsing metadata does not submit queries. Running SQL and full export submit billable jobs after review. Cancellation is best effort and cannot undo completed writes or billing. Native service compatibility still requires a disposable authorized cloud project.</p>
  </>
}
