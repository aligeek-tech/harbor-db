# Evidence and verification contract

## Baseline

The source baseline examined is `d009cc8ec8151caf228cec48bb16120e133c28ee` on `main`, version `0.1.7`. Its application source matches annotated tag `v0.1.7` at `3a924779b0edfeefb8282ee4dda8864474a54544`; the later baseline commit changes only `docs/VALIDATION.md`. This identifies the starting source, not any uncommitted candidate that follows it.

The initial history contains 18 commits dated 2026-09-14–15. The first commit introduces the existing app in one large addition; it does not preserve preceding design conversations. Older-machine conversations, ignored state, credentials, and live databases are not implied by this clone.

The supplied roadmap reports a later onboarding run with 13 desktop passes and five macOS editor-input failures. Treat these as historical reproduction leads. The repository's [validation record](../VALIDATION.md) reports older release-specific Linux/CI results, including 93 unit, 166 integration-enabled, and 18 desktop cases for v0.1.7. Neither set is acceptance evidence for new local changes. Do not combine the totals.

## Existing surfaces to preserve

These paths were present at the baseline; the links point to the current checkout, whose contents may change during implementation.

| Baseline surface | Evidence | Reconciliation implication |
| --- | --- | --- |
| Four explicit engine identities | [contracts.ts](../../src/shared/contracts.ts), [package.json](../../package.json) | `postgres`, `mariadb`, `redis`, and `mongodb` are the starting engines. Protocol compatibility does not automatically add another engine. |
| Profile organization and safe defaults | `profileSchema` in [contracts.ts](../../src/shared/contracts.ts) | Folder, tags, favorite, environment, read-only, timeout, TLS/SSH, and reconnect fields already exist. UX-01/02 need gap analysis. |
| Validated privileged operations | [preload](../../src/preload/index.ts), [IPC](../../src/main/ipc.ts), [desktop lifecycle](../../src/main/index.ts) | New capabilities require typed, validated, named operations and exact sender checks; do not expose arbitrary shell/filesystem/IPC access. |
| SQL sessions and editing | [sql.ts](../../src/main/engines/sql.ts), [table-query.ts](../../src/shared/table-query.ts), [sql tokenizer](../../src/shared/sql.ts) | Preserve database/tab/session affinity, explicit transactions, locking/conflict checks, bounded results, exact values, and uncertain-write behavior. |
| MongoDB documents | [mongo.ts](../../src/main/engines/mongo.ts), [MongoBrowser.tsx](../../src/renderer/src/components/MongoBrowser.tsx) | Existing read/aggregate/reviewed mutation flow; query history and topology administration are not implied. |
| Redis standalone | [redis.ts](../../src/main/engines/redis.ts), [RedisBrowser.tsx](../../src/renderer/src/components/RedisBrowser.tsx) | Preserve binary-safe keys, bounded SCAN/inspection, TTL behavior, and mutation safeguards. Cluster/Sentinel need independent fixtures. |
| Transport and credentials | [transport.ts](../../src/main/engines/transport.ts), [credentials.ts](../../src/main/persistence/credentials.ts) | Verified TLS, original hostname through SSH, explicit host trust, OS-protected remembered credentials and session-only fallback. |
| Workspace/library | [store.ts](../../src/main/persistence/store.ts), [renderer store](../../src/renderer/src/store.ts), [Library.tsx](../../src/renderer/src/components/Library.tsx) | Existing migration backups, drafts, saved-query targeting metadata, history and privacy behavior; migrate rather than reset. |
| Loaded export / bounded CSV import | [export.ts](../../src/main/persistence/export.ts), [CsvImportDialog.tsx](../../src/renderer/src/components/CsvImportDialog.tsx), [csv.ts](../../src/shared/csv.ts) | Full streaming/export jobs and broader imports are extensions, not aliases for loaded rows. |
| Real desktop tests | [tests](../../tests), [electron-runtime.ts](../../tests/electron-runtime.ts) | Keep real Monaco, IPC, engine, restart and sandbox assertions. A renderer store injection cannot replace all interaction coverage. |

At this baseline the architecture diagram omits MongoDB, and the Linux package synopsis omits it too. FIX-05 owns reconciling those records. The starting `ConnectionStatus` has five states without a timestamp; FIX-04 must establish actual failure/recovery behavior before changing that contract.

