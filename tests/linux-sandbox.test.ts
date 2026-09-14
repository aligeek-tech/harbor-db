import { describe, expect, it } from 'vitest'
import { sandboxPolicy } from '../scripts/linux-sandbox.mjs'

describe('Linux sandbox setup policy', () => {
  it('grants namespaces to only the exact development and packaged executables', () => {
    const policy = sandboxPolicy(
      '/home/developer/My Project',
      '/home/developer/My Project/node_modules/electron/dist/electron',
    )
    expect(policy.text).toContain('"/home/developer/My Project/node_modules/electron/dist/electron"')
    expect(policy.text).toContain('"/home/developer/My Project/release/linux-unpacked/harbor-db"')
    expect(policy.text.match(/userns,/g)).toHaveLength(2)
    expect(policy.text).not.toContain('/**')
    expect(policy.text).not.toContain('capability sys_admin')
    expect(policy.filename).toBe(
      sandboxPolicy(
        '/home/developer/My Project',
        '/home/developer/My Project/node_modules/electron/dist/electron',
      ).filename,
    )
    expect(policy.filename).not.toBe(sandboxPolicy('/home/developer/Elsewhere', '/opt/electron').filename)
  })

  it.each(['*', '?', '{', '}', '[', ']', '"', '\n', '\\'])(
    'rejects pattern/control character %j in an attachment',
    (character) => {
      expect(() => sandboxPolicy(`/home/dev/${character}`, '/opt/electron')).toThrow('unsupported')
      expect(() => sandboxPolicy('/home/dev/project', `/opt/${character}/electron`)).toThrow('unsupported')
    },
  )
})
