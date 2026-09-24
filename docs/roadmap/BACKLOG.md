# Complete implementation backlog

This checklist contains **78 independently tracked tickets** transcribed from the 2026-09-18 product brief. Original acceptance text is preserved in each card. Dependencies, source entry points and verification scenarios are planning additions. See [README.md](README.md) for authorization/milestones, [EVIDENCE.md](EVIDENCE.md) for common gates, and [UX_FLOWS.md](UX_FLOWS.md) for proposed interactions.

**Current state:** checked tickets have the concrete local acceptance evidence recorded in their card and PROGRESS.md. Unchecked tickets remain incomplete or have unresolved verification. The owner authorized a single-task release continuation on September24; see [RELEASE-CHECKPOINT.md](RELEASE-CHECKPOINT.md). A bounded release does not accept every original ticket. Platform gaps remain explicit and are never converted into passes.

**Common first action:** inspect the listed source and tests at the actual candidate; classify requested scope as existing/partial/absent/unverified and retain evidence. Extend existing behavior. For UX tickets validate the relevant proposed flow before changes. For every engine ticket check current official driver/server documentation, licensing, packaging, type model and fixture availability before adding a dependency.

**Completion rule:** original acceptance below plus the named verification packs and [per-engine contract](EVIDENCE.md#per-engine-acceptance-contract) where applicable must be met. Record exact commands, candidate, fixture and exit results in the evidence ledger. An unavailable platform or real engine leaves the relevant acceptance blocked; a mock, connection form or build cannot close the ticket.

## Ticket index

| Complete | ID | Milestone | Priority | Outcome | Status |
| --- | --- | --- | --- | --- | --- |
| [x] | [FIX-01](#fix-01) | M0 | P0 | Repair macOS Monaco E2E input helpers. | implemented and verified locally |
| [ ] | [FIX-02](#fix-02) | M0 | P0 | Make shortcut labels and behavior platform-correct. | in-progress; acceptance pending |
| [x] | [FIX-03](#fix-03) | M0 | P0 | Prevent ambiguous saved-query targeting. | implemented and verified locally |
| [ ] | [FIX-04](#fix-04) | M0 | P0 | Make connection status accurate. | in-progress; acceptance pending |
| [ ] | [FIX-05](#fix-05) | M0 | P0 | Close release-verification gaps. | release gates expanded to13native installers and locked dependency audit; final publication evidence in RELEASE-CHECKPOINT.md |
| [ ] | [UX-01](#ux-01) | M1 | P1 | Connection hub: folders, tags, favorites, recent targets, environment labels, duplicate profile, search. | in-progress; acceptance pending |
| [ ] | [UX-02](#ux-02) | M1 | P1 | Connection wizard and actionable diagnostics. | in-progress; acceptance pending |
| [ ] | [UX-03](#ux-03) | M1 | P1 | Command palette and object search. | in-progress; acceptance pending |
| [ ] | [UX-04](#ux-04) | M1 | P1 | Productive query editor. | in-progress; partial implementation / acceptance pending |
| [x] | [UX-05](#ux-05) | M1 | P1 | Typed query parameters. | implemented and verified locally |
| [ ] | [UX-08](#ux-08) | M1 | P1 | Visible staged edits and transaction state. | partial; pending insert/update/delete counts and missing-snapshot summary added; complete original acceptance remains open |
| [ ] | [UX-11](#ux-11) | M1 | P1 | Accessible, consistent interaction. | in-progress; partial implementation / acceptance pending |
| [ ] | [DB-01](#db-01) | M1 | P1 | MySQL | in-progress; acceptance pending |
| [ ] | [DB-02](#db-02) | M1 | P1 | SQLite | in-progress; acceptance pending |
| [ ] | [UX-06](#ux-06) | M2 | P1 | Better result-grid navigation. | in-progress; partial implementation / acceptance pending |
| [ ] | [UX-07](#ux-07) | M2 | P1 | Related-record navigation. | in-progress; partial implementation / acceptance pending |
| [x] | [UX-09](#ux-09) | M2 | P1 | Organized workspace. | implemented and verified locally |
| [x] | [UX-10](#ux-10) | M2 | P1 | Query library and useful history. | implemented and verified locally |
| [ ] | [UX-12](#ux-12) | M2 | P1 | Responsive large-data operation. | in-progress; partial implementation / acceptance pending |
| [ ] | [ADV-01](#adv-01) | M2 | P1 | Full-result streaming export | in-progress; partial implementation / acceptance pending |
| [ ] | [ADV-02](#adv-02) | M2 | P1 | Import wizard | in-progress |
| [ ] | [ADV-03](#adv-03) | M2 | P1 | Object inspector and generated SQL | in-progress; partial implementation / acceptance pending |
| [ ] | [ADV-06](#adv-06) | M2 | P1 | Query-plan inspector | in-progress; partial implementation / acceptance pending |
| [x] | [ADV-13](#adv-13) | M2 | P1 | Portable workspace handoff | implemented and verified locally |
| [ ] | [DB-03](#db-03) | M2 | P1 | DuckDB | in-progress; partial implementation / acceptance pending |
| [ ] | [DB-04](#db-04) | M2 | P1 | Microsoft SQL Server | in-progress; partial implementation / acceptance pending |
| [ ] | [ADV-04](#adv-04) | M3 | P2 | Visual schema editing | in-progress; partial implementation / acceptance pending |
| [ ] | [ADV-05](#adv-05) | M3 | P2 | ER diagrams | in-progress; partial implementation / acceptance pending |
| [ ] | [ADV-07](#adv-07) | M3 | P2 | Schema comparison and migration draft | in-progress; partial implementation / acceptance pending |
| [ ] | [ADV-08](#adv-08) | M3 | P2 | Data comparison | in-progress; partial implementation / acceptance pending |
| [ ] | [ADV-10](#adv-10) | M3 | P2 | Activity and lock diagnostics | in-progress; partial implementation / acceptance pending |
| [ ] | [ADV-11](#adv-11) | M3 | P2 | Index and permission tools | in-progress; partial implementation / acceptance pending |
| [ ] | [ADV-14](#adv-14) | M3 | P2 | Engine-specific advanced tools | in-progress; partial implementation / acceptance pending |
| [ ] | [ADV-16](#adv-16) | M3 | P2 | Engine adapter architecture | in-progress; partial implementation / acceptance pending |
| [ ] | [DB-05](#db-05) | M3 | P2 | ClickHouse | in-progress |
| [ ] | [DB-06](#db-06) | M3 | P2 | Elasticsearch | in-progress; partial implementation / acceptance pending |
| [ ] | [DB-07](#db-07) | M3 | P2 | OpenSearch | in-progress; partial implementation / acceptance pending |
| [ ] | [DB-08](#db-08) | M3 | P2 | Oracle Database | in-progress; partial implementation / acceptance pending |
| [ ] | [EXT-01](#ext-01) | M3 | P1 | PostgreSQL depth | in-progress; partial implementation / acceptance pending |
| [ ] | [EXT-02](#ext-02) | M3 | P2 | MariaDB depth | in-progress; partial implementation / acceptance pending |
| [ ] | [EXT-03](#ext-03) | M3 | P2 | MongoDB replica sets and Atlas/SRV | in-progress; partial implementation / acceptance pending |
| [ ] | [EXT-04](#ext-04) | M3 | P2 | Redis Cluster | in-progress; partial implementation / acceptance pending |
| [ ] | [EXT-05](#ext-05) | M3 | P2 | Redis Sentinel | in-progress; partial implementation / acceptance pending |
| [ ] | [EXT-07](#ext-07) | M3 | P2 | TimescaleDB depth | in-progress; partial implementation / acceptance pending |
| [ ] | [ADV-09](#adv-09) | M4 | P2 | Database-to-database transfer | implemented; backend112/112, native UI5/5 and410MB transfer evidence; final acceptance reconciliation pending |
| [ ] | [ADV-12](#adv-12) | M4 | P2 | Backup and restore workflows | implemented; real PG18.6 restore and interruption verified; platform/tool scope limits remain |
| [ ] | [ADV-15](#adv-15) | M4 | P2 | Analytics workspace | implemented with native reports1/1 and persistence checks passed; integrated acceptance pending |
| [ ] | [ADV-17](#adv-17) | M4 | P2 | Reliable desktop delivery | native5platform delivery gates configured; signing/notarization still unavailable; see release checkpoint for actual outcomes |
| [ ] | [EXT-06](#ext-06) | M4 | P2 | Valkey | standalone native backend and desktop passed; topology scope limitations documented |
| [ ] | [EXT-08](#ext-08) | M4 | P2 | Managed PostgreSQL/MySQL/SQL Server | integrated managed profiles/local TLS policies; real provider targets unavailable |
| [ ] | [EXT-09](#ext-09) | M4 | P3 | CockroachDB and YugabyteDB | implemented; nativeCockroach/Yugabyte backend and desktop passed; final platform limits recorded |
| [ ] | [EXT-10](#ext-10) | M4 | P3 | TiDB, Vitess, and relevant MySQL-compatible services | implemented; nativeTiDB and emulatedVitess backend and desktop passed; platform limits recorded |
| [ ] | [DB-09](#db-09) | M5 | P2 | Snowflake | native API workflow candidate; real-service verification blocked by disposable account/credentials |
| [ ] | [DB-10](#db-10) | M5 | P2 | BigQuery | native API workflow candidate; real-service verification blocked by disposable account/credentials |
| [ ] | [DB-11](#db-11) | M5 | P2 | Amazon Redshift | implemented; guardedRedshift workflow; real AWS target acceptance blocked |
| [ ] | [DB-12](#db-12) | M5 | P2 | Trino | native backend7/7 and desktop1/1 passed; wider connector/platform scope unverified |
| [ ] | [DB-13](#db-13) | M5 | P3 | Amazon Athena | native SDK workflow implemented; protocol7/7 passed; real AWS target verification blocked |
| [ ] | [DB-14](#db-14) | M5 | P3 | Databricks SQL | native API workflow candidate; real-service verification blocked by disposable account/credentials |
| [ ] | [DB-15](#db-15) | M5 | P2 | Neo4j | native graph workflow integrated; real backend and desktop passed; final combined/platform acceptance pending |
| [ ] | [DB-16](#db-16) | M5 | P2 | DynamoDB | implemented; DynamoDBLocal3.3.1 native11/11+desktop1/1; AWS service IAM compatibility blocked |
| [ ] | [DB-17](#db-17) | M5 | P2 | Cassandra | implemented; Cassandra5.0.9 native13/13 + desktop1/1; integrated focused gates passed |
| [ ] | [DB-18](#db-18) | M5 | P3 | ScyllaDB | not integrated; frozen Scylla6.2.3 candidate outside repository,13native+1desktop historical passes |
| [ ] | [DB-19](#db-19) | M5 | P3 | Couchbase | not integrated; external partial candidate7/8native, no desktop acceptance |
| [ ] | [DB-20](#db-20) | M5 | P3 | CouchDB | native backend8/8 and desktop1/1 passed; integrated candidate gates underway |
| [ ] | [DB-21](#db-21) | M5 | P3 | Azure Cosmos DB | not integrated; external partial protocol candidate; emulator license acceptance outstanding |
| [ ] | [DB-22](#db-22) | M5 | P3 | Firestore | not integrated; external partial protocol candidate; native emulator download region-restricted |
| [ ] | [DB-23](#db-23) | M5 | P2 | InfluxDB | implemented; Influx2.9.1 native6 + TLS1 + unit6 and desktop1/1; final candidate gate pending |
| [ ] | [DB-24](#db-24) | M5 | P3 | QuestDB | integrated; QuestDB10.0.1 native7/7 and desktop1/1 historical; final viewport polish acceptance incomplete |
| [ ] | [DB-25](#db-25) | M5 | P2 | Qdrant | integrated; fresh Qdrant1.19.1 exact-ID/payload/catalog/filter/mutation pass plus TLS safety; whole-ticket acceptance remains open |
| [ ] | [DB-26](#db-26) | M5 | P3 | Milvus | integrated; Milvus2.6.24 native backend/desktop historical evidence; fresh full-engine regression not run |
| [ ] | [DB-27](#db-27) | M5 | P3 | Weaviate | integrated; native Weaviate historical evidence; unsupported filter translation fails explicitly; whole-ticket acceptance open |
| [ ] | [DB-28](#db-28) | M5 | P3 | Pinecone | integrated opt-in API preview; protocol/safety checks only; real project/index/key unavailable |
| [ ] | [DB-29](#db-29) | M5 | P3 | IBM Db2 | implemented; optional runtime safely unavailable on this laptop; native Db2 acceptance blocked |
| [ ] | [DB-30](#db-30) | M5 | P3 | Firebird | implemented; Firebird5.0.4 native10/10 and desktop1/1 passed; packaging/platform gaps remain |
| [ ] | [DB-31](#db-31) | M5 | P3 | SAP HANA | implemented native hdb candidate; local contracts and driver checks passed; real target verification blocked |
| [ ] | [ADV-18](#adv-18) | M6 | P3 | Optional AI assistance | integrated opt-in provider preview/inert drafts; fresh desktop passed; actual local/cloud-provider generation still unverified |
| [ ] | [ADV-19](#adv-19) | M6 | P3 | Optional team workflow | existing local file handoff coverage under reconciliation; no external sync enabled |
| [ ] | [ADV-20](#adv-20) | M6 | P3 | Task automation | integrated opt-in tasks; fresh report desktop and cancellation/timezone/privacy regressions passed; whole import/export automation acceptance incomplete |

## Detailed tickets

Dependencies marked **G-CAPABILITY** refer to the minimal M1 capability bootstrap defined in [README.md](README.md#execution-order-and-dependency-meaning), not completion of the full M3 adapter extraction. Dependencies are feature-contract prerequisites; satisfy and record the slice relevant to the current platform rather than hiding blocked acceptance.

<a id="fix-01"></a>
### FIX-01 — Repair macOS Monaco E2E input helpers.

- [x] Full ticket accepted: **M0 / P0**.
- Current capability: **implemented**; work: **complete**; acceptance: **verified on available native macOS and disposable fixtures**; delivery: **local-only**.
- Dependencies: None; baseline reconciliation is still required.
- Starting evidence / proposed surface: Existing Electron helpers and editor interactions. [tests/electron-runtime.ts](../../tests/electron-runtime.ts); [tests/sql-ui.e2e.ts](../../tests/sql-ui.e2e.ts); [tests/table-workbench.e2e.ts](../../tests/table-workbench.e2e.ts); [tests/postgres-server-explorer.e2e.ts](../../tests/postgres-server-explorer.e2e.ts); [tests/save-query.e2e.ts](../../tests/save-query.e2e.ts); [src/renderer/src/components/QueryEditor.tsx](../../src/renderer/src/components/QueryEditor.tsx).
- Required verification: V-BASE, V-UI; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Reproduce the reported problem; use a reliable platform-aware editor interaction; assert exact editor contents before execution; all five affected workflows reach their previously blocked assertions. Preserve real UI coverage rather than bypassing all interaction through store injection.

**Concrete verification scenario and next action**

macOS Electron with the five historically blocked real-editor workflows; compare exact text before execution and reach the original downstream assertions without store-only substitution.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Acceptance evidence:** Five former macOS editor blockers reached their original assertions; native editor input and exact draft assertions verified. See PROGRESS.md integrated M0/M1 evidence. Platform-specific limitations remain in the support matrix; this is local implementation acceptance, not publication.

<a id="fix-02"></a>
### FIX-02 — Make shortcut labels and behavior platform-correct.

- [ ] Full ticket accepted: **M0 / P0**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [FIX-01](#fix-01)
- Starting evidence / proposed surface: Existing native menus and renderer actions; shared definition is proposed. [src/main/index.ts](../../src/main/index.ts); [src/renderer/src/App.tsx](../../src/renderer/src/App.tsx); [src/renderer/src/components/QueryEditor.tsx](../../src/renderer/src/components/QueryEditor.tsx); [src/renderer/src/components/CommandPalette.tsx](../../src/renderer/src/components/CommandPalette.tsx); [src/shared/](../../src/shared/).
- Required verification: V-BASE, V-UI; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

One shortcut definition feeds labels, menus, help, and actions. macOS shows Command where appropriate; Windows/Linux show the correct keys. Test execution, save, search, tab actions, and editor navigation.

**Concrete verification scenario and next action**

macOS Command and Windows/Linux Control contracts; execution, save, find, tab and navigation actions; actual native behavior remains blocked where the host is unavailable.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="fix-03"></a>
### FIX-03 — Prevent ambiguous saved-query targeting.

- [x] Full ticket accepted: **M0 / P0**.
- Current capability: **implemented**; work: **complete**; acceptance: **verified locally**; delivery: **local-only**.
- Dependencies: [FIX-01](#fix-01)
- Starting evidence / proposed surface: Existing query/history UI, savedQuerySchema and persistence. [src/renderer/src/components/Library.tsx](../../src/renderer/src/components/Library.tsx); [src/renderer/src/App.tsx](../../src/renderer/src/App.tsx); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/persistence/store.ts](../../src/main/persistence/store.ts); [tests/save-query.e2e.ts](../../tests/save-query.e2e.ts); [tests/persistence.test.ts](../../tests/persistence.test.ts).
- Required verification: V-BASE, V-UI, V-TARGET, V-PERSIST; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Queries without a bound connection open a compatible-target picker; they never silently choose the first profile. Show engine, server, database, and schema context before execution. Incompatible targets are disabled with a reason. Opening a query never executes it. Reproduce the reported concern before claiming it was a runtime defect.

**Concrete verification scenario and next action**

Two same-engine profiles with distinguishable data, one incompatible profile, a deleted saved binding and no compatible target; cancellation must not create or execute a tab.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

**Acceptance evidence:** `implementation-saved-target-safety` passed the actual desktop two-SQLite target-choice, cancelled chooser, deleted binding and no-eligible-target cases without automatic connection/execution. Earlier `saved-query-target` covered the cross-engine case. See PROGRESS.md for current evidence.

<a id="fix-04"></a>
### FIX-04 — Make connection status accurate.

- [ ] Full ticket accepted: **M0 / P0**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: None; baseline reconciliation is still required.
- Starting evidence / proposed surface: Existing connection lifecycle/status contracts; monitoring changes require reproduction. [src/main/engines/mongo.ts](../../src/main/engines/mongo.ts); [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/main/engines/redis.ts](../../src/main/engines/redis.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/store.ts](../../src/renderer/src/store.ts); [tests/mongo.integration.test.ts](../../tests/mongo.integration.test.ts).
- Required verification: V-BASE, V-UI, V-ENGINE, V-WRITE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Define connecting, connected, reconnecting, degraded, disconnected, and authentication-failed behavior where relevant. Reproduce MongoDB interruption and recovery. Clear or mark stale state on network/topology failures; show timestamps. Never automatically replay writes or restore a failed transaction as if it remained valid.

**Concrete verification scenario and next action**

Interrupt and restore a disposable MongoDB server and test invalid authentication; assert timestamps/stale state, event cleanup and no mutation or failed-transaction replay.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="fix-05"></a>
### FIX-05 — Close release-verification gaps.

- [ ] Full ticket accepted: **M0 / P0**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [FIX-01](#fix-01), [FIX-02](#fix-02), [FIX-03](#fix-03), [FIX-04](#fix-04)
- Starting evidence / proposed surface: Existing packaging, credential and historical release evidence. [electron-builder.yml](../../electron-builder.yml); [src/main/index.ts](../../src/main/index.ts); [src/main/persistence/credentials.ts](../../src/main/persistence/credentials.ts); [tests/package.e2e.ts](../../tests/package.e2e.ts); [tests/single-instance.e2e.ts](../../tests/single-instance.e2e.ts); [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md); [docs/CAPABILITIES.md](../../docs/CAPABILITIES.md); [docs/VALIDATION.md](../../docs/VALIDATION.md); [.github/workflows/](../../.github/workflows/).
- Required verification: V-BASE, V-PACKAGE, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Update stale engine documentation and the support matrix. Test normal credential storage in an isolated OS user/profile where feasible, packaged application launch, and native workflows on available supported platforms. Report unavailable platform checks as blocked. Ad-hoc signature verification must not be described as notarization.

**Concrete verification scenario and next action**

Reconcile all four engines in documentation; isolated packaged launch and normal available OS keychain; distinguish unavailable Windows/Linux/macOS modes, ad-hoc signatures and notarization.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="ux-01"></a>
### UX-01 — Connection hub: folders, tags, favorites, recent targets, environment labels, duplicate profile, search.

- [ ] Full ticket accepted: **M1 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [FIX-03](#fix-03), [FIX-04](#fix-04)
- Starting evidence / proposed surface: Existing profile fields/dialog/sidebar; reconcile which requested interactions are already exposed. [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/Sidebar.tsx](../../src/renderer/src/components/Sidebar.tsx); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/main/engines/transport.ts](../../src/main/engines/transport.ts); [tests/connection-feedback.e2e.ts](../../tests/connection-feedback.e2e.ts); [tests/transport.test.ts](../../tests/transport.test.ts).
- Required verification: V-BASE, V-UI, V-TARGET, V-PERSIST, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Finding a known connection does not require expanding many folders. Every query tab visibly identifies connection, database, schema/namespace, and environment. Production labeling uses text/icon as well as color. Credentials are not copied or exported implicitly.

**Concrete verification scenario and next action**

Many profiles across folders/tags with duplicate names and production labels; search/favorite/recent/duplicate paths preserve target identity and exclude credentials.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="ux-02"></a>
### UX-02 — Connection wizard and actionable diagnostics.

- [ ] Full ticket accepted: **M1 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [FIX-04](#fix-04)
- Starting evidence / proposed surface: Existing profile fields/dialog/sidebar; reconcile which requested interactions are already exposed. [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/Sidebar.tsx](../../src/renderer/src/components/Sidebar.tsx); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/main/engines/transport.ts](../../src/main/engines/transport.ts); [tests/connection-feedback.e2e.ts](../../tests/connection-feedback.e2e.ts); [tests/transport.test.ts](../../tests/transport.test.ts).
- Required verification: V-BASE, V-UI, V-TRANSPORT, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Engine-specific fields, safely parsed URI import with a redacted preview, advanced TLS/SSH controls, and connection testing. Distinguish DNS, routing, SSH, certificate, authentication, permission, and missing-database failures where evidence permits. Never advise disabling TLS verification as a default fix.

**Concrete verification scenario and next action**

Valid and malformed/redacted URIs; wrong hostname, SSH trust, invalid auth, restricted privileges and missing database; preserve input and show only evidence-supported diagnostic categories.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="ux-03"></a>
### UX-03 — Command palette and object search.

- [ ] Full ticket accepted: **M1 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [UX-01](#ux-01)
- Starting evidence / proposed surface: Existing command palette and lazy object navigation. [src/renderer/src/components/CommandPalette.tsx](../../src/renderer/src/components/CommandPalette.tsx); [src/renderer/src/components/Sidebar.tsx](../../src/renderer/src/components/Sidebar.tsx); [src/renderer/src/store.ts](../../src/renderer/src/store.ts); [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [tests/postgres-server-explorer.e2e.ts](../../tests/postgres-server-explorer.e2e.ts); [tests/timescale-explorer.e2e.ts](../../tests/timescale-explorer.e2e.ts).
- Required verification: V-BASE, V-UI, V-TARGET, V-PERF; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Keyboard-search connections, tables/collections/indexes, saved queries, and commands. Results show location and type. Search is scoped, cancellable, lazy, and does not automatically scan every database's data.

**Concrete verification scenario and next action**

Large lazy catalog with duplicate object names, restricted database and canceled search; no data scan or unnecessary expansion to locate a known object.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="ux-04"></a>
### UX-04 — Productive query editor.

- [ ] Full ticket accepted: **M1 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [FIX-01](#fix-01), [FIX-02](#fix-02), [UX-03](#ux-03)
- Starting evidence / proposed surface: Existing query editor/tokenizer/formatter; extend catalog completion only after reconciliation. [src/renderer/src/components/QueryEditor.tsx](../../src/renderer/src/components/QueryEditor.tsx); [src/shared/sql.ts](../../src/shared/sql.ts); [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [tests/sql.test.ts](../../tests/sql.test.ts); [tests/sql-ui.e2e.ts](../../tests/sql-ui.e2e.ts).
- Required verification: V-BASE, V-UI, V-TARGET, V-ENGINE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Schema-aware completion, alias and identifier handling, dialect-aware formatting, statement-at-cursor execution, selected-statement execution, snippets, multiple result tabs, and error locations. Catalog suggestions respect permissions and refresh/invalidation. Formatting never changes executable semantics.

**Concrete verification scenario and next action**

Quoted/aliased identifiers, dialect-specific syntax, selected/current/script execution and multiple result sets; formatting preserves behavior and revoked catalog access invalidates suggestions.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="ux-05"></a>
### UX-05 — Typed query parameters.

- [x] Full ticket accepted: **M1 / P1**.
- Current capability: **implemented**; work: **complete**; acceptance: **verified on available native macOS and disposable fixtures**; delivery: **local-only**.
- Dependencies: [UX-04](#ux-04)
- Starting evidence / proposed surface: Existing querySchema and native driver execution; reusable user parameter contract is proposed. [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/renderer/src/components/QueryEditor.tsx](../../src/renderer/src/components/QueryEditor.tsx); [src/main/persistence/store.ts](../../src/main/persistence/store.ts); [tests/sql.integration.test.ts](../../tests/sql.integration.test.ts); [tests/ipc.test.ts](../../tests/ipc.test.ts).
- Required verification: V-BASE, V-UI, V-ENGINE, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Reusable parameter forms with type validation and native driver binding. Identifier insertion is handled separately from values. Do not implement parameters through naive string replacement. Secret parameter values are excluded from default history.

**Concrete verification scenario and next action**

Repeated and missing typed values, NULL/empty, exact integer/decimal, timestamp, binary and secret parameters; native binding resists injection and excludes secret values from default history.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Acceptance evidence:** Native PostgreSQL/MariaDB/SQL Server parameter UI and exact binding/privacy gates passed; reusable definitions persist without values. See mssql-parameters-native3 and parameter integration gates. Platform-specific limitations remain in the support matrix; this is local implementation acceptance, not publication.

<a id="ux-08"></a>
### UX-08 — Visible staged edits and transaction state.

- [ ] Full ticket accepted: **M1 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [FIX-01](#fix-01), [FIX-03](#fix-03), [FIX-04](#fix-04)
- Starting evidence / proposed surface: Existing reviewed edits and per-tab transaction controls. [src/renderer/src/components/TableBrowser.tsx](../../src/renderer/src/components/TableBrowser.tsx); [src/renderer/src/components/QueryEditor.tsx](../../src/renderer/src/components/QueryEditor.tsx); [src/renderer/src/components/MongoBrowser.tsx](../../src/renderer/src/components/MongoBrowser.tsx); [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [tests/sql-ui.e2e.ts](../../tests/sql-ui.e2e.ts); [tests/table-workbench.e2e.ts](../../tests/table-workbench.e2e.ts).
- Required verification: V-BASE, V-UI, V-WRITE, V-TARGET; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

A persistent pending-change tray shows old/new values, insert/delete counts, validation problems, and the target. Review/apply/discard are distinct. Failed/conflicting edits retain useful user input; no universal undo claim after commit. Active/failed transactions and session affinity are always visible.

**Concrete verification scenario and next action**

Insert/update/delete drafts across tabs, active and failed transaction, constraint failure and concurrent conflict; review exact target, preserve rejected input and protect close/navigation.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="ux-11"></a>
### UX-11 — Accessible, consistent interaction.

- [ ] Full ticket accepted: **M1 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [FIX-01](#fix-01), [FIX-02](#fix-02)
- Starting evidence / proposed surface: Existing shared controls, theme/density and workbench layout. [src/renderer/src/components/common.tsx](../../src/renderer/src/components/common.tsx); [src/renderer/src/components/ui/](../../src/renderer/src/components/ui/); [src/renderer/src/components/SettingsDialog.tsx](../../src/renderer/src/components/SettingsDialog.tsx); [src/renderer/src/styles.css](../../src/renderer/src/styles.css); [tests/desktop.e2e.ts](../../tests/desktop.e2e.ts).
- Required verification: V-BASE, V-UI; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Complete keyboard navigation, visible focus, descriptive labels, screen-reader-friendly status updates, accessible contrast, scalable font/density settings, light/dark/system themes, consistent menus, useful empty/loading/error states, and no color-only safety cues. Verify with actual keyboard flows and automated accessibility checks where suitable.

**Concrete verification scenario and next action**

Keyboard-only connect/query/edit/export flows, focus returns, status announcements, themes and zoom/density at 1024x700 and 1440x900; automated checks complement actual interaction.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="db-01"></a>
### DB-01 — MySQL

- [ ] Full ticket accepted: **M1 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: **G-CAPABILITY**, [UX-02](#ux-02), [UX-05](#ux-05), [UX-08](#ux-08)
- Starting evidence / proposed surface: SQL adapter and dialect-specific editor/catalog/mutation behavior is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT, V-PACKAGE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

User outcome: Explicit coverage distinct from MariaDB.

**Acceptance criteria from the product brief**

L2: real MySQL authentication, catalog, SQL, paging, transactions, reviewed edits, import/export, JSON/binary/decimal handling, cancellation, TLS. Test supported versions independently of MariaDB; sharing a driver does not establish compatibility.

**Concrete verification scenario and next action**

Independent real MySQL fixture/version/auth/TLS, catalog/paging/transaction/edit/import/export/cancel tests and JSON/binary/decimal fidelity; MariaDB results cannot substitute.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="db-02"></a>
### DB-02 — SQLite

- [ ] Full ticket accepted: **M1 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: **G-CAPABILITY**, [UX-05](#ux-05), [UX-08](#ux-08)
- Starting evidence / proposed surface: Embedded adapter, file-picker/permission model and isolated native execution is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-PERSIST, V-PACKAGE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

User outcome: Open and inspect application/local database files.

**Acceptance criteria from the product brief**

L2: explicit open-existing versus create-new flow; read-only option; tables/views/indexes/triggers; query/edit/import/export; lock/busy behavior, WAL considerations, backup-safe handling, integer precision. User files must be isolated from Harbor's own metadata database. Reject accidental access to active Harbor metadata.

**Concrete verification scenario and next action**

Disposable SQLite files; explicit open-existing/create-new/read-only, busy locks/WAL, exact integers and safe backup access; reject active Harbor metadata file and aliases.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="ux-06"></a>
### UX-06 — Better result-grid navigation.

- [ ] Full ticket accepted: **M2 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [UX-04](#ux-04), [UX-08](#ux-08)
- Starting evidence / proposed surface: Existing indexed columns, sorting, virtualization and table state. [src/renderer/src/components/DataGrid.tsx](../../src/renderer/src/components/DataGrid.tsx); [src/renderer/src/components/TableBrowser.tsx](../../src/renderer/src/components/TableBrowser.tsx); [src/shared/result-sort.ts](../../src/shared/result-sort.ts); [src/shared/table-query.ts](../../src/shared/table-query.ts); [tests/table-workbench.e2e.ts](../../tests/table-workbench.e2e.ts); [tests/sql-table-query.test.ts](../../tests/sql-table-query.test.ts).
- Required verification: V-BASE, V-UI, V-ENGINE, V-PERF; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Column search, resize/reorder/hide/pin, multi-column sorting, filter builder, NULL/empty distinction, multiline/JSON/binary viewers, copy row/cell/selection, and safe format exports. Explicitly label server-side operations versus operations on the loaded page. Preserve duplicate column identities.

**Concrete verification scenario and next action**

Wide results with duplicate labels, exact numerics, multiline/JSON/binary/NULL values; multiple sorts, column search and copy scopes retain row identity and label loaded versus server scope.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="ux-07"></a>
### UX-07 — Related-record navigation.

- [ ] Full ticket accepted: **M2 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-03](#adv-03), [UX-06](#ux-06)
- Starting evidence / proposed surface: Existing raw table constraints; typed relationship contract/navigation/diagram are proposed extensions. [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/TableBrowser.tsx](../../src/renderer/src/components/TableBrowser.tsx); [src/renderer/src/components/Sidebar.tsx](../../src/renderer/src/components/Sidebar.tsx); [tests/sql-catalog.integration.test.ts](../../tests/sql-catalog.integration.test.ts).
- Required verification: V-BASE, V-UI, V-ENGINE, V-TARGET; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Open referenced rows using real foreign-key metadata, with composite-key and cross-schema support. Show breadcrumbs and return navigation. Do not infer authoritative relationships from column names.

**Concrete verification scenario and next action**

Composite and cross-schema foreign keys, nullable/missing references, restricted target and duplicate names; navigate from real constraints and restore source breadcrumb/focus.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="ux-09"></a>
### UX-09 — Organized workspace.

- [x] Full ticket accepted: **M2 / P1**.
- Current capability: **implemented**; work: **complete**; acceptance: **verified on available native macOS and disposable fixtures**; delivery: **local-only**.
- Dependencies: [UX-08](#ux-08), [FIX-03](#fix-03)
- Starting evidence / proposed surface: Existing workspaceSchema, persisted drafts and close protection. [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/App.tsx](../../src/renderer/src/App.tsx); [src/renderer/src/store.ts](../../src/renderer/src/store.ts); [src/main/persistence/store.ts](../../src/main/persistence/store.ts); [tests/persistence.test.ts](../../tests/persistence.test.ts); [tests/desktop.e2e.ts](../../tests/desktop.e2e.ts).
- Required verification: V-BASE, V-UI, V-PERSIST, V-TARGET; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Named workspaces, pinned/renamed tabs, split editor/results, result comparison, unsaved-state indicators, close/reopen behavior, and safe crash recovery. Restoring tabs does not execute queries or recreate transaction state. Avoid stale responses crossing tab/target changes.

**Concrete verification scenario and next action**

Named workspaces and pinned/renamed tabs with unsaved changes, comparison, crash/restart and deleted targets; no restored transactions or stale response crossover.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Acceptance evidence:** All three native workspace cases passed: named snapshots, rename/pin/reopen, split/comparison, transactional restore review and private discard/remount. See m2-native-gate3. Platform-specific limitations remain in the support matrix; this is local implementation acceptance, not publication.

<a id="ux-10"></a>
### UX-10 — Query library and useful history.

- [x] Full ticket accepted: **M2 / P1**.
- Current capability: **implemented**; work: **complete**; acceptance: **verified on available native macOS and disposable fixtures**; delivery: **local-only**.
- Dependencies: [FIX-03](#fix-03), [UX-05](#ux-05)
- Starting evidence / proposed surface: Existing query/history UI, savedQuerySchema and persistence. [src/renderer/src/components/Library.tsx](../../src/renderer/src/components/Library.tsx); [src/renderer/src/App.tsx](../../src/renderer/src/App.tsx); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/persistence/store.ts](../../src/main/persistence/store.ts); [tests/save-query.e2e.ts](../../tests/save-query.e2e.ts); [tests/persistence.test.ts](../../tests/persistence.test.ts).
- Required verification: V-BASE, V-UI, V-PERSIST, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Folders/tags/search, connection-aware query metadata, duration/outcome/row-count filters, retention controls, and clear-history actions. Existing saved queries and drafts migrate without loss. Query history is not represented as a tamper-proof audit log.

**Concrete verification scenario and next action**

Existing baseline saved queries/drafts plus filtered duration/outcome/count history; migration, folder/tag/search, retention and clearing retain privacy and target metadata.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Acceptance evidence:** Native query metadata/library/history filtering, retention and clear workflow passed; persistence gates passed. See grid-library native evidence. Platform-specific limitations remain in the support matrix; this is local implementation acceptance, not publication.

<a id="ux-12"></a>
### UX-12 — Responsive large-data operation.

- [ ] Full ticket accepted: **M2 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [UX-03](#ux-03), [UX-06](#ux-06)
- Starting evidence / proposed surface: Existing bounded engine results, virtual grid and benchmark. [src/renderer/src/components/DataGrid.tsx](../../src/renderer/src/components/DataGrid.tsx); [src/renderer/src/components/Sidebar.tsx](../../src/renderer/src/components/Sidebar.tsx); [src/main/engines/](../../src/main/engines/); [src/main/persistence/export.ts](../../src/main/persistence/export.ts); [tests/benchmark.test.ts](../../tests/benchmark.test.ts).
- Required verification: V-BASE, V-UI, V-PERF, V-JOB; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Virtualized rendering, lazy catalog loading, bounded fetches, cancellable jobs, progress visibility, connection limits, and background work. No unbounded table count, collection scan, or Redis key enumeration on opening a screen. Define measurable budgets from an agreed reference machine and fixture.

**Concrete verification scenario and next action**

Large catalogs and at least one million row/document/key equivalents, wide/large values and concurrent tabs; define measured budgets and prove no opening-time unbounded count or scan.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="adv-01"></a>
### ADV-01 — Full-result streaming export

- [ ] Full ticket accepted: **M2 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [UX-04](#ux-04), [UX-08](#ux-08), **G-CAPABILITY**
- Starting evidence / proposed surface: Existing loaded-results worker; full streaming job is a proposed extension. [src/main/persistence/export.ts](../../src/main/persistence/export.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/DataGrid.tsx](../../src/renderer/src/components/DataGrid.tsx); [src/main/engines/](../../src/main/engines/); [tests/desktop.e2e.ts](../../tests/desktop.e2e.ts).
- Required verification: V-BASE, V-ENGINE, V-JOB, V-PERF, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Distinguish loaded rows from the full result. Start with CSV and JSONL; add other formats through explicit tickets. Stream with backpressure through bounded worker/IPC buffers, show progress and cancellation, preserve types, handle disk-full and connection loss, mark partial output, and finalize completed output safely. Never rerun a mutating statement just to export its result. Snapshot/consistency behavior must be documented.

**Concrete verification scenario and next action**

Read-only full CSV/JSONL output larger than memory budget, slow consumer, disk-full, disconnect and cancellation; finalize safely and never rerun a mutating query to export.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="adv-02"></a>
### ADV-02 — Import wizard

- [ ] Full ticket accepted: **M2 / P1**.
- Current capability: **partial implementation — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [UX-05](#ux-05), [UX-08](#ux-08)
- Starting evidence / proposed surface: Existing bounded CSV parser/wizard and transactional SQL inserts. [src/shared/csv.ts](../../src/shared/csv.ts); [src/renderer/src/components/CsvImportDialog.tsx](../../src/renderer/src/components/CsvImportDialog.tsx); [src/main/ipc.ts](../../src/main/ipc.ts); [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [tests/csv.test.ts](../../tests/csv.test.ts); [tests/sql-ui.e2e.ts](../../tests/sql-ui.e2e.ts).
- Required verification: V-BASE, V-UI, V-WRITE, V-JOB, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Preview, mapping, encoding, delimiters, NULL rules, type validation, error policy, batch progress, cancellation, and resumability only where safe. Support CSV/JSONL first, BSON Extended JSON where appropriate; Parquet follows the analytics capability. A validation preview is not a guarantee that all rows will succeed. Report committed versus rolled-back batches accurately.

**Concrete verification scenario and next action**

CSV/JSONL and applicable Extended JSON with encoding, NULL, mapping and invalid rows; cancel between/within batches and report committed versus rolled-back outcomes honestly.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md); full ticket remains incomplete until the native workflows and acceptance criteria are met.

<a id="adv-03"></a>
### ADV-03 — Object inspector and generated SQL

- [ ] Full ticket accepted: **M2 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [UX-03](#ux-03), **G-CAPABILITY**
- Starting evidence / proposed surface: Existing object discovery/structure; richer inspector/templates are extensions. [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/main/engines/mongo.ts](../../src/main/engines/mongo.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/Sidebar.tsx](../../src/renderer/src/components/Sidebar.tsx); [src/renderer/src/components/TableBrowser.tsx](../../src/renderer/src/components/TableBrowser.tsx); [tests/sql-catalog.integration.test.ts](../../tests/sql-catalog.integration.test.ts).
- Required verification: V-BASE, V-UI, V-ENGINE, V-TARGET; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Tables/views/indexes/constraints/triggers/functions where supported; searchable properties, DDL view/copy, and dialect-correct SELECT/INSERT/UPDATE templates. Browsing must work with limited privileges. Avoid expensive automatic size/count operations.

**Concrete verification scenario and next action**

Restricted-role catalogs containing tables/views/constraints/triggers/routines/indexes; generated templates quote dialect identifiers and never auto-run count/size queries.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="adv-06"></a>
### ADV-06 — Query-plan inspector

- [ ] Full ticket accepted: **M2 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [UX-04](#ux-04), [ADV-03](#adv-03), [DB-01](#db-01)
- Starting evidence / proposed surface: Existing SQL execution/EXPLAIN path; structured plan model and tree are proposed. [src/renderer/src/components/QueryEditor.tsx](../../src/renderer/src/components/QueryEditor.tsx); [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [tests/sql.integration.test.ts](../../tests/sql.integration.test.ts); [tests/sql-timescale.integration.test.ts](../../tests/sql-timescale.integration.test.ts).
- Required verification: V-BASE, V-UI, V-ENGINE, V-WRITE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Start with PostgreSQL, MySQL, and MariaDB, gated by real support. Show raw plus tree view, estimates versus actuals, and relevant warnings. Explain and execution-based analysis are separate actions. Analysis that executes a statement requires explicit review and must not run automatically.

**Concrete verification scenario and next action**

PostgreSQL/MySQL/MariaDB raw and tree plans, estimates versus actuals, unsupported operators and restricted role; execution-based analysis requires review and never runs on opening.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="adv-13"></a>
### ADV-13 — Portable workspace handoff

- [x] Full ticket accepted: **M2 / P1**.
- Current capability: **partial implementation — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [FIX-03](#fix-03), [UX-01](#ux-01), [UX-10](#ux-10)
- Starting evidence / proposed surface: Existing profile import/export and workspace persistence; full bundle is proposed. [src/main/ipc.ts](../../src/main/ipc.ts); [src/main/persistence/store.ts](../../src/main/persistence/store.ts); [src/main/persistence/credentials.ts](../../src/main/persistence/credentials.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/SettingsDialog.tsx](../../src/renderer/src/components/SettingsDialog.tsx); [tests/persistence.test.ts](../../tests/persistence.test.ts); [tests/ipc.test.ts](../../tests/ipc.test.ts).
- Required verification: V-BASE, V-UI, V-PERSIST, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Versioned export/import of profiles without secrets, saved queries, tab drafts, tags, and settings. Show preview and merge/conflict choices; validate imported content and treat embedded paths cautiously. Re-enter/rebind credentials on the destination laptop. Do not copy OS-encrypted credentials or machine-specific paths blindly.

**Concrete verification scenario and next action**

Two isolated metadata directories, conflicts/duplicate IDs, corrupted or future-version import, and stale machine paths; preserve existing state and require credential/path rebinding.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md); full ticket remains incomplete until the native workflows and acceptance criteria are met.

<a id="db-03"></a>
### DB-03 — DuckDB

- [ ] Full ticket accepted: **M2 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: **G-CAPABILITY**, [ADV-01](#adv-01), [UX-05](#ux-05)
- Starting evidence / proposed surface: Embedded adapter, file-picker/permission model and isolated native execution is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-JOB, V-PRIVACY, V-PACKAGE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

User outcome: Local analytics and CSV/JSON/Parquet exploration.

**Acceptance criteria from the product brief**

L1 then L2: file/in-memory profiles, SQL/catalog/types, external-file scope, concurrency/locking, progress/cancel behavior, bounded streaming, packaged native bindings. Do not allow opening an untrusted database to silently grant arbitrary extension downloads or external-file/network access.

**Concrete verification scenario and next action**

DuckDB file/in-memory fixture with CSV/JSON/Parquet, native binding in Electron, concurrent access and cancel; untrusted files cannot implicitly enable downloads or external access.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="db-04"></a>
### DB-04 — Microsoft SQL Server

- [ ] Full ticket accepted: **M2 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: **G-CAPABILITY**, [UX-05](#ux-05), [UX-08](#ux-08)
- Starting evidence / proposed surface: SQL adapter and dialect-specific editor/catalog/mutation behavior is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT, V-PACKAGE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

User outcome: Major additional relational ecosystem.

**Acceptance criteria from the product brief**

L1 then L2: T-SQL, databases/schemas, Unicode, decimal/datetimeoffset/binary types, paging, transactions, cancellation, catalogs and reviewed edits. Declare supported SQL authentication, integrated authentication, and cloud identity modes separately; verify real driver and host support.

**Concrete verification scenario and next action**

Real SQL Server with declared SQL-auth support and separate integrated/cloud modes; T-SQL, Unicode, decimal/datetimeoffset/binary, databases/schemas, paging, transactions and cancellation.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="adv-04"></a>
### ADV-04 — Visual schema editing

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-03](#adv-03), [UX-08](#ux-08), [ADV-16](#adv-16)
- Starting evidence / proposed surface: Existing catalog/query path; reviewed schema editor/comparison are proposed modules. [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/sql-catalog.integration.test.ts](../../tests/sql-catalog.integration.test.ts); [tests/sql.integration.test.ts](../../tests/sql.integration.test.ts).
- Required verification: V-BASE, V-UI, V-ENGINE, V-WRITE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Create/alter tables, columns, indexes, and constraints with generated DDL preview, dependency checks, destructive-change warnings, lock implications, target review, and execution results. Engine-specific DDL atomicity is explicit; no promise of rollback where the database cannot provide it.

**Concrete verification scenario and next action**

Disposable schema with dependent objects; create/alter DDL preview, destructive/lock review, partial nontransactional DDL failure and precise actual results.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="adv-05"></a>
### ADV-05 — ER diagrams

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-03](#adv-03), [UX-07](#ux-07)
- Starting evidence / proposed surface: Existing raw table constraints; typed relationship contract/navigation/diagram are proposed extensions. [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/TableBrowser.tsx](../../src/renderer/src/components/TableBrowser.tsx); [src/renderer/src/components/Sidebar.tsx](../../src/renderer/src/components/Sidebar.tsx); [tests/sql-catalog.integration.test.ts](../../tests/sql-catalog.integration.test.ts).
- Required verification: V-BASE, V-UI, V-ENGINE, V-PERF; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Generate diagrams from inspected foreign keys, with schema filters, search, focused neighborhoods, and local export. Large schemas load incrementally. Optional inferred relationships are visibly separate from database constraints.

**Concrete verification scenario and next action**

Large schema, composite/cross-schema foreign keys and focused neighborhood; searchable incremental diagram and local export distinguish optional inference from real constraints.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="adv-07"></a>
### ADV-07 — Schema comparison and migration draft

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-03](#adv-03), [ADV-04](#adv-04), [ADV-16](#adv-16)
- Starting evidence / proposed surface: Existing catalog/query path; reviewed schema editor/comparison are proposed modules. [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/sql-catalog.integration.test.ts](../../tests/sql-catalog.integration.test.ts); [tests/sql.integration.test.ts](../../tests/sql.integration.test.ts).
- Required verification: V-BASE, V-UI, V-ENGINE, V-TARGET; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Compare same-engine sources first; show object-level differences and generate a reviewed migration script. Do not auto-apply. Flag potential renames, dependencies, destructive changes, and unsupported conversions. Generated scripts are not automatically safe rollback plans.

**Concrete verification scenario and next action**

Two same-engine disposable schemas with potential renames, dependencies, unsupported types and destructive changes; generate a reviewed draft without applying or claiming safe automatic rollback.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="adv-08"></a>
### ADV-08 — Data comparison

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [UX-06](#ux-06), [ADV-16](#adv-16)
- Starting evidence / proposed surface: Existing value/grid contracts; bounded comparison engine/UI are proposed. [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/shared/result-sort.ts](../../src/shared/result-sort.ts); [src/renderer/src/components/DataGrid.tsx](../../src/renderer/src/components/DataGrid.tsx); [src/main/engines/](../../src/main/engines/).
- Required verification: V-BASE, V-UI, V-ENGINE, V-PERF, V-TARGET; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

User selects scope, keys, columns, and comparison limits. Compare incrementally and show differences, NULLs, duplicates, and type/timezone rules. No full-database scan by default. Synchronization is a separate, explicitly reviewed operation.

**Concrete verification scenario and next action**

Two explicitly selected datasets with NULLs, duplicates, exact decimals and timezone variations; bounded incremental compare and separate reviewed synchronization boundary.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="adv-10"></a>
### ADV-10 — Activity and lock diagnostics

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-03](#adv-03), [ADV-16](#adv-16), [FIX-04](#fix-04)
- Starting evidence / proposed surface: Existing catalogs/execution/session safeguards; monitoring/admin commands are proposed. [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/sql.integration.test.ts](../../tests/sql.integration.test.ts).
- Required verification: V-BASE, V-UI, V-ENGINE, V-WRITE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Privilege-aware sessions, running queries, blockers, database health, and optional query-statistics integration. Refresh is bounded and user-controlled. Cancel/terminate actions display exact target and require confirmation. No server extension installation or privilege escalation without authorization.

**Concrete verification scenario and next action**

Disposable sessions with blockers, long query and restricted monitoring role; bounded manual refresh and exact-target cancel/terminate review without implicit privilege/extension changes.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="adv-11"></a>
### ADV-11 — Index and permission tools

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-03](#adv-03), [ADV-04](#adv-04), [ADV-16](#adv-16)
- Starting evidence / proposed surface: Existing catalogs/execution/session safeguards; monitoring/admin commands are proposed. [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/sql.integration.test.ts](../../tests/sql.integration.test.ts).
- Required verification: V-BASE, V-UI, V-ENGINE, V-WRITE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Inspect indexes, sizes, usage where available, grants, and effective-access caveats. Index creation and grant/revoke flows preview engine-specific commands and risks. Do not represent the desktop profile's read-only flag as database-enforced authorization.

**Concrete verification scenario and next action**

Disposable indexes/users/grants with limited privileges; inspect usage/size only on request and preview index/grant/revoke effects; distinguish app safeguard from server permissions.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="adv-14"></a>
### ADV-14 — Engine-specific advanced tools

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-03](#adv-03), [ADV-16](#adv-16), [EXT-03](#ext-03), [EXT-04](#ext-04), [EXT-05](#ext-05), [EXT-07](#ext-07)
- Starting evidence / proposed surface: Existing model-specific browser/service pairs; advanced topology/admin tools extend them. [src/main/engines/mongo.ts](../../src/main/engines/mongo.ts); [src/main/engines/redis.ts](../../src/main/engines/redis.ts); [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/renderer/src/components/MongoBrowser.tsx](../../src/renderer/src/components/MongoBrowser.tsx); [src/renderer/src/components/RedisBrowser.tsx](../../src/renderer/src/components/RedisBrowser.tsx); [src/renderer/src/components/Sidebar.tsx](../../src/renderer/src/components/Sidebar.tsx).
- Required verification: V-BASE, V-UI, V-ENGINE, V-WRITE, V-JOB; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

MongoDB pipeline editor/index inspector/replica awareness; Redis stream/group viewer, TTL tools, bounded pub/sub viewer, Cluster/Sentinel navigation; Timescale hypertable/chunk/policy inspection. Separate read-only inspection from administration and bound live subscriptions.

**Concrete verification scenario and next action**

Mongo replica/index/pipeline, Redis stream/group/pubsub/topology and Timescale policy fixtures; bound subscriptions and separate inspection from reviewed administration.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="adv-16"></a>
### ADV-16 — Engine adapter architecture

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: **G-CAPABILITY**, [FIX-05](#fix-05)
- Starting evidence / proposed surface: Current concrete services and engine-specific IPC; incremental typed capability/conformance extraction. [src/main/engines/](../../src/main/engines/); [src/main/ipc.ts](../../src/main/ipc.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/preload/index.ts](../../src/preload/index.ts); [tests/ipc.test.ts](../../tests/ipc.test.ts); [tests/sql.integration.test.ts](../../tests/sql.integration.test.ts); [tests/redis.integration.test.ts](../../tests/redis.integration.test.ts); [tests/mongo.integration.test.ts](../../tests/mongo.integration.test.ts).
- Required verification: V-BASE, V-ENGINE, V-WRITE, V-JOB; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Typed, capability-based interfaces for connections, catalogs, queries, values, cancellation, transactions, edits, and exports. Keep data-model-specific operations. Use a conformance suite. Extract incrementally from working adapters; avoid a wholesale rewrite and avoid loading arbitrary third-party driver code by default.

**Concrete verification scenario and next action**

Run conformance against current real adapters during incremental extraction; compare unsupported/permission/topology/disconnected cases, type fidelity, cancellation, sessions and exports.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="db-05"></a>
### DB-05 — ClickHouse

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **partial implementation — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [ADV-01](#adv-01), [ADV-02](#adv-02)
- Starting evidence / proposed surface: Analytical SQL adapter and query/job/table-engine interface is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-JOB, V-PACKAGE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

User outcome: High-volume analytical queries and observability datasets.

**Acceptance criteria from the product brief**

L1 plus import/export: database/table engine metadata, partition-aware inspection, appropriate types, streamed results, query IDs/cancellation. Model mutations and insert semantics honestly; do not reuse transactional OLTP editing assumptions.

**Concrete verification scenario and next action**

Real ClickHouse table engines/partitions, exact types, streamed query-ID/cancel and import/export; insert and mutation results do not imitate OLTP transaction semantics.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md); full ticket remains incomplete until the native workflows and acceptance criteria are met.

<a id="db-06"></a>
### DB-06 — Elasticsearch

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-06](#ux-06)
- Starting evidence / proposed surface: Dedicated search adapter with index/mapping browser and DSL editor is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-JOB, V-PACKAGE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

User outcome: Search-index and document exploration.

**Acceptance criteria from the product brief**

L1 then targeted L2: index/alias/mapping browser, JSON DSL editor, bounded search and aggregation, appropriate deep-pagination strategy, document preview, reviewed mutations with concurrency controls where available. Use a search-oriented UI, not a SQL-table facade.

**Concrete verification scenario and next action**

Real Elasticsearch mappings/aliases/indexes, DSL and aggregations, bounded/deep pagination, timeout/cancel and sequence/version conflict; search-first interaction.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-07"></a>
### DB-07 — OpenSearch

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [DB-06](#db-06)
- Starting evidence / proposed surface: Dedicated search adapter with index/mapping browser and DSL editor is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-JOB, V-PACKAGE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

User outcome: Independent support for this search ecosystem.

**Acceptance criteria from the product brief**

Separate adapter identity and version/authentication tests even if UI components are shared with Elasticsearch. Include index/mapping/DSL/search workflows and explicit service/auth limitations.

**Concrete verification scenario and next action**

Separate real OpenSearch versions/auth fixture and adapter identity; verify shared UI behavior plus service restrictions independently from Elasticsearch.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-08"></a>
### DB-08 — Oracle Database

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-05](#ux-05), [UX-08](#ux-08)
- Starting evidence / proposed surface: SQL adapter and dialect-specific editor/catalog/mutation behavior is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT, V-PACKAGE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

User outcome: Enterprise relational coverage.

**Acceptance criteria from the product brief**

L1 then L2: schemas, SQL/PLSQL, metadata, NUMBER precision, date/time and LOB handling, cancellation, transactions. Publish driver Thin/Thick requirements and supported server/authentication modes. Provisioning or licenses must be settled before claiming integration verification.

**Concrete verification scenario and next action**

Licensed/authorized Oracle fixture and declared Thin/Thick mode; PL/SQL, NUMBER, timezone/LOB, cancellation and transactions; unavailable provisioning blocks integration claims.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="ext-01"></a>
### EXT-01 — PostgreSQL depth

- [ ] Full ticket accepted: **M3 / P1**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-03](#adv-03), [ADV-06](#adv-06), [UX-07](#ux-07), [ADV-10](#adv-10)
- Starting evidence / proposed surface: Extend PostgreSQL/MariaDB/Timescale behavior through their existing service and tests. [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/Sidebar.tsx](../../src/renderer/src/components/Sidebar.tsx); [src/renderer/src/components/QueryEditor.tsx](../../src/renderer/src/components/QueryEditor.tsx); [tests/sql-catalog.integration.test.ts](../../tests/sql-catalog.integration.test.ts); [tests/sql-timescale.integration.test.ts](../../tests/sql-timescale.integration.test.ts).
- Required verification: V-BASE, V-ENGINE, V-UI, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Better catalog/object inspection, plans, FK navigation, extensions awareness, partition metadata, session/lock inspection where authorized. Treat PostGIS spatial viewing and pgvector inspection as optional extension capabilities.

**Concrete verification scenario and next action**

PostgreSQL partitions/extensions, FK/catalog/plan/lock workflows with restricted roles; separate optional PostGIS/pgvector fixtures and capability claims.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="ext-02"></a>
### EXT-02 — MariaDB depth

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-03](#adv-03), [ADV-06](#adv-06), [ADV-10](#adv-10), [ADV-11](#adv-11)
- Starting evidence / proposed surface: Extend PostgreSQL/MariaDB/Timescale behavior through their existing service and tests. [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/Sidebar.tsx](../../src/renderer/src/components/Sidebar.tsx); [src/renderer/src/components/QueryEditor.tsx](../../src/renderer/src/components/QueryEditor.tsx); [tests/sql-catalog.integration.test.ts](../../tests/sql-catalog.integration.test.ts); [tests/sql-timescale.integration.test.ts](../../tests/sql-timescale.integration.test.ts).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Version-aware catalogs, routines/events/triggers, plans, indexes and diagnostics. Do not regress distinctions from MySQL.

**Concrete verification scenario and next action**

Real advertised MariaDB versions with routines/events/triggers/plans/indexes and diagnostics; preserve differences from separately tested MySQL.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="ext-03"></a>
### EXT-03 — MongoDB replica sets and Atlas/SRV

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [FIX-04](#fix-04), [ADV-03](#adv-03), [ADV-16](#adv-16)
- Starting evidence / proposed surface: Extend existing MongoDB profile/driver/browser with separately tested topology support. [src/main/engines/mongo.ts](../../src/main/engines/mongo.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/MongoBrowser.tsx](../../src/renderer/src/components/MongoBrowser.tsx); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [tests/mongo.integration.test.ts](../../tests/mongo.integration.test.ts); [tests/mongo-ui.e2e.ts](../../tests/mongo-ui.e2e.ts).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

SRV/auth/TLS/topology validation, live status, bounded pipeline UI, index inspection. Add multi-document transaction workflows only with session/topology support and explicit commit/abort semantics. Atlas is a deployment target, not a separate database engine.

**Concrete verification scenario and next action**

Disposable replica set plus explicitly authorized Atlas/SRV target; topology/auth/TLS/failover, pipeline/index and session/commit/abort for any claimed transactions.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="ext-04"></a>
### EXT-04 — Redis Cluster

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [FIX-04](#fix-04)
- Starting evidence / proposed surface: Extend existing Redis driver/browser without inheriting untested topology support. [src/main/engines/redis.ts](../../src/main/engines/redis.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/RedisBrowser.tsx](../../src/renderer/src/components/RedisBrowser.tsx); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [tests/redis.integration.test.ts](../../tests/redis.integration.test.ts); [tests/redis-ui.e2e.ts](../../tests/redis-ui.e2e.ts).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Multiple-node discovery, slot routing, redirects, reconnect/failover behavior, node-aware scan progress, and cross-slot operation limitations. A standalone test is insufficient.

**Concrete verification scenario and next action**

Real multi-node Redis Cluster: slot routing, MOVED/ASK redirects, node scan progress, failover/recovery, cross-slot limitations and no write replay.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="ext-05"></a>
### EXT-05 — Redis Sentinel

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [FIX-04](#fix-04)
- Starting evidence / proposed surface: Extend existing Redis driver/browser without inheriting untested topology support. [src/main/engines/redis.ts](../../src/main/engines/redis.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/RedisBrowser.tsx](../../src/renderer/src/components/RedisBrowser.tsx); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [tests/redis.integration.test.ts](../../tests/redis.integration.test.ts); [tests/redis-ui.e2e.ts](../../tests/redis-ui.e2e.ts).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Master discovery, service-name configuration, authentication separation where needed, failover and status updates. Test a real disposable Sentinel topology.

**Concrete verification scenario and next action**

Disposable Redis master/replica/Sentinel topology; service name and auth separation, real election/failover, state changes and cleanup.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="ext-07"></a>
### EXT-07 — TimescaleDB depth

- [ ] Full ticket accepted: **M3 / P2**.
- Current capability: **existing and implemented increments — see PROGRESS.md**; work: **in-progress**; acceptance: **partial evidence; full ticket pending**; delivery: **local-only**.
- Dependencies: [ADV-03](#adv-03), [ADV-06](#adv-06), [ADV-16](#adv-16)
- Starting evidence / proposed surface: Extend PostgreSQL/MariaDB/Timescale behavior through their existing service and tests. [src/main/engines/sql.ts](../../src/main/engines/sql.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/Sidebar.tsx](../../src/renderer/src/components/Sidebar.tsx); [src/renderer/src/components/QueryEditor.tsx](../../src/renderer/src/components/QueryEditor.tsx); [tests/sql-catalog.integration.test.ts](../../tests/sql-catalog.integration.test.ts); [tests/sql-timescale.integration.test.ts](../../tests/sql-timescale.integration.test.ts).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Version-aware hypertables, chunks, retention/compression or equivalent current policies, continuous aggregates, and query-plan workflows. Inspect by default; administration requires reviewed commands.

**Concrete verification scenario and next action**

Real supported Timescale versions with hypertables/chunks/policies/continuous aggregates; preserve unsorted preview and compressed-row lock restrictions; admin commands reviewed.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Incremental evidence:** [PROGRESS.md](PROGRESS.md), dated checks in [EVIDENCE.md](EVIDENCE.md). Full-ticket acceptance remains unchecked; specific missing checks and implementation slices remain work, not external blockers.

<a id="adv-09"></a>
### ADV-09 — Database-to-database transfer

- [ ] Full ticket accepted: **M4 / P2**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-01](#adv-01), [ADV-02](#adv-02), [ADV-08](#adv-08), [ADV-16](#adv-16)
- Starting evidence / proposed surface: Existing driver reads, reviewed edits and import/export boundaries; transfer orchestration is proposed. [src/main/engines/](../../src/main/engines/); [src/main/persistence/export.ts](../../src/main/persistence/export.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/CsvImportDialog.tsx](../../src/renderer/src/components/CsvImportDialog.tsx).
- Required verification: V-BASE, V-UI, V-WRITE, V-JOB, V-PERF; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Preview mappings and incompatible types, key/identity behavior, transaction boundaries, batching, errors, and partial completion. Support a documented source/target matrix, not an implicit all-to-all guarantee. No silent truncation, precision loss, or unsupported type conversion.

**Concrete verification scenario and next action**

Documented source/target pair with incompatible types, identity keys, mid-batch failure and cancel; no silent coercion/truncation and truthful partial completion.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="adv-12"></a>
### ADV-12 — Backup and restore workflows

- [ ] Full ticket accepted: **M4 / P2**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [ADV-17](#adv-17), [UX-08](#ux-08)
- Starting evidence / proposed surface: New scoped native-tool workflow; existing main privilege and worker boundaries are reusable. [src/main/](../../src/main/); [src/main/ipc.ts](../../src/main/ipc.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/](../../src/renderer/src/components/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-UI, V-JOB, V-PRIVACY, V-PACKAGE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Start with selected SQL engines using supported native tooling. Validate tool/server versions, target, storage, credentials, progress, failure, and cancellation. Restore into a disposable target and verify representative contents before calling a backup workflow accepted. Query export is not a backup. PITR and cluster disaster recovery are separate future scopes.

**Concrete verification scenario and next action**

Selected SQL server/native-tool version pair; backup then restore to fresh disposable database and verify rows/types/objects; wrong versions, cancellation, credential redaction and partial artifacts.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="adv-15"></a>
### ADV-15 — Analytics workspace

- [ ] Full ticket accepted: **M4 / P2**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [DB-03](#db-03), [UX-05](#ux-05), [ADV-01](#adv-01), [ADV-02](#adv-02)
- Starting evidence / proposed surface: New scoped local analytics module built on DB-03; reuse parameter/grid/job contracts. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/renderer/src/components/QueryEditor.tsx](../../src/renderer/src/components/QueryEditor.tsx); [src/renderer/src/components/DataGrid.tsx](../../src/renderer/src/components/DataGrid.tsx).
- Required verification: V-BASE, V-UI, V-ENGINE, V-JOB, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Query CSV/JSON/Parquet through an explicitly scoped local engine; save parameterized reports and simple table/bar/line charts. Show sampling and filters. Charts do not mutate data or send it remotely. Remote object-storage access requires separate credentials and scope.

**Concrete verification scenario and next action**

Scoped local CSV/JSON/Parquet including large files and exact values; parameterized reports/charts show filters/sampling; no file/network/remote-storage access beyond selected scope.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="adv-17"></a>
### ADV-17 — Reliable desktop delivery

- [ ] Full ticket accepted: **M4 / P2**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [FIX-05](#fix-05), [ADV-13](#adv-13)
- Starting evidence / proposed surface: Existing packaging, credential and historical release evidence. [electron-builder.yml](../../electron-builder.yml); [src/main/index.ts](../../src/main/index.ts); [src/main/persistence/credentials.ts](../../src/main/persistence/credentials.ts); [tests/package.e2e.ts](../../tests/package.e2e.ts); [tests/single-instance.e2e.ts](../../tests/single-instance.e2e.ts); [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md); [docs/CAPABILITIES.md](../../docs/CAPABILITIES.md); [docs/VALIDATION.md](../../docs/VALIDATION.md); [.github/workflows/](../../.github/workflows/).
- Required verification: V-BASE, V-PERSIST, V-PACKAGE, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Packaged smoke tests, supported OS/CPU matrix, signed artifacts and notarization where applicable, safe workspace migrations, migration backups, and redacted diagnostic bundles. Automatic updates require authenticated/signed artifacts, channel policy, failure recovery, and preserving unsaved work. Never install updates during active writes without explicit user coordination.

**Concrete verification scenario and next action**

Packaged existing/new native drivers, baseline migration/recovery, redacted bundles and update failure simulation; real signing/notarization/other OS checks remain blocked without infrastructure.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="ext-06"></a>
### EXT-06 — Valkey

- [ ] Full ticket accepted: **M4 / P2**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [EXT-04](#ext-04), [EXT-05](#ext-05)
- Starting evidence / proposed surface: Extend existing Redis driver/browser without inheriting untested topology support. [src/main/engines/redis.ts](../../src/main/engines/redis.ts); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/renderer/src/components/RedisBrowser.tsx](../../src/renderer/src/components/RedisBrowser.tsx); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [tests/redis.integration.test.ts](../../tests/redis.integration.test.ts); [tests/redis-ui.e2e.ts](../../tests/redis-ui.e2e.ts).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT, V-PACKAGE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Distinct advertised target with its own versions, commands, topology, auth/TLS, and fixtures. Protocol similarity permits code reuse, not an untested full-support badge.

**Concrete verification scenario and next action**

Independent Valkey versions/auth/TLS and each advertised standalone/Cluster/Sentinel topology; scope can start standalone but must not inherit Redis support badges.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="ext-08"></a>
### EXT-08 — Managed PostgreSQL/MySQL/SQL Server

- [ ] Full ticket accepted: **M4 / P2**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [DB-01](#db-01), [DB-04](#db-04), [ADV-16](#adv-16), [FIX-04](#fix-04)
- Starting evidence / proposed surface: Explicit compatible-deployment identity/preset with independently tested semantics is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Add tested presets for relevant RDS/Aurora, Azure SQL, Cloud SQL, Supabase, and Neon deployments. Verify certificates, identity/token expiry, pooling/session limitations, and database restrictions independently. Presets do not equal separate engine implementations.

**Concrete verification scenario and next action**

Explicitly authorized RDS/Aurora/Azure SQL/Cloud SQL/Supabase/Neon targets selected separately; certificate/identity expiry, pooling/session/database restrictions; no account provisioning.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="ext-09"></a>
### EXT-09 — CockroachDB and YugabyteDB

- [ ] Full ticket accepted: **M4 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [EXT-01](#ext-01)
- Starting evidence / proposed surface: Explicit compatible-deployment identity/preset with independently tested semantics is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Evaluate as PostgreSQL-compatible targets with separate catalogs, transactions/retry semantics, feature gates, and real fixtures. Never inherit automatic write replay from compatibility claims.

**Concrete verification scenario and next action**

Separate disposable CockroachDB and YugabyteDB fixtures, catalogs, restart/retry/transaction semantics and feature gates; never introduce automatic uncertain-write replay.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="ext-10"></a>
### EXT-10 — TiDB, Vitess, and relevant MySQL-compatible services

- [ ] Full ticket accepted: **M4 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [DB-01](#db-01), [ADV-16](#adv-16)
- Starting evidence / proposed surface: Explicit compatible-deployment identity/preset with independently tested semantics is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Separate compatibility targets with verified server metadata, transaction/DDL/constraint limitations, routing, and authentication.

**Concrete verification scenario and next action**

Separate TiDB/Vitess/relevant service targets with catalog, routing, auth and transaction/DDL/constraint limitations; no inherited MySQL full-support claim.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-09"></a>
### DB-09 — Snowflake

- [ ] Full ticket accepted: **M5 / P2**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [ADV-01](#adv-01), [UX-05](#ux-05)
- Starting evidence / proposed surface: Warehouse/job adapter with namespace, identity and cost context is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-JOB, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Warehouse/database/schema selection, asynchronous query state, authentication, result paging and cancellation; explicit warehouse/cost implications.

**Concrete verification scenario and next action**

Authorized Snowflake warehouse/database/schema fixture, async query/result/cancel, supported auth and warehouse cost consequences; no silent compute changes.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-10"></a>
### DB-10 — BigQuery

- [ ] Full ticket accepted: **M5 / P2**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [ADV-01](#adv-01), [UX-05](#ux-05)
- Starting evidence / proposed surface: Warehouse/job adapter with namespace, identity and cost context is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-JOB, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Project/dataset/table selection, job location, query jobs, parameter binding, dry-run/bytes estimates when available, cost controls, paged results, cancellation limitations.

**Concrete verification scenario and next action**

Authorized BigQuery project/dataset/location with binding, dry-run bytes/cost controls, paged jobs and actual cancellation limits; explicit quotas and spending boundary.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-11"></a>
### DB-11 — Amazon Redshift

- [ ] Full ticket accepted: **M5 / P2**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [ADV-01](#adv-01), [UX-05](#ux-05)
- Starting evidence / proposed surface: Warehouse/job adapter with namespace, identity and cost context is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-JOB, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Warehouse/serverless profiles, catalog/query/export, IAM/auth scope and Redshift-specific behavior; not just a renamed PostgreSQL adapter.

**Concrete verification scenario and next action**

Authorized Redshift warehouse/serverless target with IAM/auth and catalog/query/export; test Redshift-specific behavior independently of PostgreSQL.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-12"></a>
### DB-12 — Trino

- [ ] Full ticket accepted: **M5 / P2**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [ADV-01](#adv-01), [UX-05](#ux-05)
- Starting evidence / proposed surface: Warehouse/job adapter with namespace, identity and cost context is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-JOB, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Catalog/schema browsing, SQL, asynchronous result pages, progress/cancel, identity and connector limitations.

**Concrete verification scenario and next action**

Disposable Trino with selected connectors/catalogs/schemas, identity, async result pages/progress/cancel and connector-specific limitations.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-13"></a>
### DB-13 — Amazon Athena

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [ADV-01](#adv-01), [UX-05](#ux-05)
- Starting evidence / proposed surface: Warehouse/job adapter with namespace, identity and cost context is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-JOB, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Catalog/workgroup/output-location settings, asynchronous jobs, cost-aware execution and cancellation; account/storage access explicitly scoped.

**Concrete verification scenario and next action**

Authorized Athena catalog/workgroup/output location; async jobs, cancellation, scoped storage and cost evidence without provisioning accounts/buckets.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-14"></a>
### DB-14 — Databricks SQL

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [ADV-01](#adv-01), [UX-05](#ux-05)
- Starting evidence / proposed surface: Warehouse/job adapter with namespace, identity and cost context is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-JOB, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Warehouse/catalog/schema selection, identity, query lifecycle, data types and result transfer; no provisioning compute silently.

**Concrete verification scenario and next action**

Authorized Databricks SQL warehouse/catalog/schema and identity; query lifecycle/type/result-transfer tests, no implicit compute provisioning.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-15"></a>
### DB-15 — Neo4j

- [ ] Full ticket accepted: **M5 / P2**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-05](#ux-05), [UX-06](#ux-06)
- Starting evidence / proposed surface: Graph adapter with Cypher, properties and bounded visualization is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-PERF; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Cypher editor, property inspector, paged table output and bounded graph visualization; parameter binding and engine-specific mutations.

**Concrete verification scenario and next action**

Disposable Neo4j with Cypher parameters, property fidelity, bounded graph expansion, paged table output and engine-specific reviewed mutations.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-16"></a>
### DB-16 — DynamoDB

- [ ] Full ticket accepted: **M5 / P2**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-06](#ux-06)
- Starting evidence / proposed surface: Partition-aware adapter with explicit paging/consistency/access semantics is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Account/region/table/index navigation, distinguish Query from Scan, bounded pagination, capacity visibility, attribute fidelity, conditional mutations; no full-table scan by default.

**Concrete verification scenario and next action**

DynamoDB local fixture plus authorized service checks for claimed auth/capacity; account/region/table/index, typed attributes, bounded Query versus Scan and conditional conflicts.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-17"></a>
### DB-17 — Cassandra

- [ ] Full ticket accepted: **M5 / P2**.
- Current capability: **implemented candidate — see PROGRESS.md**; work: **verification and integration**; acceptance: **implemented; Cassandra5.0.9 native13/13 + desktop1/1; integrated focused gates passed**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-05](#ux-05)
- Starting evidence / proposed surface: Partition-aware adapter with explicit paging/consistency/access semantics is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

CQL, keyspaces/tables, partition-key-aware access, consistency settings, paging; do not pretend to offer relational transactions or unrestricted filtering cheaply.

**Concrete verification scenario and next action**

Disposable Cassandra keyspaces/tables and multiple partitions, consistency and paging; show partition-key restrictions and no relational transaction/unrestricted-filter promise.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Current evidence:** implemented; Cassandra5.0.9 native13/13 + desktop1/1; integrated focused gates passed. Exact commands and integration records are in PROGRESS.md and worker lane notes. This ticket remains unchecked until its full declared acceptance is reconciled.

<a id="db-18"></a>
### DB-18 — ScyllaDB

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [DB-17](#db-17)
- Starting evidence / proposed surface: Partition-aware adapter with explicit paging/consistency/access semantics is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Separate compatibility validation of the relevant Cassandra-style workflows and driver behavior.

**Concrete verification scenario and next action**

Separate ScyllaDB version/driver fixture for relevant CQL/consistency/paging workflows; Cassandra acceptance cannot substitute.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-19"></a>
### DB-19 — Couchbase

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-06](#ux-06)
- Starting evidence / proposed surface: Document adapter and revision/CAS/partition-aware editor is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Bucket/scope/collection exploration, documents, supported SQL++ query workflows and CAS-aware editing.

**Concrete verification scenario and next action**

Disposable Couchbase bucket/scope/collection plus SQL++ and document fidelity; CAS conflict and limited-role queries/mutations.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-20"></a>
### DB-20 — CouchDB

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-06](#ux-06)
- Starting evidence / proposed surface: Document adapter and revision/CAS/partition-aware editor is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Databases/documents, selectors and revision-aware editing, explicit conflict representation.

**Concrete verification scenario and next action**

Disposable CouchDB databases/documents/selectors; revision-aware replacement/deletion, visible conflicts and bounded pagination.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-21"></a>
### DB-21 — Azure Cosmos DB

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-06](#ux-06)
- Starting evidence / proposed surface: Document adapter and revision/CAS/partition-aware editor is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Select an explicit API first, such as NoSQL; partition keys, continuation tokens, consistency and request-unit visibility. Do not call one API's implementation support for every Cosmos API.

**Concrete verification scenario and next action**

Explicitly chosen Cosmos DB API with emulator where faithful and authorized real target for claimed behavior; partition keys/continuations/consistency/request units remain API-specific.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-22"></a>
### DB-22 — Firestore

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-06](#ux-06)
- Starting evidence / proposed surface: Document adapter and revision/CAS/partition-aware editor is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Project/database/collection/document navigation, query/index limitations, typed values, pagination and explicit billing-aware actions.

**Concrete verification scenario and next action**

Firestore emulator plus authorized account validation for service claims; project/database/document hierarchy, typed values, index/query limits, paging and billing-aware actions.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-23"></a>
### DB-23 — InfluxDB

- [ ] Full ticket accepted: **M5 / P2**.
- Current capability: **implemented candidate — see PROGRESS.md**; work: **verification and integration**; acceptance: **implemented; Influx2.9.1 native6 + TLS1 + unit6 and desktop1/1; final candidate gate pending**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-05](#ux-05)
- Starting evidence / proposed surface: Time-series adapter with explicit generation/dialect and time-range workflow is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-JOB, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Time-range-first browsing and queries with explicit server-generation/query-language support. Test each advertised generation independently.

**Concrete verification scenario and next action**

Real separately named InfluxDB generations/query languages with time-range-first UI; auth/types/limits/query/cancel checked independently for each claim.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Current evidence:** implemented; Influx2.9.1 native6 + TLS1 + unit6 and desktop1/1; final candidate gate pending. Exact commands and integration records are in PROGRESS.md and worker lane notes. This ticket remains unchecked until its full declared acceptance is reconciled.

<a id="db-24"></a>
### DB-24 — QuestDB

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **implemented candidate — see PROGRESS.md**; work: **verification and integration**; acceptance: **implemented; QuestDB10.0.1 native7/7; desktop gate underway**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-05](#ux-05)
- Starting evidence / proposed surface: Time-series adapter with explicit generation/dialect and time-range workflow is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Time-series SQL, timestamp-aware browsing and engine-specific catalog/types; verify write and protocol capabilities.

**Concrete verification scenario and next action**

Disposable QuestDB version/protocol, timestamp/catalog/type behavior and declared query/write capabilities; no implicit PostgreSQL equivalence.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Current evidence:** implemented; QuestDB10.0.1 native7/7; desktop gate underway. Exact commands and integration records are in PROGRESS.md and worker lane notes. This ticket remains unchecked until its full declared acceptance is reconciled.

<a id="db-25"></a>
### DB-25 — Qdrant

- [ ] Full ticket accepted: **M5 / P2**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-06](#ux-06)
- Starting evidence / proposed surface: Vector adapter with dimension/distance/payload/search interfaces is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-PERF; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Collections, payload filters, vector search, distance/index settings, bounded vector inspection and reviewed mutations.

**Concrete verification scenario and next action**

Disposable Qdrant collections with dimension/distance/index settings, payload filters, bounded vectors and reviewed mutation/conflict limitations.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-26"></a>
### DB-26 — Milvus

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-06](#ux-06)
- Starting evidence / proposed surface: Vector adapter with dimension/distance/payload/search interfaces is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-PERF; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Collection/schema/index exploration, typed vector search and scalar filters; bounded results and deployment/version validation.

**Concrete verification scenario and next action**

Disposable supported Milvus topology/version with schema/index, typed vector/scalar filters and bounded results; failed/unsupported deployment modes explicit.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-27"></a>
### DB-27 — Weaviate

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-06](#ux-06)
- Starting evidence / proposed surface: Vector adapter with dimension/distance/payload/search interfaces is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-TRANSPORT; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Collections/schema, supported search modes, vector/property inspectors and authentication/version checks.

**Concrete verification scenario and next action**

Disposable Weaviate versions/auth with collection schema, supported search modes and bounded vector/property inspectors; advertise modes independently.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-28"></a>
### DB-28 — Pinecone

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-06](#ux-06)
- Starting evidence / proposed surface: Vector adapter with dimension/distance/payload/search interfaces is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Index/namespace exploration and vector search with clear limits on record enumeration and data visibility; scoped credentials and usage awareness.

**Concrete verification scenario and next action**

Authorized Pinecone index/namespace, scoped credentials/search and usage limits; explicitly document unavailable enumeration/visibility rather than simulate records.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-29"></a>
### DB-29 — IBM Db2

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **implemented candidate — see PROGRESS.md**; work: **verification and integration**; acceptance: **implemented; optional runtime safely unavailable on this laptop; native Db2 acceptance blocked**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-05](#ux-05)
- Starting evidence / proposed surface: Engine-specific adapter with driver/license/native-packaging requirements is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-TRANSPORT, V-PACKAGE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Enterprise relational explorer/query support, driver distribution/runtime constraints, types, auth, licensing and real fixtures.

**Concrete verification scenario and next action**

Licensed/authorized IBM Db2 fixture, redistributable driver and supported runtime/OS; exact types/auth/query/catalog; missing license/platform blocks claim.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Current evidence:** implemented; optional runtime safely unavailable on this laptop; native Db2 acceptance blocked. Exact commands and integration records are in PROGRESS.md and worker lane notes. This ticket remains unchecked until its full declared acceptance is reconciled.

<a id="db-30"></a>
### DB-30 — Firebird

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-05](#ux-05)
- Starting evidence / proposed surface: Engine-specific adapter with driver/license/native-packaging requirements is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-WRITE, V-PACKAGE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Relational file/server connection modes, metadata/query/types, transaction semantics, driver packaging.

**Concrete verification scenario and next action**

Disposable Firebird file/server modes with actual packaged driver, metadata/types/query and transaction semantics; protect existing user files.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="db-31"></a>
### DB-31 — SAP HANA

- [ ] Full ticket accepted: **M5 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-16](#adv-16), [UX-05](#ux-05)
- Starting evidence / proposed surface: Engine-specific adapter with driver/license/native-packaging requirements is proposed; do not assume the engine exists at baseline. [src/main/engines/](../../src/main/engines/); [src/shared/contracts.ts](../../src/shared/contracts.ts); [src/main/ipc.ts](../../src/main/ipc.ts); [src/preload/index.ts](../../src/preload/index.ts); [src/renderer/src/components/ConnectionDialog.tsx](../../src/renderer/src/components/ConnectionDialog.tsx); [src/renderer/src/components/](../../src/renderer/src/components/); [tests/](../../tests/); [electron-builder.yml](../../electron-builder.yml).
- Required verification: V-BASE, V-ENGINE, V-UI, V-TRANSPORT, V-PACKAGE; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Catalog/query support, driver/platform/auth constraints, analytical types and real target verification.

**Concrete verification scenario and next action**

Licensed/authorized SAP HANA target and supported driver/platform/auth; analytical types/catalog/query with actual target evidence and redistribution review.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="adv-18"></a>
### ADV-18 — Optional AI assistance

- [ ] Full ticket accepted: **M6 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [UX-04](#ux-04), [UX-05](#ux-05), [ADV-16](#adv-16)
- Starting evidence / proposed surface: Proposed optional module, not an existing service claim; reuse explicit main/IPC/persistence boundaries. [src/main/](../../src/main/); [src/main/ipc.ts](../../src/main/ipc.ts); [src/shared/](../../src/shared/); [src/renderer/src/components/](../../src/renderer/src/components/); [src/main/persistence/store.ts](../../src/main/persistence/store.ts).
- Required verification: V-BASE, V-UI, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Opt-in explain/generate/diagnose assistance with local-provider options where feasible. Show exactly which schema/query/data will leave the laptop; default to no row-data upload. Redact secrets, treat database content as untrusted, preview generated queries, and require user execution. No autonomous database writes.

**Concrete verification scenario and next action**

Explicit local-provider and authorized remote-provider modes, outbound scope preview, untrusted schema/query content, cancellation and secret redaction; suggestions never execute themselves.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="adv-19"></a>
### ADV-19 — Optional team workflow

- [ ] Full ticket accepted: **M6 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-13](#adv-13), [UX-10](#ux-10)
- Starting evidence / proposed surface: Proposed optional module, not an existing service claim; reuse explicit main/IPC/persistence boundaries. [src/main/](../../src/main/); [src/main/ipc.ts](../../src/main/ipc.ts); [src/shared/](../../src/shared/); [src/renderer/src/components/](../../src/renderer/src/components/); [src/main/persistence/store.ts](../../src/main/persistence/store.ts).
- Required verification: V-BASE, V-UI, V-PERSIST, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Begin with reviewable query files and secret-free workspace sharing. Shared cloud sync, organizations, collaboration, and application RBAC require a separate product and security design; they are not prerequisites for an excellent local workbench.

**Concrete verification scenario and next action**

Reviewable query files and two secret-free workspaces with merge conflicts; optional cloud/org/RBAC is a separately specified product design, never an implicit prerequisite or activation.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

<a id="adv-20"></a>
### ADV-20 — Task automation

- [ ] Full ticket accepted: **M6 / P3**.
- Current capability: **unverified — needs reconciliation**; work: **needs-reconciliation**; acceptance: **not-run**; delivery: **local-only**.
- Dependencies: [ADV-01](#adv-01), [ADV-02](#adv-02), [ADV-15](#adv-15), [ADV-17](#adv-17)
- Starting evidence / proposed surface: Proposed optional module, not an existing service claim; reuse explicit main/IPC/persistence boundaries. [src/main/](../../src/main/); [src/main/ipc.ts](../../src/main/ipc.ts); [src/shared/](../../src/shared/); [src/renderer/src/components/](../../src/renderer/src/components/); [src/main/persistence/store.ts](../../src/main/persistence/store.ts).
- Required verification: V-BASE, V-UI, V-JOB, V-PRIVACY; see [verification packs and commands](EVIDENCE.md#verification-packs-used-by-the-backlog).

**Acceptance criteria from the product brief**

Reusable import/export/report jobs with a visible target, schedule, local execution state, resource limits, redacted credentials, and logs. Explicit opt-in only. Explain that jobs cannot run while the required desktop runtime is unavailable; no silent production automation.

**Concrete verification scenario and next action**

Explicitly enabled disposable local report/import/export job; schedule boundaries, app-offline state, limits, failure/cancel and redacted logs; no silent production automation.

Reconcile the complete acceptance scope first, then implement the smallest useful slice with its failure paths. Add or extend focused tests; run the named packs against the final candidate. Record resource bounds, migration/recovery implications and unsupported cases where applicable. Credentials, licensed targets, native platform/signing infrastructure and external activation are blockers only when the corresponding scenario needs them.

**Completion evidence:** none recorded. Add a dated ticket record to [EVIDENCE.md](EVIDENCE.md#progress-records) before changing this status or checking the box.

## Source provenance

- Source brief filename: `Harbor-DB-Product-and-Implementation-Roadmap.md`; prepared 2026-09-18.
- Source brief SHA-256: `b30d838061ab1ea327f84b2b51106d77d80da2515239c69dbd3fac086b65f564`.
- Numbered source rows preserved: FIX 5, UX 12, ADV 20, DB 31, EXT 10; total **78**.
- Every original acceptance paragraph is copied into its corresponding card. No implementation claim is inferred from a ticket title.
- The source brief's M0-only/per-milestone authorization text is superseded by the later user authorization described in [README.md](README.md#authorization-and-scope); local-only and evidence boundaries remain.
