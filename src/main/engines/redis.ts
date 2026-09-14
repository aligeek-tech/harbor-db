import { createClient, RESP_TYPES } from 'redis'
import type {
  Cell,
  ConnectionProfile,
  ConnectionStatus,
  QueryInput,
  QueryResult,
  RedisInspectInput,
  RedisKey,
  RedisMutateInput,
  RedisScanInput,
  RedisScanResult,
  RedisValue,
  Secrets,
} from '../../shared/contracts'
import { openTransport, type Transport } from './transport'

const MAX_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 4 * MAX_BYTES
const MAX_COLLECTION_ROWS = 500

interface WireClient {
  readonly isOpen: boolean
  readonly isReady: boolean
  connect(): Promise<unknown>
  destroy(): void
  sendCommand(args: (string | Buffer)[]): Promise<unknown>
  on(event: string, callback: (...args: unknown[]) => void): unknown
}
interface LiveConnection {
  client: WireClient
  profile: ConnectionProfile
  transport: Transport
  status: ConnectionStatus
}

export const REDIS_READ_COMMANDS = new Set([
  'PING',
  'ECHO',
  'GET',
  'GETRANGE',
  'MGET',
  'STRLEN',
  'TYPE',
  'TTL',
  'PTTL',
  'EXISTS',
  'DBSIZE',
  'TIME',
  'INFO',
  'SCAN',
  'HGET',
  'HMGET',
  'HLEN',
  'HEXISTS',
  'HSTRLEN',
  'LLEN',
  'LINDEX',
  'LRANGE',
  'SCARD',
  'SISMEMBER',
  'SMISMEMBER',
  'ZCARD',
  'ZSCORE',
  'ZMSCORE',
  'ZRANK',
  'ZREVRANK',
  'ZCOUNT',
  'ZRANGE',
  'XLEN',
  'XRANGE',
  'XREVRANGE',
])
const WRITE_COMMANDS = new Set([
  'SET',
  'SETNX',
  'SETEX',
  'PSETEX',
  'MSET',
  'MSETNX',
  'DEL',
  'UNLINK',
  'RENAME',
  'RENAMENX',
  'EXPIRE',
  'PEXPIRE',
  'EXPIREAT',
  'PEXPIREAT',
  'PERSIST',
  'INCR',
  'INCRBY',
  'INCRBYFLOAT',
  'DECR',
  'DECRBY',
  'APPEND',
  'SETRANGE',
  'HSET',
  'HSETNX',
  'HDEL',
  'HINCRBY',
  'HINCRBYFLOAT',
  'LPUSH',
  'RPUSH',
  'LPUSHX',
  'RPUSHX',
  'LSET',
  'LTRIM',
  'LREM',
  'SADD',
  'SREM',
  'SMOVE',
  'ZADD',
  'ZREM',
  'ZINCRBY',
  'ZREMRANGEBYRANK',
  'ZREMRANGEBYSCORE',
  'XADD',
  'XDEL',
  'XTRIM',
  'FLUSHDB',
  'FLUSHALL',
])
const UNSUPPORTED_COMMANDS = new Set([
  'AUTH',
  'HELLO',
  'SELECT',
  'RESET',
  'QUIT',
  'MULTI',
  'EXEC',
  'DISCARD',
  'WATCH',
  'UNWATCH',
  'EVAL',
  'EVALSHA',
  'EVAL_RO',
  'EVALSHA_RO',
  'FCALL',
  'FCALL_RO',
  'SCRIPT',
  'FUNCTION',
  'SUBSCRIBE',
  'PSUBSCRIBE',
  'SSUBSCRIBE',
  'MONITOR',
  'BLPOP',
  'BRPOP',
  'BLMOVE',
  'BLMPOP',
  'BZPOPMIN',
  'BZPOPMAX',
  'BZMPOP',
  'XREAD',
  'XREADGROUP',
  'CONFIG',
  'ACL',
  'CLIENT',
  'DEBUG',
  'SHUTDOWN',
  'REPLICAOF',
  'SLAVEOF',
  'MIGRATE',
  'RESTORE',
  'CLUSTER',
  'SENTINEL',
])

