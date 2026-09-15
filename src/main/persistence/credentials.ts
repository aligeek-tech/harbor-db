import type { Secrets } from '../../shared/contracts'

export interface SecureStorageProvider {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}
export interface StoredCredential {
  ciphertext: Uint8Array
  hasPassword: boolean
  hasSshPassword: boolean
  hasPassphrase: boolean
}
export interface CredentialRepository {
  getCredential(id: string): StoredCredential | undefined
  writeCredential(id: string, value: StoredCredential): void
  deleteCredential(id: string): void
}

/** Only privileged code can instantiate this service or request plaintext credentials. */
export class CredentialService {
  private session = new Map<string, Secrets>()
  private lastFailure?: { id: string; reason: string }
  constructor(
    private provider: SecureStorageProvider,
    private repository: CredentialRepository,
    private platform = process.platform,
  ) {}

  status(): { available: boolean; backend: string; reason?: string } {
    const protection = this.protectionStatus()
    return protection.available && this.lastFailure
      ? { ...protection, available: false, reason: this.lastFailure.reason }
      : protection
  }

  private protectionStatus(): { available: boolean; backend: string; reason?: string } {
    let backend =
      this.platform === 'linux'
        ? 'unknown'
        : this.platform === 'darwin'
          ? 'keychain'
          : this.platform === 'win32'
            ? 'dpapi'
            : 'unknown'
    try {
      if (this.platform === 'linux') backend = this.provider.getSelectedStorageBackend?.() || 'unknown'
      // Electron currently exposes these OS-backed Linux choices. Never accept a fallback.
      const trusted =
        this.platform === 'linux'
          ? ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)
          : ['keychain', 'dpapi'].includes(backend)
      if (!trusted)
        return {
          available: false,
          backend,
          reason:
            'No protected operating-system credential store is available. Passwords are session-only; existing encrypted passwords are preserved.',
        }
      if (!this.provider.isEncryptionAvailable())
        return {
          available: false,
          backend,
          reason:
            'The operating-system credential store is unavailable or locked. Unlock it and retry, or supply a session-only password.',
        }
      return { available: true, backend }
    } catch {
      return {
        available: false,
        backend,
        reason:
          'The operating-system credential store could not be accessed. Existing encrypted passwords are preserved.',
      }
    }
  }

  prepare(
    id: string,
    supplied: Secrets | undefined,
    remember: boolean,
  ): { credential?: StoredCredential; remove: boolean; session?: Secrets } {
    const previous = this.repository.getCredential(id)
    if (!remember) return { remove: true, session: supplied }
    if (!supplied || Object.keys(supplied).length === 0) return { credential: previous, remove: false }
    // A user-initiated save retries a protected backend after a temporary lock.
    if (!this.protectionStatus().available) return { credential: previous, remove: false, session: supplied }
    let merged = { ...this.session.get(id), ...supplied }
    if (previous) {
      try {
        merged = { ...JSON.parse(this.provider.decryptString(Buffer.from(previous.ciphertext))), ...merged }
      } catch {
        this.lastFailure = {
          id,
          reason:
            'A saved password could not be unlocked. Existing encrypted passwords are preserved; newly entered passwords are session-only. Unlock the credential store and retry the connection.',
        }
        return { credential: previous, remove: false, session: supplied }
      }
    }
    try {
      const credential = {
        ciphertext: this.provider.encryptString(JSON.stringify(merged)),
        hasPassword: merged.password !== undefined,
        hasSshPassword: merged.sshPassword !== undefined,
        hasPassphrase: merged.passphrase !== undefined,
      }
      this.lastFailure = undefined
      return {
        remove: false,
        credential,
      }
    } catch {
      this.lastFailure = {
        id,
        reason:
          'The operating-system credential store could not encrypt this password. It may be locked. Newly entered passwords are session-only and existing encrypted passwords are preserved; unlock the store and retry saving.',
      }
      return { credential: previous, remove: false, session: supplied }
    }
  }

  rememberSession(id: string, secrets?: Secrets): void {
    if (secrets) this.session.set(id, { ...this.session.get(id), ...secrets })
  }
  resolve(id: string, supplied?: Secrets): Secrets {
    if (supplied) this.rememberSession(id, supplied)
    const session = this.session.get(id)
    const stored = this.repository.getCredential(id)
    if (!stored) return { ...session }
    const hasAllSavedFields =
      session &&
      (!stored.hasPassword || session.password !== undefined) &&
      (!stored.hasSshPassword || session.sshPassword !== undefined) &&
      (!stored.hasPassphrase || session.passphrase !== undefined)
    if (hasAllSavedFields) return { ...session }
    const status = this.protectionStatus()
    if (!status.available) throw new Error(status.reason)
    try {
      const secret = {
        ...JSON.parse(this.provider.decryptString(Buffer.from(stored.ciphertext))),
        ...session,
      }
      this.lastFailure = undefined
      return secret
    } catch {
      this.lastFailure = {
        id,
        reason:
          'A saved password could not be unlocked. Existing encrypted passwords are preserved. Unlock the operating-system credential store and retry, or enter a session-only password.',
      }
      throw new Error(
        'The saved password could not be unlocked. Unlock your credential store and retry, or enter a session-only password. The encrypted password has been preserved.',
      )
    }
  }
  forget(id: string): void {
    this.repository.deleteCredential(id)
    this.clearSession(id)
    if (this.lastFailure?.id === id) this.lastFailure = undefined
  }
  clearSession(id: string): void {
    this.session.delete(id)
  }
  clearAll(): void {
    this.session.clear()
  }

  /** Driver errors may echo connection URLs or credentials; sanitize at the privilege boundary. */
  sanitize(error: unknown, extra?: Secrets): string {
    let message = error instanceof Error ? error.message : 'Operation failed'
    for (const secret of [...this.session.values(), ...(extra ? [extra] : [])]) {
      for (const value of Object.values(secret)) if (value) message = message.split(value).join('[redacted]')
    }
    return message
      .replace(
        /((?:postgres(?:ql)?|mariadb|mysql|redis|rediss|mongodb(?:\+srv)?):\/\/)[^\s/@]*@/gi,
        '$1[redacted]@',
      )
      .replace(/\b(password|passwd|passphrase|AUTH)\s*[=: ]\s*[^\s,;]+/gi, '$1=[redacted]')
      .slice(0, 3000)
  }
}

export function redactHistory(sql: string): string {
  if (
    /\b(?:AUTH|HELLO\s+[^\r\n]*\bAUTH|PASSWORD|IDENTIFIED\s+BY|MASTERAUTH|REQUIREPASS|ACL\s+SETUSER|CONFIG\s+SET)\b/i.test(
      sql,
    ) ||
    /(?:postgres(?:ql)?|mariadb|mysql|redis|rediss):\/\/[^\s]*@/i.test(sql)
  )
    return '[Credential-bearing command omitted]'
  return sql
}
