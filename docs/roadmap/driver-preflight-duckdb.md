# DuckDB driver preflight — DB-03

Investigated 2026-09-18. This records dependency selection and local verification scope, not full ticket acceptance or release certification. Baseline `d009cc8` did not implement DuckDB. Current implementation work is local and unpublished.

## Driver decision

Use the maintained official **Neo API**, `@duckdb/node-api` pinned exactly to **1.5.5-r.5**, MIT licensed, from [duckdb/duckdb-node-neo](https://github.com/duckdb/duckdb-node-neo). The official [Node Neo overview](https://duckdb.org/docs/current/clients/node_neo/overview) documents instance/connection isolation, prepared values, streaming chunks, and exact value classes. Do not substitute the legacy `duckdb` Node API or a compatibility protocol.

Registry metadata read locally with `npm view @duckdb/node-api version license engines dependencies optionalDependencies repository --json` showed exact dependency `@duckdb/node-bindings: 1.5.5-r.5`, MIT license, and the official repository. No `engines` declaration was returned; compatibility must be tested, not inferred from its absence. Parent integration owns `package.json` and the lockfile.

`npm view @duckdb/node-bindings@1.5.5-r.5 license engines scripts dependencies optionalDependencies --json` showed MIT, `detect-libc: ^2.1.2`, and matching exact optional native packages for:

| OS | Native package CPU/library choices | Verification |
| --- | --- | --- |
| macOS | arm64, x64 | arm64 local Node service tests; packaged Electron smoke still required |
| Windows | arm64, x64 | package metadata only; not executed here |
| Linux | arm64, x64, each glibc or musl | package metadata only; not executed here |

The installed `@duckdb/node-bindings/duckdb.js` selects the binary package from OS/CPU/libc and loads `duckdb.node`. `@duckdb/node-bindings-darwin-arm64@1.5.5-r.5` declares Darwin/arm64 and approximately 117.5 MB unpacked. Preserve its associated native shared-library assets when packaging; having JavaScript in ASAR alone does not establish native loadability. No install script was returned in the queried package metadata. Existing `npmRebuild: false` is not proof that an artifact contains or can load these binaries.

## Isolation and resource design

One worker thread owns one DuckDB instance for each connected profile. Each tab uses a distinct native connection, so in-memory tables share the profile instance while explicit transactions remain isolated. Worker/native failures do not replay queries. The Node driver exposes asynchronous execution and `connection.interrupt()`; interruption is confirmed only by completion/error of the original operation. Earlier committed script statements may already have completed. Cancellation rolls back an open transaction before acknowledging its final result.

The worker retains at most the requested row count and 8 MiB across a script's result sets. It consumes native chunks individually and drains excess rows without retaining them. This is a display bound, not a statement rewrite or a claim that every DuckDB plan streams: sorts, aggregates and other operators may materialize inside the engine. Each instance is configured with 256 MB memory, two threads and no spill directory. Native memory limits do not bound every allocation or constitute an OS sandbox. Typed integers/decimals/timestamps/nested containers use native exact textual representations; BLOB uses tagged base64, NULL remains NULL, duplicate column names keep their ordered positions.

File profiles distinguish open-existing and deliberate create. Creation uses a private sibling temporary directory then an exclusive hard link to the requested filename, so an existing destination is never overwritten. Open-existing first requires a regular existing file and rechecks its identity before native open. Harbor metadata and its sidecars are rejected by canonical path and device/inode identity, including symbolic/hard links. In-memory profiles discard their contents on disconnect. Other processes may hold incompatible DuckDB locks; surfaced native lock failures are not automatically retried as writes.

## External-access boundary

Consulted [DuckDB configuration](https://duckdb.org/docs/current/configuration/overview) and [security guidance](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview). The ordinary instance starts with external access, automatic extension install/load, community and unsigned extensions, and persistent secrets disabled. Allowed paths/directories use their empty defaults. Configuration is locked before any editor SQL. Arbitrary attach/detach, prepared-SQL indirection and extension operations are rejected using native statement classifications as an additional boundary. The `enable_global_s3_configuration` extension option is unavailable when HTTPFS is not loaded; this adapter does not claim to set it. HTTPFS loading, network access and external reads remain disabled.

CSV/JSON/Parquet operations accept a **main-process grant** from a native file picker, never a renderer-supplied path. The root integration owns opaque token binding and identity revalidation. The service again validates a regular file's device/inode and rejects application metadata. It creates a separate empty in-memory instance and sets exactly one canonical file in `allowed_paths`, then disables external access and locks configuration before opening any selected content. This ordering is necessary because allowed paths are SQL-only configuration in the pinned driver and cannot change after external access is disabled. It issues only a fixed file-reader query. No editor SQL executes on this instance. Preview is a bounded prefix; inference/sampling is declared. Import creates a fresh target table in an idle tab transaction and copies native chunks using a native appender, avoiding conversion of exact values through JavaScript numbers. It commits only after the reader finishes; failures/cancellation roll back the newly created table and data. An existing target is never replaced. Remote object storage and general external SQL remain unsupported.

These settings are defense in depth, not a claim that DuckDB is a secure execution sandbox for arbitrary malicious database files. A concurrent actor with filesystem write privileges can mutate a granted file in place; identity checks detect replacement, not every in-place change. Grants must be short-lived, connection-bound and re-reviewed in the UI.

## Verification record and remaining gates

Commands run from repository root through the task's isolated Node 24 runner:

```sh
npm exec -- vitest run tests/duckdb.test.ts
npm run typecheck
npm exec -- eslint src/main/engines/duckdb.ts src/main/engines/duckdb-worker.ts tests/duckdb.test.ts
```

The first adapter run was blocked by the public engine enum not yet containing DuckDB; that run did not pass. Root subsequently added the public enum, and the final fixture uses the real profile schema without overrides. The combined local adapter command `npm exec -- vitest run tests/duckdb.test.ts tests/sqlite.test.ts` passed **36 tests** (18 DuckDB, 18 SQLite) in 6.54 seconds on 2026-09-18. This covers native exact types, independent-process file locks, MVCC conflicts, native aggregate cancellation and timeout, import rollback, scoped CSV/JSON/Parquet workflows, schema/FK metadata, bounded result retention and full-result streaming. Export tests verify 3,000 rows beyond display limits, ordered duplicate columns, consumer backpressure, abort/sink failure cleanup, independent active-tab transactions, oversized-row rejection and engine-enforced read-only sequence mutation rejection. Full typecheck passed at the initial checkpoint; the later shared-source gate must be recorded separately by root.

Full-result export uses a dedicated native `BEGIN TRANSACTION READ ONLY` connection and an acknowledged row protocol. Each callback completes before the worker advances to the next row. No active editor transaction is reused, no modifying SQL is re-executed, and an 8 MiB per-row excess aborts the job instead of finalizing truncated output. Ordinary query display limits do not truncate export. Export snapshot scope is new execution against committed data, not a recreation of an earlier editor result.

Remaining full-ticket gates include final service tests; native Electron picker, preview/import and table workflows; actual native-module load from the packaged macOS artifact; supported platform jobs for Windows/Linux and other CPU targets; cancellation/locking/error evidence; exact capability declarations; and no external access beyond the reviewed path. No signed release, other-platform runtime verification, publication or security certification is claimed here.
