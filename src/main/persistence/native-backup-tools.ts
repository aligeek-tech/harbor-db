import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { NativeBackupTool, NativeBackupToolKind } from '../../shared/native-backup'

export interface NativeFileIdentity {
  path: string
  size: number
  modified: number
  changed: number
  device: number
  inode: number
  sha256: string
}
export const cleanNativeEnvironment = (): NodeJS.ProcessEnv => ({
  PATH:
    process.platform === 'win32'
      ? process.env.SystemRoot
        ? `${process.env.SystemRoot}\\System32`
        : ''
      : '/usr/bin:/bin',
  ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  LANG: 'C',
  LC_ALL: 'C',
})
export function redactNativeText(value: string, secrets: string[] = []) {
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    value = value.replaceAll(secret, '[redacted]')
  return value
    .replace(/(password\s*[=:]\s*)(?:'[^']*'|"[^"]*"|[^\s]+)/gi, '$1[redacted]')
    .replace(/(postgres(?:ql)?:\/\/[^\s:]+:)[^@\s]+@/gi, '$1[redacted]@')
}
export async function nativeFileIdentity(
  path: string,
  maxBytes: number,
  expected?: NativeFileIdentity,
): Promise<NativeFileIdentity> {
  const resolved = await realpath(path),
    file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > maxBytes)
      throw new Error('Select a regular file within the stated byte limit.')
    if (
      expected &&
      (resolved !== expected.path ||
        before.dev !== expected.device ||
        before.ino !== expected.inode ||
        before.size !== expected.size ||
        before.mtimeMs !== expected.modified ||
        before.ctimeMs !== expected.changed)
    )
      throw new Error('The selected file changed after review. Select it and preview again.')
    const digest = createHash('sha256'),
      deadline = Date.now() + 120000
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) {
      if (Date.now() > deadline)
        throw new Error(
          'File verification exceeded two minutes. Use a smaller archive or faster local storage.',
        )
      digest.update(chunk)
    }
    const after = await file.stat(),
      sha256 = digest.digest('hex')
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      (expected && expected.sha256 !== sha256)
    )
      throw new Error('The selected file changed during verification.')
    return {
      path: resolved,
      size: after.size,
      modified: after.mtimeMs,
      changed: after.ctimeMs,
      device: after.dev,
      inode: after.ino,
      sha256,
    }
  } finally {
    await file.close()
  }
}
interface RunOptions {
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputBytes?: number
  input?: Readable
  onOutput?: (chunk: Buffer) => Promise<void>
  onMessage?: (line: string) => void
  secrets?: string[]
  cwd?: string
}
/** Runs one explicitly chosen native executable. No shell, inherited libpq settings, startup files, or password arguments. */
export async function runNative(path: string, args: string[], options: RunOptions = {}) {
  if (options.signal?.aborted) throw new Error('Native operation cancelled before launch.')
  const child = spawn(path, args, {
    shell: false,
    windowsHide: true,
    cwd: options.cwd || tmpdir(),
    env: { ...cleanNativeEnvironment(), ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let timedOut = false,
    cancelled = false,
    killed: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    child.kill('SIGTERM')
    killed ||= setTimeout(() => child.kill('SIGKILL'), 2000)
    killed.unref()
  }
  const onAbort = () => {
    cancelled = true
    options.input?.destroy(new Error('Native operation cancelled.'))
    stop()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    options.input?.destroy(new Error('Native operation deadline exceeded.'))
    stop()
  }, options.timeoutMs || 10000)
  timer.unref()
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  // Attach rejection handlers immediately: an executable error must not become an unhandled rejection.
  const completion = exited.catch((error) => {
    throw error
  })
  void completion.catch(() => undefined)
  const output: Buffer[] = [],
    errors: Buffer[] = []
  let outputBytes = 0,
    errorBytes = 0
  const stdout = (async () => {
    for await (const piece of child.stdout) {
      const chunk = Buffer.from(piece)
      if (options.onOutput) await options.onOutput(chunk)
      else {
        outputBytes += chunk.length
        if (outputBytes > (options.maxOutputBytes || 1024 * 1024))
          throw new Error('Native metadata output exceeded its byte limit.')
        output.push(chunk)
      }
    }
  })()
  const stderr = (async () => {
    let pending = ''
    for await (const piece of child.stderr) {
      const chunk = Buffer.from(piece)
      // Retain a bounded tail of diagnostics; progress can be unbounded over a long native dump.
      errors.push(chunk)
      errorBytes += chunk.length
      while (errorBytes > 32768 && errors.length > 1) errorBytes -= errors.shift()!.length
      if (errors[0]?.length > 32768) {
        errors[0] = errors[0].subarray(-32768)
        errorBytes = 32768
      }
      pending = (pending + chunk.toString('utf8')).slice(-32768)
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      for (const line of lines) options.onMessage?.(redactNativeText(line.slice(0, 2000), options.secrets))
    }
    if (pending) options.onMessage?.(redactNativeText(pending.slice(0, 2000), options.secrets))
  })()
  const stdin = options.input
    ? pipeline(options.input, child.stdin)
    : Promise.resolve(child.stdin.end()).then(() => undefined)
  try {
    const [result] = await Promise.all([completion, stdout, stderr, stdin])
    if (cancelled || options.signal?.aborted)
      throw new Error('Native operation cancelled. No automatic retry was attempted.')
    if (timedOut)
      throw new Error('Native operation exceeded its configured deadline. No automatic retry was attempted.')
    const details = redactNativeText(Buffer.concat(errors).toString('utf8'), options.secrets)
    if (result.code !== 0)
      throw new Error(
        `Native tool exited ${result.code ?? result.signal ?? 'without status'}.${details ? ` ${details}` : ''}`,
      )
    return { stdout: Buffer.concat(output).toString('utf8'), stderr: details }
  } catch (error) {
    stop()
    options.input?.destroy()
    await Promise.allSettled([completion, stdout, stderr, stdin])
    if (cancelled || options.signal?.aborted)
      throw new Error('Native operation cancelled. No automatic retry was attempted.')
    if (timedOut)
      throw new Error('Native operation exceeded its configured deadline. No automatic retry was attempted.')
    throw new Error(
      redactNativeText(error instanceof Error ? error.message : 'Native process failed.', options.secrets),
    )
  } finally {
    clearTimeout(timer)
    if (killed) clearTimeout(killed)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
export async function inspectNativeTool(
  path: string,
  kind: NativeBackupToolKind,
): Promise<{ tool: NativeBackupTool; identity: NativeFileIdentity }> {
  const identity = await nativeFileIdentity(path, 100 * 1024 * 1024)
  if (!new RegExp(`^${kind}(?:\\.exe)?$`, 'i').test(basename(identity.path)))
    throw new Error(
      `Select the actual ${kind} executable. Wrapper scripts and other executables are not accepted.`,
    )
  await access(identity.path, constants.X_OK)
  const file = await open(identity.path, 'r')
  try {
    const magic = Buffer.alloc(4)
    await file.read(magic, 0, 4, 0)
    if (
      ![
        '7f454c46',
        'cffaedfe',
        'cefaedfe',
        'feedfacf',
        'feedface',
        'cafebabe',
        'bebafeca',
        'cafebabf',
        'bfbafeca',
      ].includes(magic.toString('hex')) &&
      magic.subarray(0, 2).toString() !== 'MZ'
    )
      throw new Error('Select a native binary, not a shell script or launcher.')
  } finally {
    await file.close()
  }
  const response = await runNative(identity.path, ['--version'], { timeoutMs: 5000, maxOutputBytes: 4096 })
  const match = new RegExp(`^${kind} \\(PostgreSQL\\) (\\d+)(?:\\.\\d+)+(?:[^\\r\\n]*)$`).exec(
    response.stdout.trim(),
  )
  if (!match || Number(match[1]) < 14)
    throw new Error(
      'This workflow requires a PostgreSQL native tool version 14 or later with an identifiable version string.',
    )
  await nativeFileIdentity(identity.path, 100 * 1024 * 1024, identity)
  return {
    tool: {
      id: crypto.randomUUID(),
      kind,
      path: identity.path,
      name: basename(identity.path),
      version: response.stdout.trim(),
      major: Number(match[1]),
      sha256: identity.sha256,
    },
    identity,
  }
}
export async function writeNativeChunk(file: FileHandle, chunk: Buffer) {
  let position = 0
  while (position < chunk.length) {
    const written = await file.write(chunk, position, chunk.length - position)
    if (!written.bytesWritten) throw new Error('Storage stopped accepting backup bytes.')
    position += written.bytesWritten
  }
}
export async function verifyOpenNativeFile(file: FileHandle, identity: NativeFileIdentity) {
  const current = await file.stat(),
    path = await stat(identity.path)
  if (
    current.dev !== identity.device ||
    current.ino !== identity.inode ||
    current.size !== identity.size ||
    current.mtimeMs !== identity.modified ||
    current.ctimeMs !== identity.changed ||
    path.dev !== current.dev ||
    path.ino !== current.ino
  )
    throw new Error('The selected archive changed before execution. Review it again.')
}
