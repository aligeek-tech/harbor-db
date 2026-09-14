# Architecture

```text
React renderer (sandbox)
  ├─ Zustand: drafts, open tabs, settings, volatile results and connection state
  ├─ Monaco: locally bundled editor and workers
  └─ TanStack Table + Virtual: bounded result pages and virtual rows
           │ named, typed promises
Minimal preload contextBridge
           │ validated IPC payload + exact sender/frame identity
Electron main
  ├─ IPC / native file dialogs / menus / shutdown handshake
  ├─ MetadataStore (SQLite) + CredentialService (OS safeStorage)
  ├─ SqlService → node-postgres / official MariaDB connector
  ├─ RedisService → official Redis client
  ├─ SSH2 transport → loopback forwarding + host verification
  └─ Export worker → loaded-result CSV / ordered JSON
```

## Contracts

`src/shared/contracts.ts` is the source of truth for Zod validation and TypeScript payloads. Profiles separate metadata from secret input. Query requests contain connection, tab/session and request IDs; responses are ignored when their request is stale or the owning tab no longer exists. Ordered column arrays and ordered row arrays preserve duplicate column names. Exact integers, decimals, JSON text and time representations cross IPC as strings; binary values use tagged base64.

`src/shared/sql.ts` tokenizes quoted identifiers, escaped strings, nested comments and PostgreSQL dollar-quoted bodies. It does not pretend to parse unknown compound MariaDB routines: ambiguous current-statement execution fails closed. The explicit script action submits the authored script without appending a LIMIT. Consequential SQL confirmation is determined again in main, not only in the renderer.

## Sessions and network behavior

Connection managers retain bounded session maps. SQL creates a dedicated physical session for each connection ID and tab ID, preserving transaction affinity. The server's transaction status is authoritative. Failed sessions require explicit reconnect; neither a write nor an open transaction is replayed. Metadata queries use separate sessions. Changing execution-related connection settings closes old sessions; updating only organization metadata does not interrupt them.

Table browsing generates bounded SELECTs with parameterized filters and quoted catalog-validated identifiers. Offsets are explicit; primary-key ordering is preferred. Arbitrary SQL is streamed and drained with capped retained rows/bytes to avoid changing semantics. That display limit does not reduce server work. Redis uses SCAN and bounded reads, deduplicates returned keys, and treats COUNT as a hint rather than an exact progress total.

## Persistence lifecycle

SQLite stores JSON metadata only after validation, plus ciphertext in a separate credential table. Migration writes run in a transaction after `VACUUM INTO` creates a version-stamped backup. Integrity failure aborts startup and identifies the original path. Files are private to the local account where OS permissions support that protection.

Renderer draft updates debounce at 400 ms. On ordinary close, main sends `prepare-close`; renderer resolves active-transaction/staged-change confirmation, flushes current workspace, then calls `readyToClose`. Main closes engines/tunnels, clears session secrets and checkpoints SQLite before exit. A hard crash can lose edits since the last debounce. Backup/checkpoint data can contain ordinary query text; privacy settings are not retroactive secure erasure of old filesystem backups.

Secure storage is injected into CredentialService so tests can cover unavailable/locked states without replacing production OS-backed encryption. No hardcoded encryption key exists. Unremembered secrets are held only in privileged live/pending session memory; disconnect and shutdown clear them. Export validation excludes credential fields and secret flags are cleared.

## Feature ownership

| Area                                   | Source                          |
| -------------------------------------- | ------------------------------- |
| Desktop lifecycle and native menus     | `src/main/index.ts`             |
| Validated operations and sender checks | `src/main/ipc.ts`               |
| SQL sessions/explorers/edit generation | `src/main/engines/sql.ts`       |
| Redis console/key operations           | `src/main/engines/redis.ts`     |
| TLS and SSH transport                  | `src/main/engines/transport.ts` |
| Metadata, credentials, export worker   | `src/main/persistence/`         |
| Shared schemas/tokenizers              | `src/shared/`                   |
| Workbench and feature components       | `src/renderer/src/components/`  |
| Tests                                  | `tests/`                        |

The browser preview has no fake backend. The demo consists of clearly marked in-memory fixtures; execution is disabled. Desktop workflows always use the real privileged adapters.
