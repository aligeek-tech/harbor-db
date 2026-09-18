# SQL Server driver and local fixture preflight

Status on 2026-09-18: implementation in progress; native, desktop and packaged acceptance are separate gates. No release or remote deployment is authorized.

## Driver and runtime

The exact direct dependency is **tedious 20.0.0**, MIT, maintained in [tediousjs/tedious](https://github.com/tediousjs/tedious). The installed package declares Node **>=22**. The project’s Node 24 tooling and Electron runtime must still execute the final artifact. Tedious is the asynchronous JavaScript TDS driver; there is no native client library or architecture-specific addon to bundle. It is externalized through the normal Electron dependency path. This does not establish that Windows/Linux artifacts have been executed.

The adapter currently selects SQL username/password authentication only. Integrated authentication, Entra/cloud identity, token renewal and managed-server variants are not claimed. Existing verified TLS settings and SSH transport are reused. The SQL Server driver’s `readOnlyIntent` controls availability-group routing; it is not a read-only permission boundary. Database permissions remain authoritative, with Harbor’s guarded SELECT policy as an additional user-facing restriction. See [Tedious connection API](https://tediousjs.github.io/tedious/api-connection.html).

## Exact values and execution

Tedious decodes decimal/money values into JavaScript numbers and temporal values into JavaScript dates in its [value parser](https://github.com/tediousjs/tedious/blob/master/src/value-parser.ts). Converting those objects to strings afterward cannot restore lost precision or offset.

For one describable SELECT, Harbor requests [sp_describe_first_result_set](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-describe-first-result-set-transact-sql?view=sql-server-ver17), preserves the original ordered metadata, then executes the original statement using native parameter binding and [EXECUTE WITH RESULT SETS](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/execute-transact-sql?view=sql-server-ver17). Exact numeric and modern temporal fields are converted on the server to text before TDS decoding; binary fields remain binary and duplicate output labels remain positional. The description is not a query execution or cached result. A changed/undescribable result shape fails explicitly rather than silently switching to a lossy path.

Legacy MONEY/SMALLMONEY and DATETIME/SMALLDATETIME need explicit conversion styles because their default implicit text format can discard precision. Controlled table-browser projections use style 2 for money and style 126 for legacy datetime, preserving original column metadata separately. Arbitrary editor SQL containing these types must explicitly CONVERT them; Harbor does not rewrite arbitrary projections. Complex batches returning unsupported raw exact types fail with a warning that earlier statements may already have completed. No automatic replay is performed.

Typed parameters declare exact BIGINT/DECIMAL, bit, binary, text or datetimeoffset types while transmitting values independently of SQL text. Decimal exponents are expanded as strings, never through Number. More than 38 decimal digits, integer overflow and temporal precision above 7 fractional digits are rejected before submission. Private-parameter failures use a static redacted message.

Each tab owns a physical TDS session, preserving native transaction state and temporary objects. Query cancellation uses Tedious [Request.cancel](https://tediousjs.github.io/tedious/api-request.html), with completion acknowledged by the original request. It does not undo committed statements. Disconnect rolls back open transactions where acknowledged and never retries queries. GO is a client directive and rejected; USE is rejected to avoid silently changing the tab’s selected database.

Display results retain the requested row count and 8 MiB, then drain the request. Full-result export pauses/resumes rows for consumer backpressure on a dedicated snapshot session, enforces an 8 MiB row ceiling, and never reuses an active editor transaction. It requires the target database’s existing ALLOW_SNAPSHOT_ISOLATION setting; Harbor does not enable this on shared targets. Reviewed table edits require a base table with a declared primary key, reject generated columns, compare the complete original row under update/hold locks, and commit or roll back the reviewed batch atomically.

## Authorized disposable server

The user explicitly accepted the [SQL Server 2022 Developer EULA](https://www.microsoft.com/content/dam/microsoft/usetm/documents/sql-server/sql-server-2022-developer-express-evaluation/retail-packaged/SQLServer2022_SQLServer2022DeveloperExpressEvaluation_English.pdf) for this local test fixture. Developer edition is selected; this is not a production deployment.

- Image: `mcr.microsoft.com/mssql/server@sha256:4402d880dd4c34bfa7d8705e56a86cd6c88da80a1f6bbbe741f999e76264a090`.
- Registry metadata: SQL Server 2022 version 16.0.4295.3, Ubuntu 22.04; image created 2026-08-26.
- Docker Compose project: `harbor-mssql-roadmap-20260918`; loopback binding `127.0.0.1:25433:1433`.
- Limits: 3 GiB container memory, 2 CPUs, SQL Server memory target 2048 MiB, 256 MiB shared memory.
- Disposable data: 2 GiB tmpfs at `/var/opt/mssql`; dedicated Docker bridge; no host project/database mount and no restart policy.
- A newly generated password is stored in a mode 0600 environment file outside the repository. Its contents are not in logs, tests, documentation or source control. EULA acceptance is in a separate local Compose override.
- This Apple Silicon laptop runs the AMD64 image through Docker emulation. Microsoft’s [Linux container guidance](https://learn.microsoft.com/en-us/sql/linux/install-upgrade/quickstart-install-docker?view=sql-server-ver17) supports x86-64 Linux hosts and does not support emulation. Functional evidence from this fixture must not be described as Microsoft-certified ARM server support.

The local fixture lives under the external onboarding temporary directory. Integration tests opt in using `HARBOR_MSSQL_TEST_ENV_FILE`, read only this private local file, and connect only to the fixed loopback fixture port. Each suite creates a uniquely named disposable database, enables snapshot isolation only there, then disconnects and removes it. No test targets an existing database’s user tables.

## Verification status

The focused gate `HARBOR_MSSQL_TEST_ENV_FILE=<private external file> npm exec -- vitest run tests/mssql.integration.test.ts tests/mssql-values.test.ts` passed **16/16 tests** on 2026-09-18 (11 real SQL Server workflows and five helper tests; Vitest2.43s, process2.90s). The environment value is a filename, never a password. Evidence log: external onboarding `logs/implementation-mssql-native2.log`. Full `npm run typecheck` passed at the preceding source checkpoint, and focused ESLint passed; root owns the final integrated gate.

Runtime evidence includes actual SQL Server16 responses; signed BIGINT, decimal(38,9), datetimeoffset(7) with preserved+03:30 offset, datetime2/time seven-digit fractions, NULL, bit, binary and duplicate labels; exact native parameter declarations and private-error redaction; Unicode; catalog/index/composite-FK metadata; bound multi-filter paging and runnable editor SQL; rollback and stale-edit atomic rollback; native cancellation and timeout without replay; permanent termination of a killed tab session; full3000-row export with backpressure, abort/sink failure and oversized-row rejection; and exact MONEY/DATETIME table projection/edit behavior.

TLS checks prove that verified TLS rejects the fixture’s self-signed certificate and that explicit unverified encryption succeeds only for this disposable target. An incorrect password fails without echoing its value. Positive trusted-CA verification and SSH against SQL Server are still unverified. Tedious emits Node DEP0123 for an IP-address TLS ServerName in its ordinary TLS path; no dependency patch or global warning suppression was applied.

Native Electron connection/editor/table workflows and packaged macOS launch are being verified separately by root; do not infer them from service tests. Other-platform artifacts, integrated/Entra authentication, temporary-table description limitations, complex raw exact-result batches, trusted-CA/SSH and full table DDL reconstruction remain explicitly outside the evidence. No supported ARM SQL Server deployment, signed release, or full-ticket acceptance is claimed.

The fixture remains running for root’s distinct native-UI database. Service tests remove only their uniquely created database after closing all sessions. Stop/remove only this task’s fixture with `docker compose --env-file <external>/mssql-test.private.env -f <external>/mssql-compose.pending.yml -f <external>/mssql-compose.accepted.yml -f <external>/mssql-compose.loopback.yml down`; the tmpfs disappears with the container. Keep the private file private; do not paste its contents into a terminal transcript or report.

The initial internal-only bridge suppressed host port publication in this Docker Desktop environment (`NetworkSettings.Ports` was empty although `HostConfig.PortBindings` was set). Startup logs were healthy but a real loopback TCP probe failed. A local Compose override replaces only that fixture network with an ordinary dedicated bridge while preserving the loopback binding, resource limits and disposable storage. No external connection is exercised by the tests.
