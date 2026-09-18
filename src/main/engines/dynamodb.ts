import {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
  QueryCommand,
  ScanCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  type AttributeValue,
  type QueryCommandInput,
  type KeySchemaElement,
} from '@aws-sdk/client-dynamodb'
import { randomUUID } from 'node:crypto'
import type { ConnectionProfile, ConnectionStatus, Secrets } from '../../shared/contracts'
import {
  dynamoReadSchema,
  dynamoNextSchema,
  dynamoMutationSchema,
  dynamoConfirmation,
  type DynamoRead,
  type DynamoMutation,
  type DynamoPage,
  type DynamoTable,
} from '../../shared/dynamodb'
import { dynamoClient } from './dynamodb-http'
import { attributes, encodeAttributes, singleAttribute, json, DynamoInputError } from './dynamodb-values'
interface Cursor {
  session: string
  input: DynamoRead
  key: Record<string, AttributeValue>
  identity: string
  pages: number
  evaluated: number
  bytes: number
  expires: number
}
interface Live {
  profile: ConnectionProfile
  client: DynamoDBClient
  status: ConnectionStatus
  active: Map<string, { session: string; request: string; abort: AbortController }>
  cursors: Map<string, Cursor>
}
function failure(error: unknown, mutation = false): Error {
  if (error instanceof DynamoInputError)
    return mutation
      ? new DynamoInputError(
          error.message +
            ' The submitted write outcome is uncertain; inspect the exact item before retrying. No request was replayed.',
        )
      : error
  const name =
    error &&
    typeof error === 'object' &&
    'name' in error &&
    typeof error.name === 'string' &&
    /^[A-Za-z0-9_.]{1,100}$/.test(error.name)
      ? error.name
      : 'connection_or_request_failure'
  if (name === 'ConditionalCheckFailedException')
    return new DynamoInputError(
      'DynamoDB condition failed. The item was not changed. Refresh and review its current attributes.',
    )
  const rejected = [
    'ValidationException',
    'AccessDeniedException',
    'ResourceNotFoundException',
    'UnrecognizedClientException',
    'InvalidSignatureException',
  ].includes(name)
  return new DynamoInputError(
    `DynamoDB operation failed (${name}). ${mutation && !rejected ? 'The write outcome is uncertain; inspect the exact item before retrying. ' : ''}No request was replayed.`,
  )
}
export class DynamoService {
  private connections = new Map<string, Live>()
  private states = new Map<string, ConnectionStatus>()
  private generations = new Map<string, number>()
  status(id: string): ConnectionStatus {
    return this.connections.get(id)?.status || this.states.get(id) || { state: 'disconnected' }
  }
  async connect(profile: ConnectionProfile, secrets: Secrets = {}): Promise<ConnectionStatus> {
    if (profile.engine !== 'dynamodb') throw new DynamoInputError('Use a DynamoDB profile.')
    await this.disconnect(profile.id)
    const generation = this.generations.get(profile.id),
      started = performance.now()
    let client: DynamoDBClient | undefined
    try {
      client = dynamoClient(profile, secrets)
      await client.send(new ListTablesCommand({ Limit: 1 }), {
        abortSignal: AbortSignal.timeout(profile.connectTimeout),
      })
      if (this.generations.get(profile.id) !== generation) {
        client.destroy()
        return { state: 'disconnected' }
      }
      const status: ConnectionStatus = {
        state: 'connected',
        version: profile.dynamo.local
          ? 'DynamoDB Local (emulator; IAM and capacity not verified)'
          : 'Amazon DynamoDB (regional API; account checked per table)',
        durationMs: Math.round(performance.now() - started),
        transport: profile.dynamo.local ? 'Loopback HTTP' : 'Verified TLS + explicit AWS signing',
        lastConnectedAt: new Date().toISOString(),
      }
      this.connections.set(profile.id, { profile, client, status, active: new Map(), cursors: new Map() })
      return status
    } catch (error) {
      client?.destroy()
      const status: ConnectionStatus = { state: 'failed', error: failure(error).message }
      if (this.generations.get(profile.id) === generation) this.states.set(profile.id, status)
      return status
    }
  }
  private live(id: string): Live {
    const live = this.connections.get(id)
    if (!live) throw new DynamoInputError('Connect to DynamoDB first.')
    for (const [key, cursor] of live.cursors) if (cursor.expires < Date.now()) live.cursors.delete(key)
    return live
  }
  private async operation<T>(
    live: Live,
    session: string,
    request: string,
    work: (signal: AbortSignal) => Promise<T>,
    mutation = false,
  ): Promise<T> {
    if (live.active.size >= 4)
      throw new DynamoInputError('Four DynamoDB requests are already active. Wait before retrying.')
    if ([...live.active.values()].some((active) => active.session === session))
      throw new DynamoInputError('Wait for the current request in this workspace.')
    const token = randomUUID(),
      abort = new AbortController()
    live.active.set(token, { session, request, abort })
    const timer = setTimeout(() => abort.abort(), Math.min(live.profile.queryTimeout, 60000))
    try {
      return await work(abort.signal)
    } catch (error) {
      throw failure(error, mutation)
    } finally {
      clearTimeout(timer)
      live.active.delete(token)
    }
  }
  async tables(input: { connectionId: string; after?: string }) {
    const live = this.live(input.connectionId)
    return this.operation(live, randomUUID(), randomUUID(), async (signal) => {
      const result = await live.client.send(
        new ListTablesCommand({ Limit: 100, ExclusiveStartTableName: input.after }),
        { abortSignal: signal },
      )
      return { tables: result.TableNames || [], after: result.LastEvaluatedTableName }
    })
  }
  private async describe(live: Live, name: string, signal: AbortSignal): Promise<DynamoTable> {
    const raw = (
      await live.client.send(new DescribeTableCommand({ TableName: name }), { abortSignal: signal })
    ).Table
    if (!raw?.TableArn || !raw.KeySchema)
      throw new DynamoInputError('DynamoDB did not return a complete table identity.')
    if (!live.profile.dynamo.local) {
      const parts = raw.TableArn.split(':')
      if (parts[4] !== live.profile.dynamo.accountId || parts[3] !== live.profile.dynamo.region)
        throw new DynamoInputError(
          'Table account or region differs from the reviewed profile. No item request was sent.',
        )
    }
    const keys = (schema: KeySchemaElement[] | undefined) => {
      const key = (kind: string) => {
        const field = schema?.find((item) => item.KeyType === kind)?.AttributeName
        return field
          ? {
              name: field,
              type:
                raw.AttributeDefinitions?.find((attr) => attr.AttributeName === field)?.AttributeType || '',
            }
          : undefined
      }
      const partition = key('HASH')
      if (!partition) throw new DynamoInputError('Table or index has no usable partition key.')
      return { partition, sort: key('RANGE') }
    }
    return {
      name: raw.TableName || name,
      arn: raw.TableArn,
      identity: raw.TableArn + '|' + raw.CreationDateTime?.getTime(),
      ...keys(raw.KeySchema),
      indexes: [
        ...(raw.GlobalSecondaryIndexes || []).map((index) => ({
          name: index.IndexName!,
          global: true,
          ...keys(index.KeySchema),
        })),
        ...(raw.LocalSecondaryIndexes || []).map((index) => ({
          name: index.IndexName!,
          global: false,
          ...keys(index.KeySchema),
        })),
      ],
      status: raw.TableStatus || 'unknown',
      capacityMode: raw.BillingModeSummary?.BillingMode || 'PROVISIONED',
      readCapacity: raw.ProvisionedThroughput?.ReadCapacityUnits,
      writeCapacity: raw.ProvisionedThroughput?.WriteCapacityUnits,
      local: live.profile.dynamo.local,
    }
  }
  async table(input: { connectionId: string; table: string }) {
    const live = this.live(input.connectionId)
    return this.operation(live, randomUUID(), randomUUID(), (signal) =>
      this.describe(live, input.table, signal),
    )
  }
  async read(raw: DynamoRead): Promise<DynamoPage> {
    const input = dynamoReadSchema.parse(raw),
      live = this.live(input.connectionId)
    if (input.mode === 'scan' && !input.allowScan)
      throw new DynamoInputError('Scan requires explicit full-table/index scan consent.')
    if ([...live.cursors.values()].some((cursor) => cursor.session === input.sessionId))
      throw new DynamoInputError('Close the existing DynamoDB cursor before another request.')
    if (live.cursors.size + live.active.size >= 20)
      throw new DynamoInputError('Close an existing DynamoDB cursor before starting another.')
    return this.operation(live, input.sessionId, input.requestId, async (signal) => {
      const table = await this.describe(live, input.table, signal)
      return this.page(
        live,
        {
          session: input.sessionId,
          input,
          key: {},
          identity: table.identity,
          pages: 0,
          evaluated: 0,
          bytes: 0,
          expires: Date.now() + 600000,
        },
        table,
        signal,
      )
    })
  }
  async next(raw: Parameters<import('../../shared/dynamodb').DynamoAPI['dynamoNext']>[0]) {
    const input = dynamoNextSchema.parse(raw),
      live = this.live(input.connectionId),
      cursor = live.cursors.get(input.cursor)
    if (!cursor || cursor.session !== input.sessionId)
      throw new DynamoInputError('This DynamoDB cursor expired, closed or belongs to another workspace.')
    live.cursors.delete(input.cursor)
    return this.operation(live, input.sessionId, input.requestId, async (signal) => {
      const table = await this.describe(live, cursor.input.table, signal)
      if (table.identity !== cursor.identity)
        throw new DynamoInputError('The DynamoDB table was replaced. Start a fresh query.')
      return this.page(live, cursor, table, signal)
    })
  }
  private async page(
    live: Live,
    cursor: Cursor,
    table: DynamoTable,
    signal: AbortSignal,
  ): Promise<DynamoPage> {
    const input = cursor.input,
      index = input.index ? table.indexes.find((index) => index.name === input.index) : undefined
    if (input.index && !index) throw new DynamoInputError('Choose an existing index.')
    if (index?.global && input.consistent)
      throw new DynamoInputError('Global secondary indexes support eventually consistent reads only.')
    const target = index || table
    const command: QueryCommandInput = {
      TableName: input.table,
      IndexName: input.index || undefined,
      ConsistentRead: input.consistent,
      Limit: Math.min(input.limit, 1000 - cursor.evaluated),
      ExclusiveStartKey: Object.keys(cursor.key).length ? cursor.key : undefined,
      ReturnConsumedCapacity: 'INDEXES',
    }
    if (input.mode === 'query') {
      const partition = singleAttribute(input.partition)
      this.keyType(partition, target.partition)
      command.KeyConditionExpression = '#pk = :pk'
      command.ExpressionAttributeNames = { '#pk': target.partition.name }
      command.ExpressionAttributeValues = { ':pk': partition }
      command.ScanIndexForward = !input.descending
      if (input.sortOperator !== 'none') {
        if (!target.sort) throw new DynamoInputError('This table/index has no sort key.')
        const values = json(input.sortValues)
        if (!Array.isArray(values) || values.length !== (input.sortOperator === 'between' ? 2 : 1))
          throw new DynamoInputError('Supply one typed sort value, or two for between.')
        const attrs = values.map((value) => singleAttribute(JSON.stringify(value)))
        attrs.forEach((value) => this.keyType(value, target.sort!))
        command.ExpressionAttributeNames['#sk'] = target.sort.name
        command.ExpressionAttributeValues[':sk0'] = attrs[0]!
        if (attrs[1]) command.ExpressionAttributeValues[':sk1'] = attrs[1]
        const op = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[input.sortOperator as 'eq']
        command.KeyConditionExpression +=
          ' AND ' +
          (input.sortOperator === 'between'
            ? '#sk BETWEEN :sk0 AND :sk1'
            : input.sortOperator === 'begins_with'
              ? 'begins_with(#sk, :sk0)'
              : `#sk ${op} :sk0`)
      }
    }
    const result = await live.client.send(
      input.mode === 'query' ? new QueryCommand(command) : new ScanCommand(command),
      { abortSignal: signal },
    )
    const items = (result.Items || []).map(encodeAttributes)
    cursor.bytes += items.reduce((sum, item) => sum + Buffer.byteLength(item), 0)
    cursor.evaluated += result.ScannedCount || 0
    cursor.pages++
    if (cursor.bytes > 8 * 1024 * 1024)
      throw new DynamoInputError('This DynamoDB traversal reached the 8 MiB bound. Narrow the query.')
    let token: string | undefined
    const more = result.LastEvaluatedKey && Object.keys(result.LastEvaluatedKey).length
    if (more && cursor.evaluated < 1000 && cursor.pages < 10) {
      token = randomUUID()
      cursor.key = result.LastEvaluatedKey!
      live.cursors.set(token, cursor)
    }
    return {
      table: input.table,
      index: input.index,
      items,
      cursor: token,
      count: result.Count || 0,
      evaluated: result.ScannedCount || 0,
      totalEvaluated: cursor.evaluated,
      capacity: JSON.stringify(result.ConsumedCapacity || null),
      pages: cursor.pages,
      warning: `${live.profile.dynamo.local ? 'Local emulator capacity is not a billed AWS capacity measurement. ' : ''}Limit bounds evaluated items, not total table size. Pages are not a snapshot. ${more && !token ? 'Traversal stopped at 10 pages / 1,000 evaluated items; narrow the query.' : ''}`,
    }
  }
  private keyType(value: AttributeValue, key: { name: string; type: string }) {
    if (Object.keys(value).length !== 1 || !Object.prototype.hasOwnProperty.call(value, key.type))
      throw new DynamoInputError(`Key ${key.name} requires native ${key.type} type.`)
    if (('S' in value && !value.S) || ('B' in value && !value.B?.length))
      throw new DynamoInputError('Key values cannot be empty.')
  }
  private key(table: DynamoTable, source: string) {
    const key = attributes(source),
      expected = [table.partition, ...(table.sort ? [table.sort] : [])]
    if (Object.keys(key).length !== expected.length)
      throw new DynamoInputError('Provide the complete primary key, with no extra attributes.')
    expected.forEach((field) => {
      if (!key[field.name]) throw new DynamoInputError('Provide every primary key field.')
      this.keyType(key[field.name]!, field)
    })
    return key
  }
  async mutate(raw: DynamoMutation) {
    const input = dynamoMutationSchema.parse(raw),
      live = this.live(input.connectionId)
    if (live.profile.readOnly || input.confirm !== dynamoConfirmation(input.connectionId, input.table))
      throw new DynamoInputError('Writes need a writable profile and exact target confirmation.')
    return this.operation(
      live,
      input.sessionId,
      input.requestId,
      async (signal) => {
        const table = await this.describe(live, input.table, signal),
          names: Record<string, string> = {},
          values: Record<string, AttributeValue> = {}
        let conditions: string[] = []
        const key = this.key(table, input.key),
          item = attributes(input.item),
          expected = attributes(input.expected)
        const add = (name: string, value?: AttributeValue) => {
          const index = Object.keys(names).length,
            n = '#a' + index
          names[n] = name
          if (value) values[':v' + index] = value
          return { name: n, value: ':v' + index }
        }
        if (input.mode === 'create') {
          for (const [name, value] of Object.entries(key)) {
            if (encodeAttributes({ x: item[name]! }) !== encodeAttributes({ x: value }))
              throw new DynamoInputError('New item must contain the reviewed complete primary key.')
          }
          conditions = [`attribute_not_exists(${add(table.partition.name).name})`]
        } else {
          for (const [name, value] of Object.entries(expected)) {
            const entry = add(name, value)
            conditions.push(`${entry.name} = ${entry.value}`)
          }
          for (const name of input.absent) conditions.push(`attribute_not_exists(${add(name).name})`)
          if (!conditions.length)
            throw new DynamoInputError(
              'Patch/delete requires at least one expected attribute or absence condition.',
            )
          conditions.push(`attribute_exists(${add(table.partition.name).name})`)
        }
        const common = {
          TableName: input.table,
          ConditionExpression: conditions.join(' AND '),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnConsumedCapacity: 'INDEXES' as const,
        }
        let command: PutItemCommand | UpdateItemCommand | DeleteItemCommand
        if (input.mode === 'create')
          command = new PutItemCommand({ ...common, ExpressionAttributeValues: undefined, Item: item })
        else if (input.mode === 'delete')
          command = new DeleteItemCommand({
            ...common,
            ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
            Key: key,
          })
        else {
          const primary = new Set([table.partition.name, table.sort?.name]),
            sets: string[] = [],
            removes: string[] = []
          if (!Object.keys(item).length && !input.remove.length)
            throw new DynamoInputError('Choose at least one attribute to set or remove.')
          for (const [name, value] of Object.entries(item)) {
            if (primary.has(name) || input.remove.includes(name))
              throw new DynamoInputError('Primary keys cannot change and SET/REMOVE fields must differ.')
            const entry = add(name, value)
            sets.push(`${entry.name} = ${entry.value}`)
          }
          for (const name of new Set(input.remove)) {
            if (primary.has(name)) throw new DynamoInputError('Primary keys cannot be removed.')
            removes.push(add(name).name)
          }
          command = new UpdateItemCommand({
            ...common,
            ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
            Key: key,
            UpdateExpression: [
              sets.length ? 'SET ' + sets.join(', ') : '',
              removes.length ? 'REMOVE ' + removes.join(', ') : '',
            ]
              .filter(Boolean)
              .join(' '),
          })
        }
        try {
          const options = { abortSignal: signal }
          const result =
            command instanceof PutItemCommand
              ? await live.client.send(command, options)
              : command instanceof UpdateItemCommand
                ? await live.client.send(command, options)
                : await live.client.send(command, options)
          live.cursors.clear()
          return {
            acknowledged: true,
            capacity: JSON.stringify(result.ConsumedCapacity || null),
            message: 'Native conditional write acknowledged. Refresh explicitly to read current data.',
          }
        } catch (error) {
          throw failure(error, true)
        }
      },
      false,
    )
  }
  async cancel(input: { connectionId: string; sessionId: string; requestId: string }) {
    const live = this.live(input.connectionId),
      active = [...live.active.values()].find(
        (value) => value.session === input.sessionId && value.request === input.requestId,
      )
    active?.abort.abort()
    return {
      requested: !!active,
      message: active
        ? 'Local request aborted. A submitted write can be uncertain; inspect the item before retrying.'
        : 'No matching DynamoDB request is active.',
    }
  }
  async closeSession(input: { connectionId: string; sessionId: string }) {
    const live = this.connections.get(input.connectionId)
    if (!live) return
    for (const active of live.active.values()) if (active.session === input.sessionId) active.abort.abort()
    for (const [key, cursor] of live.cursors) if (cursor.session === input.sessionId) live.cursors.delete(key)
  }
  async disconnect(id: string) {
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    const live = this.connections.get(id)
    this.connections.delete(id)
    this.states.set(id, { state: 'disconnected' })
    if (live) {
      for (const active of live.active.values()) active.abort.abort()
      live.client.destroy()
      live.cursors.clear()
    }
  }
  async closeAll() {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)))
  }
}
