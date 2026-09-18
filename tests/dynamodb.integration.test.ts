import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  PutItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { profileSchema } from '../src/shared/contracts'
import { dynamoConfirmation, type DynamoRead, type DynamoMutation } from '../src/shared/dynamodb'
import { DynamoService } from '../src/main/engines/dynamodb'
const enabled = process.env.HARBOR_DYNAMODB_FIXTURE === '1',
  service = new DynamoService(),
  table = 'Harbor_' + randomUUID().replaceAll('-', ''),
  credentials = { accessKeyId: 'HarborFixtureKey', secretAccessKey: randomUUID() },
  password = JSON.stringify(credentials),
  profile = profileSchema.parse({
    id: randomUUID(),
    name: 'DynamoDB Local fixture',
    engine: 'dynamodb',
    host: '127.0.0.1',
    port: 18000,
    readOnly: false,
    queryTimeout: 5000,
    dynamo: { region: 'us-east-1', accountId: '', local: true },
  })
const control = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:18000',
  credentials,
  maxAttempts: 1,
  ignoreConfiguredEndpointUrls: true,
})
const read = (extra: Partial<DynamoRead> = {}) =>
  service.read({
    connectionId: profile.id,
    sessionId: randomUUID(),
    requestId: randomUUID(),
    table,
    index: '',
    mode: 'query',
    partition: '{"S":"group"}',
    sortOperator: 'none',
    sortValues: '[]',
    consistent: true,
    descending: false,
    allowScan: false,
    limit: 25,
    ...extra,
  })
const mutate = (extra: Partial<DynamoMutation> = {}) =>
  service.mutate({
    connectionId: profile.id,
    sessionId: randomUUID(),
    requestId: randomUUID(),
    table,
    mode: 'create',
    key: '{"pk":{"S":"write"},"sk":{"N":"1"}}',
    item: '{"pk":{"S":"write"},"sk":{"N":"1"},"version":{"N":"1"}}',
    expected: '{}',
    absent: [],
    remove: [],
    confirm: dynamoConfirmation(profile.id, table),
    ...extra,
  })
