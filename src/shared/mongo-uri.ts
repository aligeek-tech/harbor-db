import type { ConnectionProfile } from './contracts'

/** Parse only the options the form and native adapter can actually preserve. */
export function parseMongoConnectionUrl(input: string): {
  profile: Partial<ConnectionProfile>
  password?: string
} {
  const match = /^(mongodb(?:\+srv)?):\/\/([^/?#]+)(.*)$/i.exec(input.trim())
  if (!match) throw new Error('Enter a valid MongoDB URL with percent-encoded credentials.')
  const srv = match[1].toLowerCase() === 'mongodb+srv'
  const authority = match[2]
  const at = authority.lastIndexOf('@')
  if (at !== authority.indexOf('@'))
    throw new Error('Percent-encode @ and other reserved credential characters.')
  const credentials = at < 0 ? '' : authority.slice(0, at + 1)
  const hosts = authority.slice(at + 1).split(',')
  if (!hosts.length || hosts.length > 11 || hosts.some((host) => !host))
    throw new Error('Use between one and eleven explicit MongoDB seed hosts.')
  if (srv && hosts.length !== 1) throw new Error('SRV discovery uses one DNS name, not a manual host list.')
  let urls: URL[]
  try {
    urls = hosts.map((host) => new URL(`${match[1].toLowerCase()}://${credentials}${host}${match[3] || '/'}`))
  } catch {
    throw new Error(
      'Enter valid MongoDB hostnames/ports; bracket IPv6 addresses and percent-encode credentials.',
    )
  }
  const url = urls[0]
  if (url.hash)
    throw new Error('Connection URLs cannot contain fragments. Percent-encode reserved password characters.')
  const options = url.searchParams
  const supported = [
    'authSource',
    'replicaSet',
    'directConnection',
    'tls',
    'ssl',
    'authMechanism',
    'readPreference',
    'retryReads',
    'retryWrites',
  ]
  const seen = new Set<string>()
  for (const [key, value] of options) {
    if (!supported.includes(key))
      throw new Error(
        'This MongoDB URL contains unsupported options. No option was silently ignored; review supported fields instead.',
      )
    if (seen.has(key)) throw new Error('Repeated URL options are ambiguous. Supply each option once.')
    seen.add(key)
    if (
      ['tls', 'ssl', 'directConnection', 'retryReads', 'retryWrites'].includes(key) &&
      !['true', 'false'].includes(value)
    )
      throw new Error('Boolean URL options must be true or false.')
    if (['retryReads', 'retryWrites'].includes(key) && value !== 'false')
      throw new Error(
        'Harbor does not automatically retry MongoDB operations. Remove the retry option or set it to false before reviewing the target.',
      )
  }
  if (options.has('tls') && options.has('ssl') && options.get('tls') !== options.get('ssl'))
    throw new Error('Conflicting TLS options. Use one TLS setting.')
  const tls =
    (options.get('tls') ?? options.get('ssl')) === 'true' ||
    (srv && (options.get('tls') ?? options.get('ssl')) !== 'false')
  const directConnection = options.get('directConnection') === 'true'
  if (srv && directConnection) throw new Error('SRV discovery cannot be combined with directConnection=true.')
  if (hosts.length > 1 && directConnection)
    throw new Error('Multiple seeds cannot use directConnection=true.')
  if (srv && url.port) throw new Error('SRV URLs must not specify a port.')
  if (srv && !tls) throw new Error('Harbor requires TLS for MongoDB SRV connections.')
  const readPreference = options.get('readPreference') || 'primary'
  if (!['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'].includes(readPreference))
    throw new Error('Unsupported MongoDB read preference.')
  const authMechanism = options.get('authMechanism') || 'DEFAULT'
  if (!['DEFAULT', 'SCRAM-SHA-256', 'SCRAM-SHA-1'].includes(authMechanism))
    throw new Error('Only negotiated SCRAM, SCRAM-SHA-256 and SCRAM-SHA-1 authentication are available.')
  const seeds = urls.map((item) => {
    const host = item.hostname.replace(/^\[|\]$/g, '')
    if (!host || /[\s/@?%#]/.test(host)) throw new Error('Enter a valid MongoDB seed hostname.')
    const port = item.port ? Number(item.port) : 27017
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Port must be between 1 and 65535.')
    return { host, port }
  })
  if (new Set(seeds.map((seed) => `${seed.host.toLowerCase()}:${seed.port}`)).size !== seeds.length)
    throw new Error('MongoDB seed hosts must be unique.')
  let username: string, password: string | undefined, database: string
  try {
    username = decodeURIComponent(url.username)
    password = url.password ? decodeURIComponent(url.password) : undefined
    database = decodeURIComponent(url.pathname.slice(1))
  } catch {
    throw new Error('Malformed percent encoding in MongoDB credentials or database name.')
  }
  if (database.includes('/')) throw new Error('A MongoDB URL path contains one database name.')
  return {
    profile: {
      engine: 'mongodb',
      ...seeds[0],
      username,
      database,
      mongo: {
        srv,
        authSource: options.get('authSource') || (srv ? 'admin' : database) || 'admin',
        replicaSet: options.get('replicaSet') || '',
        directConnection,
        seeds: seeds.slice(1),
        authMechanism: authMechanism as ConnectionProfile['mongo']['authMechanism'],
        readPreference: readPreference as ConnectionProfile['mongo']['readPreference'],
      },
      tls: { enabled: tls, rejectUnauthorized: true, ca: '', cert: '', keyPath: '' },
    },
    ...(password ? { password } : {}),
  }
}
