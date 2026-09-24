# Release continuation — 2026-09-24

Owner authorized single-task continuation and publication at a verified release point; no new tasks/agents. Starting main00a1d6c6379591c3c5ee0eb5eb58e86825765b11, clean tracked/untracked state; version0.1.7. Prior workers remain idle. Earlier full roadmap is incomplete and will not be represented as complete by this release.

## Release gates

- [x] Repair known vector exact-value, credential transport, filter, deadline and identity safeguards with tests.
- [x] Repair automation startup cancellation, timezone drift and log privacy with tests.
- [x] Repair existing Linux CI diagnostic capability and DuckDB file identity failures.
- [x] Reconcile reviewed completed checkpoints and document remaining preview/blocked scope.
- [x] Linux x64/ARM64 AppImage, DEB, RPM and portable archive packaging; explicit distro requirements and limitations.
- [x] Local lint/type/build/unit and meaningful desktop/package verification.
- [x] Native-platform CI passes before publication; all promised installers accounted for.
- [x] Patch version/download/release docs updated, commit/push/tag through existing workflow, public asset checksums independently verified.

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

## Native CI result and long-fixture input correction

Release35979935766 at f362c8f/v0.1.9: **all five native installer jobs passed**, including actual packaged SQLite/DuckDB, sandbox, reload and diagnostics on Ubuntu24.04x64/ARM64, macOS15Intel/ARM64 and Windows2025x64. Both extra package jobs passed. Linux audit/static/unit/build/native integrations passed. Desktop gate:51pass,22skip,1fail. The sole failure was `pressSequentially` timing out at30seconds while typing a roughly1KB SQL fixture into Monaco in ux12-ui.e2e.ts, before performance measurement. All functional desktop cases passed. Publication was skipped, not forced.

The performance fixture now uses browser bulk text input through Monaco's normal input event path; all other typing regressions retain individual keyboard events. Existing full persisted-SQL equality,5s catalog,8s query,250ms event-loop and1s settings thresholds remain unchanged. No model/workspace injection, retry or weaker threshold. Corrected candidate is **0.1.10**; v0.1.8/v0.1.9 tags are preserved, neither was published. Job-specific logs had a DNS/network failure; the standard GitHub run-log archive endpoint succeeded, without changing DNS/global settings or bypassing access controls.

Local unchanged-threshold performance rerun after bulk fixture entry: **PASS1/1**, catalog188ms, query133ms, maximum measured event-loop delay122ms, exit0,4.23s. CI now emits GitHub test annotations alongside the ordinary list reporter for direct diagnosis if artifact log routing is unavailable.

## Published candidate and platform verification

**v0.1.10** at **346fe241a7c4c6c94b870a84d8d2235f252dd5a3** was published September24,2026 at09:42:21UTC. [Release workflow35981461078](https://github.com/aligeek-tech/harbor-db/actions/runs/35981461078) and [branch CI35981443428](https://github.com/aligeek-tech/harbor-db/actions/runs/35981443428) both succeeded. Publication required all13installers plusSHA256SUMS; no failed gate was bypassed. v0.1.8 was cancelled and v0.1.9 failed before publication; both tags remain immutable and unpublished.

| Final release gate | Result |
| --- | --- |
| Clean locked install, full dependency audit, lint, TypeScript and build | PASS; audit0findings |
| Default unit gate |465passed,336explicit skips;64passed/54skipped files |
| Enabled real-engine integration gate |697passed,225explicit skips;83passed/35skipped files |
| Linux desktop acceptance |52passed,22explicit skips,5.4minutes |
| Linux packaged remote/local-driver acceptance |1/1passed,5.1s |
| Ubuntu24.04 x64,4Linux formats and actual packaged smoke |PASS; native smoke1/1,4.0s |
| Ubuntu24.04 ARM64,4Linux formats and actual packaged smoke |PASS; native smoke1/1,2.7s |
| macOS15 Intel,DMG+ZIP and actual packaged smoke |PASS; native smoke1/1,12.9s |
| macOS15 Apple Silicon,DMG+ZIP and actual packaged smoke |PASS; native smoke1/1,5.1s |
| Windows2025 x64,NSIS and actual packaged smoke |PASS; native smoke1/1,3.8s |

Release-run performance: catalog547ms, query69ms, maximum measured renderer event-loop delay50.8ms,4timer ticks. Thresholds were unchanged. Native package smoke exercises SQLite/DuckDB,ASAR,sandbox,diagnostics and reload on every platform; the separate Linux package gate exercises five real network drivers. This does not certify every adapter,distribution,serverversion,OSkeyring or desktop environment. Windows remains unsigned; macOS ad-hoc signed without notarization. No Alpine/musl,32bit,ARMv7,RISC-V,WindowsARM,Flatpak/Snap/AUR publication claim.

Temporary fixture containers and test apps are stopped. Existing user work/services were preserved. The working tree was clean at the tagged candidate; final documentation-only evidence will be recorded without moving that tag. For local development use Node24 and `npm ci && npm run dev` from the repository root; installer users do not need Node. The scoped external npm runtime and logs remain in W for this session, but are not promised permanent storage.

## Final public asset verification and handoff

Release: https://github.com/aligeek-tech/harbor-db/releases/tag/v0.1.10 . All13installer URLs were tested **without authentication** using `curl --fail --location --head`; each returnedHTTP200. The anonymously downloaded SHA256SUMS matches GitHub's independently recorded `sha256:` digest for **every installer**, with an exact13file set. Two additional complete local streamed downloads (Linuxaarch64RPM,120429473bytes; Linuxamd64DEB,150517932bytes) matched the same hashes. The remaining optional full-body transfers were intentionally stopped after the complete13asset metadata/public-access verification; they are **not** claimed as complete local rehashes. There is no13/13full-download claim.

Evidence: W/v0.1.10-public-metadata-verification.json, W/v0.1.10-SHA256SUMS, W/v0.1.10-complete-body-samples.json and the two successful public GitHub workflow runs above. The full run-log archive API succeeded; failed direct job-log access is not needed for the recorded results. All task-owned download processes are now stopped.

Handoff: released source346fe241a7c4c6c94b870a84d8d2235f252dd5a3; package0.1.10; main includes a subsequent documentation-only evidence commit, with no retagging or installer replacement. Important paths: src/main/engines/vector.ts,vector-http.ts,duckdb-worker.ts; src/main/persistence/automation.ts,transfers.ts,transfer-imports.ts; tests/editor-input.ts,ux12-ui.e2e.ts,package-local.e2e.ts; .github/workflows/{ci,release}.yml; docs/CAPABILITIES.md and roadmap/BACKLOG.md. All78ticket cards remain present; unchecked acceptance is not changed into completion by this release. No new worker task or agent was created. Next work must preserve exact values, validatedIPC, explicit targets, conflict/write guards and opt-in data transfer; Scylla/Couchbase/Cosmos/Firestore outside copies remain unintegrated. No fixture/app/download process is intentionally left running, and no future automation was created.
