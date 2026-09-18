import { createClient, createCluster, createSentinel, RESP_TYPES } from 'redis'
import { checkServerIdentity } from 'node:tls'
import type { ConnectionProfile, Secrets } from '../../shared/contracts'
import { redisHashSlot, type RedisTopologySnapshot } from '../../shared/redis-topology'
import { openTransport, tlsOptions, type Transport } from './transport'

export interface RedisWireClient {
  readonly isOpen: boolean
  readonly isReady: boolean
  connect(): Promise<unknown>
  destroy(): void | Promise<void>
  sendCommand(args: (string | Buffer)[]): Promise<unknown>
  on(event: string, callback: (...args: unknown[]) => void): unknown
  topology(): RedisTopologySnapshot
  scanNodes?(): string[]
  sendToNode?(address: string, args: (string | Buffer)[]): Promise<unknown>
}
const mapping = {
  [RESP_TYPES.BLOB_STRING]: Buffer,
  [RESP_TYPES.NUMBER]: String,
  [RESP_TYPES.BIG_NUMBER]: String,
  [RESP_TYPES.DOUBLE]: String,
}
const noKey = new Set(['PING', 'ECHO', 'DBSIZE', 'TIME', 'INFO', 'SCAN', 'SELECT', 'FLUSHDB', 'FLUSHALL'])

/** Only the workbench's allowlisted commands reach this extractor. Unknown keys fail closed. */
export function redisCommandKeys(args: (string | Buffer)[]): Buffer[] {
  const name = String(args[0]).toUpperCase()
  if (noKey.has(name)) return []
  if (name === 'MEMORY') return args[2] === undefined ? [] : [Buffer.from(args[2])]
  if (name === 'XINFO') return args[2] === undefined ? [] : [Buffer.from(args[2])]
  if (name === 'EVAL' || name === 'EVAL_RO') {
    const count = Number(String(args[2]))
    if (!Number.isSafeInteger(count) || count < 0 || count > 2000 || args.length < 3 + count)
      throw new Error('Invalid script key declaration.')
    return args.slice(3, 3 + count).map((key) => Buffer.from(key))
  }
  if (['MGET', 'DEL', 'UNLINK', 'EXISTS'].includes(name)) return args.slice(1).map((key) => Buffer.from(key))
  if (name === 'MSET' || name === 'MSETNX')
    return args
      .slice(1)
      .filter((_key, index) => index % 2 === 0)
      .map((key) => Buffer.from(key))
  if (['RENAME', 'RENAMENX', 'SMOVE'].includes(name)) return args.slice(1, 3).map((key) => Buffer.from(key))
  return args[1] === undefined ? [] : [Buffer.from(args[1])]
}
export function enforceRedisSlot(args: (string | Buffer)[]): Buffer | undefined {
  const keys = redisCommandKeys(args)
  if (keys.some((key) => redisHashSlot(key) !== redisHashSlot(keys[0]!)))
    throw new Error(
      'CROSSSLOT: all keys in one operation must share a hash slot. Use a shared {hash-tag}; Harbor never splits a write across nodes.',
    )
  return keys[0]
}

