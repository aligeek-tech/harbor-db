import { FirebirdConnectionFields } from './FirebirdConnectionFields'
import { WarehouseConnectionFields } from './WarehouseConnectionFields'
import { AthenaConnectionFields } from './AthenaConnectionFields'
import { isCloudWarehouse } from '@shared/warehouses'
import { DynamoConnectionFields } from './DynamoConnectionFields'
import { OracleConnectionFields } from './OracleConnectionFields'
import { BigQueryConnectionFields } from './BigQueryConnectionFields'
import { TrinoConnectionFields } from './TrinoConnectionFields'
import { Db2Context } from './Db2Context'
import { ManagedDeploymentFields } from './ManagedDeploymentFields'
import { CompatibleSqlFields } from './CompatibleSqlFields'
import { defaultManagedDeployment } from '@shared/managed-deployment'
import { isCompatibleSqlEngine } from '@shared/compatible-sql'
import { isKeyValueEngine } from '@shared/key-value'
import { LocalDatabaseFields } from './LocalDatabaseFields'
import { MongoConnectionFields } from './MongoConnectionFields'
import { RedisConnectionFields } from './RedisConnectionFields'
import { useState } from 'react'
import { CheckCircle2, Link, LoaderCircle, LockKeyhole, Plug, Save, Shield, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { profileSchema, type ConnectionProfile, type Engine, type SaveProfileInput } from '@shared/contracts'
import { connectionDiagnostic, redactConnectionMessage } from '@shared/connection-guidance'
import { useApp } from '../store'
import { api, isDesktop } from '../lib/api'
import { engineNames, enginePorts, errorText, newProfile, parseConnectionUrl } from '../lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
import { Field, FieldGroup, FieldLabel } from './ui/field'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { DatabaseEnginePicker } from './DatabaseEnginePicker'
import { useConfirm } from './common'

export function ConnectionDialog({ initial, onClose }: { initial?: ConnectionProfile; onClose: () => void }) {
  const [profile, setProfile] = useState(initial || { ...newProfile(), database: '' })
  const [password, setPassword] = useState('')
  const [sentinelPassword, setSentinelPassword] = useState('')
  const [sshPassword, setSshPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [remember, setRemember] = useState(
    !!(initial?.hasPassword || initial?.hasSshPassword || initial?.hasPassphrase || initial?.hasSentinelPassword),
  )
  const [url, setUrl] = useState('')
  const [urlPreview, setUrlPreview] = useState('')
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const secure = useApp((s) => s.secureStorage)
  const sqlite = profile.engine === 'sqlite'
  const local = sqlite || profile.engine === 'duckdb'
  const search = ['elasticsearch', 'opensearch'].includes(profile.engine)
  const vector = ['qdrant', 'milvus', 'weaviate', 'pinecone'].includes(profile.engine)
  const localOptions = sqlite ? profile.sqlite : profile.duckdb
  const creatingFile = local && localOptions.mode === 'create'
  const safeFeedback = feedback
    ? redactConnectionMessage(feedback.text, [password, sshPassword, passphrase, sentinelPassword, url])
    : ''
  const diagnostic = feedback && !feedback.ok ? connectionDiagnostic(safeFeedback) : null
  const confirm = useConfirm()
  const update = (partial: Partial<ConnectionProfile>) => {
    setProfile((p) => ({ ...p, ...partial }))
    setFeedback(null)
  }
  const field = (
    key: 'name' | 'host' | 'username' | 'database' | 'schema' | 'folder' | 'color' | 'notes',
    label: string,
    extra?: { placeholder?: string; full?: boolean },
  ) => (
    <Field className={extra?.full ? 'full-field' : ''}>
      <FieldLabel htmlFor={`connection-${key}`}>{label}</FieldLabel>
      <Input
        id={`connection-${key}`}
        value={profile[key]}
        placeholder={extra?.placeholder}
        onChange={(e) => update({ [key]: e.target.value })}
      />
    </Field>
  )
  const payload = (): SaveProfileInput => ({
    profile: profileSchema.parse(creatingFile ? { ...profile, autoReconnect: false } : profile),
    secrets: local
      ? undefined
      : {
          ...(password ? { password } : {}),
          ...(sshPassword ? { sshPassword } : {}),
          ...(passphrase ? { passphrase } : {}),
          ...(isKeyValueEngine(profile.engine) && profile.redis.mode === 'sentinel' && sentinelPassword ? { sentinelPassword } : {}),
        },
    rememberPassword: local ? false : remember,
  })
  async function action(kind: 'test' | 'save' | 'connect') {
    setFeedback(null)
    setBusy(kind)
    try {
      const input = payload()
      if (creatingFile) {
        if (kind !== 'connect')
          throw new Error(
            'Choose Save and create to create a new local database file. Testing or saving a profile does not create files.',
          )
        if (!localOptions.path.trim()) throw new Error('Choose a new local database file first.')
        if (profile.readOnly) throw new Error('Creating a local database file requires writes to be enabled.')
        if (
          !(await confirm({
            title: `Create this ${engineNames[profile.engine]} database?`,
            description:
              'A new empty local database file will be created. Existing files will not be overwritten.',
            detail: localOptions.path,
            label: 'Create database',
          }))
        )
          return
      }
      if (kind !== 'test' && initial) {
        const state = useApp.getState()
        const related = state.workspace.tabs
          .filter((t) => t.connectionId === initial.id)
          .map((t) => state.runtime[t.id])
        if (related.some((r) => r?.running)) {
          setFeedback({
            ok: false,
            text: 'Wait for running operations or cancel them before editing this connection.',
          })
          return
        }
        if (related.some((r) => r?.pendingEdits)) {
          setFeedback({
            ok: false,
            text: 'Apply or discard staged changes in related tabs before editing this connection.',
          })
          return
        }
        if (related.some((r) => r?.transaction && r.transaction !== 'idle')) {
          if (
            !(await confirm({
              title: 'Roll back open transactions?',
              description: `Saving connection settings for ${initial.name} closes its database sessions and rolls back open transactions.`,
              label: 'Roll back and save',
              danger: true,
            }))
          )
            return
        }
      }
      if (!input.profile.readOnly && initial?.readOnly) {
        const okay = await confirm({
          title: 'Enable writes for this connection?',
          description: `${profile.name} · ${local ? localOptions.path : `${profile.host}:${profile.port}`} · ${isKeyValueEngine(profile.engine) ? `${engineNames[profile.engine]} DB ${profile.redisDb}` : profile.database || (local ? 'main' : 'No default database')} · ${profile.environment}. Queries and edits can change data. ${local ? 'File-system permissions remain the security boundary.' : 'Use restricted database credentials for a security boundary.'}`,
          label: 'Enable writes',
          typed: profile.environment === 'production' ? profile.name : undefined,
          danger: true,
        })
        if (!okay) return
      }
      if (kind === 'test') {
        const status = await api.testConnection(input)
        setFeedback({
          ok: status.state === 'connected',
          text:
            status.state === 'connected'
              ? `Connection successful · ${status.version || engineNames[profile.engine]} · ${Math.round(status.durationMs || 0)} ms\n${status.transport || 'Direct connection'}`
              : `Connection failed: ${status.error || 'Could not connect to the server.'}`,
        })
        return
      }
      const saved = await api.saveProfile(input)
      await useApp.getState().refreshMetadata()
      useApp.getState().setStatus(saved.id, await api.status(saved.id))
      useApp.getState().selectConnection(saved.id)
      if (kind === 'connect') {
        useApp.getState().setStatus(saved.id, { state: 'connecting' })
        try {
          const status = await api.connect({ id: saved.id, secrets: input.secrets })
          useApp.getState().setStatus(saved.id, status)
          if (status.state !== 'connected') {
            setProfile(saved)
            setFeedback({
              ok: false,
              text: `Profile saved. Connection failed: ${status.error || 'Could not connect to the server.'}`,
            })
            return
          }
        } catch (e) {
          useApp.getState().setStatus(saved.id, { state: 'failed', error: errorText(e) })
          setProfile(saved)
          setFeedback({ ok: false, text: `Profile saved. Connection failed: ${errorText(e)}` })
          return
        }
      }
      toast.success(kind === 'connect' ? `Connected to ${saved.name}` : 'Connection saved')
      if (local && kind === 'connect') await useApp.getState().refreshMetadata()
      onClose()
    } catch (e) {
      setFeedback({ ok: false, text: errorText(e) })
    } finally {
      setBusy('')
    }
  }
  function switchEngine(engine: Engine) {
    setSentinelPassword('')
    setPassword('')
    setSshPassword('')
    setPassphrase('')
    setRemember(false)
    setUrl('')
    setUrlPreview('')
    update({
      ...(Object.values(engineNames).some((n) => profile.name === `New ${n}`)
        ? { name: `New ${engineNames[engine]}` }
        : {}),
      engine,
      managed: { ...defaultManagedDeployment },
      ...(isCompatibleSqlEngine(engine) || engine === 'db2' ? { autoReconnect: false, readOnly: true } : {}),
      ...(['redshift','db2'].includes(engine) ? { tls: { ...profile.tls, enabled: true, rejectUnauthorized: true } } : {}),
      ...(engine === 'pinecone' ? { host: 'api.pinecone.io', tls: { ...profile.tls, enabled: true, rejectUnauthorized: true } } : {}),
      ...(['influxdb','questdb'].includes(engine) ? {autoReconnect:false,readOnly:true} : {}),
      ...(engine === 'dynamodb' ? {host:'127.0.0.1',dynamo:{region:'us-east-1',accountId:'',local:true},tls:{...profile.tls,enabled:false},ssh:{...profile.ssh,enabled:false}} : {}),
      port: enginePorts[engine],
      ...(engine === 'trino' ? { database: '', schema: '', trino: { auth: 'none' as const, timeZone: 'UTC' } } : {}),
      ...(engine === 'valkey' ? { redis: { ...profile.redis, mode: 'standalone' as const } } : {}),
      username: engine === 'cassandra' ? 'cassandra' : engine === 'neo4j' ? 'neo4j' : engine === 'elasticsearch' ? 'elastic' : engine === 'opensearch' ? 'admin' : engine === 'clickhouse' ? 'default' : ['db2','influxdb','questdb','redis', 'valkey', 'mongodb', 'sqlite', 'duckdb', 'mssql', 'trino', 'oracle'].includes(engine)
        ? ''
        : engine === 'postgres'
          ? 'postgres'
          : 'root',
      database: engine === 'neo4j' ? 'neo4j' : engine === 'oracle' ? 'FREEPDB1' : engine === 'clickhouse' ? 'default' : '',
      schema:
        engine === 'postgres'
          ? 'public'
          : engine === 'mssql'
            ? 'dbo'
            : ['sqlite', 'duckdb'].includes(engine)
              ? 'main'
              : engine === 'clickhouse' ? 'default' : '',
      ...(['elasticsearch', 'opensearch'].includes(engine) ? { search: { auth: 'basic', pathPrefix: '' }, tls: { ...profile.tls, enabled: true, rejectUnauthorized: true } } : {}),
      ...(['snowflake','databricks'].includes(engine) ? { host: '', username: '', tls: { ...profile.tls, enabled: true, rejectUnauthorized: true }, ssh: { ...profile.ssh, enabled: false }, warehouse: { warehouse: '', role: '', snowflakeTokenType: 'OAUTH' as const } } : {}),
      ...(engine === 'hana' ? { host: '', username: '', database: '', schema: '', tls: { ...profile.tls, enabled: true, rejectUnauthorized: true } } : {}),
      ...(engine === 'firebird' ? { host: '127.0.0.1', username: '', schema: '', tls: { ...profile.tls, enabled: false } } : {}),
      ...(engine === 'athena' ? { host: 'athena.us-east-1.amazonaws.com', username: '', schema: '', tls: { ...profile.tls, enabled: true, rejectUnauthorized: true }, ssh: { ...profile.ssh, enabled: false } } : {}),
      ...(engine === 'bigquery' ? { host: 'bigquery.googleapis.com', username: '', tls: { ...profile.tls, enabled: true, rejectUnauthorized: true }, ssh: { ...profile.ssh, enabled: false } } : {}),
      ...(engine === 'mssql' ? { tls: { ...profile.tls, enabled: true, rejectUnauthorized: true } } : {}),
      ...(['sqlite', 'duckdb'].includes(engine)
        ? {
            tls: { ...profile.tls, enabled: false, keyPath: '' },
            ssh: { ...profile.ssh, enabled: false, privateKeyPath: '' },
          }
        : {}),
    })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="connection-dialog">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit connection' : 'New connection'}</DialogTitle>
          <DialogDescription>
            A direct connection to your database. Your workspace stays on this computer.
          </DialogDescription>
        </DialogHeader>
        <DatabaseEnginePicker value={profile.engine} onChange={switchEngine} disabled={!!busy} />
        {!local && !search && !vector && !isCompatibleSqlEngine(profile.engine) && !['cassandra','db2','influxdb', 'questdb', 'dynamodb', 'valkey', 'trino', 'bigquery', 'oracle', 'snowflake', 'databricks', 'athena', 'couchdb', 'firebird', 'neo4j', 'hana'].includes(profile.engine) && (
          <details>
            <summary className="field-note cursor-pointer">Use a connection URL</summary>
            <div className="connection-url mt-3">
              <Input
                type="password"
                autoComplete="off"
                aria-label="Connection URL"
                placeholder={
                  isKeyValueEngine(profile.engine)
                    ? 'redis://user:password@localhost:6379/0'
                    : profile.engine === 'mongodb'
                      ? 'mongodb://user:password@localhost:27017/database?authSource=admin'
                      : 'postgresql://user:password@localhost:5432/database'
                }
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <Button
                variant="outline"
                disabled={!url}
                onClick={() => {
                  try {
                    const parsed = parseConnectionUrl(url)
                    update(parsed.profile)
                    setPassword(parsed.password || '')
                    setUrlPreview(
                      `${engineNames[parsed.profile.engine!]} · ${parsed.profile.host}:${parsed.profile.port} · ${isKeyValueEngine(parsed.profile.engine!) ? `DB ${parsed.profile.redisDb}` : parsed.profile.database || 'No default database'} · ${parsed.password ? 'Password supplied (hidden)' : 'No password supplied'} · ${parsed.profile.tls?.enabled ? 'TLS with certificate verification' : 'Direct connection without TLS'}`,
                    )
                    setUrl('')
                    toast.success('URL parsed. Review the fields below.')
                  } catch (e) {
                    setFeedback({ ok: false, text: errorText(e) })
                  }
                }}
              >
                <Link />
                Parse
              </Button>
            </div>
            {urlPreview && (
              <p className="field-note" role="status" aria-label="Parsed connection URL preview">
                {urlPreview}. Review all fields before saving or connecting.
              </p>
            )}
          </details>
        )}
        <FieldGroup className="form-grid">
          {field('name', 'Connection name', { full: true, placeholder: 'My local database' })}
          <ManagedDeploymentFields profile={profile} update={update} />
          <CompatibleSqlFields profile={profile} update={update} />
          <Db2Context profile={profile} />
          {profile.engine === 'db2' && field('schema', 'Schema', { placeholder: 'Required schema' })}
          {local ? (
            <LocalDatabaseFields
              profile={profile}
              update={update}
              onError={(text) => setFeedback({ ok: false, text })}
            />
          ) : (
            <>
              {field('host', 'Host', { placeholder: 'localhost' })}
              <Field>
                <FieldLabel htmlFor="connection-port">Port</FieldLabel>
                <Input
                  id="connection-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={profile.port}
                  onChange={(e) => update({ port: Number(e.target.value) })}
                />
              </Field>
              {search && <>
                <Field><FieldLabel htmlFor="search-auth">Search authentication</FieldLabel><select id="search-auth" value={profile.search.auth} onChange={(e) => update({ search: { ...profile.search, auth: e.target.value as 'none' | 'basic' | 'api-key' } })}><option value="basic">Username and password</option>{profile.engine === 'elasticsearch' && <option value="api-key">Encoded Elasticsearch API key</option>}<option value="none">No authentication</option></select></Field>
                <Field><FieldLabel htmlFor="search-prefix">Proxy path prefix (optional)</FieldLabel><Input id="search-prefix" value={profile.search.pathPrefix} placeholder="/search" onChange={(e) => update({ search: { ...profile.search, pathPrefix: e.target.value } })} /></Field>
                <p className="field-note full-field">The endpoint must identify the selected product. Identity checks need cluster monitor permission; index reads and writes use the account’s own permissions. Managed AWS signing and cloud-ID discovery are unavailable.</p>
              </>}
              {vector && <>
                <Field><FieldLabel htmlFor="vector-prefix">API path prefix (optional)</FieldLabel><Input id="vector-prefix" value={profile.search.pathPrefix} placeholder="/proxy" onChange={(e) => update({ search: { ...profile.search, pathPrefix: e.target.value } })} /></Field>
                <p className="field-note full-field">Credentials are session-only unless secure storage is explicitly enabled. Pinecone requires a project-scoped API key and HTTPS; Qdrant, Milvus and Weaviate keys/tokens depend on server configuration. Use least-privilege credentials.</p>
              </>}
              {!['influxdb','dynamodb'].includes(profile.engine) && !vector && !isCloudWarehouse(profile.engine) && (!search || profile.search.auth === 'basic') && field('username', isKeyValueEngine(profile.engine) ? 'ACL username (optional)' : 'Username')}
              {profile.engine !== 'dynamodb' && (!search || profile.search.auth !== 'none') && (profile.engine !== 'trino' || profile.trino.auth !== 'none') && <Field>
                <FieldLabel htmlFor="connection-password">
                  {profile.engine === 'influxdb' ? 'InfluxDB API token' : vector ? 'API key or bearer token' : profile.engine === 'athena' ? 'AWS credentials JSON' : isCloudWarehouse(profile.engine) ? 'Provider access token' : profile.engine === 'trino' && profile.trino.auth === 'bearer' ? 'Bearer token' : search && profile.search.auth === 'api-key' ? 'Encoded API key' : 'Password'} {initial?.hasPassword && <span className="success">· Credential saved</span>}
                </FieldLabel>
                <Input
                  id="connection-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  placeholder={initial?.hasPassword ? 'Leave blank to keep saved password' : 'Enter password'}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    setFeedback(null)
                  }}
                />
              </Field>}
              {isKeyValueEngine(profile.engine) ? (
                <RedisConnectionFields profile={profile} update={update} sentinelPassword={sentinelPassword} setSentinelPassword={setSentinelPassword} />
              ) : !search && !['dynamodb','influxdb','questdb'].includes(profile.engine) ? (
                <Field>
                  <FieldLabel htmlFor="connection-database">{profile.engine === 'cassandra' ? 'Keyspace' : profile.engine === 'firebird' ? 'Database alias or server file path' : profile.engine === 'oracle' ? 'Service name' : profile.engine === 'bigquery' ? 'Billing project' : ['trino', 'databricks'].includes(profile.engine) ? 'Catalog' : 'Database'}</FieldLabel>
                  <Input
                    id="connection-database"
                    value={profile.database}
                    onChange={(e) => update({ database: e.target.value })}
                    placeholder={profile.engine === 'db2' || isCompatibleSqlEngine(profile.engine) || profile.managed.provider !== 'none' ? 'Required database or keyspace' : profile.engine === 'hana' ? 'Exact tenant database name' : profile.engine === 'neo4j' ? 'neo4j' : profile.engine === 'oracle' ? 'FREEPDB1' : 'Optional — browse available databases'}
                  />
                  {profile.managed.provider === 'none' && ['mariadb', 'mysql'].includes(profile.engine) && (
                    <p className="field-note">
                      Leave blank to browse databases available to this account. Set a default to use
                      unqualified table names in queries.
                    </p>
                  )}
                  {profile.managed.provider === 'none' && ['postgres', 'mssql'].includes(profile.engine) && (
                    <p className="field-note">
                      Leave blank to browse databases available to this account. Choose a database in the
                      explorer for your tables and queries, or set a default here.
                    </p>
                  )}
                  {profile.engine === 'mssql' && (
                    <p className="field-note">
                      SQL authentication with username/password. Integrated Windows and Entra authentication
                      are not available. T-SQL batches run without client GO separators. Use restricted SQL
                      Server permissions for enforced read-only access.
                    </p>
                  )}
                </Field>
              ) : null}
              {vector && <p className="field-note">Milvus uses Database as dbName (default: default). Other vector providers discover collections/indexes.</p>}
              {['snowflake', 'databricks'].includes(profile.engine) && <WarehouseConnectionFields profile={profile} update={update} />}
              {profile.engine === 'oracle' && <OracleConnectionFields profile={profile} update={update} />}
              {profile.engine === 'firebird' && <FirebirdConnectionFields profile={profile} update={update} />}
              {profile.engine === 'neo4j' && <p>Neo4j 5.26.x · direct Bolt · explicit user database. Typed Cypher and bounded graph results run only on request. Mutations require review; no retries. TLS verifies host and certificate. Routing clusters, Aura, client certificates and combined SSH+TLS are not enabled.</p>}
              {profile.engine === 'hana' && <p>SAP HANA · direct tenant SQL endpoint · explicit database name verified on each tab. Username/password only. Native catalog and column metadata, bounded SQL and read-only export; reviewed writes use autocommit. Cancel closes this tab connection and cannot confirm server rollback. No transparent reconnect, cloud routing, parameter binding, grid editing or interactive transactions. Real HANA target verification is pending.</p>}
              {profile.engine === 'couchdb' && <p>CouchDB 3.5.x · Basic authentication · exact database names. Mango selectors run explicitly with bounded pages; document writes require revision review. TLS requires certificate verification. Attachments and sibling conflicts are inspected but not merged here.</p>}
              {profile.engine === 'athena' && <AthenaConnectionFields profile={profile} update={update} />}
              {profile.engine === 'bigquery' && <BigQueryConnectionFields profile={profile} update={update} />}
              {profile.engine === 'trino' && <TrinoConnectionFields profile={profile} update={update} />}
              {profile.engine === 'influxdb' && <><Field><FieldLabel htmlFor="influx-org">InfluxDB 2 organization ID</FieldLabel><Input id="influx-org" value={profile.timeSeries.orgId} onChange={e=>update({timeSeries:{...profile.timeSeries,orgId:e.target.value}})} /></Field><p>InfluxDB 2.x Flux only. Use a token authorized to read the desired buckets. At least one accessible bucket must confirm the organization ID. Queries are generated from explicit time ranges; no arbitrary Flux scripts or writes.</p></>}
              {profile.engine === 'questdb' && <p>QuestDB 10.0.x HTTP SQL on port 9000. Time-range browsing uses designated timestamps. Raw SQL requires explicit write mode and per-run confirmation; no transaction emulation. BINARY HTTP results are rejected. Remote connections require verified TLS or pinned SSH.</p>}
              {profile.engine === 'cassandra' && <><Field><FieldLabel htmlFor="cql-data-center">Local data center</FieldLabel><Input id="cql-data-center" value={profile.cql.dataCenter} onChange={event=>update({cql:{dataCenter:event.target.value}})} /></Field><p className="full-field">Apache Cassandra 5.0.x · explicit username/password · single endpoint and declared data center. Prepared CQL, partition-aware reads and conditional writes only. Verified TLS/SSH transport; no implicit node discovery connections, retries, relational transactions or server-side rollback on local cancellation.</p></>}
              {profile.engine === 'dynamodb' && <DynamoConnectionFields profile={profile} update={update} password={password} setPassword={setPassword} />}
              {profile.engine === 'mongodb' && <MongoConnectionFields profile={profile} update={update} />}
            </>
          )}
          <Field>
            <FieldLabel htmlFor="connection-environment">Environment</FieldLabel>
            <select
              id="connection-environment"
              value={profile.environment}
              onChange={(e) =>
                update({
                  environment: e.target.value,
                  ...(e.target.value === 'production' ? { readOnly: true } : {}),
                })
              }
            >
              {[
                'local',
                'development',
                'staging',
                'production',
                ...(!['local', 'development', 'staging', 'production'].includes(profile.environment)
                  ? [profile.environment]
                  : []),
              ].map((env) => (
                <option key={env} value={env}>
                  {env[0].toUpperCase() + env.slice(1)}
                </option>
              ))}
            </select>
          </Field>
          <div className="full-field flex flex-col gap-2">
            {!local && (
              <>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={remember}
                    disabled={!secure.available && !remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                  <LockKeyhole />
                  Remember passwords securely
                </label>
                {!secure.available && (
                  <p className="field-note">
                    {secure.reason || 'Secure storage is unavailable.'} You can save the profile and connect
                    for this session.
                  </p>
                )}
              </>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={profile.readOnly}
                disabled={creatingFile}
                onChange={(e) => update({ readOnly: e.target.checked })}
              />
              <Shield />
              Read-only safeguard
            </label>
            <span className="field-note">
              {local
                ? 'Read-only opening uses the engine file access mode. File-system permissions remain the security boundary.'
                : 'Helps prevent accidental writes. Restricted database credentials remain the security boundary.'}
            </span>
          </div>
        </FieldGroup>
        <details className="advanced-options">
          <summary>Organization & connection preferences</summary>
          <FieldGroup className="form-grid">
            {field('folder', 'Folder')}
            {['postgres', 'sqlite', 'duckdb', 'mssql', 'trino', 'bigquery', 'snowflake', 'databricks', 'hana', 'cockroachdb', 'yugabytedb', 'redshift'].includes(profile.engine)
              ? field('schema', profile.engine === 'bigquery' ? 'Preferred dataset' : 'Preferred schema')
              : field('color', 'Label color (optional)')}
            <Field>
              <FieldLabel htmlFor="connection-tags">Tags (comma separated)</FieldLabel>
              <Input
                id="connection-tags"
                value={profile.tags.join(', ')}
                onChange={(e) =>
                  update({
                    tags: e.target.value
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="custom-env">Custom environment label</FieldLabel>
              <Input
                id="custom-env"
                value={profile.environment}
                onChange={(e) =>
                  update({
                    environment: e.target.value,
                    ...(e.target.value === 'production' ? { readOnly: true } : {}),
                  })
                }
              />
            </Field>
            {field('notes', 'Notes', { full: true })}
            <Field>
              <FieldLabel>Connect timeout (ms)</FieldLabel>
              <Input
                aria-label="Connect timeout"
                type="number"
                min={1000}
                max={120000}
                value={profile.connectTimeout}
                onChange={(e) => update({ connectTimeout: Number(e.target.value) })}
              />
            </Field>
            <Field>
              <FieldLabel>Query timeout (ms)</FieldLabel>
              <Input
                aria-label="Query timeout"
                type="number"
                min={1000}
                max={600000}
                value={profile.queryTimeout}
                onChange={(e) => update({ queryTimeout: Number(e.target.value) })}
              />
            </Field>
            <label className="check-row full-field">
              <input
                type="checkbox"
                checked={!creatingFile && profile.autoReconnect}
                disabled={creatingFile}
                onChange={(e) => update({ autoReconnect: e.target.checked })}
              />
              Reconnect automatically when Harbor DB starts
            </label>
            {creatingFile && (
              <p className="field-note full-field">
                Creation requires explicit confirmation and never runs automatically on startup.
              </p>
            )}
            <label className="check-row full-field">
              <input
                type="checkbox"
                checked={profile.historyEnabled}
                onChange={(e) => update({ historyEnabled: e.target.checked })}
              />
              Keep query history for this connection
            </label>
          </FieldGroup>
        </details>
        {!local && (
          <details className="advanced-options">
            <summary>TLS / SSL encryption</summary>
            <FieldGroup>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={profile.tls.enabled}
                  onChange={(e) => update({ tls: { ...profile.tls, enabled: e.target.checked } })}
                />
                Use TLS
              </label>
              {profile.tls.enabled && (
                <>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={profile.tls.rejectUnauthorized}
                      onChange={(e) =>
                        update({ tls: { ...profile.tls, rejectUnauthorized: e.target.checked } })
                      }
                    />
                    Verify server certificate and hostname
                  </label>
                  {!profile.tls.rejectUnauthorized && (
                    <p className="field-note warning">
                      Certificate verification disabled for this connection. Use only with a trusted
                      development server.
                    </p>
                  )}
                  <Field>
                    <FieldLabel>CA certificate (PEM, optional)</FieldLabel>
                    <textarea
                      aria-label="CA certificate"
                      rows={3}
                      value={profile.tls.ca}
                      onChange={(e) => update({ tls: { ...profile.tls, ca: e.target.value } })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Client certificate (PEM, optional)</FieldLabel>
                    <textarea
                      aria-label="Client certificate"
                      rows={3}
                      value={profile.tls.cert}
                      onChange={(e) => update({ tls: { ...profile.tls, cert: e.target.value } })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Client private-key file path</FieldLabel>
                    <Input
                      aria-label="TLS private-key file path"
                      value={profile.tls.keyPath}
                      onChange={(e) => update({ tls: { ...profile.tls, keyPath: e.target.value } })}
                    />
                  </Field>
                </>
              )}
            </FieldGroup>
          </details>
        )}
        {!local && (
          <details className="advanced-options">
            <summary>SSH tunnel</summary>
            <FieldGroup>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={profile.ssh.enabled}
                  onChange={(e) => update({ ssh: { ...profile.ssh, enabled: e.target.checked } })}
                />
                Connect through SSH
              </label>
              {profile.ssh.enabled && (
                <>
                  <p className="field-note">
                    The database host above is resolved from the SSH server. Verify the host-key fingerprint
                    with your administrator before trusting it.
                  </p>
                  <FieldGroup className="form-grid">
                    {(['host', 'username', 'privateKeyPath', 'hostKey'] as const).map((key) => (
                      <Field
                        className={key === 'hostKey' || key === 'privateKeyPath' ? 'full-field' : ''}
                        key={key}
                      >
                        <FieldLabel>
                          {
                            (
                              {
                                host: 'SSH host',
                                username: 'SSH username',
                                privateKeyPath: 'Private-key file path',
                                hostKey: 'Trusted host fingerprint (SHA256:…)',
                              } as const
                            )[key]
                          }
                        </FieldLabel>
                        <Input
                          aria-label={`SSH ${key}`}
                          value={profile.ssh[key]}
                          onChange={(e) => update({ ssh: { ...profile.ssh, [key]: e.target.value } })}
                        />
                      </Field>
                    ))}
                    <Field>
                      <FieldLabel>SSH port</FieldLabel>
                      <Input
                        aria-label="SSH port"
                        type="number"
                        value={profile.ssh.port}
                        onChange={(e) => update({ ssh: { ...profile.ssh, port: Number(e.target.value) } })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>
                        SSH password {initial?.hasSshPassword ? '· Password saved' : ''}
                      </FieldLabel>
                      <Input
                        aria-label="SSH password"
                        type="password"
                        autoComplete="new-password"
                        value={sshPassword}
                        onChange={(e) => {
                          setSshPassword(e.target.value)
                          setFeedback(null)
                        }}
                      />
                    </Field>
                    <Field className="full-field">
                      <FieldLabel>
                        Private-key passphrase {initial?.hasPassphrase ? '· Saved' : ''}
                      </FieldLabel>
                      <Input
                        aria-label="Private-key passphrase"
                        type="password"
                        autoComplete="new-password"
                        value={passphrase}
                        onChange={(e) => {
                          setPassphrase(e.target.value)
                          setFeedback(null)
                        }}
                      />
                    </Field>
                  </FieldGroup>
                </>
              )}
            </FieldGroup>
          </details>
        )}
        {!isDesktop && (
          <p className="field-note warning">
            Browser preview · connections and secure persistence require the Electron desktop app.
          </p>
        )}
        <div className="connection-dialog-footer">
          {feedback && (
            <div
              className={`form-status ${feedback.ok ? 'success' : 'danger'}`}
              role={feedback.ok ? 'status' : 'alert'}
              aria-atomic="true"
            >
              {feedback.ok ? <CheckCircle2 /> : <ShieldAlert />}
              <div>
                <p>{safeFeedback}</p>
                {diagnostic && (
                  <p className="field-note">
                    <strong>{diagnostic.category}:</strong> {diagnostic.nextStep}
                  </p>
                )}
              </div>
            </div>
          )}
          <div className="dialog-actions">
            <Button
              className="test-connection"
              variant="outline"
              disabled={!!busy || creatingFile}
              title={
                creatingFile
                  ? 'Testing never creates database files. Use Save and create after reviewing the path.'
                  : undefined
              }
              onClick={() => void action('test')}
            >
              {busy === 'test' ? <LoaderCircle className="spin" /> : <Plug />}Test connection
            </Button>
            <Button variant="outline" disabled={!!busy || creatingFile} onClick={() => void action('save')}>
              {busy === 'save' ? <LoaderCircle className="spin" /> : <Save />}Save
            </Button>
            <Button disabled={!!busy} onClick={() => void action('connect')}>
              {busy === 'connect' ? <LoaderCircle className="spin" /> : <Plug />}
              {creatingFile ? 'Save and create' : 'Save and connect'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
