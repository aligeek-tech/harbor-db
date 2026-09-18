import { describe, expect, it } from 'vitest'
import { chmod, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  cleanNativeEnvironment,
  inspectNativeTool,
  nativeFileIdentity,
  redactNativeText,
  runNative,
  verifyOpenNativeFile,
  writeNativeChunk,
} from '../src/main/persistence/native-backup-tools'

describe('native backup process/file boundaries (not server acceptance)', () => {
  it('does not inherit libpq or application credentials and redacts bounded native diagnostics', async () => {
    expect(cleanNativeEnvironment()).not.toHaveProperty('PGPASSWORD')
    expect(cleanNativeEnvironment()).not.toHaveProperty('PGSERVICEFILE')
    const result = await runNative(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify(Object.keys(process.env)))',
    ])
    expect(JSON.parse(result.stdout)).not.toContain('HOME')
    expect(
      redactNativeText('password=synthetic postgres://user:synthetic@local synthetic', ['synthetic']),
    ).not.toContain('synthetic')
  })
  it('bounds metadata, propagates storage failures, acknowledges cancellation/deadline and never reruns', async () => {
    await expect(
      runNative(process.execPath, ['-e', "process.stdout.write('x'.repeat(8192))"], { maxOutputBytes: 100 }),
    ).rejects.toThrow(/byte limit/)
    let calls = 0
    await expect(
      runNative(process.execPath, ['-e', "process.stdout.write('data');setInterval(()=>{},1000)"], {
        onOutput: async () => {
          calls++
          throw new Error('ENOSPC synthetic bounded storage fault')
        },
      }),
    ).rejects.toThrow(/ENOSPC/)
    expect(calls).toBe(1)
    const controller = new AbortController(),
      pending = runNative(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow(/cancelled/)
    await expect(
      runNative(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 }),
    ).rejects.toThrow(/deadline/)
  })
  it('pins selected and opened file identity and refuses scripts as native tools', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-native-files-')),
      path = join(directory, 'archive.dump')
    try {
      await writeFile(path, 'PGDMP original')
      const identity = await nativeFileIdentity(path, 1024),
        handle = await open(path, 'r')
      try {
        await rename(path, join(directory, 'old.dump'))
        await writeFile(path, 'PGDMP replacement')
        await expect(nativeFileIdentity(path, 1024, identity)).rejects.toThrow(/changed/)
        await expect(verifyOpenNativeFile(handle, identity)).rejects.toThrow(/changed/)
      } finally {
        await handle.close()
      }
      const tool = join(directory, 'pg_dump')
      await writeFile(tool, '#!/bin/sh\nexit 0\n')
      await chmod(tool, 0o700)
      await expect(inspectNativeTool(tool, 'pg_dump')).rejects.toThrow(/native binary/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('handles short filesystem writes and fails if storage accepts no more bytes', async () => {
    const output: number[] = []
    await writeNativeChunk(
      {
        write: async (chunk: Buffer, offset: number) => {
          output.push(chunk[offset])
          return { bytesWritten: 1 }
        },
      } as never,
      Buffer.from('abc'),
    )
    expect(Buffer.from(output).toString()).toBe('abc')
    await expect(
      writeNativeChunk({ write: async () => ({ bytesWritten: 0 }) } as never, Buffer.from('x')),
    ).rejects.toThrow(/Storage/)
  })
})