/** Redis arguments, never shell syntax. Quotes retain whitespace and \xNN retains bytes. */
export function parseRedisCommand(source: string): Buffer[] {
  const args: Buffer[] = []
  const points = [...source]
  let quote: '"' | "'" | undefined
  let active = false
  let bytes: Buffer[] = []
  const append = (value: string) => bytes.push(Buffer.from(value))
  for (let i = 0; i < points.length; i++) {
    const char = points[i]!
    if (!quote && /\s/.test(char)) {
      if (active) {
        args.push(Buffer.concat(bytes))
        bytes = []
        active = false
      }
      continue
    }
    active = true
    if (char === quote) {
      quote = undefined
      continue
    }
    if (!quote && (char === '"' || char === "'")) {
      quote = char
      continue
    }
    if (char === '\\') {
      const next = points[++i]
      if (next === undefined) throw new Error('The command ends with an incomplete escape sequence.')
      if (quote === "'" && next !== "'" && next !== '\\') {
        append('\\')
        append(next)
        continue
      }
      if (next === 'x') {
        const hex = `${points[i + 1] ?? ''}${points[i + 2] ?? ''}`
        if (!/^[a-fA-F0-9]{2}$/.test(hex))
          throw new Error('A hexadecimal escape must contain exactly two digits, for example \\x00.')
        bytes.push(Buffer.from([Number.parseInt(hex, 16)]))
        i += 2
      } else {
        append(({ n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' } as Record<string, string>)[next] ?? next)
      }
      continue
    }
    append(char)
  }
  if (quote) throw new Error('The command contains an unclosed quote.')
  if (active) args.push(Buffer.concat(bytes))
  if (!args.length || !args[0]!.length) throw new Error('Enter a Redis command.')
  if (args.length > 2000) throw new Error('A command may contain at most 2,000 arguments.')
  return args
}

export function redisConfirmationTarget(profile: ConnectionProfile, command = 'FLUSHDB'): string {
  return command.toUpperCase() === 'FLUSHALL'
    ? `All Redis databases on ${profile.host}:${profile.port}`
    : `Redis database ${profile.redisDb} on ${profile.host}:${profile.port}`
}

export function assertRedisCommandAllowed(
  profile: ConnectionProfile,
  args: Buffer[],
  confirmation?: string,
): string {
  const command = args[0]!.toString('ascii').toUpperCase()
  if (command === 'KEYS')
    throw new Error('KEYS can block Redis. Use the incremental key browser or SCAN instead.')
  if (UNSUPPORTED_COMMANDS.has(command))
    throw new Error(
      `${command} is unavailable in this console. Connection identity, scripts, transactions, subscriptions, blocking operations, and server administration require dedicated support.`,
    )
  if (!REDIS_READ_COMMANDS.has(command) && !WRITE_COMMANDS.has(command))
    throw new Error(
      `${command} is not in the supported command list. Use the type-specific key inspector for collection browsing.`,
    )
  if (profile.readOnly && !REDIS_READ_COMMANDS.has(command))
    throw new Error(
      'This connection is read-only. Enable writes in its connection settings before changing data.',
    )
  if (
    (command === 'FLUSHDB' || command === 'FLUSHALL') &&
    confirmation !== redisConfirmationTarget(profile, command)
  ) {
    throw new Error(
      `Type “${redisConfirmationTarget(profile, command)}” to confirm ${command}. This operation cannot be undone.`,
    )
  }
  if (
    (command === 'DEL' || command === 'UNLINK') &&
    args.length > 21 &&
    confirmation !== redisConfirmationTarget(profile)
  ) {
    throw new Error(`Deleting more than 20 keys requires typing “${redisConfirmationTarget(profile)}”.`)
  }
  if (command === 'SET' && args.slice(3).some((arg) => arg.toString().toUpperCase() === 'GET'))
    throw new Error(
      'SET GET is unavailable because the prior value can be unbounded. Inspect the value first, then use SET.',
    )
  return command
}

function text(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function buffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(text(value))
}
export function decodeBase64(source: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source))
    throw new Error('Invalid base64 data.')
  return Buffer.from(source, 'base64')
}
export function redisCell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) {
    const decoded = value.toString('utf8')
    const hasControls = value.some((byte) => (byte < 32 && ![9, 10, 13].includes(byte)) || byte === 127)
    return Buffer.from(decoded).equals(value) && !hasControls
      ? decoded
      : { type: 'binary', base64: value.toString('base64') }
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : String(value)
  if (typeof value === 'boolean' || typeof value === 'string') return value
  return JSON.stringify(jsonValue(value))
}
function jsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value instanceof Map)
    return [...value.entries()].map(([key, entry]) => [jsonValue(key), jsonValue(entry)])
  if (value instanceof Set) return [...value].map(jsonValue)
  if (Buffer.isBuffer(value)) return redisCell(value)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]))
  return typeof value === 'bigint' ? value.toString() : value
}
function redisKey(key: Buffer, type: unknown, ttl: unknown): RedisKey {
  const display = redisCell(key)
  return {
    key: typeof display === 'string' ? display : `base64:${key.toString('base64')}`,
    keyBase64: key.toString('base64'),
    type: text(type),
    ttl: Number(text(ttl)),
  }
}

