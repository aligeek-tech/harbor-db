# Release continuation — 2026-09-24

Owner authorized single-task continuation and publication at a verified release point; no new tasks/agents. Starting main00a1d6c6379591c3c5ee0eb5eb58e86825765b11, clean tracked/untracked state; version0.1.7. Prior workers remain idle. Earlier full roadmap is incomplete and will not be represented as complete by this release.

## Release gates

- [x] Repair known vector exact-value, credential transport, filter, deadline and identity safeguards with tests.
- [x] Repair automation startup cancellation, timezone drift and log privacy with tests.
- [x] Repair existing Linux CI diagnostic capability and DuckDB file identity failures.
- [x] Reconcile reviewed completed checkpoints and document remaining preview/blocked scope.
- [ ] Linux x64/ARM64 AppImage, DEB, RPM and portable archive packaging; explicit distro requirements and limitations.
- [x] Local lint/type/build/unit and meaningful desktop/package verification.
- [ ] Native-platform CI passes before publication; all promised installers accounted for.
- [ ] Patch version/download/release docs updated, commit/push/tag through existing workflow, public asset checksums independently verified.

Earlier disposable runtime/log directory was removed by the system. Node24.19.0 is available in the Codex bundled runtime; recreating external locked npm11.19 tooling. Prior evidence is historical and worker files remain available. No licenses newly accepted; no cloud data transfer authorized by publication.

## Bounded release scope

This release publishes the integrated root checkpoint and the September24 safety/packaging corrections. It does **not** complete or accept all78roadmap tickets. Existing worker tasks remain idle and no new tasks/agents were created. Scylla's frozen checkpoint, partial Couchbase and partial Cosmos/Firestore remain outside this checkout; they have not been silently counted as delivered. Cloud warehouses/Pinecone/HANA/Db2 retain explicit external prerequisites. Optional assistance/team/automation remain opt-in; publication activates no provider or schedule.

Closed pause findings: vector lossless JSON and uint64/int64 IDs, verified native TLS/CA/mTLS/SSH transport, pinned Pinecone hosts, bounded request admission, effective caller+session+deadline cancellation, safe provider errors and explicit unsupported filters; automation pre-start cancellation, live timezone drift, timer failure containment and value-free persisted summaries; DuckDB grants also check size/mtime/ctime before use and before import commit. UX08 now shows pending insert/update/delete counts and missing original snapshots. Further UX/time-series/automation whole-ticket acceptance remains open in PAUSED.md/BACKLOG.md.

## Fresh local evidence (macOS ARM64, Node24.19.0)

All commands run in the repository root with scoped external npm11.19.0; no global runtime/settings change. W is a disposable external `harbor-release-20260924-*` directory; command metadata/logs remain there without committed credentials.

