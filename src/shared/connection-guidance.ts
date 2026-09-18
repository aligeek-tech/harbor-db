export function redactConnectionMessage(message: string, secrets: string[] = []): string {
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    message = message.split(secret).join('[redacted]')
  return message
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s]+/gi, '[connection URL omitted]')
    .replace(
      /\b(password|passwd|passphrase|token|secret)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[redacted]',
    )
}

export function connectionDiagnostic(message: string): { category: string; nextStep: string } {
  if (
    /ER_CANNOT_RETRIEVE_RSA_KEY|RSA public key is not available|caching_sha2_password.*secure connection/i.test(
      message,
    )
  )
    return {
      category: 'MySQL authentication transport',
      nextStep:
        'Enable TLS and provide the trusted server CA with certificate verification enabled. MySQL password authentication can require a secure connection when its authentication cache is empty; Harbor does not automatically retrieve or trust an RSA key.',
    }
  if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message))
    return {
      category: 'SQLite file lock',
      nextStep:
        'Another connection may hold a transaction or file lock. Finish that work or retry after the lock is released; increasing the lock wait does not resolve the underlying conflict.',
    }
  if (/SQLite file|SQLite path|application metadata cannot|SQLITE_READONLY|EEXIST|ENOENT/i.test(message))
    return {
      category: 'Local database file',
      nextStep:
        'Review the exact file path and file permissions. Open requires an existing database; create requires a new path. Harbor workspace metadata and its sidecar files are protected.',
    }
  if (/host key|hostkey|fingerprint|ssh|all configured authentication methods failed/i.test(message))
    return {
      category: 'SSH tunnel',
      nextStep:
        'Check the SSH host, account, key and pinned host fingerprint. Confirm the database is reachable from the SSH server.',
    }
  if (/ENOTFOUND|EAI_AGAIN|querySrv|DNS|name or service not known|getaddrinfo/i.test(message))
    return {
      category: 'DNS lookup',
      nextStep:
        'Check the hostname and DNS or VPN connection. For SRV targets, verify the DNS records are reachable.',
    }
  if (/certificate|CERT_|SELF_SIGNED|TLS|SSL|hostname.*match/i.test(message))
    return {
      category: 'TLS certificate',
      nextStep:
        'Check the server hostname, certificate expiry and trusted CA chain. Keep certificate verification enabled.',
    }
  if (
    /28P01|28000|authentication failed|password authentication|access denied for user|WRONGPASS|NOAUTH|bad auth|authentication-failed/i.test(
      message,
    )
  )
    return {
      category: 'Authentication',
      nextStep:
        'Check the database username and password. For MongoDB, also check the authentication database and mechanism.',
    }
  if (/42501|permission denied|not authorized|unauthorized|NOPERM|insufficient privilege/i.test(message))
    return {
      category: 'Permission',
      nextStep:
        'Ask the database owner for the minimum privileges needed on this target. A saved profile cannot grant server permissions.',
    }
  if (/3D000|unknown database|database .*does not exist|database .*not found/i.test(message))
    return {
      category: 'Missing database',
      nextStep:
        'Check the database name. Where supported, leave the default database blank to browse databases available to this account.',
    }
  if (
    /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|timed out|timeout|socket|server selection/i.test(
      message,
    )
  )
    return {
      category: 'Network or unavailable server',
      nextStep:
        'Check the host, port, VPN or firewall and whether the server is running. A timeout alone does not establish an authentication failure.',
    }
  return {
    category: 'Connection or configuration',
    nextStep:
      'Review the target and advanced settings. The available error does not identify a more specific cause.',
  }
}