// This script bounds bytes before replies cross the socket. SCAN COUNT remains a hint;
// a cursor:skip continuation lets compact hashes/sets return bounded UI pages.
const INSPECT_SCRIPT = `
local k=KEYS[1]
local kind=redis.call('TYPE',k).ok
local ttl=redis.call('TTL',k)
local count=tonumber(ARGV[1])
local offset=tonumber(ARGV[2])
local cursor=ARGV[3]
local skip=tonumber(ARGV[4])
local budget=tonumber(ARGV[5])
local clipped=0
local function clip(s)
  if type(s)~='string' then return s end
  local limit=math.min(65536,math.max(0,budget))
  if #s>limit then clipped=1 end
  local v=string.sub(s,1,limit)
  budget=budget-#v
  return v
end
local result={kind,ttl,0,false,{},'0',0}
if kind=='none' then return result end
if kind=='string' then
  result[3]=redis.call('STRLEN',k)
  result[4]=redis.call('GETRANGE',k,0,tonumber(ARGV[5])-1)
  if result[3]>tonumber(ARGV[5]) then clipped=1 end
elseif kind=='hash' or kind=='set' then
  local scan
  local step=1
  if kind=='hash' then
    result[3]=redis.call('HLEN',k)
    scan=redis.call('HSCAN',k,cursor,'COUNT',count)
    step=2
  else
    result[3]=redis.call('SCARD',k)
    scan=redis.call('SSCAN',k,cursor,'COUNT',count)
  end
  local start=skip*step+1
  local finish=math.min(#scan[2],start+count*step-1)
  for i=start,finish,step do
    if step==2 then table.insert(result[5],{clip(scan[2][i]),clip(scan[2][i+1])})
    else table.insert(result[5],{clip(scan[2][i])}) end
  end
  if finish<#scan[2] then result[6]=cursor..':'..tostring(skip+count)
  else result[6]=scan[1] end
elseif kind=='list' then
  result[3]=redis.call('LLEN',k)
  local values=redis.call('LRANGE',k,offset,offset+count-1)
  for i,v in ipairs(values) do table.insert(result[5],{tostring(offset+i-1),clip(v)}) end
  if offset+#values<result[3] then result[6]=tostring(offset+#values) end
elseif kind=='zset' then
  result[3]=redis.call('ZCARD',k)
  local values=redis.call('ZRANGE',k,offset,offset+count-1,'WITHSCORES')
  for i=1,#values,2 do table.insert(result[5],{clip(values[i]),values[i+1]}) end
  if offset+#values/2<result[3] then result[6]=tostring(offset+#values/2) end
elseif kind=='stream' then
  result[3]=redis.call('XLEN',k)
  local start='-'
  if cursor~='0' then
    if skip>0 then start=cursor else start='('..cursor end
  end
  local values=redis.call('XRANGE',k,start,'+','COUNT',count)
  for _,v in ipairs(values) do
    local first=1
    if skip>0 and v[1]==cursor then first=skip*2+1 end
    for i=first,#v[2],2 do
      table.insert(result[5],{v[1],clip(v[2][i]),clip(v[2][i+1])})
      if #result[5]==count then
        if i<#v[2]-1 then result[6]=v[1]..':'..tostring((i+1)/2)
        else result[6]=v[1] end
        result[7]=clipped
        return result
      end
    end
  end
  if #values==count then result[6]=values[#values][1] end
end
result[7]=clipped
return result
`

const SET_SCRIPT = `
local kind=redis.call('TYPE',KEYS[1]).ok
if ARGV[5]=='1' and kind~='none' then return redis.error_reply('CONFLICT: this key already exists; choose another name') end
if kind~='none' and kind~='string' then return redis.error_reply('WRONGTYPE: select the type-specific editor') end
if ARGV[2]=='1' and redis.call('GET',KEYS[1])~=ARGV[3] then return redis.error_reply('CONFLICT: value changed or the key expired; refresh before applying') end
redis.call('SET',KEYS[1],ARGV[1],'KEEPTTL')
if ARGV[4]~='' then redis.call('EXPIRE',KEYS[1],ARGV[4]) end
return 'OK'
`