| Command / log label | Actual result | Limits |
| --- | --- | --- |
| `npm run lint` / final-lint | PASS, exit0 | Rechecked after final source changes by CI. |
| `npm run typecheck` / final-types | PASS, exit0 | Static only. |
| `npm run build` / final-build | PASS, exit0,17.55s | Development bundle. |
| `HARBOR_INTEGRATION=1 HARBOR_TIMESCALE=1 HARBOR_MYSQL=1 HARBOR_MYSQL_TLS_CA=<disposable CA> npm test` / final-integration | PASS,697tests,225explicit skips,83passed/35skipped files,exit0,56.43s | Fresh PostgreSQL/MariaDB/MySQL/MongoDB/Redis/Timescale plus real local engines. Other fixtures not enabled. |
| `npm test -- tests/vector-transport.test.ts` / vector-tls-2 | PASS1/1,exit0 | Real local HTTPS customCA/mTLS/original hostname and rejection tests; not an external provider. |
| `HARBOR_VECTOR_QDRANT_PORT=16333 npm test -- tests/vector.integration.test.ts` / qdrant-exact | PASS1,2other-provider skips,exit0 | RealQdrant1.19.1 catalog/filter/mutation plus9007199254740993ID andpayload round trip. |
| `HARBOR_INTEGRATION=1 HARBOR_TIMESCALE=1 npx playwright test` / desktop-full | 51PASS,1FAIL,22SKIP,exit1 | MongoDB URI preview introduced a second status live region; an ambiguous locator failed. Explicit connection-status locator corrected; focused rerun recorded below. |
| `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --dir --publish never` / package-arm | PASS,exit0,24.56s | Actual macOSARM ASAR, ad-hoc signature; no notarization. |
| `HARBOR_PACKAGE_LOCAL=1 npx playwright test tests/package-local.e2e.ts` / package-local-4 | PASS1/1,exit0 | PackagedSQLite/DuckDB exact values, sandbox, diagnostics, reload. Mock keychain/session-only harness; no protected-storage claim. |
| `HARBOR_PACKAGE=1 HARBOR_PACKAGE_SESSION_ONLY=1 HARBOR_MYSQL_TLS_CA=<CA> npx playwright test tests/package.e2e.ts` / package-full | PASS1/1,exit0,3.97s | Verified ad-hoc signature,ASAR/sandbox,five real remote drivers,local native workers,editor/reload/diagnostics; OS-keychain reconnect intentionally not exercised. |

Earlier failed attempts remain failures: initial package probe hit a macOSKeychain prompt and timed out; its owned PID24381 required termination after graceful termination did not complete. Two new package-smoke fixture profiles were missing required host fields and failed before engine assertions; corrected to the established local-engine profile contract. The first expanded integration run passed696tests but failed one hard-coded x64 sandbox-path expectation; architecture-aware regression passed10/10 before the final697pass gate. Initial TLS test had the wrong expected error wording; subsequent test exercised all positive/negative cases and passed. None of these earlier attempts is counted as a pass.

Fresh fixtures are uniquely named `harbor-release-20260924` (Compose), `harbor-release-mysql-20260924` and `harbor-release-qdrant-20260924`, bound to loopback, synthetic data only. Existing unrelated/older containers and user configuration were preserved. Runtime shutdown and remote publication evidence will be appended after the final gates.

MongoDB focused rerun `HARBOR_INTEGRATION=1 npx playwright test tests/mongo-ui.e2e.ts` / mongo-desktop: **PASS1/1**, exit0,3.44s; full real document edit/delete/saved-query/URI connection workflow completed after the locator correction.

## Dependency audit correction before publication

`npm audit --omit=dev --json` found2high findings: Cassandra4.9.0 transitively pinned adm-zip0.5.18, affected by GHSA-xcpc-8h2w-3j85, GHSA-vwc7-r8mq-g2x9 and GHSA-7q85-xj36-vmfc. The archive reader is used only by the driver's cloud secure-connect-bundle option; Harbor constructs an explicit direct Client and does not expose that option. Nevertheless the release workflow35979410821 was cancelled before publication. Tagv0.1.8 remains preserved and is not moved or reused. Corrected candidate is **0.1.9**, pinning only adm-zip0.6.1 via npm override; Cassandra driver stays4.9.0. `npm install --ignore-scripts --no-audit --no-fund` changed exactly one transitive package; no optional Db2 installation hook ran. Vendor advisory: https://github.com/advisories/GHSA-7q85-xj36-vmfc .

Owned local fixtures are stopped, no disposable Electron process remains, and the two Db2 desktop screenshots created under untracked work/ were moved to W/db2-evidence. Dependencies/build/package outputs and external logs are retained. No unrelated runtime was stopped.

Corrected dependency checks: full `npm audit --json` (including development dependencies) **PASS,0findings**, exit0; CQL safety7/7 and vector/automation20/20 pass; `npm run build` passes16.04s. The first focused command named a nonexistent cql.test.ts and therefore did not include CQL; the explicit cql-safety.test.ts run supplies that separate7case evidence. CI now audits the locked graph at high severity before release verification.
