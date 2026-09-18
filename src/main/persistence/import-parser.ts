import type { FileHandle } from 'node:fs/promises'
import { isLosslessNumber, parse, stringify } from 'lossless-json'
import type { Cell } from '../../shared/contracts'
import type { ImportOptions } from '../../shared/imports'

export const IMPORT_ROW_BYTES = 8 * 1024 * 1024
export type ImportRecord = { columns: string[] } | { cells: Cell[]; line: number; issue?: string }

async function* decoded(
  file: FileHandle,
  options: ImportOptions,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): AsyncGenerator<string> {
  const decoder = new TextDecoder(options.encoding === 'utf8' ? 'utf-8' : 'utf-16le', { fatal: true })
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  try {
    while (true) {
      if (signal.aborted) throw new Error('Import cancelled.')
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      position += bytesRead
      progress(position)
      const text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
      if (text.includes('\uFFFE'))
        throw new Error('The selected encoding does not match the file byte order.')
      yield text
    }
    const tail = decoder.decode()
    if (tail) yield tail
  } catch (error) {
    if (error instanceof TypeError)
      throw new Error(
        'The file contains invalid bytes for the selected encoding. No replacement characters were inserted.',
      )
    throw error
  }
}

async function* csvRecords(
  chunks: AsyncIterable<string>,
  options: ImportOptions,
): AsyncGenerator<ImportRecord> {
  let value = '',
    fields: Cell[] = [],
    headers: string[] | undefined
  let quoted = false,
    inside = false,
    closed = false,
    trailingSpace = false,
    started = false,
    previousCR = false
  let line = 1,
    startLine = 1,
    units = 0
  const finishField = () => {
    fields.push(!quoted && value === options.nullToken && (headers || !options.header) ? null : value)
    value = ''
    quoted = false
    closed = false
    trailingSpace = false
    if (fields.length > 200) throw new Error(`Line ${startLine}: import is limited to 200 source columns.`)
  }
  const finish = (): ImportRecord[] => {
    const include = started || fields.length > 0 || quoted
    finishField()
    const cells = fields
    fields = []
    started = false
    units = 0
    if (!include) return []
    if (Buffer.byteLength(JSON.stringify(cells), 'utf8') > IMPORT_ROW_BYTES)
      throw new Error(`Line ${startLine}: a source row exceeds 8 MiB.`)
    const result: ImportRecord[] = []
    if (!headers) {
      headers = cells.map((cell, index) =>
        options.header ? String(cell ?? `Column ${index + 1}`) : `Column ${index + 1}`,
      )
      if (headers.some((header) => header.length > 255))
        throw new Error('A source column name exceeds 255 characters.')
      result.push({ columns: headers })
      if (options.header) return result
    }
    result.push({
      cells,
      line: startLine,
      ...(cells.length !== headers.length
        ? { issue: `Expected ${headers.length} source fields, found ${cells.length}.` }
        : {}),
    })
    return result
  }
  for await (const chunk of chunks)
    for (const char of chunk) {
      if (++units > IMPORT_ROW_BYTES)
        throw new Error(`Line ${startLine}: a source row exceeds the 8 MiB parsing limit.`)
      if (inside) {
        if (char === '"') {
          inside = false
          closed = true
        } else {
          value += char
          if (value.length > 1000000)
            throw new Error(`Line ${startLine}: a field exceeds 1,000,000 characters.`)
          if (char === '\r' || (char === '\n' && !previousCR)) line++
        }
        previousCR = char === '\r'
        continue
      }
      if (char === '\n' && previousCR) {
        previousCR = false
        continue
      }
      previousCR = char === '\r'
      if (closed && char === '"' && !trailingSpace) {
        inside = true
        closed = false
        value += '"'
        continue
      }
      if (char === options.delimiter) {
        started = true
        finishField()
        continue
      }
      if (char === '\r' || char === '\n') {
        for (const record of finish()) yield record
        line++
        startLine = line
        continue
      }
      if (closed) {
        if (char === ' ' || char === '\t') {
          trailingSpace = true
          continue
        }
        throw new Error(`Line ${line}: unexpected text after a closing quote.`)
      }
      if (char === '"') {
        if (value.length) throw new Error(`Line ${line}: an unquoted field contains a quote.`)
        quoted = true
        inside = true
        started = true
      } else {
        value += char
        started = true
        if (value.length > 1000000)
          throw new Error(`Line ${startLine}: a field exceeds 1,000,000 characters.`)
      }
    }
  if (inside) throw new Error(`Line ${startLine}: the quoted field is not closed.`)
  if (started || fields.length || value.length || closed) for (const record of finish()) yield record
  if (!headers) throw new Error('The source file has no records.')
}