const BOUNDED_REPLY_SCRIPT = `
local result=redis.call(unpack(ARGV))
local budget=4194304
local function fits(value)
  if type(value)=='string' then budget=budget-#value
  elseif type(value)=='table' then
    budget=budget-16
    for _,entry in pairs(value) do if not fits(entry) then return false end end
  end
  return budget>=0
end
if not fits(result) then return redis.error_reply('Response exceeds the 4 MiB limit. Use the bounded key inspector, narrow the range, or reduce the SCAN batch.') end
return result
`

export class RedisService {
  private readonly connections = new Map<string, LiveConnection>()
  private readonly states = new Map<string, ConnectionStatus>()

  status(id: string): ConnectionStatus {
    const live = this.connections.get(id)
    if (live && !live.client.isReady && live.status.state === 'connected')
      return {
        state: 'failed',
        error: 'Redis disconnected. Reconnect explicitly; writes are never replayed.',
      }
    return live?.status ?? this.states.get(id) ?? { state: 'disconnected' }
  }

  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    await this.disconnect(profile.id)
    this.states.set(profile.id, { state: 'connecting' })
    const started = performance.now()
    let transport: Transport | undefined
    let client: WireClient | undefined
    try {
      transport = await openTransport(profile, secrets)
      client = createClient({
        socket: {
          host: transport.host,
          port: transport.port,
          connectTimeout: profile.connectTimeout,
          reconnectStrategy: false,
          ...(transport.tls ? { tls: true as const, ...transport.tls } : {}),
        },
        username: profile.username || undefined,
        password: secrets.password,
        disableOfflineQueue: true,
        commandsQueueMaxLength: 256,
        commandOptions: {
          typeMapping: {
            [RESP_TYPES.BLOB_STRING]: Buffer,
            [RESP_TYPES.NUMBER]: String,
            [RESP_TYPES.BIG_NUMBER]: String,
            [RESP_TYPES.DOUBLE]: String,
          },
        },
      }) as unknown as WireClient
      const live: LiveConnection = {
        client,
        profile: structuredClone(profile),
        transport,
        status: { state: 'connecting' },
      }
      client.on('error', (...args) => {
        live.status = {
          state: 'failed',
          error: `Redis connection failed: ${args[0] instanceof Error ? args[0].message : 'The socket closed.'} Reconnect explicitly; no command will be replayed.`,
        }
        this.states.set(profile.id, live.status)
      })
      client.on('end', () => {
        if (this.connections.get(profile.id) === live && live.status.state !== 'failed') {
          live.status = {
            state: 'failed',
            error: 'Redis disconnected. Reconnect explicitly; no command will be replayed.',
          }
          void live.transport.close()
        }
      })
      await client.connect()
      this.connections.set(profile.id, live)
      // INFO is required to distinguish Sentinel/Cluster before any SELECT assumption.
      const info = text(await this.command(live, ['INFO']))
      const mode = /^redis_mode:(.+)$/m.exec(info)?.[1]?.trim()
      if (mode === 'sentinel' || mode === 'cluster' || /^cluster_enabled:1\r?$/m.test(info)) {
        throw new Error(
          `Redis ${mode === 'sentinel' ? 'Sentinel' : 'Cluster'} is outside this release. Connect to a standalone Redis server; logical database selection is not applied to clusters.`,
        )
      }
      if (!/^redis_version:/m.test(info))
        throw new Error(
          'Unable to establish the Redis deployment mode. This release requires INFO permission and a standalone Redis server.',
        )
      await this.command(live, ['SELECT', String(profile.redisDb)])
      const version = /^redis_version:(.+)$/m.exec(info)?.[1]?.trim()
      live.status = {
        state: 'connected',
        version,
        durationMs: Math.round(performance.now() - started),
        transport: `${profile.ssh.enabled ? 'SSH + ' : ''}${profile.tls.enabled ? (profile.tls.rejectUnauthorized ? 'TLS verified' : 'TLS verification disabled') : 'TCP'}`,
      }
      this.states.set(profile.id, live.status)
      return live.status
    } catch (error) {
      if (client?.isOpen) client.destroy()
      await transport?.close()
      this.connections.delete(profile.id)
      const status: ConnectionStatus = {
        state: 'failed',
        durationMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      }
      this.states.set(profile.id, status)
      return status
    }
  }

  async disconnect(id: string): Promise<void> {
    const live = this.connections.get(id)
    this.connections.delete(id)
    this.states.set(id, { state: 'disconnected' })
    if (!live) return
    if (live.client.isOpen) live.client.destroy()
    await live.transport.close()
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }

  private live(id: string): LiveConnection {
    const live = this.connections.get(id)
    if (!live || !live.client.isReady)
      throw new Error('Redis is disconnected. Connect before running this operation.')
    return live
  }

  private async command(live: LiveConnection, args: (string | Buffer)[]): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        live.client.sendCommand(args),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            live.status = {
              state: 'failed',
              error:
                'Redis command timed out. The connection was closed; a write may have reached the server. Check the value before retrying.',
            }
            // Settle the timeout before destroying the driver, which synchronously rejects its queue.
            reject(new Error(live.status.error))
            if (live.client.isOpen) live.client.destroy()
            void live.transport.close()
          }, live.profile.queryTimeout)
          timer.unref()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private readScriptName(live: LiveConnection): string {
    return Number(live.status.version?.split('.')[0] ?? 7) >= 7 ? 'EVAL_RO' : 'EVAL'
  }

  private boundedRead(live: LiveConnection, args: (string | Buffer)[]): Promise<unknown> {
    return this.command(live, [this.readScriptName(live), BOUNDED_REPLY_SCRIPT, '0', ...args])
  }

  async scan(input: RedisScanInput): Promise<RedisScanResult> {
    const live = this.live(input.connectionId)
    const reply = array(
      await this.boundedRead(live, [
        'SCAN',
        input.cursor,
        'MATCH',
        input.pattern,
        'COUNT',
        String(Math.min(input.count, 1000)),
      ]),
    )
    const unique = [
      ...new Map(array(reply[1]).map((key) => [buffer(key).toString('base64'), buffer(key)])).values(),
    ]
    const keys: RedisKey[] = []
    // Limit queued metadata calls even when COUNT returns more than requested.
    for (let start = 0; start < unique.length; start += 16) {
      const batch = await Promise.all(
        unique.slice(start, start + 16).map(async (key) => {
          const [type, ttl] = await Promise.all([
            this.command(live, ['TYPE', key]),
            this.command(live, ['TTL', key]),
          ])
          return redisKey(key, type, ttl)
        }),
      )
      keys.push(...batch)
    }
    return { cursor: text(reply[0]), keys }
  }

  async inspect(input: RedisInspectInput): Promise<RedisValue> {
    const live = this.live(input.connectionId)
    const key = decodeBase64(input.keyBase64)
    const parts = /^(\d+)(?::(\d+))?$/.exec(input.cursor)
    const stream = /^(\d+-\d+)(?::(\d+))?$/.exec(input.cursor)
    if (!parts && !stream) throw new Error('Invalid Redis collection cursor.')
    const cursor = stream ? stream[1]! : parts![1]!
    const skip = stream ? (stream[2] ?? '0') : (parts![2] ?? '0')
    const reply = array(
      await this.command(live, [
        this.readScriptName(live),
        INSPECT_SCRIPT,
        '1',
        key,
        String(Math.min(input.count, MAX_COLLECTION_ROWS)),
        String(input.offset),
        cursor,
        skip,
        String(MAX_BYTES),
      ]),
    )
    const type = text(reply[0])
    if (!['none', 'string', 'hash', 'list', 'set', 'zset', 'stream'].includes(type))
      throw new Error(`The ${type} Redis module type is not supported by this release.`)
    return {
      key: redisKey(key, reply[0], reply[1]),
      size: Number(text(reply[2])),
      value: redisCell(reply[3]),
      entries: array(reply[4]).map((row) => array(row).map(redisCell)),
      cursor: text(reply[5]),
      truncated: text(reply[6]) === '1',
      ...(type === 'string' && reply[3] !== null ? { rawBase64: buffer(reply[3]).toString('base64') } : {}),
    }
  }

  async mutate(input: RedisMutateInput): Promise<void> {
    const live = this.live(input.connectionId)
    if (live.profile.readOnly)
      throw new Error(
        'This connection is read-only. Enable writes in connection settings before changing a key.',
      )
    const key = decodeBase64(input.keyBase64)
    const value =
      input.valueBase64 !== undefined ? decodeBase64(input.valueBase64) : Buffer.from(input.value ?? '')
    const field = () => {
      if (input.fieldBase64 !== undefined) return decodeBase64(input.fieldBase64)
      if (input.field === undefined) throw new Error('A field, member, or stream entry ID is required.')
      return input.field
    }
    const run = (args: (string | Buffer)[]) => {
      if (input.createOnly) {
        if (!['HSET', 'LPUSH', 'RPUSH', 'SADD', 'ZADD', 'XADD'].includes(String(args[0])))
          throw new Error('This operation cannot create a key.')
        return this.command(live, [
          'EVAL',
          "if redis.call('EXISTS',KEYS[1])==1 then return redis.error_reply('CONFLICT: this key already exists; choose another name') end return redis.call(unpack(ARGV))",
          '1',
          key,
          ...args,
        ])
      }
      return this.command(live, args)
    }
    switch (input.action) {
      case 'set':
        await this.command(live, [
          'EVAL',
          SET_SCRIPT,
          '1',
          key,
          value,
          input.expectedBase64 !== undefined ? '1' : '0',
          input.expectedBase64 !== undefined ? decodeBase64(input.expectedBase64) : '',
          input.ttl !== undefined ? String(input.ttl) : '',
          input.createOnly ? '1' : '0',
        ])
        break
      case 'delete':
        await this.command(live, ['UNLINK', key])
        break
      case 'rename': {
        if (!value.length) throw new Error('A destination key name is required.')
        const result = await this.command(live, ['RENAMENX', key, value])
        if (text(result) !== '1')
          throw new Error('A key already exists at the destination. Rename did not replace it.')
        break
      }
      case 'expire':
        if (input.ttl === undefined) throw new Error('Enter an expiration in seconds.')
        if (text(await this.command(live, ['EXPIRE', key, String(input.ttl)])) !== '1')
          throw new Error('The key no longer exists. Refresh the key browser.')
        break
      case 'persist':
        await this.command(live, ['PERSIST', key])
        break
      case 'hset':
        await run(['HSET', key, field(), value])
        break
      case 'hdel':
        await this.command(live, ['HDEL', key, field()])
        break
      case 'lpush':
        await run(['LPUSH', key, value])
        break
      case 'rpush':
        await run(['RPUSH', key, value])
        break
      case 'lset':
        if (input.index === undefined) throw new Error('A list index is required.')
        await this.command(live, ['LSET', key, String(input.index), value])
        break
      case 'sadd':
        await run(['SADD', key, value])
        break
      case 'srem':
        await this.command(live, ['SREM', key, value])
        break
      case 'zadd':
        if (input.score === undefined) throw new Error('A finite score is required.')
        await run(['ZADD', key, String(input.score), value])
        break
      case 'zrem':
        await this.command(live, ['ZREM', key, value])
        break
      case 'xadd':
        await run(['XADD', key, '*', field(), value])
        break
      case 'xdel':
        if (!/^\d+-\d+$/.test(text(field())))
          throw new Error('Enter a stream entry ID in milliseconds-sequence format.')
        await this.command(live, ['XDEL', key, field()])
        break
    }
  }

  private async guardReply(
    live: LiveConnection,
    command: string,
    args: Buffer[],
    maxRows: number,
  ): Promise<void> {
    const limit = Math.min(maxRows, MAX_COLLECTION_ROWS)
    const numeric = (index: number): number => Number(args[index]?.toString())
    if (['GET', 'MGET'].includes(command)) {
      if (args.length > 201) throw new Error('Read at most 200 string keys in one command.')
      const sizes = await Promise.all(args.slice(1).map((key) => this.command(live, ['STRLEN', key])))
      if (sizes.reduce<number>((total, size) => total + Number(text(size)), 0) > MAX_RESPONSE_BYTES)
        throw new Error(
          'The requested strings exceed the 4 MiB console limit. Use GETRANGE or the bounded key inspector.',
        )
    }
    if (
      command === 'GETRANGE' &&
      (numeric(2) < 0 ||
        numeric(3) < numeric(2) ||
        numeric(3) - numeric(2) >= MAX_BYTES ||
        !Number.isSafeInteger(numeric(3)))
    )
      throw new Error('GETRANGE requires a nonnegative range of at most 1 MiB in this console.')
    if (command === 'HGET' || command === 'HMGET') {
      if (args.length > 202) throw new Error('Read at most 200 hash fields in one command.')
      const sizes = await Promise.all(
        args.slice(2).map((field) => this.command(live, ['HSTRLEN', args[1]!, field])),
      )
      if (sizes.reduce<number>((total, size) => total + Number(text(size)), 0) > MAX_RESPONSE_BYTES)
        throw new Error(
          'The requested hash fields exceed the 4 MiB console limit. Use the bounded key inspector.',
        )
    }
    if (command === 'LRANGE' || command === 'ZRANGE') {
      if (
        !Number.isSafeInteger(numeric(2)) ||
        !Number.isSafeInteger(numeric(3)) ||
        numeric(2) < 0 ||
        numeric(3) < numeric(2) ||
        numeric(3) - numeric(2) >= limit
      )
        throw new Error(`Use a nonnegative rank range of at most ${limit} entries, or use the key inspector.`)
      if (args.slice(4).some((arg) => !['WITHSCORES', 'REV'].includes(arg.toString().toUpperCase())))
        throw new Error(
          'This console supports bounded rank-based ZRANGE. Use the key inspector for collections.',
        )
    }
    if (command === 'XRANGE' || command === 'XREVRANGE') {
      if (
        args.length !== 6 ||
        args[4]?.toString().toUpperCase() !== 'COUNT' ||
        numeric(5) < 1 ||
        numeric(5) > limit ||
        !Number.isInteger(numeric(5))
      )
        throw new Error(`Stream reads require COUNT between 1 and ${limit}.`)
    }
    if (command === 'SCAN') {
      const index = args.findIndex((arg, index) => index > 1 && arg.toString().toUpperCase() === 'COUNT')
      if (
        index >= 0 &&
        (!Number.isInteger(numeric(index + 1)) || numeric(index + 1) < 1 || numeric(index + 1) > 1000)
      )
        throw new Error('SCAN COUNT must be between 1 and 1,000; COUNT is a hint.')
    }
    // A bounded number of collection entries can still contain huge individual values.
    // Refuse raw reads of large collections; the inspector clips them on the server.
    if (['LINDEX', 'LRANGE', 'ZRANGE', 'XRANGE', 'XREVRANGE'].includes(command) && args[1]) {
      const used = Number(text(await this.command(live, ['MEMORY', 'USAGE', args[1]])))
      if (used > MAX_RESPONSE_BYTES)
        throw new Error(
          'This collection is larger than the console response limit. Use the bounded key inspector.',
        )
    }
  }

  async execute(input: QueryInput): Promise<QueryResult> {
    const live = this.live(input.connectionId)
    const args = parseRedisCommand(input.sql)
    const command = assertRedisCommandAllowed(live.profile, args, input.confirm)
    const started = performance.now()
    await this.guardReply(live, command, args, input.maxRows)
    const boundedCommands = [
      'GET',
      'GETRANGE',
      'MGET',
      'HGET',
      'HMGET',
      'LINDEX',
      'LRANGE',
      'ZRANGE',
      'XRANGE',
      'XREVRANGE',
      'SCAN',
    ]
    const reply = await (boundedCommands.includes(command)
      ? this.boundedRead(live, args)
      : this.command(live, args))
    const allRows = Array.isArray(reply) ? reply : [reply]
    let bytes = 0
    let truncated = allRows.length > input.maxRows
    const rows: Cell[][] = []
    for (const row of allRows.slice(0, input.maxRows)) {
      const cell = redisCell(row)
      const size = Buffer.byteLength(JSON.stringify(cell))
      if (bytes + size > MAX_RESPONSE_BYTES) {
        truncated = true
        break
      }
      bytes += size
      rows.push([cell])
    }
    return {
      requestId: input.requestId,
      durationMs: Math.round(performance.now() - started),
      transaction: 'idle',
      sets: [{ columns: [{ name: 'Response', type: 'redis' }], rows, affectedRows: 0, command, truncated }],
      messages: [
        ...(truncated
          ? ['Response display was truncated. Use the key inspector for bounded collection pages.']
          : []),
        ...(command === 'SCAN'
          ? [
              'SCAN COUNT is a hint. Cursors do not measure progress; keys can repeat or change during a scan.',
            ]
          : []),
        ...(live.profile.readOnly
          ? [
              'Application read-only safeguards are active. Restricted Redis ACL credentials remain the security boundary.',
            ]
          : []),
      ],
    }
  }
}
