import type { ConnectionProfile } from '@shared/contracts'
import { Input } from './ui/input'
export function DynamoConnectionFields({
  profile,
  update,
  password,
  setPassword,
}: {
  profile: ConnectionProfile
  update: (value: Partial<ConnectionProfile>) => void
  password: string
  setPassword: (value: string) => void
}) {
  let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } = {
    accessKeyId: '',
    secretAccessKey: '',
  }
  try {
    if (password) credentials = JSON.parse(password)
  } catch {
    /* No saved credentials are exposed to the form. */
  }
  const set = (key: string, value: string) => {
    const next = { ...credentials, [key]: value }
    if (!next.sessionToken) delete next.sessionToken
    setPassword(JSON.stringify(next))
  }
  const configure = (region: string, local: boolean) =>
    update({
      dynamo: { ...profile.dynamo, region, local },
      host: local ? '127.0.0.1' : `dynamodb.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`,
      port: local ? 18000 : 443,
      tls: { enabled: !local, rejectUnauthorized: true, ca: '', cert: '', keyPath: '' },
      ssh: { ...profile.ssh, enabled: false },
    })
  return (
    <div className="full-field">
      <label>
        Service target
        <select
          aria-label="DynamoDB service target"
          value={profile.dynamo.local ? 'local' : 'aws'}
          onChange={(event) => configure(profile.dynamo.region, event.target.value === 'local')}
        >
          <option value="local">DynamoDB Local (loopback emulator)</option>
          <option value="aws">AWS regional service</option>
        </select>
      </label>
      <label>
        AWS region
        <Input
          aria-label="DynamoDB region"
          value={profile.dynamo.region}
          onChange={(event) => configure(event.target.value, profile.dynamo.local)}
        />
      </label>
      {!profile.dynamo.local && (
        <label>
          Expected AWS account ID
          <Input
            aria-label="DynamoDB account ID"
            value={profile.dynamo.accountId}
            onChange={(event) => update({ dynamo: { ...profile.dynamo, accountId: event.target.value } })}
          />
        </label>
      )}
      <label>
        Access key ID
        <Input
          aria-label="DynamoDB access key ID"
          autoComplete="off"
          value={credentials.accessKeyId}
          onChange={(event) => set('accessKeyId', event.target.value)}
        />
      </label>
      <label>
        Secret access key
        <Input
          aria-label="DynamoDB secret access key"
          type="password"
          autoComplete="new-password"
          value={credentials.secretAccessKey}
          onChange={(event) => set('secretAccessKey', event.target.value)}
        />
      </label>
      <label>
        Session token (optional)
        <Input
          aria-label="DynamoDB session token"
          type="password"
          autoComplete="new-password"
          value={credentials.sessionToken || ''}
          onChange={(event) => set('sessionToken', event.target.value)}
        />
      </label>
      <p>
        {profile.hasPassword
          ? 'Credentials saved. Leave all credential fields blank to retain them; enter the complete set when replacing. '
          : ''}
        Credentials are supplied explicitly. No AWS profile, environment or instance credentials are loaded.
        Query is the default; Scan requires explicit consent. Local credentials are required for signing but
        the emulator does not validate IAM permissions or billing capacity. AWS table account and region are
        checked before item operations.
      </p>
    </div>
  )
}
