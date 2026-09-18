import type { ConnectionProfile } from '@shared/contracts'
import { Field, FieldLabel } from './ui/field'
import { Input } from './ui/input'

export function AthenaConnectionFields({
  profile,
  update,
}: {
  profile: ConnectionProfile
  update: (value: Partial<ConnectionProfile>) => void
}) {
  const fields = {
    region: 'AWS region',
    catalog: 'Data catalog',
    workgroup: 'Workgroup',
    outputLocation: 'S3 result prefix (s3://bucket/prefix/)',
    expectedBucketOwner: 'Expected S3 bucket owner (12 digits)',
    maximumScannedBytes: 'Maximum scanned bytes per query',
  }
  return (
    <>
      {Object.entries(fields).map(([key, label]) => (
        <Field key={key}>
          <FieldLabel htmlFor={'athena-' + key}>{label}</FieldLabel>
          <Input
            id={'athena-' + key}
            value={profile.athena[key as keyof typeof fields]}
            onChange={(event) =>
              update({
                athena: { ...profile.athena, [key]: event.target.value },
                ...(key === 'region'
                  ? {
                      host: `athena.${event.target.value}.amazonaws.com${event.target.value.startsWith('cn-') ? '.cn' : ''}`,
                    }
                  : {}),
              })
            }
          />
        </Field>
      ))}
      <p className="field-note full-field">
        Supply credentials JSON with accessKeyId, secretAccessKey and optional sessionToken in the protected
        credential field. No ambient AWS account, login or automatic refresh is used. The selected workgroup
        must enforce the same encrypted S3 output prefix and owner, with a scan cutoff no greater than this
        budget. Harbor checks these settings but never changes them. This cutoff is not a monetary cap.
      </p>
      <p className="field-note full-field">
        Catalog browsing uses metadata APIs. Table opening creates an inert SQL draft. Every query requires
        review before SQL is sent to AWS; cancellation may arrive after writes, charges or S3 output. IAM and
        source-storage permissions remain authoritative. Real-service acceptance awaits an authorized
        disposable AWS account; protocol tests alone do not establish compatibility.
      </p>
    </>
  )
}