## Non-negotiable engineering requirements

- Privileged drivers, local files, secrets, and native tools stay outside the renderer. Validate inputs and sender/frame identity in main.
- Preserve connection/database/schema/tab/session/request identity and stale-response rejection. Opening/restoring/importing a query must never execute it automatically.
- Never automatically replay writes, uncertain mutations, or failed transactions. A recovered connection does not recreate an old transaction.
- Read-only profiles are application safeguards; database permissions enforce authorization. Never describe SQL text classification as a security boundary.
- Keep exact integers/decimals, BSON types, NULL/empty distinctions, binary, timezone information, ordered duplicate columns, and nested values. No silent truncation or coercion.
- Keep secrets out of query history, diagnostic bundles, exports, screenshots, fixtures and logs. Review both success and error paths. Session secrets must be cleared on disconnect/shutdown.
- Preserve protected credential storage. Do not export OS ciphertext or blindly copy machine-specific paths. Secret-free handoffs still contain potentially sensitive query text and require scope review.
- Blocking/native and large streaming work must not freeze the desktop main process. Bound queues, retained results and concurrent jobs.
- Preserve existing workspace data through migrations, validation failures and recovery. Test upgrade from baseline storage with a disposable copy and rollback/recovery behavior.

## Verification packs used by the backlog

These packs are requirements, not assertions that all necessary tests already exist. Existing commands below are real baseline commands. Add focused regression tests where the ticket introduces behavior; name their exact commands in the ticket's completion record. A new engine needs its own real fixture and actual desktop flow.

| Pack | Required evidence |
| --- | --- |
| V-BASE | Locked dependency resolution where manifests changed; ESLint, strict typecheck, focused units, production build; appropriate existing regressions on the final candidate. |
| V-UI | Real Electron interaction, actual editor contents before run, keyboard/focus, empty/loading/error/cancel states, narrow and normal windows, dark/light/system, renderer errors and failed requests. |
| V-TARGET | Two compatible connections/databases with distinguishable data plus incompatible/offline/deleted targets; bound identity survives navigation, save/reopen and restart; opening never executes. |
| V-ENGINE | Complete per-engine acceptance contract below, with server/version/auth/topology/OS recorded separately; a mock is insufficient. |
| V-WRITE | Read-only rejection, target confirmation, conflict/duplicate/constraint errors, exact values, atomicity or truthful partial commits, uncertain disconnect outcome, no automatic replay. |
| V-PERSIST | Baseline database migration, metadata/draft/history preservation, restart/crash recovery, private session handling, secret redaction, corrupted/unsupported-version recovery. |
| V-JOB | Bounded worker/IPC queues, progress, timeout/cancel, disconnect, disk-full, partial-file marking, exact output, no leaking handles/sessions, cleanup and multi-tab responsiveness. |
| V-PERF | Reproducible machine/fixture budget; large catalog, million-row/document/key equivalent, wide/large values, concurrency; first usable result, peak memory, responsiveness, cancellation latency and cleanup. |
| V-TRANSPORT | Valid/invalid credentials, TLS trusted/wrong hostname/untrusted CA, claimed client-cert/SSH modes, trust mismatch, disconnect/reconnect and cleanup; no insecure default workaround. |
| V-PACKAGE | Actual packaged launch with isolated data; native module loading on each claimed OS/architecture; normal OS keychain outside mock-keychain switches; signature identity checked separately from notarization. |
| V-PRIVACY | Explicit scope/consent, secret/data-flow inspection, imported untrusted text and path handling, private-history behavior, cancellation and retention; external transmission tested only with authorization. |

### Existing check commands

Run from the exact candidate checkout or a faithful disposable copy, with Node 24 and locked dependencies. Capture cwd, runtime versions, candidate commit plus working-diff fingerprint, command, start/end time, exit code, output location and fixture identities. Read current scripts first. `npm run format` mutates files and is not a verification command.

```sh
rtk npm ci
rtk npm run lint
rtk npm run typecheck
rtk npm test
rtk npm run build
rtk npm exec -- prettier --check src tests '*.ts' '*.json'
rtk proxy env HARBOR_TIMESCALE=1 npm run test:integration
rtk proxy env HARBOR_INTEGRATION=1 HARBOR_TIMESCALE=1 npm run test:e2e
rtk npm run benchmark
rtk npm run build
rtk npm exec -- electron-builder --dir --publish never
```

