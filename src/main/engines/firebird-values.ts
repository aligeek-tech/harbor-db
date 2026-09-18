import { Blob as FirebirdBlob, type Attachment, type Statement, type Transaction } from 'node-firebird-driver'
import { StatementImpl } from 'node-firebird-driver-wire/dist/lib/statement.js'
import { blr } from 'node-firebird-driver-wire/dist/lib/constants.js'
import { sqlTypes } from 'node-firebird-driver/dist/lib/impl/index.js'
import type { MutableStatementColumn } from 'node-firebird-driver-wire/dist/lib/protocol-types.js'
import type { Cell, ResultColumn } from '../../shared/contracts'

export class FirebirdInputError extends Error {}

const exactText = new Set<number>([
  sqlTypes.SQL_SHORT,
  sqlTypes.SQL_LONG,
  sqlTypes.SQL_INT64,
  sqlTypes.SQL_INT128,
  sqlTypes.SQL_DEC16,
  sqlTypes.SQL_DEC34,
  sqlTypes.SQL_TYPE_DATE,
  sqlTypes.SQL_TYPE_TIME,
  sqlTypes.SQL_TIMESTAMP,
  sqlTypes.SQL_TIME_TZ,
  sqlTypes.SQL_TIMESTAMP_TZ,
  sqlTypes.SQL_TIME_TZ_EX,
  sqlTypes.SQL_TIMESTAMP_TZ_EX,
])
const typeName = (type: number) =>
  Object.entries(sqlTypes)
    .find(([, value]) => value === type)?.[0]
    .replace('SQL_', '') || `FIREBIRD_${type}`
const align = (value: number, alignment: number) => Math.ceil(value / alignment) * alignment

/**
 * Pinned beta.4 protocol boundary: its default INT64/scaled integer => double and
 * temporal => Date conversions lose information. Request native server text for
 * those fields in the result BLR before execution. No SQL rewriting or dependency
 * files are involved. Any driver shape/type drift fails before dispatch.
 */
