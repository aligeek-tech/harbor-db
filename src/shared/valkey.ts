/** Protocol sharing never supplies the advertised product identity. INFO does. */
export function keyValueConfirmationTarget(
  profile: { engine: string; host: string; port: number; redisDb: number },
  command = 'FLUSHDB',
): string {
  const name = profile.engine === 'valkey' ? 'Valkey' : 'Redis'
  return command.toUpperCase() === 'FLUSHALL'
    ? `All ${name} databases on ${profile.host}:${profile.port}`
    : `${name} database ${profile.redisDb} on ${profile.host}:${profile.port}`
}
export function redisServerIdentity(
  info: string,
  expected: 'redis' | 'valkey',
): {
  product: 'Redis' | 'Valkey'
  version: string
  mode: 'standalone' | 'cluster' | 'sentinel'
} {
  const fields = Object.fromEntries(
    info
      .split(/\r?\n/)
      .filter((line) => line.includes(':'))
      .map((line) => {
        const split = line.indexOf(':')
        return [line.slice(0, split), line.slice(split + 1).trim()]
      }),
  )
  const valkey = fields.server_name?.toLowerCase() === 'valkey' || !!fields.valkey_version
  if (expected === 'redis' && valkey)
    throw new Error(
      'This endpoint identifies itself as Valkey. Choose a Valkey profile to preserve its real server identity and support boundaries.',
    )
  if (expected === 'valkey' && (!valkey || fields.server_name?.toLowerCase() !== 'valkey'))
    throw new Error(
      'This endpoint does not identify itself as Valkey. Use a matching engine profile; Redis compatibility alone is not Valkey verification.',
    )
  const version = expected === 'valkey' ? fields.valkey_version : fields.redis_version
  if (!version || !/^\d+\.\d+\.\d+(?:[.-][A-Za-z0-9.-]+)?$/.test(version))
    throw new Error(
      'INFO permission and a valid native server version are required to establish this deployment.',
    )
  const mode = fields.server_mode ?? fields.redis_mode
  if (!['standalone', 'cluster', 'sentinel'].includes(mode))
    throw new Error('The server did not provide a supported deployment mode in INFO.')
  return {
    product: expected === 'valkey' ? 'Valkey' : 'Redis',
    version,
    mode: mode as 'standalone' | 'cluster' | 'sentinel',
  }
}