Integration, E2E and benchmark commands require the inspected disposable fixtures. Benchmark additionally requires the inspected seed. Current `tests/package.e2e.ts` is a Linux-oriented packaged check; do not report it as macOS/Windows acceptance. Its documented Linux invocation is `rtk proxy env HARBOR_PACKAGE=1 npm exec -- playwright test tests/package.e2e.ts`. Native platform equivalents require actual evidence. A packaging build alone is not startup or credential acceptance.

Use test-file filters for focused work, for example `rtk npm exec -- vitest run tests/persistence.test.ts`, or after building, `rtk npm exec -- playwright test tests/single-instance.e2e.ts`. Do not weaken assertions, update snapshots just to pass, or substitute old results after source changes.

### Fixture and process boundaries

The baseline [Compose file](../../compose.yaml) uses loopback ports 15432 PostgreSQL, 13306 MariaDB, 17017 MongoDB, 16379 Redis, and optional 15433 TimescaleDB. Existing scripts/tests often hardcode these ports and fixture credentials; verify occupants before starting anything. Use a unique Compose project and disposable volumes. Do not stop unrelated services to free ports. If ports are occupied, use an inspected temporary override and a supported test configuration; do not point tests at an unknown database.

MongoDB and Timescale use temporary storage; PostgreSQL/MariaDB/Redis default to named volumes. The seed creates SQL rows and replaces named Redis fixtures. Loopback is not proof that data is disposable. Record service names, image tags/digests, ports, volume names, created databases/schemas/keys, and exact stop commands. Test screenshot paths may be fixed under `/tmp/harbor-db-e2e`; preserve pre-existing artifacts before overwriting them.

Use `HARBOR_USER_DATA` only for the unpackaged app, with a newly created disposable directory. Packaged isolation must use the platform's actual supported mechanism and be checked before launch. No automatic reconnect may reach an existing user profile. Inspect native-tool and engine startup side effects before running them. Do not install global software, change global security policy, or provision cloud services as an implicit verification step.

## Per-engine acceptance contract

For every advertised engine, server version, authentication method, topology and OS/CPU combination:

1. Record a reproducible fixture or exact external prerequisite, client provenance/license, versions and platform support.
2. Exercise successful connection, invalid credentials, restricted catalog privileges, unavailable target, claimed TLS/SSH, interruption, recovery and cleanup.
3. Browse objects and run bounded representative queries; assert exact types including large integers/decimals, NULL/empty, timestamps, binary, duplicate fields and nested/engine-specific values.
4. Verify cancellation/timeout semantics and cleanup. Distinguish cancellation requested, server-confirmed termination, unknown outcome and partial result.
5. For writes, verify reviewed target, safeguard rejection, concurrency conflicts, transaction/partial-commit behavior and ambiguous network failure. Never replay automatically.
6. For supported import/export, verify fidelity, limits, progress, cancel, partial completion and failure cleanup.
7. Save/reopen/restart without automatic execution or transaction restoration.
8. Exercise an actual desktop workflow against the real engine; preview fixtures and unit mocks are insufficient.
9. Load any native module inside the packaged application on each advertised OS/CPU, or explicitly withhold that claim.
10. Record unsupported operations, permission limitations and blocked checks. Update capability claims only to the level earned by this evidence.

Before selecting any new driver, check current official documentation, maintenance, redistribution/license terms, supported Node/Electron/OS/CPU, type model and reproducible testing. Links in the original brief are research starting points, not a frozen technical contract. Do not install a package merely because its name resembles an engine.

## Capability and support record

Use one row per materially different combination; no automatic inheritance from MySQL/MariaDB or other protocol-compatible products. Managed deployments, authentication methods, topology and platform need separate rows.

| Engine / capability | Server version | Client version | Topology | Authentication / transport | OS / CPU | Level | Source status | Verification / evidence | Limits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| No new claim recorded | — | — | — | — | — | Unassigned | Needs reconciliation | None | Populate only from evidence |