export function firebirdExactStatement(statement: Statement): {
  columns: ResultColumn[]
  blobText: Set<number>
} {
  if (!(statement instanceof StatementImpl) || !statement.statementHandle || !statement.attachment.protocol)
    throw new FirebirdInputError('Unsupported Firebird driver metadata interface.')
  const metadata = statement.attachment.protocol.getStatementMetadata(statement.statementHandle)
  if (metadata.inputColumns.length)
    throw new FirebirdInputError(
      'Firebird parameter binding is not advertised; no lossy driver conversion or interpolation was attempted.',
    )
  if (metadata.outputColumns.length > 2000)
    throw new FirebirdInputError('Firebird result exceeds 2,000 columns.')
  const columns = metadata.outputColumns.map((column) => ({
    name: column.alias,
    type: typeName(column.originalType),
    nullable: column.nullable,
  }))
  const output: MutableStatementColumn[] = metadata.outputColumns.map((column) => ({ ...column }))
  const blobText = new Set<number>(),
    count = output.length * 2
  const format = [blr.version5, blr.begin, blr.message, 0, count & 255, count >> 8]
  let size = 0
  output.forEach((column, ordinal) => {
    if (exactText.has(column.originalType))
      Object.assign(column, { type: sqlTypes.SQL_VARYING, subType: 4, charSet: 4, scale: 0, length: 256 })
    let alignment: number, length: number, bytes: number[]
    if (column.type === sqlTypes.SQL_VARYING) {
      alignment = 2
      length = column.length + 2
      bytes = [
        blr.varying2,
        column.charSet & 255,
        column.charSet >> 8,
        column.length & 255,
        column.length >> 8,
      ]
    } else if (column.type === sqlTypes.SQL_DOUBLE) {
      alignment = 8
      length = 8
      bytes = [blr.double]
    } else if (column.type === sqlTypes.SQL_BOOLEAN) {
      alignment = 1
      length = 1
      bytes = [blr.bool]
    } else if (column.type === sqlTypes.SQL_BLOB) {
      alignment = 4
      length = 8
      bytes = [blr.blob2, column.subType & 255, column.subType >> 8, 0, 0]
      if (column.subType === 1) blobText.add(ordinal)
    } else if (column.type === sqlTypes.SQL_NULL) {
      alignment = 1
      length = 0
      bytes = [blr.null_]
    } else
      throw new FirebirdInputError(
        `Unsupported Firebird result type ${column.originalType}; use an explicit native scalar projection.`,
      )
    column.offset = align(size, alignment)
    column.nullOffset = align(column.offset + length, 2)
    size = column.nullOffset + 2
    format.push(...bytes, blr.short, 0)
  })
  if (size > 8 * 1024 * 1024) throw new FirebirdInputError('Firebird result row descriptor exceeds 8 MiB.')
  format.push(blr.end, blr.eoc)
  Object.assign(metadata, {
    outputColumns: output,
    outputBlr: Buffer.from(format),
    outputMessageLength: size,
  })
  statement.dataReader = async (attachment, _transaction, raw) => {
    const buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
    return output.map((column) => {
      if (buffer.readInt16LE(column.nullOffset) === -1) return null
      if (column.type === sqlTypes.SQL_VARYING) {
        const length = buffer.readUInt16LE(column.offset)
        if (length > column.length)
          throw new FirebirdInputError('Firebird text length exceeds its descriptor.')
        const bytes = buffer.subarray(column.offset + 2, column.offset + 2 + length)
        if (column.charSet === 1) return Buffer.from(bytes)
        if (column.charSet !== 4 && column.charSet !== 2 && column.charSet !== 0)
          throw new FirebirdInputError('Unsupported Firebird result character set.')
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      }
      if (column.type === sqlTypes.SQL_DOUBLE) {
        const value = buffer.readDoubleLE(column.offset)
        if (!Number.isFinite(value))
          throw new FirebirdInputError(
            'Non-finite Firebird floating value requires an explicit text projection.',
          )
        return value
      }
      if (column.type === sqlTypes.SQL_BOOLEAN) return buffer.readUInt8(column.offset) !== 0
      if (column.type === sqlTypes.SQL_BLOB)
        return new FirebirdBlob(attachment, buffer.subarray(column.offset, column.offset + 8))
      return null
    })
  }
  return { columns, blobText }
}

export async function firebirdRow(
  values: unknown[],
  attachment: Attachment,
  transaction: Transaction,
  blobText: Set<number>,
): Promise<Cell[]> {
  let bytes = 0
  const result: Cell[] = []
  for (let index = 0; index < values.length; index++) {
    let value = values[index]
    if (value instanceof FirebirdBlob) {
      const stream = await attachment.openBlob(transaction, value),
        parts: Buffer[] = []
      try {
        const length = await stream.length
        if (length > 8 * 1024 * 1024 - bytes)
          throw new FirebirdInputError('Firebird LOB exceeds the remaining 8 MiB row budget.')
        const buffer = Buffer.alloc(65536)
        let lobBytes = 0
        for (;;) {
          const count = await stream.read(buffer)
          if (count === -1) break
          if (count === 0) throw new FirebirdInputError('Firebird LOB made no progress.')
          lobBytes += count
          if (lobBytes + bytes > 8 * 1024 * 1024) throw new FirebirdInputError('Firebird row exceeds 8 MiB.')
          parts.push(Buffer.from(buffer.subarray(0, count)))
        }
        const content = Buffer.concat(parts)
        value = blobText.has(index) ? new TextDecoder('utf-8', { fatal: true }).decode(content) : content
      } finally {
        await stream.close()
      }
    }
    let cell: Cell
    if (value === null) cell = null
    else if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
      cell = value
    else if (Buffer.isBuffer(value)) cell = { type: 'binary', base64: value.toString('base64') }
    else throw new FirebirdInputError('Unsupported Firebird value; no implicit conversion was performed.')
    bytes += Buffer.byteLength(JSON.stringify(cell))
    if (bytes > 8 * 1024 * 1024) throw new FirebirdInputError('Firebird row exceeds 8 MiB.')
    result.push(cell)
  }
  return result
}