function jsonCell(value: unknown, harbor: boolean): Cell {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (isLosslessNumber(value)) return value.value
  if (
    harbor &&
    value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'binary' &&
    'base64' in value &&
    typeof value.base64 === 'string'
  ) {
    if (
      Object.keys(value).length !== 2 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)
    )
      throw new Error('The Harbor JSONL binary cell is invalid.')
    return { type: 'binary', base64: value.base64 }
  }
  if (harbor) throw new Error('The Harbor JSONL row contains an unsupported cell type.')
  // Lossless stringify retains every numeric token, including nested objects/arrays.
  const text = stringify(value)
  if (text === undefined) throw new Error('The JSONL row contains an unsupported value.')
  return text
}

async function* jsonRecords(chunks: AsyncIterable<string>): AsyncGenerator<ImportRecord> {
  let pending = '',
    line = 0,
    headers: string[] | undefined,
    harbor = false
  const record = (text: string): ImportRecord[] => {
    line++
    if (!text.trim()) return []
    if (Buffer.byteLength(text, 'utf8') > IMPORT_ROW_BYTES)
      throw new Error(`Line ${line}: a source row exceeds 8 MiB.`)
    let parsed: unknown
    try {
      parsed = parse(text)
    } catch {
      throw new Error(
        `Line ${line}: invalid JSON or duplicate object keys. Source values were omitted from this error.`,
      )
    }
    if (
      !headers &&
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      'format' in parsed &&
      parsed.format === 'harbor-db-jsonl'
    ) {
      const metadata = parsed as Record<string, unknown>
      if (
        !isLosslessNumber(metadata.version) ||
        metadata.version.value !== '1' ||
        !Array.isArray(metadata.columns) ||
        !metadata.columns.length ||
        metadata.columns.length > 200
      )
        throw new Error('Unsupported Harbor JSONL metadata.')
      headers = metadata.columns.map((column: unknown) => {
        if (
          !column ||
          typeof column !== 'object' ||
          !('name' in column) ||
          typeof column.name !== 'string' ||
          column.name.length > 255
        )
          throw new Error('Invalid Harbor JSONL column metadata.')
        return column.name
      })
      harbor = true
      return [{ columns: headers }]
    }
    const result: ImportRecord[] = []
    if (!headers) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || isLosslessNumber(parsed))
        throw new Error(
          `Line ${line}: JSONL must contain objects, or Harbor metadata followed by ordered arrays.`,
        )
      headers = Object.keys(parsed)
      if (!headers.length || headers.length > 200 || headers.some((header) => header.length > 255))
        throw new Error('JSONL must have 1–200 columns with names up to 255 characters.')
      result.push({ columns: headers })
    }
    let cells: Cell[], issue: string | undefined
    if (harbor) {
      if (!Array.isArray(parsed)) throw new Error(`Line ${line}: Harbor JSONL expects an ordered row array.`)
      cells = parsed.map((value) => jsonCell(value, true))
      if (cells.length !== headers.length)
        issue = `Expected ${headers.length} source fields, found ${cells.length}.`
    } else {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || isLosslessNumber(parsed))
        throw new Error(`Line ${line}: JSONL expects an object.`)
      if (Object.keys(parsed).some((name) => !headers!.includes(name)))
        issue = 'The object contains a field not present in the first record.'
      cells = headers.map((name) =>
        Object.hasOwn(parsed, name) ? jsonCell((parsed as Record<string, unknown>)[name], false) : null,
      )
    }
    result.push({ cells, line, ...(issue ? { issue } : {}) })
    return result
  }
  for await (const chunk of chunks) {
    let start = 0
    for (let index = 0; index < chunk.length; index++)
      if (chunk[index] === '\n') {
        pending += chunk.slice(start, index)
        for (const item of record(pending)) yield item
        pending = ''
        start = index + 1
      }
    pending += chunk.slice(start)
    if (pending.length > IMPORT_ROW_BYTES)
      throw new Error(`Line ${line + 1}: a source row exceeds the 8 MiB parsing limit.`)
  }
  if (pending) for (const item of record(pending)) yield item
  if (!headers) throw new Error('The source file has no records.')
}

export async function* parseImport(
  file: FileHandle,
  options: ImportOptions,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): AsyncGenerator<ImportRecord> {
  const chunks = decoded(file, options, signal, progress)
  yield* options.format === 'csv' ? csvRecords(chunks, options) : jsonRecords(chunks)
}