async function proxy(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void) {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
function forward(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  onResponse?: (incoming: http.IncomingMessage) => void,
) {
  const upstream = http.request(
    { host: '127.0.0.1', port: 18000, path: request.url, method: request.method, headers: request.headers },
    (incoming) => {
      if (onResponse) onResponse(incoming)
      else {
        response.writeHead(incoming.statusCode!, incoming.headers)
        incoming.pipe(response)
      }
    },
  )
  upstream.on('error', () => response.destroy())
  request.pipe(upstream)
}
describe.skipIf(!enabled)('DynamoDB Local native conditional and partition workflow', () => {
  beforeAll(async () => {
    await control.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'N' },
          { AttributeName: 'gpk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'ByGroup',
            KeySchema: [
              { AttributeName: 'gpk', KeyType: 'HASH' },
              { AttributeName: 'sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    )
    for (let batch = 0; batch < 60; batch += 4)
      await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          control.send(
            new PutItemCommand({
              TableName: table,
              Item: {
                pk: { S: 'group' },
                sk: { N: String(batch + index) },
                gpk: { S: 'index-group' },
                exact: { N: '90071992547409931234567890123456789012' },
                text: { S: 'سلام 🌊' },
                bytes: { B: Uint8Array.from([0, 255, 128]) },
                set: { NS: ['1', '9007199254740993'] },
                strings: { SS: ['a', 'ب'] },
                binaries: { BS: [Uint8Array.from([1]), Uint8Array.from([2])] },
                nested: { M: { list: { L: [{ NULL: true }, { BOOL: false }, { S: '' }] } } },
              },
            }),
          ),
        ),
      )
    const status = await service.connect(profile, { password })
    expect(status.state, status.error).toBe('connected')
    expect(status.version).toContain('emulator')
  }, 30000)
  afterAll(async () => {
    await service.closeAll()
    await control.send(new DeleteTableCommand({ TableName: table }))
    control.destroy()
  })
  it('inspects native table/index keys and preserves all AttributeValue types', async () => {
    expect((await service.tables({ connectionId: profile.id })).tables).toContain(table)
    const meta = await service.table({ connectionId: profile.id, table })
    expect(meta.partition).toEqual({ name: 'pk', type: 'S' })
    expect(meta.indexes[0]).toMatchObject({
      name: 'ByGroup',
      global: true,
      partition: { name: 'gpk', type: 'S' },
    })
    const page = await read({ sortOperator: 'eq', sortValues: '[{"N":"1"}]' })
    expect(page.count).toBe(1)
    const item = JSON.parse(page.items[0]!)
    expect(item.exact.N).toBe('90071992547409931234567890123456789012')
    expect(item.bytes.B).toBe('AP+A')
    expect(item.binaries.BS).toEqual(['AQ==', 'Ag=='])
    expect(item.set.NS).toContain('9007199254740993')
    expect(item.text.S).toBe('سلام 🌊')
    expect(item.nested.M.list.L).toEqual([{ NULL: true }, { BOOL: false }, { S: '' }])
    expect(page.capacity).toContain('CapacityUnits')
    expect(page.warning).toContain('not a billed')
  })
  it('pages exact partition/sort queries without scanning and rejects cross-session/replayed cursors', async () => {
    const sessionId = randomUUID()
    let page = await read({
      sessionId,
      limit: 10,
      sortOperator: 'between',
      sortValues: '[{"N":"10"},{"N":"34"}]',
      descending: true,
    })
    expect(JSON.parse(page.items[0]!).sk.N).toBe('34')
    const first = page.cursor!
    await expect(
      service.next({
        connectionId: profile.id,
        sessionId: randomUUID(),
        requestId: randomUUID(),
        cursor: first,
      }),
    ).rejects.toThrow('belongs')
    let count = page.count
    while (page.cursor) {
      page = await service.next({
        connectionId: profile.id,
        sessionId,
        requestId: randomUUID(),
        cursor: page.cursor,
      })
      count += page.count
    }
    expect(count).toBe(25)
    await expect(
      service.next({ connectionId: profile.id, sessionId, requestId: randomUUID(), cursor: first }),
    ).rejects.toThrow('expired')
  })
  it('requires scan consent and enforces GSI consistency, typed keys and ten-page traversal bound', async () => {
    await expect(read({ mode: 'scan' })).rejects.toThrow('consent')
    await expect(
      read({ index: 'ByGroup', partition: '{"S":"index-group"}', consistent: true }),
    ).rejects.toThrow('eventually')
    const indexed = await read({
      index: 'ByGroup',
      partition: '{"S":"index-group"}',
      consistent: false,
      sortOperator: 'eq',
      sortValues: '[{"N":"2"}]',
    })
    expect(indexed.count).toBe(1)
    await expect(read({ partition: '{"N":"1"}' })).rejects.toThrow('requires native S')
    const sessionId = randomUUID()
    let page = await read({ mode: 'scan', allowScan: true, sessionId, limit: 1 })
    for (let i = 1; i < 10; i++)
      page = await service.next({
        connectionId: profile.id,
        sessionId,
        requestId: randomUUID(),
        cursor: page.cursor!,
      })
    expect(page.pages).toBe(10)
    expect(page.cursor).toBeUndefined()
    expect(page.warning).toContain('stopped at 10 pages')
  })
  it('creates only absent keys and applies native conditional patches without losing concurrent fields', async () => {
    expect((await mutate()).acknowledged).toBe(true)
    await expect(mutate()).rejects.toThrow('condition failed')
    expect(
      (
        await mutate({
          mode: 'patch',
          item: '{"version":{"N":"2"},"name":{"S":"updated"}}',
          expected: '{"version":{"N":"1"}}',
        })
      ).acknowledged,
    ).toBe(true)
    await expect(
      mutate({ mode: 'patch', item: '{"name":{"S":"stale overwrite"}}', expected: '{"version":{"N":"1"}}' }),
    ).rejects.toThrow('condition failed')
    const current = await control.send(
      new GetItemCommand({
        TableName: table,
        Key: { pk: { S: 'write' }, sk: { N: '1' } },
        ConsistentRead: true,
      }),
    )
    expect(current.Item?.name?.S).toBe('updated')
    expect(current.Item?.version?.N).toBe('2')
    await expect(
      mutate({ mode: 'patch', item: '{"sk":{"N":"9"}}', expected: '{"version":{"N":"2"}}' }),
    ).rejects.toThrow('Primary keys')
    await expect(mutate({ mode: 'delete', expected: '{}' })).rejects.toThrow('at least one')
    await expect(mutate({ mode: 'delete', expected: '{"version":{"N":"1"}}' })).rejects.toThrow(
      'condition failed',
    )
    expect((await mutate({ mode: 'delete', expected: '{"version":{"N":"2"}}' })).acknowledged).toBe(true)
    expect(
      (
        await control.send(
          new GetItemCommand({ TableName: table, Key: { pk: { S: 'write' }, sk: { N: '1' } } }),
        )
      ).Item,
    ).toBeUndefined()
  })
  it('supports native REMOVE guarded by absence without an empty values expression', async () => {
    await mutate({
      key: '{"pk":{"S":"remove"},"sk":{"N":"1"}}',
      item: '{"pk":{"S":"remove"},"sk":{"N":"1"},"temporary":{"S":"remove me"}}',
    })
    expect(
      (
        await mutate({
          mode: 'patch',
          key: '{"pk":{"S":"remove"},"sk":{"N":"1"}}',
          item: '{}',
          expected: '{}',
          absent: ['unexpected'],
          remove: ['temporary'],
        })
      ).acknowledged,
    ).toBe(true)
    const result = await control.send(
      new GetItemCommand({ TableName: table, Key: { pk: { S: 'remove' }, sk: { N: '1' } } }),
    )
    expect(result.Item?.temporary).toBeUndefined()
  })
  it('fails closed for incomplete explicit credentials, wrong endpoints, local read-only and malformed types', async () => {
    const bad = await service.connect({ ...profile, id: randomUUID() }, {})
    expect(bad.state).toBe('failed')
    expect(bad.error).toContain('explicit AWS')
    expect(
      (await service.connect({ ...profile, id: randomUUID(), host: 'example.com' }, { password })).state,
    ).toBe('failed')
    const ro = { ...profile, id: randomUUID(), readOnly: true }
    expect((await service.connect(ro, { password })).state).toBe('connected')
    await expect(mutate({ connectionId: ro.id, confirm: dynamoConfirmation(ro.id, table) })).rejects.toThrow(
      'writable',
    )
    await expect(mutate({ confirm: 'wrong' })).rejects.toThrow('confirmation')
    await expect(read({ partition: '{"S":"group","S":"other"}' })).rejects.toThrow('duplicate')
    await expect(read({ partition: '{"B":"not base64"}' })).rejects.toThrow('base64')
    await service.disconnect(ro.id)
  })
  it('aborts a paused native HTTP request and recovers without retries', async () => {
    let pause = false,
      requests = 0,
      notify!: () => void
    const arrived = new Promise<void>((resolve) => (notify = resolve))
    const wire = await proxy((req, res) => {
      if (pause && String(req.headers['x-amz-target']).endsWith('.Query')) {
        requests++
        notify()
        return
      }
      forward(req, res)
    })
    const p = { ...profile, id: randomUUID(), port: wire.port }
    try {
      expect((await service.connect(p, { password })).state).toBe('connected')
      pause = true
      const sessionId = randomUUID(),
        requestId = randomUUID()
      const pending = read({ connectionId: p.id, sessionId, requestId }).then(
        () => '',
        (error) => String(error),
      )
      await arrived
      expect((await service.cancel({ connectionId: p.id, sessionId, requestId: 'wrong' })).requested).toBe(
        false,
      )
      expect((await service.cancel({ connectionId: p.id, sessionId, requestId })).requested).toBe(true)
      expect(await pending).toContain('No request was replayed')
      expect(requests).toBe(1)
      pause = false
      expect((await read({ connectionId: p.id, sortOperator: 'eq', sortValues: '[{"N":"1"}]' })).count).toBe(
        1,
      )
    } finally {
      await service.disconnect(p.id)
      await wire.close()
    }
  })
  it('admits four live requests and rejects excess work before native Query dispatch', async () => {
    let paused = false,
      count = 0,
      notify!: () => void
    const arrived = new Promise<void>((resolve) => (notify = resolve))
    const wire = await proxy((req, res) => {
      if (paused && String(req.headers['x-amz-target']).endsWith('.Query')) {
        if (++count === 4) notify()
        return
      }
      forward(req, res)
    })
    const p = { ...profile, id: randomUUID(), port: wire.port }
    try {
      expect((await service.connect(p, { password })).state).toBe('connected')
      paused = true
      const inputs = Array.from({ length: 4 }, () => ({
          connectionId: p.id,
          sessionId: randomUUID(),
          requestId: randomUUID(),
        })),
        pending = inputs.map((input) => read(input).catch((error) => String(error)))
      await arrived
      await expect(read({ connectionId: p.id })).rejects.toThrow('Four DynamoDB requests')
      expect(count).toBe(4)
      await Promise.all(inputs.map((input) => service.cancel(input)))
      await Promise.all(pending)
      paused = false
      expect((await read({ connectionId: p.id, sortOperator: 'eq', sortValues: '[{"N":"1"}]' })).count).toBe(
        1,
      )
    } finally {
      await service.disconnect(p.id)
      await wire.close()
    }
  })
  it('reports a lost native write acknowledgment as uncertain and never replays the persisted create', async () => {
    let writes = 0
    const wire = await proxy((req, res) => {
      if (String(req.headers['x-amz-target']).endsWith('.PutItem')) {
        writes++
        forward(req, res, (incoming) => {
          incoming.resume()
          incoming.on('end', () => res.destroy())
        })
      } else forward(req, res)
    })
    const p = { ...profile, id: randomUUID(), port: wire.port }
    try {
      expect((await service.connect(p, { password })).state).toBe('connected')
      await expect(
        mutate({
          connectionId: p.id,
          confirm: dynamoConfirmation(p.id, table),
          key: '{"pk":{"S":"lost"},"sk":{"N":"1"}}',
          item: '{"pk":{"S":"lost"},"sk":{"N":"1"}}',
        }),
      ).rejects.toThrow('uncertain')
      expect(writes).toBe(1)
      const result = await control.send(
        new GetItemCommand({
          TableName: table,
          Key: { pk: { S: 'lost' }, sk: { N: '1' } },
          ConsistentRead: true,
        }),
      )
      expect(result.Item?.pk?.S).toBe('lost')
    } finally {
      await service.disconnect(p.id)
      await wire.close()
    }
  })
  it('reports an oversized native write response as uncertain after the item persisted', async () => {
    let writes = 0
    const wire = await proxy((req, res) => {
      if (String(req.headers['x-amz-target']).endsWith('.PutItem')) {
        writes++
        forward(req, res, (incoming) => {
          incoming.resume()
          incoming.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/x-amz-json-1.0' })
            res.end('x'.repeat(9 * 1024 * 1024))
          })
        })
      } else forward(req, res)
    })
    const p = { ...profile, id: randomUUID(), port: wire.port }
    try {
      expect((await service.connect(p, { password })).state).toBe('connected')
      await expect(
        mutate({
          connectionId: p.id,
          confirm: dynamoConfirmation(p.id, table),
          key: '{"pk":{"S":"oversized"},"sk":{"N":"1"}}',
          item: '{"pk":{"S":"oversized"},"sk":{"N":"1"}}',
        }),
      ).rejects.toThrow('uncertain')
      expect(writes).toBe(1)
      expect(
        (
          await control.send(
            new GetItemCommand({
              TableName: table,
              Key: { pk: { S: 'oversized' }, sk: { N: '1' } },
              ConsistentRead: true,
            }),
          )
        ).Item?.pk?.S,
      ).toBe('oversized')
    } finally {
      await service.disconnect(p.id)
      await wire.close()
    }
  })
  it('bounds raw response bytes before SDK deserialization', async () => {
    let oversized = false
    const wire = await proxy((req, res) => {
      if (oversized && String(req.headers['x-amz-target']).endsWith('.Query')) {
        res.writeHead(200, { 'Content-Type': 'application/x-amz-json-1.0' })
        res.end('x'.repeat(9 * 1024 * 1024))
      } else forward(req, res)
    })
    const p = { ...profile, id: randomUUID(), port: wire.port }
    try {
      expect((await service.connect(p, { password })).state).toBe('connected')
      oversized = true
      await expect(read({ connectionId: p.id })).rejects.toThrow('8 MiB')
    } finally {
      await service.disconnect(p.id)
      await wire.close()
    }
  })
})
