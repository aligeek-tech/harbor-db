import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseImport } from '../src/main/persistence/import-parser'
import { importOptionsSchema } from '../src/shared/imports'

describe('bounded import parser', () => {
  let directory = ''
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'harbor-import-parser-'))
  })
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  async function read(
    source: string | Buffer,
    options: Partial<ReturnType<typeof importOptionsSchema.parse>> = {},
  ) {
    const path = join(directory, crypto.randomUUID())
    await writeFile(path, source)
    const file = await open(path, 'r')
    try {
      const records = []
      for await (const record of parseImport(
        file,
        importOptionsSchema.parse({ format: 'csv', ...options }),
        new AbortController().signal,
        () => undefined,
      ))
        records.push(record)
      return records
    } finally {
      await file.close()
    }
  }
  it('preserves quoted multiline fields, escaped quotes, CRLF lines and explicit versus literal NULL', async () => {
    expect(await read('\uFEFFa,b,c\r\n1,"hello\r\n""world""",\\N\r\n2,"\\N",""\r\n')).toEqual([
      { columns: ['a', 'b', 'c'] },
      { cells: ['1', 'hello\r\n"world"', null], line: 2 },
      { cells: ['2', '\\N', ''], line: 4 },
    ])
  })
  it('handles quotes and multibyte characters split across physical read buffers', async () => {
    const field = 'x'.repeat(65528) + '😀"next'
    const rows = await read('a\n"' + field.replaceAll('"', '""') + '"\n')
    expect(rows[1]).toEqual({ cells: [field], line: 2 })
  })
  it('supports explicit delimiters, no header and custom NULL without numeric coercion', async () => {
    expect(
      await read('9007199254740993;NULL;"NULL"\n', { delimiter: ';', header: false, nullToken: 'NULL' }),
    ).toEqual([
      { columns: ['Column 1', 'Column 2', 'Column 3'] },
      { cells: ['9007199254740993', null, 'NULL'], line: 1 },
    ])
  })
  it('decodes UTF-16LE and rejects malformed UTF-8/UTF-16 bytes without replacement', async () => {
    expect(await read(Buffer.from('\uFEFFa,b\n1,سلام\n', 'utf16le'), { encoding: 'utf16le' })).toEqual([
      { columns: ['a', 'b'] },
      { cells: ['1', 'سلام'], line: 2 },
    ])
    await expect(read(Buffer.from([97, 10, 0xff, 10]))).rejects.toThrow('invalid bytes')
    await expect(read(Buffer.from([97, 0, 10]), { encoding: 'utf16le' })).rejects.toThrow('invalid bytes')
  })
  it('preserves all numeric JSON tokens including decimals, exponents and nested structures', async () => {
    expect(
      await read(
        '{"n":9007199254740993123,"d":0.123456789012345678901,"nested":{"n":9007199254740993123,"a":[1e+400,-0]}}\n',
        { format: 'jsonl' },
      ),
    ).toEqual([
      { columns: ['n', 'd', 'nested'] },
      {
        cells: [
          '9007199254740993123',
          '0.123456789012345678901',
          '{"n":9007199254740993123,"a":[1e+400,-0]}',
        ],
        line: 1,
      },
    ])
  })
  it('reads Harbor ordered JSONL with duplicate names and typed binary cells', async () => {
    expect(
      await read(
        '{"format":"harbor-db-jsonl","version":1,"columns":[{"name":"same"},{"name":"same"}]}\n[9007199254740993,{"type":"binary","base64":"AP+A"}]\n',
        { format: 'jsonl' },
      ),
    ).toEqual([
      { columns: ['same', 'same'] },
      { cells: ['9007199254740993', { type: 'binary', base64: 'AP+A' }], line: 2 },
    ])
  })
  it('reports recoverable width/extra-field errors while rejecting malformed syntax and duplicate JSON keys privately', async () => {
    expect((await read('a,b\n1\n'))[1]).toEqual({
      cells: ['1'],
      line: 2,
      issue: 'Expected 2 source fields, found 1.',
    })
    expect((await read('{"a":1}\n{"b":2}\n', { format: 'jsonl' }))[2]).toEqual({
      cells: [null],
      line: 2,
      issue: 'The object contains a field not present in the first record.',
    })
    await expect(read('a\n"unclosed')).rejects.toThrow('not closed')
    await expect(read('{"a":"private-row-token","a":2}', { format: 'jsonl' })).rejects.toThrow(
      'duplicate object keys',
    )
    try {
      await read('{"a":"private-row-token","a":2}', { format: 'jsonl' })
    } catch (error) {
      expect(String(error)).not.toContain('private-row-token')
    }
  })
  it('rejects oversize fields before accepting an unbounded row', async () => {
    await expect(read('a\n' + 'x'.repeat(1000001))).rejects.toThrow('1,000,000')
  })
})
