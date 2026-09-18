import type { ConnectionProfile, Engine } from './contracts'
import { parseMongoConnectionUrl } from './mongo-uri'
const enginePorts = { postgres: 5432, mariadb: 3306, mysql: 3306, redis: 6379, mongodb: 27017 }
export function parseConnectionUrl(input: string): {
  profile: Partial<ConnectionProfile>
  password?: string
} {
  if (/^mongodb(?:\+srv)?:\/\//i.test(input.trim())) return parseMongoConnectionUrl(input)
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error(
      'Enter a valid connection URL. Percent-encode reserved characters in usernames and passwords.',
    )
  }
  if (url.hash)
    throw new Error('Connection URLs cannot contain fragments. Percent-encode reserved password characters.')
  if (!url.hostname || url.hostname.includes(','))
    throw new Error('Enter one hostname. Multi-host connection URLs are not supported by this form.')
  const engine: Engine =
    url.protocol === 'postgres:' || url.protocol === 'postgresql:'
      ? 'postgres'
      : url.protocol === 'mysql:'
        ? 'mysql'
        : url.protocol === 'mariadb:'
          ? 'mariadb'
          : url.protocol === 'redis:' || url.protocol === 'rediss:'
            ? 'redis'
            : url.protocol === 'mongodb:' || url.protocol === 'mongodb+srv:'
              ? 'mongodb'
              : (() => {
                  throw new Error(
                    'Use a postgresql://, mariadb://, mysql://, redis://, rediss://, mongodb://, or mongodb+srv:// URL.',
                  )
                })()
  const supported =
    engine === 'mongodb'
      ? ['authSource', 'replicaSet', 'directConnection', 'tls', 'ssl']
      : engine === 'postgres'
        ? ['sslmode', 'ssl']
        : engine === 'mariadb' || engine === 'mysql'
          ? ['ssl']
          : []
  const seen = new Set<string>()
  for (const [key, value] of url.searchParams) {
    if (!supported.includes(key))
      throw new Error(
        'This URL contains unsupported options. Use the documented connection fields instead; no option was silently ignored.',
      )
    if (seen.has(key)) throw new Error('Repeated URL options are ambiguous. Supply each option once.')
    seen.add(key)
    if (['directConnection', 'tls', 'ssl'].includes(key) && !['true', 'false'].includes(value))
      throw new Error('Boolean URL options must be true or false.')
  }
  const tls = url.searchParams.get('tls'),
    sslOption = url.searchParams.get('ssl')
  if (tls !== null && sslOption !== null && tls !== sslOption)
    throw new Error('Conflicting TLS options. Use one TLS setting.')
  const sslmode = url.searchParams.get('sslmode')
  if (sslmode && !['disable', 'require', 'verify-ca', 'verify-full'].includes(sslmode))
    throw new Error(
      'This TLS mode is not supported. Choose disabled TLS or required TLS with certificate verification.',
    )
  if (sslmode && sslOption !== null && (sslmode !== 'disable') !== (sslOption === 'true'))
    throw new Error('Conflicting TLS options. Use one TLS setting.')
  if (url.protocol === 'mongodb+srv:' && url.port) throw new Error('SRV URLs must not specify a port.')
  if (url.protocol === 'mongodb+srv:' && url.searchParams.get('directConnection') === 'true')
    throw new Error('SRV discovery cannot be combined with directConnection=true.')
  if (engine === 'redis' && !/^\/\d*$/.test(url.pathname || '/'))
    throw new Error('Redis database must be a non-negative integer.')
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))
    throw new Error('Port must be between 1 and 65535.')
  const explicitTls = url.searchParams.get('tls') ?? url.searchParams.get('ssl')
  const ssl =
    engine === 'mongodb'
      ? explicitTls === 'true' || (url.protocol === 'mongodb+srv:' && explicitTls !== 'false')
      : url.protocol === 'rediss:' ||
        explicitTls === 'true' ||
        ['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') || '')
  if (engine === 'mongodb' && url.protocol === 'mongodb+srv:' && !ssl)
    throw new Error('Harbor requires TLS for MongoDB SRV connections.')
  return {
    profile: {
      engine,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port) || enginePorts[engine],
      username: decodeURIComponent(url.username),
      database: engine === 'redis' ? '' : decodeURIComponent(url.pathname.slice(1)),
      redisDb: engine === 'redis' ? Number(url.pathname.slice(1) || '0') : 0,
      ...(engine === 'mongodb'
        ? {
            mongo: {
              srv: url.protocol === 'mongodb+srv:',
              authSource:
                url.searchParams.get('authSource') ||
                (url.protocol === 'mongodb+srv:' ? 'admin' : decodeURIComponent(url.pathname.slice(1))) ||
                'admin',
              replicaSet: url.searchParams.get('replicaSet') || '',
              directConnection: url.searchParams.get('directConnection') === 'true',
              seeds: [],
              authMechanism: 'DEFAULT',
              readPreference: 'primary',
            },
          }
        : {}),
      tls: { enabled: ssl, rejectUnauthorized: true, ca: '', cert: '', keyPath: '' },
    },
    password: url.password ? decodeURIComponent(url.password) : undefined,
  }
}
