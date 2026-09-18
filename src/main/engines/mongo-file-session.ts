import type { MongoFileExportInput } from '../../shared/mongo-files'
export class MongoFileWriteError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
  ) {
    super(message)
  }
}
export interface MongoFileSession {
  validate(): Promise<void>
  canonical(source: string): string
  insert(source: string, signal: AbortSignal): Promise<void>
  stream(
    input: MongoFileExportInput,
    signal: AbortSignal,
    onDocument: (source: string) => Promise<void>,
  ): Promise<boolean>
}
