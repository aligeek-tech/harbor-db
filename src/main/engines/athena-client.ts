import { Readable } from 'node:stream'
import https from 'node:https'
import {
  AthenaClient,
  GetWorkGroupCommand,
  GetDataCatalogCommand,
  ListDatabasesCommand,
  ListTableMetadataCommand,
  GetTableMetadataCommand,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StopQueryExecutionCommand,
} from '@aws-sdk/client-athena'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import type { ConnectionProfile } from '../../shared/contracts'
import { athenaCredentialSchema } from '../../shared/athena'
import type { JsonRecord } from './cloud-json'

export type AthenaAction =
  | 'GetWorkGroup'
  | 'GetDataCatalog'
  | 'ListDatabases'
  | 'ListTableMetadata'
  | 'GetTableMetadata'
  | 'StartQueryExecution'
  | 'GetQueryExecution'
  | 'GetQueryResults'
  | 'StopQueryExecution'
export interface AthenaEndpoint {
  call(action: AthenaAction, input: JsonRecord, signal?: AbortSignal): Promise<JsonRecord>
  close(): void
}
export const athenaHost = (region: string) =>
  `athena.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`

/** Signed native AWS calls, without credential discovery, retries, redirects or unbounded SDK response buffering. */
export class NativeAthenaEndpoint implements AthenaEndpoint {
  private client: AthenaClient
  constructor(profile: ConnectionProfile, credentialJson: string) {
    let credentials: ReturnType<typeof athenaCredentialSchema.parse>
    try {
      credentials = athenaCredentialSchema.parse(JSON.parse(credentialJson))
    } catch {
      throw new Error(
        'Enter AWS credentials JSON containing accessKeyId, secretAccessKey and optional sessionToken. Credential contents are omitted.',
      )
    }
    const transport = new NodeHttpHandler({
      connectionTimeout: 5000,
      requestTimeout: profile.queryTimeout,
      httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 4,
        rejectUnauthorized: true,
        ...(profile.tls.ca ? { ca: profile.tls.ca } : {}),
      }),
    })
    const handle: NodeHttpHandler['handle'] = async (request, options) => {
      if (
        request.hostname !== athenaHost(profile.athena.region) ||
        request.protocol !== 'https:' ||
        (request.port && request.port !== 443)
      )
        throw new Error('AWS request target differs from the explicitly selected Athena endpoint.')
      const result = await transport.handle(request, options)
      const stream = result.response.body as Readable,
        chunks: Buffer[] = []
      let size = 0
      try {
        for await (const part of stream) {
          const bytes = Buffer.from(part)
          size += bytes.length
          if (size > 32 * 1024 * 1024) throw new Error('Athena response exceeds the bounded 32 MiB page.')
          chunks.push(bytes)
        }
      } catch {
        stream.destroy()
        throw new Error(
          'Athena response was interrupted or exceeded its page bound. Submitted work is not retried.',
        )
      }
      result.response.body = Readable.from([Buffer.concat(chunks)])
      return result
    }
    this.client = new AthenaClient({
      region: profile.athena.region,
      credentials,
      endpoint: `https://${athenaHost(profile.athena.region)}`,
      ignoreConfiguredEndpointUrls: true,
      maxAttempts: 1,
      requestHandler: { handle, destroy: () => transport.destroy() },
    })
  }
  async call(action: AthenaAction, input: JsonRecord, signal?: AbortSignal): Promise<JsonRecord> {
    if (signal?.aborted) throw new Error('Athena operation cancelled before dispatch.')
    try {
      // The action union and service-owned inputs prevent arbitrary AWS operations.
      let result: unknown
      switch (action) {
        case 'GetWorkGroup':
          result = await this.client.send(new GetWorkGroupCommand(input as never), { abortSignal: signal })
          break
        case 'GetDataCatalog':
          result = await this.client.send(new GetDataCatalogCommand(input as never), { abortSignal: signal })
          break
        case 'ListDatabases':
          result = await this.client.send(new ListDatabasesCommand(input as never), { abortSignal: signal })
          break
        case 'ListTableMetadata':
          result = await this.client.send(new ListTableMetadataCommand(input as never), {
            abortSignal: signal,
          })
          break
        case 'GetTableMetadata':
          result = await this.client.send(new GetTableMetadataCommand(input as never), {
            abortSignal: signal,
          })
          break
        case 'StartQueryExecution':
          result = await this.client.send(new StartQueryExecutionCommand(input as never), {
            abortSignal: signal,
          })
          break
        case 'GetQueryExecution':
          result = await this.client.send(new GetQueryExecutionCommand(input as never), {
            abortSignal: signal,
          })
          break
        case 'GetQueryResults':
          result = await this.client.send(new GetQueryResultsCommand(input as never), { abortSignal: signal })
          break
        case 'StopQueryExecution':
          result = await this.client.send(new StopQueryExecutionCommand(input as never), {
            abortSignal: signal,
          })
          break
      }
      return result as JsonRecord
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      throw new Error(
        [
          'AccessDeniedException',
          'UnrecognizedClientException',
          'ExpiredTokenException',
          'InvalidSignatureException',
        ].includes(name)
          ? 'AWS authentication or permission denied. Reconnect with fresh scoped credentials; no automatic refresh occurred.'
          : 'Athena request failed, was cancelled, or exceeded its response bound. Provider details are omitted and no retry occurred.',
      )
    }
  }
  close(): void {
    this.client.destroy()
  }
}
