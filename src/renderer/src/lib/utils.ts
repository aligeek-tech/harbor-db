import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { Cell, ConnectionProfile, Engine } from '@shared/contracts'
import { profileSchema } from '@shared/contracts'
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
export const engineNames: Record<Engine, string> = {
  postgres: 'PostgreSQL',
  mariadb: 'MariaDB',
  redis: 'Redis',
}
export const enginePorts: Record<Engine, number> = { postgres: 5432, mariadb: 3306, redis: 6379 }
export const uid = () => crypto.randomUUID()
export function displayCell(value: Cell | undefined): string {
  if (value === null) return 'NULL'
  if (value === undefined) return ''
  if (typeof value === 'object')
    return `0x${Array.from(atob(value.base64), (x) => x.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`
  return String(value)
}
export function errorText(e: unknown) {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(e)
}
export function newProfile(engine: Engine = 'postgres'): ConnectionProfile {
  return profileSchema.parse({
    id: uid(),
    engine,
    host: 'localhost',
    port: enginePorts[engine],
    username: engine === 'postgres' ? 'postgres' : engine === 'mariadb' ? 'root' : '',
    database: '',
    readOnly: true,
    ...{ name: `New ${engineNames[engine]}` },
  })
}
export function parseConnectionUrl(input: string): {
  profile: Partial<ConnectionProfile>
  password?: string
} {
  const url = new URL(input.trim())
  const engine: Engine =
    url.protocol === 'postgres:' || url.protocol === 'postgresql:'
      ? 'postgres'
      : url.protocol === 'mysql:' || url.protocol === 'mariadb:'
        ? 'mariadb'
        : url.protocol === 'redis:' || url.protocol === 'rediss:'
          ? 'redis'
          : (() => {
              throw new Error('Use a postgresql://, mariadb://, mysql://, redis://, or rediss:// URL.')
            })()
  const ssl =
    url.protocol === 'rediss:' ||
    ['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') || '')
  return {
    profile: {
      engine,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port) || enginePorts[engine],
      username: decodeURIComponent(url.username),
      database: engine === 'redis' ? '' : decodeURIComponent(url.pathname.slice(1)),
      redisDb: engine === 'redis' ? Number(url.pathname.slice(1) || '0') : 0,
      tls: { enabled: ssl, rejectUnauthorized: true, ca: '', cert: '', keyPath: '' },
    },
    password: url.password ? decodeURIComponent(url.password) : undefined,
  }
}
