import { isIP } from 'node:net'
import type { ConnectionProfile } from '../../shared/contracts'
import type { Transport } from './transport'

export function mongoHost(host: string): string {
  if (isIP(host)) return host.includes(':') ? `[${host}]` : host
  if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.?$/.test(host))
    throw new Error('Enter a MongoDB hostname or IP address without a URL, port or credentials.')
  return host
}
export function validateMongoProfile(profile: ConnectionProfile): void {
  mongoHost(profile.host)
  for (const seed of profile.mongo.seeds) mongoHost(seed.host)
  if (profile.mongo.srv) {
    if (profile.mongo.directConnection || profile.ssh.enabled || profile.mongo.seeds.length)
      throw new Error('SRV discovery cannot be combined with direct connection, SSH or manual seed hosts.')
    if (isIP(profile.host) || !profile.host.includes('.') || profile.port !== 27017)
      throw new Error(
        'SRV needs a DNS hostname and no custom port; DNS supplies the discovered hosts and ports.',
      )
    if (!profile.tls.enabled || !profile.tls.rejectUnauthorized)
      throw new Error('Harbor requires verified TLS for MongoDB SRV connections.')
  }
  if (profile.mongo.seeds.length && (profile.mongo.directConnection || profile.ssh.enabled))
    throw new Error('Multiple MongoDB seeds cannot use a direct connection or one SSH tunnel.')
  if (profile.ssh.enabled && profile.mongo.replicaSet)
    throw new Error('Replica-set discovery through a single SSH tunnel is not supported.')
  if (profile.mongo.authMechanism !== 'DEFAULT' && !profile.username)
    throw new Error('The selected SCRAM authentication mechanism requires a username.')
  const seeds = [{ host: profile.host, port: profile.port }, ...profile.mongo.seeds].map(
    ({ host, port }) => `${host.toLowerCase()}:${port}`,
  )
  if (new Set(seeds).size !== seeds.length)
    throw new Error('MongoDB seed hosts must not repeat the primary host or each other.')
}
export function mongoConnectionUri(
  profile: ConnectionProfile,
  transport: Pick<Transport, 'host' | 'port'>,
): string {
  validateMongoProfile(profile)
  if (profile.mongo.srv) return `mongodb+srv://${mongoHost(profile.host)}/`
  const seeds = [{ host: transport.host, port: transport.port }, ...profile.mongo.seeds]
  return `mongodb://${seeds.map(({ host, port }) => `${mongoHost(host)}:${port}`).join(',')}/`
}
