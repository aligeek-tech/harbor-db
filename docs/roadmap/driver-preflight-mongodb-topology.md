# MongoDB replica sets, SRV and advanced document tools

Local implementation and evidence dated 2026-09-18. EXT-03 and the MongoDB portion of ADV-14; local-only, no publication. This extends the existing MongoDB engine rather than creating a separate Atlas engine. Full EXT-03 acceptance remains partial without an explicitly authorized Atlas target and platform/package checks.

## Driver and platform preflight

- Existing locked dependency: `mongodb@7.6.0`, official MongoDB Node.js driver, Apache-2.0; Node requirement `>=20.19.0`. No extra Mongo dependency was installed. Harbor's Node 24 and Electron 44 main process execute the JS driver. No native BSON encryption/compression module was introduced. [Official driver repository](https://github.com/mongodb/node-mongodb-native), [driver release notes](https://www.mongodb.com/docs/drivers/node/current/reference/release-notes/).
- Fixture: MongoDB Community Server **7.0.43**, Linux ARM64 Docker image `mongo@sha256:9854f7139445d766a9523571d6f047530c45547460ffcf8259eb2bf4264632ca`. The server uses SSPL v1, separately from the client driver's Apache license. The server is a disposable local dependency, not bundled into Harbor. [MongoDB Community licensing](https://www.mongodb.com/legal/licensing/community-edition).
- Observed platform: macOS ARM64; Linux ARM64 server processes. Windows/Linux desktop and packaged Mongo advanced-tool workflows are not established by the Node integration checks below.
- Official design references: [connection string options](https://www.mongodb.com/docs/manual/reference/connection-string/), [Node driver options](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/), [keyfile replica authentication](https://www.mongodb.com/docs/manual/tutorial/deploy-replica-set-with-keyfile-access-control/), [createIndexes](https://www.mongodb.com/docs/manual/reference/command/createIndexes/), [dropIndexes](https://www.mongodb.com/docs/manual/reference/command/dropIndexes/), [TTL behavior](https://www.mongodb.com/docs/manual/core/index-ttl/).

## Implemented scope and boundaries

`ConnectionProfile.mongo` preserves old defaults and adds up to ten extra host/port seeds, explicit negotiated SCRAM/SCRAM-SHA-256/SCRAM-SHA-1, and the five driver read preferences. Primary host/port remains the first seed. SRV accepts a single DNS hostname with no custom port, requires verified TLS, and cannot combine with direct mode/manual seeds/SSH. Duplicate seeds and incompatible direct/SSH discovery are rejected before connecting. URI parsing preserves the supported fields and rejects unknown, repeated or conflicting options. A typical Atlas URI containing `retryWrites=true`, `appName`, or `w` must be reviewed and expressed using supported settings; Harbor does not silently discard those options.

Credentials stay in existing main-process secret storage and are absent from profile/bootstrap responses. Discovered-member TLS uses each member's own hostname; an explicit single SSH tunnel keeps the original-host certificate check. The driver disables retryReads, retryWrites, overload retargeting and adaptive retries. Existing FIX-04 generation guards, stale status, authenticated recovery and uncertain-write behavior are preserved. No multi-document transaction, X.509/IAM/OIDC authentication, Atlas administration, sharded-cluster administration or replica reconfiguration is claimed.

Topology is an explicit UI action backed by a bounded authenticated ping and real driver observations: set/type, primary, member roles/round trips, read preference and current status. Secondary reads may be stale. Writes require connected state and an observed writable primary/standalone/router; missing members retain existing degraded status protections. The topology view does not change the replica set.

The aggregation builder edits ordered Extended JSON stage bodies, reorders/enables/disables stages, previews exact numeric text, and applies a draft without running it. Disabled stages are omitted when applied. Native execution still rejects nested write stages, change streams and server-side JavaScript; max 100 stages / 1 MB, no disk spilling, existing query timeout and 4 MiB result preview. Canonical BSON wrappers preserve int64, decimal, date and binary values. Plain integers outside the exact numeric range are now rejected before BSON conversion rather than rounded. Use `$numberLong`/`$numberDecimal` strings for exact large/decimal values; plain JSON floating-point values retain BSON double semantics.

The index inspector reads the primary's actual ordered definitions and collection UUID. Create supports named ordered ascending/descending, hashed, text and 2dsphere keys; explicit unique/sparse/hidden/partial/TTL settings. Invalid unique-hashed, sparse+partial, repeated fields and compound TTL combinations are rejected. Drop is one exact existing named index; `_id_` and wildcard/all-index drops are unavailable. Index definition data is capped at 1,000 entries / 4 MiB. Views, time-series index management and Atlas Search/vector index APIs are visibly unsupported.

Index execution requires a sealed one-use review (max 20 live, two-minute expiry), exact namespace/index confirmation, current native connection, writable profile, and a fresh collection/catalog fingerprint. Production confirmation includes the profile name. TTL review expressly warns that the server can automatically delete existing documents and that hiding the index or enabling Harbor read-only does not stop TTL. Native majority acknowledgement and bounded server timeouts apply. Index changes are nontransactional; MongoDB has no atomic compare-and-swap index DDL, so the final catalog recheck cannot eliminate a concurrent administrator race. Connection/timeout outcomes remain uncertain with inspect-before-retry guidance. No automatic retry or undo is promised.

## UX flow

```text
Connection form: first host + extra seeds → replica set / SCRAM / preference → verified TLS → Test → Save/connect
Mongo collection → Topology → observed members + primary + status (no reconfiguration)
Mongo collection → Build pipeline → stage bodies/order/enabled → exact preview → Apply draft → Run query
Mongo collection → Indexes → actual definitions → structured create/drop → preview + warnings
                 → exact target confirmation → fresh UUID/catalog check → one native operation → reload
```

Source: `src/main/engines/mongo.ts`, `mongo-config.ts`, `mongo-indexes.ts`; `src/shared/mongo-tools.ts`, `mongo-uri.ts`, `mongo-pipeline.ts`; `MongoConnectionFields.tsx`, `MongoPipelineBuilder.tsx`, `MongoTools.tsx`, and the existing `MongoBrowser.tsx`. IPC/preload additions are restricted to topology/index catalog/review/execute. The renderer has no generic native-command IPC.

## Local fixture and resource accounting

External task directory:
`/var/folders/tx/rf_fyjp13vqgywb46ydkh9_80000gn/T/harbor-onboarding-20260918-y6pr0dek/mongo-replica`.

`compose.yml`, `start.sh`, `bootstrap.js` and a public `tls-ca.pem` are there. Generated password, shared member key and TLS private keys are separate mode-0600 files; no values belong in logs or repository files. Three authenticated `mongod` processes share one container, use distinct tmpfs directories, and advertise `localhost:27117/27118/27119`; publish only `127.0.0.1` on those same ports. Verified TLS is required; the locally generated CA is trusted explicitly. Container name: `harbor-mongo-replica-20260918-replica-1`. Limits: 2 GiB memory, 2 CPUs, 1 GiB tmpfs, 0.25 GiB cache per member, no restart policy. This proves process-level elections, not independent-host/zone resilience. Test failpoints are enabled only on this disposable fixture.

Tests use `HARBOR_MONGO_RS_TEST_DIR` and read the private credential file directly. User: `harbor_rs_admin`, temporary root role only on this empty local fixture; tests use unique `harbor_rs_*`/`harbor_mongo_ui_*` databases and remove their databases afterward. The earlier standalone fixture on port 17017 remains separate.

Exact stop command (task-owned container only):

```sh
rtk proxy docker compose -f /var/folders/tx/rf_fyjp13vqgywb46ydkh9_80000gn/T/harbor-onboarding-20260918-y6pr0dek/mongo-replica/compose.yml down
```

Restart requires `up -d` with that same file, then wait for TLS listeners and rerun initialization because stopping loses tmpfs data:

```sh
rtk proxy docker exec harbor-mongo-replica-20260918-replica-1 mongosh --quiet --host localhost --port 27117 --tls --tlsCAFile /fixture/tls-ca.pem --file /fixture/bootstrap.js
```

Certificates expire after seven days and must be regenerated in the disposable external fixture before later reuse. No system trust store, global DNS, host file, global settings or external account was modified. ES/OpenSearch task containers were stopped separately to make room; their retained compose files can restart them, but their tmpfs data is disposable too.

## Verification evidence

Working directory for checks: `/Users/aligeek/Documents/harbor-db`; Node 24 task runner. Logs are in the sibling external `logs/` directory. Prefix shown here is the exact runner invocation; environment assignments are parsed by the runner, not printed credential values.

```sh
rtk proxy python3 /var/folders/tx/rf_fyjp13vqgywb46ydkh9_80000gn/T/harbor-onboarding-20260918-y6pr0dek/implement.py mongo-native-expanded HARBOR_INTEGRATION=1 HARBOR_MONGO_RS_TEST_DIR=/var/folders/tx/rf_fyjp13vqgywb46ydkh9_80000gn/T/harbor-onboarding-20260918-y6pr0dek/mongo-replica npm exec -- vitest run tests/mongo.test.ts tests/mongo-tools.test.ts tests/mongo-replica.integration.test.ts tests/mongo.integration.test.ts tests/mongo-lifecycle.integration.test.ts
```

**Passed, exit 0: 44/44**, 22.35 seconds, `implementation-mongo-native-expanded.log`: 29 existing BSON/standalone/FIX-04 tests, eight new helper cases, seven real replica/index cases. Proves TLS/authenticated three-member discovery, secondary preference and surviving seeds, invalid replica/authentication, actual primary stepdown/recovery, failpoint-rejected insert with no replay, index create/drop/compound/partial/hidden/TTL/unique rejection, readonly execution block, stale catalog and dropped/recreated collection UUID rejection. The SRV/TXT case emulates DNS only inside its test process and then connects the real native driver to the real TLS replica members; this is explicitly not a public DNS or Atlas acceptance test.

An additional real restricted-principal case passed (`implementation-mongo-index-permission.log`, exit 0): one selected test, seven deliberately deselected; a native database `read` role can inspect but receives server code 13 for index creation, and the denied index does not exist. The temporary principal is removed in `finally`. This adds one distinct passing case, not an eight-test full-suite pass.

Whole `npm run typecheck` passed (`implementation-mongo-final-type.log`, exit 0). Targeted owned-file ESLint passed on final source (`implementation-mongo-owned-final-lint.log`, exit 0). `npm run build` passed in 27.02 seconds (`implementation-mongo-advanced-desktop-build.log`).

Desktop command:

```sh
rtk proxy python3 /var/folders/tx/rf_fyjp13vqgywb46ydkh9_80000gn/T/harbor-onboarding-20260918-y6pr0dek/implement.py mongo-advanced-desktop-final2 HARBOR_MONGO_RS_TEST_DIR=/var/folders/tx/rf_fyjp13vqgywb46ydkh9_80000gn/T/harbor-onboarding-20260918-y6pr0dek/mongo-replica npm exec -- playwright test tests/mongo-tools.e2e.ts
```

**Passed, exit 0: one complete native Electron workflow**, 5.86 seconds, `implementation-mongo-advanced-desktop-final2.log`. Actual form entry creates a two-extra-seed SCRAM/verified-TLS profile; real topology displays one primary/two secondaries; pipeline stages reorder and disable, apply changes only the draft, Run returns actual aggregation data; index create requires exact confirmation and produces ordered native keys; a concurrently changed catalog rejects a reviewed drop, then a fresh review removes the actual index. Bootstrap excludes the password and query history stays empty. Normal light and compact 1024×700 dark topology views were exercised and screenshot-inspected; four `mongo-*.png` images are preserved in external logs. No renderer exception was observed.

Two prior test-only failures were investigated and corrected: ambiguous duplicate Close button labels and an incorrect command-palette search phrase. Neither was counted as a pass. The successful final run includes those exact interactions. The earlier `mongo-advanced-desktop-native2` log contains only a Playwright version probe and is not test evidence.

Temporary test applications and unique databases/principals were cleaned up. The capped replica fixture remains running for later integrated/package checks; no survival beyond this task session is promised. Final packaged/platform acceptance and a separately authorized Atlas/SRV target remain unverified.


## Worker C document file checkpoint (2026-09-18)

`ADV-01`/`ADV-02` now include native file selection, bounded canonical BSON Extended JSON JSONL export and reviewed insert-only import. File paths remain in the main process. The renderer receives a single-use ten-minute preview token bound to the exact connection generation, collection UUID/options and file inode/size/timestamps. Preview is limited to 20 documents / 32 KiB, source lines to 1 MB, active jobs to two, retained jobs to 100 and chosen document count to one million. Whole documents preserve nested structure and BSON types without column mapping; missing `_id` receives the native generated ID.

Export explicitly reruns the reviewed find or read-only aggregation using a fresh cursor, with one awaited disk write at a time. It reports a document cap separately from full completion. It is not a point-in-time database snapshot. Exclusive mode-0600 partial files, fsync and a no-overwrite final link protect existing destinations. A failed/cancelled output remains labelled partial; a successfully published export with redundant-link cleanup failure remains completed with a visible cleanup warning.

Import requires an ordinary existing uncapped collection, exact typed target and consent to individual commits. Each acknowledged insert remains committed. Late malformed documents, duplicate IDs, validator/permission failures or cancellation stop further dispatch. An ambiguous native acknowledgement is counted as uncertain and is never replayed. Cancellation waits for an already-dispatched write outcome. Collection identity is checked before start and every 50 documents; a drop/recreate concurrent with an individual insert is not atomically preventable through ordinary MongoDB insert commands and remains an explicitly bounded limitation. No transaction, rollback, resume or bulk-backup promise is made.

`parallel-worker-c-mongo-files-final-backend` passed **61/61**, seven files, exit 0, 22.73 seconds. Includes existing BSON, standalone lifecycle, real authenticated TLS replica and strict IPC regressions, plus six new real file scenarios: canonical precision/binary round-trip, no-overwrite/single-use safeguards, late malformed/duplicate partial progress, acknowledged-prefix cancellation, changed/recreated/read-only target rejection, encoding/line/query limits, and a real failpoint-induced lost write-concern acknowledgement. The latter proves the first document actually persisted while Harbor reports zero acknowledged/one uncertain and sends no second document. The failpoint is disabled and temporary data removed in finally.

Checks use `/Users/aligeek/Documents/harbor-db-parallel-20260918/run.py worker-c`, never the historical implement.py runner above. Actual working directory is the isolated worker-c copy; runner JSON's old cwd field is incorrect. `parallel-worker-c-lane-final-desktop` passed both Mongo and Oracle workflows (2/2 total), exit 0, 20.48 seconds; Mongo took 3.4 seconds. It exercises actual export consent, native file-dialog selection, canonical exact BSON preview, disabled import before exact review, independent server-verified round-trip, compact/light controls and absence of document payload in bootstrap. Native file dialogs are stubbed only to choose disposable test paths; application IPC and real filesystem/database operations execute normally. `parallel-worker-c-lane-final-build` typecheck/build passed, exit 0, 15.7 seconds; targeted final lint passed. Packaged and multi-platform acceptance remain separate.
