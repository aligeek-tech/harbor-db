import { NodeHttpHandler } from '@smithy/node-http-handler'
import { Readable } from 'node:stream'
import http from 'node:http'
import https from 'node:https'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { ConnectionProfile, Secrets } from '../../shared/contracts'
import { dynamoCredentialSchema } from '../../shared/dynamodb'
import { DynamoInputError } from './dynamodb-values'
/** Fixed regional/local endpoint, supplied credentials, single attempt, bounded raw HTTP body. */
export function dynamoClient(profile: ConnectionProfile, secrets: Secrets): DynamoDBClient {
  const config = profile.dynamo
  if (profile.ssh.enabled) throw new DynamoInputError('DynamoDB does not use SSH transport.')
  let credentials
  try {
    credentials = dynamoCredentialSchema.parse(JSON.parse(secrets.password || ''))
  } catch {
    throw new DynamoInputError(
      'Enter an explicit AWS access key, secret key and optional session token. No ambient credentials are loaded.',
    )
  }
  const host = config.local
    ? '127.0.0.1'
    : `dynamodb.${config.region}.amazonaws.com${config.region.startsWith('cn-') ? '.cn' : ''}`
  if (profile.host !== host || (!config.local && profile.port !== 443))
    throw new DynamoInputError('The endpoint must match the selected local or AWS regional endpoint.')
  if (!config.local && (!config.accountId || !profile.tls.enabled || !profile.tls.rejectUnauthorized))
    throw new DynamoInputError('AWS DynamoDB requires an expected account ID and verified TLS.')
  if (profile.tls.cert || profile.tls.keyPath || profile.tls.ca || (config.local && profile.tls.enabled))
    throw new DynamoInputError(
      'Use system-trusted TLS for AWS, or plain loopback HTTP for DynamoDB Local. Custom certificates are excluded.',
    )
  const native = new NodeHttpHandler({
    connectionTimeout: profile.connectTimeout,
    socketTimeout: profile.queryTimeout,
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 4 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 4, rejectUnauthorized: true }),
  })
  const handler = {
    metadata: native.metadata,
    destroy: () => native.destroy(),
    handle: async (
      request: Parameters<NodeHttpHandler['handle']>[0],
      options: Parameters<NodeHttpHandler['handle']>[1],
    ) => {
      if (typeof request.body === 'string' && Buffer.byteLength(request.body) > 1024 * 1024)
        throw new DynamoInputError('DynamoDB request exceeds 1 MiB.')
      const result = await native.handle(request, options),
        body = result.response.body as Readable,
        chunks: Buffer[] = []
      let bytes = 0
      const abort = () => body.destroy(new Error('DynamoDB HTTP response aborted'))
      const signal = options?.abortSignal as AbortSignal | undefined
      signal?.addEventListener('abort', abort, { once: true })
      try {
        if (options?.abortSignal?.aborted) abort()
        for await (const piece of body) {
          const chunk = Buffer.from(piece)
          bytes += chunk.length
          if (bytes > 8 * 1024 * 1024)
            throw new DynamoInputError('DynamoDB response exceeds 8 MiB. Narrow the request.')
          chunks.push(chunk)
        }
        result.response.body = Readable.from([Buffer.concat(chunks)])
        return result
      } finally {
        signal?.removeEventListener('abort', abort)
        if (!body.readableEnded) body.destroy()
      }
    },
  }
  return new DynamoDBClient({
    region: config.region,
    credentials,
    endpoint: `${config.local ? 'http' : 'https'}://${host}:${profile.port}`,
    ignoreConfiguredEndpointUrls: true,
    maxAttempts: 1,
    endpointDiscoveryEnabled: false,
    requestHandler: handler,
  })
}
