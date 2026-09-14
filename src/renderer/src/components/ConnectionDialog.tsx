import { useState } from 'react'
import { CheckCircle2, Link, LoaderCircle, LockKeyhole, Plug, Save, Shield, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { profileSchema, type ConnectionProfile, type Engine, type SaveProfileInput } from '@shared/contracts'
import { useApp } from '../store'
import { api, isDesktop } from '../lib/api'
import { engineNames, enginePorts, errorText, newProfile, parseConnectionUrl } from '../lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
import { Field, FieldGroup, FieldLabel } from './ui/field'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { EngineIcon, useConfirm } from './common'

export function ConnectionDialog({ initial, onClose }: { initial?: ConnectionProfile; onClose: () => void }) {
  const [profile, setProfile] = useState(initial || { ...newProfile(), database: '' })
  const [password, setPassword] = useState('')
  const [sshPassword, setSshPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [remember, setRemember] = useState(
    !!(initial?.hasPassword || initial?.hasSshPassword || initial?.hasPassphrase),
  )
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const secure = useApp((s) => s.secureStorage)
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
    profile: profileSchema.parse(profile),
    secrets: {
      ...(password ? { password } : {}),
      ...(sshPassword ? { sshPassword } : {}),
      ...(passphrase ? { passphrase } : {}),
    },
    rememberPassword: remember,
  })
  async function action(kind: 'test' | 'save' | 'connect') {
    setFeedback(null)
    setBusy(kind)
    try {
      const input = payload()
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
          description: `${profile.name} · ${profile.host}:${profile.port} · ${profile.engine === 'redis' ? `Redis DB ${profile.redisDb}` : profile.database || 'No default database'} · ${profile.environment}. Queries and edits can change data. Use restricted database credentials for a security boundary.`,
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
              : status.error || 'Connection failed',
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
            setFeedback({ ok: false, text: `Profile saved. ${status.error || 'Could not connect.'}` })
            return
          }
        } catch (e) {
          useApp.getState().setStatus(saved.id, { state: 'failed', error: errorText(e) })
          setProfile(saved)
          setFeedback({ ok: false, text: `Profile saved. ${errorText(e)}` })
          return
        }
      }
      toast.success(kind === 'connect' ? `Connected to ${saved.name}` : 'Connection saved')
      onClose()
    } catch (e) {
      setFeedback({ ok: false, text: errorText(e) })
    } finally {
      setBusy('')
    }
  }
  function switchEngine(engine: Engine) {
    update({
      ...(Object.values(engineNames).some((n) => profile.name === `New ${n}`)
        ? { name: `New ${engineNames[engine]}` }
        : {}),
      engine,
      port: enginePorts[engine],
      username: engine === 'redis' ? '' : engine === 'postgres' ? 'postgres' : 'root',
      database: '',
      schema: engine === 'postgres' ? 'public' : '',
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
        <ToggleGroup
          type="single"
          value={profile.engine}
          onValueChange={(v) => v && switchEngine(v as Engine)}
          className="connection-engine-choice"
          variant="outline"
          aria-label="Database engine"
        >
          {(['postgres', 'mariadb', 'redis'] as Engine[]).map((engine) => (
            <ToggleGroupItem key={engine} value={engine}>
              <EngineIcon engine={engine} />
              {engineNames[engine]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <details>
          <summary className="field-note cursor-pointer">Use a connection URL</summary>
          <div className="connection-url mt-3">
            <Input
              type="password"
              autoComplete="off"
              aria-label="Connection URL"
              placeholder={
                profile.engine === 'redis'
                  ? 'redis://user:password@localhost:6379/0'
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
        </details>
        <FieldGroup className="form-grid">
          {field('name', 'Connection name', { full: true, placeholder: 'My local database' })}
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
          {field('username', profile.engine === 'redis' ? 'ACL username (optional)' : 'Username')}
          <Field>
            <FieldLabel htmlFor="connection-password">
              Password {initial?.hasPassword && <span className="success">· Password saved</span>}
            </FieldLabel>
            <Input
              id="connection-password"
              type="password"
              autoComplete="new-password"
              value={password}
              placeholder={initial?.hasPassword ? 'Leave blank to keep saved password' : 'Enter password'}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {profile.engine === 'redis' ? (
            <Field>
              <FieldLabel htmlFor="connection-db">Logical database</FieldLabel>
              <Input
                id="connection-db"
                type="number"
                min={0}
                value={profile.redisDb}
                onChange={(e) => update({ redisDb: Number(e.target.value) })}
              />
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor="connection-database">Database</FieldLabel>
              <Input
                id="connection-database"
                value={profile.database}
                onChange={(e) => update({ database: e.target.value })}
                placeholder="Optional — browse available databases"
              />
              {profile.engine === 'mariadb' && (
                <p className="field-note">
                  Leave blank to browse databases available to this account. Set a default to use unqualified
                  table names in queries.
                </p>
              )}
              {profile.engine === 'postgres' && (
                <p className="field-note">
                  Leave blank to browse databases available to this account. Choose a database in the explorer
                  for your tables and queries, or set a default here.
                </p>
              )}
            </Field>
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
                {secure.reason || 'Secure storage is unavailable.'} You can save the profile and connect for
                this session.
              </p>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={profile.readOnly}
                onChange={(e) => update({ readOnly: e.target.checked })}
              />
              <Shield />
              Read-only safeguard
            </label>
            <span className="field-note">
              Helps prevent accidental writes. Restricted database credentials remain the security boundary.
            </span>
          </div>
        </FieldGroup>
        <details className="advanced-options">
          <summary>Organization & connection preferences</summary>
          <FieldGroup className="form-grid">
            {field('folder', 'Folder')}
            {profile.engine === 'postgres'
              ? field('schema', 'Preferred schema')
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
                checked={profile.autoReconnect}
                onChange={(e) => update({ autoReconnect: e.target.checked })}
              />
              Reconnect automatically when Harbor DB starts
            </label>
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
                    Certificate verification disabled for this connection. Use only with a trusted development
                    server.
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
                    <FieldLabel>SSH password {initial?.hasSshPassword ? '· Password saved' : ''}</FieldLabel>
                    <Input
                      aria-label="SSH password"
                      type="password"
                      autoComplete="new-password"
                      value={sshPassword}
                      onChange={(e) => setSshPassword(e.target.value)}
                    />
                  </Field>
                  <Field className="full-field">
                    <FieldLabel>Private-key passphrase {initial?.hasPassphrase ? '· Saved' : ''}</FieldLabel>
                    <Input
                      aria-label="Private-key passphrase"
                      type="password"
                      autoComplete="new-password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                    />
                  </Field>
                </FieldGroup>
              </>
            )}
          </FieldGroup>
        </details>
        {feedback && (
          <div
            className={`form-status ${feedback.ok ? 'success' : 'danger'}`}
            role={feedback.ok ? 'status' : 'alert'}
          >
            {feedback.ok ? <CheckCircle2 /> : <ShieldAlert />}
            <p>{feedback.text}</p>
          </div>
        )}
        {!isDesktop && (
          <p className="field-note warning">
            Browser preview · connections and secure persistence require the Electron desktop app.
          </p>
        )}
        <div className="dialog-actions">
          <Button
            className="test-connection"
            variant="outline"
            disabled={!!busy}
            onClick={() => void action('test')}
          >
            {busy === 'test' ? <LoaderCircle className="spin" /> : <Plug />}Test connection
          </Button>
          <Button variant="outline" disabled={!!busy} onClick={() => void action('save')}>
            {busy === 'save' ? <LoaderCircle className="spin" /> : <Save />}Save
          </Button>
          <Button disabled={!!busy} onClick={() => void action('connect')}>
            {busy === 'connect' ? <LoaderCircle className="spin" /> : <Plug />}Save and connect
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
