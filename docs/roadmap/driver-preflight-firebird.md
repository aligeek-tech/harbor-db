# Firebird DB-30 — 2026-09-18

Pinned `node-firebird-driver-wire` 0.0.1-beta.4 and its directly used `node-firebird-driver` 3.7.1 interfaces are MIT and pure Node JavaScript. Published lifecycle scripts were inspected and installs used `--save-exact --ignore-scripts --no-audit --no-fund`. The wire driver remains experimental, disclosed in the form and query messages. No native fbclient distribution is required. Other OS/architecture packages have not been verified.

Official image Firebird 5.0.4, native ARM64, index `sha256:1529560400fc7847f015c57fc9d70729c44d9a9d8f9000df19c5ce1950b4c202`, ARM child `sha256:e7e66d1a4d0ba5754d193aade9b8bc6d7f28616f29bade94f7db8c79fe5265d9`. Entrypoint was inspected before starting the disposable database. The fixture uses localhost13050, 512 MiB/1CPU, a 256MiB tmpfs data directory and a new synthetic password stored externally mode0600. No host database file or shared endpoint is mounted. `compose.firebird.yaml` reproduces those limits; stopping its tmpfs database discards its data.

## Implementation

Server mode accepts explicit database aliases or server file paths. Local-file mode accepts an absolute path through an existing loopback Firebird server; it is not embedded opening and never creates/overwrites a user database. Direct native wire is restricted to loopback; remote use requires existing verified SSH. Native Firebird authentication is not advertised as TLS; TLS flags and unsupported IPv6 forms fail closed.

Firebird 5.x table/view catalogs, column/primary-key metadata, bounded table paging/sorting, typed SQL results, per-tab native transactions and read-only streaming export are implemented. Each physical tab owns an attachment; changed database identity is rejected. Native READ_ONLY transactions protect reads. Writes use review where required; failed transactions must roll back. Cancellation is request-bound and native. No automatic reconnect or statement replay occurs. Lost commit acknowledgement makes the connection degraded and reports uncertainty.

The pinned driver's default fixed-number and temporal decoding loses precision. `firebird-values.ts` requests exact native server VARCHAR representations in the statement-owned BLR result descriptor, retaining original type labels. It does not patch installed dependencies or rewrite user SQL. Its guarded metadata interface fails before execution on driver/type drift. IEEE floats stay native, binary is tagged, and LOB reads are bounded. Parameters, grid edits, server-generated filters, inferred DDL/indexes/foreign keys and affected-row counts are not advertised.

## Verification

`implementation-firebird-native3`: 10/10 passed, exit0, 1.35s runner. Actual engine cases cover 64/128-bit/scaled numerics, four-digit timestamps/timezone, binary/Unicode LOB/null/empty, duplicate labels and row limits, catalogs/PK, separate-tab transaction commit/rollback/failed-state guards, concurrent transaction controls, read-only rejection, actual restricted-user UPDATE denial, bad credentials, target mismatch, TLS/remote-plaintext rejection, cursor backpressure/abort and active-query cancellation. A real COMMIT followed by an injected client acknowledgement failure persisted exactly one row, reported uncertainty and did not replay; this is a native engine plus injected acknowledgement test, not a wire-loss proxy.

Native desktop and packaged loading evidence is recorded separately in PROGRESS.md. Earlier build failure exposed bundling of an undeclared direct interface dependency; it was pinned explicitly. First native startup then exposed missing ESM `.js` subpaths that the test bundler had hidden; explicit runtime paths fixed it. Those failures are preserved in logs and are not counted as passes. Wider server versions, native remote transport fixtures and Windows/Linux packaging remain unverified.

References: [driver source](https://github.com/asfernandes/node-firebird-drivers), [Firebird Docker](https://github.com/FirebirdSQL/firebird-docker), [Firebird 5 reference](https://firebirdsql.org/file/documentation/chunk/en/refdocs/fblangref50/fblangref50.html).