export async function redisWire(
  profile: ConnectionProfile,
  secrets: Secrets,
): Promise<{ client: RedisWireClient; transport: Transport }> {
  const mode = profile.redis.mode
  const common = {
    username: profile.username || undefined,
    password: secrets.password,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 256,
  }
  const limits = { connectTimeout: profile.connectTimeout, reconnectStrategy: false as const }
  const snapshot = (
    nodes: RedisTopologySnapshot['nodes'],
    limitations: string[] = [],
  ): RedisTopologySnapshot => ({
    mode,
    nodes,
    checkedAt: new Date().toISOString(),
    limitations,
    ...(mode === 'sentinel' ? { serviceName: profile.redis.serviceName } : {}),
  })
  if (mode === 'standalone') {
    const transport = await openTransport(profile, secrets)
    const native = createClient({
      ...common,
      socket: {
        ...limits,
        host: transport.host,
        port: transport.port,
        ...(transport.tls ? { tls: true as const, ...transport.tls } : {}),
      },
      commandOptions: { typeMapping: mapping },
    })
    const client = native as unknown as RedisWireClient
    client.topology = () =>
      snapshot([{ address: `${profile.host}:${profile.port}`, role: 'primary', ready: native.isReady }])
    return { client, transport }
  }
  if (profile.ssh.enabled)
    throw new Error(
      'Redis topology discovery requires direct access to each node. Single-host SSH tunnels are not supported for Cluster or Sentinel; use trusted reachable endpoints or address mappings.',
    )
  if (mode === 'cluster' && profile.redisDb !== 0)
    throw new Error('Redis Cluster only supports database 0. Change the logical database before connecting.')
  if (mode === 'sentinel' && !profile.redis.serviceName) throw new Error('Enter the Sentinel service name.')
  const tls = await tlsOptions(profile)
  // A discovered node is checked against its own connected hostname, never the seed hostname.
  if (tls) {
    delete tls.servername
    tls.checkServerIdentity = checkServerIdentity
  }
  const socket = { ...limits, ...(tls ? { tls: true as const, ...tls } : {}) }
  const seeds = profile.redis.seeds.length
    ? profile.redis.seeds
    : [{ host: profile.host, port: profile.port }]
  const addressMap = Object.fromEntries(
    profile.redis.addressMap.map(({ discovered, host, port }) => [discovered, { host, port }]),
  )
  const transport = { host: profile.host, port: profile.port, close: async () => {} }
  if (mode === 'cluster') {
    const native = createCluster({
      rootNodes: seeds.map(({ host, port }) => ({ ...common, socket: { ...socket, host, port } })),
      defaults: { ...common, socket },
      commandOptions: { typeMapping: mapping },
      useReplicas: true,
      maxCommandRedirections: 8,
      topologyRefreshOnReconnectionAttemptStrategy: false,
      nodeAddressMap: addressMap,
    })
    const client: RedisWireClient = {
      get isOpen() {
        return native.isOpen
      },
      get isReady() {
        return native.isReady
      },
      connect: () => native.connect(),
      destroy: () => native.destroy(),
      on: (event, callback) => native.on(event, callback),
      sendCommand: (args) => {
        if (['SELECT', 'FLUSHDB', 'FLUSHALL', 'SCAN'].includes(String(args[0]).toUpperCase()))
          throw new Error(
            'This command is unavailable in Cluster. Use the node-aware key browser for SCAN; whole-cluster flush is intentionally unavailable.',
          )
        const key = enforceRedisSlot(args)
        return native.sendCommand(key, false, args)
      },
      scanNodes: () => native.masters.map((node) => node.address).sort(),
      sendToNode: async (address, args) => {
        const node = native.masters.find((entry) => entry.address === address)
        if (!node) throw new Error('Cluster topology changed. Restart the scan; its results are incomplete.')
        return (await native.nodeClient(node)).sendCommand(args, { typeMapping: mapping })
      },
      topology: () => {
        const counts = new Map<string, number>()
        for (const slot of native.slots)
          if (slot) counts.set(slot.master.address, (counts.get(slot.master.address) ?? 0) + 1)
        return snapshot(
          [
            ...native.masters.map((node) => ({
              address: node.address,
              role: 'primary' as const,
              ready: node.client?.isReady ?? false,
              slots: counts.get(node.address) ?? 0,
            })),
            ...native.replicas.map((node) => ({
              address: node.address,
              role: 'replica' as const,
              ready: node.client?.isReady ?? false,
              slots: 0,
            })),
          ],
          [
            'Reads use primaries. Multi-key commands must use one hash slot.',
            'SCAN is incremental, not a consistent snapshot. A topology change invalidates its cursor.',
            'Keyless console commands report one node. Use topology navigation for the full node list.',
            'Only explicit MOVED/ASK replies are redirected. Uncertain writes are never replayed.',
          ],
        )
      },
    }
    return { client, transport }
  }
  const native = createSentinel({
    name: profile.redis.serviceName,
    sentinelRootNodes: seeds,
    nodeClientOptions: { ...common, socket, database: profile.redisDb },
    sentinelClientOptions: {
      ...common,
      username: profile.redis.sentinelUsername || undefined,
      password: secrets.sentinelPassword,
      socket,
    },
    nodeAddressMap: addressMap,
    commandOptions: { typeMapping: mapping },
    maxCommandRediscovers: 0,
    masterPoolSize: 1,
    replicaPoolSize: 0,
    scanInterval: 2000,
    passthroughClientErrorEvents: true,
  })
  const client: RedisWireClient = {
    get isOpen() {
      return native.isOpen
    },
    get isReady() {
      return native.isReady
    },
    connect: () => native.connect(),
    destroy: () => native.destroy(),
    on: (event, callback) => native.on(event, callback),
    sendCommand: (args) => native.sendCommand(false, args),
    scanNodes: () => {
      const primary = native.getMasterNode()
      return primary ? [`${primary.host}:${primary.port}`] : []
    },
    sendToNode: (address, args) => {
      const primary = native.getMasterNode()
      if (!primary || address !== `${primary.host}:${primary.port}`)
        throw new Error('Sentinel primary changed. Restart the scan; prior results are incomplete.')
      return native.sendCommand(false, args)
    },
    topology: () => {
      const primary = native.getMasterNode(),
        sentinel = native.getSentinelNode()
      return snapshot(
        [
          ...(primary
            ? [
                {
                  address: `${primary.host}:${primary.port}`,
                  role: 'primary' as const,
                  ready: native.isReady,
                },
              ]
            : []),
          ...[...native.getReplicaNodes().keys()].map((node) => ({
            address: `${node.host}:${node.port}`,
            role: 'replica' as const,
            ready: false,
          })),
          ...(sentinel
            ? [
                {
                  address: `${sentinel.host}:${sentinel.port}`,
                  role: 'sentinel' as const,
                  ready: native.isReady,
                },
              ]
            : []),
        ],
        [
          'Reads and writes use the current primary. Replica readiness is not probed.',
          'Sentinel discovery runs only while this profile is connected. Failed commands are not replayed; retry explicitly after checking uncertain writes.',
          'Failover can lose asynchronously replicated data. SCAN is not a consistent snapshot.',
        ],
      )
    },
  }
  return { client, transport }
}