Preview is experimental with visible limits. L1 requires connection/authentication/discovery/bounded read/exact values/cancellation semantics and clear errors. L2 adds model-appropriate reviewed writes, parameters, history, import/export and real integration/UI checks. L3 adds supported schema/index/permission/diagnostic/topology/backup workflows. Record levels by capability where support depth differs. Merely implementing a form never earns L1.

## Performance gate

Before claiming performance, record CPU, memory, OS, storage, runtime, server image, dataset generator/seed, row/value widths, concurrency and the measurement method. Set justified budgets for first usable result, peak main/renderer/worker memory, interaction responsiveness, cancellation latency and resource cleanup. Do not invent thresholds without a measured reference.

For streaming, use total data larger than the allowed memory budget and compare multiple dataset sizes. Memory must remain bounded rather than grow with output size. Include slow disk/consumer, errors and concurrent tabs. A fast first page or one million tiny rows is not proof of bounded full export.

## Ticket completion record template

Append dated records below, then update the ticket status and index consistently. Preserve prior failure evidence rather than overwriting it with a success label.

```text
Date / ticket / owner:
Candidate: commit plus working-tree fingerprint; cwd:
Current capability: existing / partial / absent / unverified
Work status: ready / in-progress / implemented / blocked
Acceptance: not-run / partial / passed / failed / blocked
Delivery: local-only
Reproduction and baseline evidence:
Behavior and files changed:
Dependency slices satisfied and remaining gaps:
UX flow / focus / empty, loading and error states:
Engine / version / auth / topology / OS / CPU:
Commands, prerequisites, exit codes and evidence paths:
Passed scenarios and failure/cancellation coverage:
Unavailable or skipped checks and why:
Performance/resource observations:
Migration, recovery and data/credential handling:
Residual limitations and next executable action:
Local processes/resources, stop commands and final workspace state:
```

## Progress records

### 2026-09-18 — backlog initialization

The 78-ticket backlog, dependency map, verification contract and proposed UX flows were transcribed from the user-supplied brief. This is a documentation/planning action only. No ticket is marked implemented or accepted by this entry. Concurrent implementation must add its own evidence before changing any status.

### 2026-09-18 local checkpoints after the first integrated build

All commands below run at `/Users/aligeek/Documents/harbor-db` with Node24.19.0/npm11.19.0 through the external isolated runner described in PROGRESS.md. This is incremental evidence, not final acceptance of later edits. No releases were published.

| Check | Exact npm command (environment before command) | Result | Limits |
|---|---|---|---|
| M1 integrated build3 | `npm run build` | exit0 | Source continued afterward |
| Normal OS credential backend | `HARBOR_NATIVE_STORAGE=1 npm exec -- playwright test tests/native-storage.e2e.ts` (included in m1-gate-ui3 combined run) | individual test passed; whole run exit1 from unrelated tests | Native macOSARM only; no mock keychain/basic store |
| M2 core build | `npm run build` | exit0 | Built artifact fingerprint recorded below |
| Loaded grid/library | `HARBOR_INTEGRATION=1 npm exec -- playwright test tests/accessibility.e2e.ts tests/grid-library.e2e.ts tests/related-records.e2e.ts` | both grid/library cases passed; overall exit1 | Related-record geometry and theme transition test timing failed, not accepted |
| Settled UI accessibility | `npm exec -- playwright test tests/accessibility.e2e.ts` | 1passed, exit0 | Single Electron frame; light/dark settings/welcome/connection/palette keyboard+WCAG; finite transitions awaited; no rules disabled |
| Server view / SQL generation / IPC | `HARBOR_INTEGRATION=1 npm exec -- vitest run tests/server-table-view.test.ts tests/sql-table-query.test.ts tests/ipc.test.ts` | 30passed, exit0 | Actual PG/Maria/MySQL/SQLite/DuckDB; not desktop server-view acceptance |

The first server-view candidate regressed legacy default PK sort direction (1failed/29passed). Preserving legacy direction fixed it; structured sort tie-breakers remain explicitly ascending. No failing assertion was weakened.

M2 core built artifact SHA-256 (`out/**`, sorted paths and per-file SHA): `6809a1620fdb292be0f0c73e8af152d36718b25c8877562f3939ed0a34a85340`.
