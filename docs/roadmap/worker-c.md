# Worker C — local engine continuation

Authorized 2026-09-18, isolated copy `/Users/aligeek/Documents/harbor-db-parallel-20260918/worker-c`; coordinator `01a0b3f4-151c-7333-9552-b3d82dd0ddeb`. No Git/publication operations. Baseline `/Users/aligeek/Documents/harbor-db-parallel-20260918/baseline.json`.

## Historical work log (superseded by checkpoints below)

- EXT06: native Valkey 9.1.2 standalone fixture independently verified. Fixed read-only scripting command selection: native version is separate from product-labelled status; Valkey uses EVAL_RO. Added restricted-account key-inspection regression. First run 20 passed/1 failed; corrected run 21/21 passed, exit0, `parallel-worker-c-valkey-native-fixed` (final version-field refinement awaits combined gate). Product-specific browser/topology/live-tool labels and disabled unverified topology choices implemented.
- Coordinator leased ConnectionDialog worker-copy-only Valkey choice/reset/label changes. Build `parallel-worker-c-valkey-build` exit0/20.48s. Native first run reached real form/test/connect but failed because Sidebar exclusion arrays omit Valkey; requested exact narrow Sidebar lease. Native slot currently leased to C. No accepted desktop result yet.
- Oracle fixture discovered running healthy at expected pinned image/loopback25421/2CPU/4GiB; bootstrap validated project/image/volume/endpoint and created dedicated HARBOR_VERIFY schema quota100MiB. Actual server23.26.1.0.0. Redundant bounded pull encountered registry timeout; existing image/container retained, no retry needed.
- DB08 first actual tests disproved source assumptions: combined NLS offset+region format rejected ORA01857 and Thin STRING fetching uses JavaScript Date, losing nanoseconds/timezone. Raw date/time results now fail closed; table and object catalog projections use server TO_CHAR with native type metadata; user SQL can use explicit projection. No query wrapping/replay. Real projected BC year, named region, native NUMBER/LOB/native transaction tests executing.
- Oracle real Unicode CLOB test exposed surrogate split via driver's Readable UTF-8 conversion. Implemented bounded public getData slices retained as strings before concatenation. Testing in progress. Import batch currently times out; remains unresolved. Native timeout actual~6s includes driver cancellation cleanup; test budget8s for1s execution timeout and cleanup.

## Evidence runner

All npm checks: `rtk proxy python3 /Users/aligeek/Documents/harbor-db-parallel-20260918/run.py worker-c LABEL [ENV=value ...] npm ...`. Logs under external task `logs/parallel-worker-c-LABEL.{log,json}`. Runner JSON incorrectly reports original cwd, but subprocess cwd and Vitest banner are worker-c; no tests run via implement.py.

Original Mongo/Redis evidence is historical baseline, not new passes: Mongo44 backend plus separate restricted-account and native advanced cases; Redis64 plus native topology. Atlas/public SRV, other platforms and packaged acceptance remain unverified. Shared ledgers are coordinator-owned.

## Valkey checkpoint ready

Native49/49 + Electron1/1 passed. Electron slot released. Formatting only after final native evidence. Owned-file ESLint subsequently passed (`valkey-lint`, exit 0). Root should integrate the eight owned files below and reconcile only authorized ConnectionDialog/Sidebar hunks. Oracle files are still in progress and excluded from this checkpoint.

| File | Baseline SHA256 | Candidate SHA256 |
| --- | --- | --- |
| src/main/engines/redis.ts | e75e65564186ddc2a3d221885c14ccac92cba91383a4036252840074f55ab130 | 96fa7971273e9df9e928b0b6adc8f82ccfc5d333c253bcd36923e78fb7aaaddc |
| src/renderer/src/components/RedisBrowser.tsx | bde11d5443232df23e43141e97d1c52de21848cd3befd043b6c5e6c38ebfb093 | 55189b74881dac7a4e00c8debe2b22149bf785c706363ad99f68d6e9f22f005a |
| src/renderer/src/components/RedisConnectionFields.tsx | b86ce03df1363096e37e97cb36a30f8bb7258a4219e5b4d963460cdee9ab05f6 | 370d6ed5ed1aa72be8905ed061675e3ddc970d1d08604ca6283e91a2f5ba1788 |
| src/renderer/src/components/RedisTopologyPanel.tsx | 4ba879ee20a4a396dcc6cf3704e9cb5044319d11565bd50b9c9a2dc946da4fba | 8ba0330cd0da1dbbf43d8ad46fb1266ab6a2b8a54cf439a005617be657fe612d |
| src/renderer/src/components/RedisLiveTools.tsx | 3796cde49d0777688d6ed440ad440b2d894aed0774aa87a1e756a046c0caab49 | a98c3f81b462b297b5c69371da200c6f517c53fae60a50f688aefffd97dbbe85 |
| tests/valkey.integration.test.ts | 6042e17fa2296a0932080c8959dbbdf0df0168fbabb3e0070e4d1068aff873ad | 764a3f5cd72f32a94720d217d00b819f590ce73ea0a9133b63ce1eb8ef4526d3 |
| tests/valkey-ui.e2e.ts | new | fc4ac3c9f4a579ed678cbd96b4a5aceae1133d08346748c34b04390d228f973d |
| docs/roadmap/driver-preflight-valkey.md | 0730eaf696c34d72543ccd963ebd5386cfd4f88c917b15d13f643b11b67e5f73 | e3b360fa1aaafbb493447632d22ced439c060554356ac9593d6c3c9e4570f977 |
| src/renderer/src/components/ConnectionDialog.tsx | 8f5929e0deb654894f755742205f92d53420c88a1116f19cbfc32981e951a216 | 3c5d0a89a138f5e023f3398b11981f7aad560019f0564b94a08c11b98ae5ec98 |
| src/renderer/src/components/Sidebar.tsx | 549d5cef0775fa44226507ac4f2c19b6231f476560d80a8a2a05597e1745f78c | 3aa013048298c0f293ca763a9ad1dbde434f8d9c9588148005d65cf8d4ce6267 |


## Oracle / Mongo / Redis checkpoint ready for integration

All code below is frozen for coordinator integration; no original-root edits, Git operations or publication. Electron slot released after final pass. Valkey checkpoint above was already integrated by coordinator.

- Oracle DB08 source and real fixture correction complete for implemented scope. Native backend **24/24**, `oracle-final-backend`, exit 0, 33.61s; memory benchmark **1/1**, `oracle-stream-memory`, exit 0, 2.94s; final built Electron Oracle workflow passed 16.2s. Raw DATE/TIMESTAMP fails closed; table browsing projects exact server text. Oracle native catalog/LOB/import fixes are documented in preflight. Hosted wallets, alternate versions, packages/platforms and grid edits remain outside verified scope.
- Mongo ADV01/02 canonical EJSON file export/import complete for described insert-only individual-commit scope. **61/61** seven-suite backend gate `mongo-files-final-backend`, exit 0, 22.73s; final built native workflow passed 3.4s. Real write-concern failpoint proves persisted-but-unacknowledged insert is uncertain and is never replayed. Partial import, cancellation and collection/file identity limitations are explicit in preflight.
- Redis UX12 follow-up: worker A's ten simultaneous scans exhausted the driver queue. Per-live admission now allows two scans; excess requests receive actionable wait/retry guidance before SCAN dispatch. No pending queue or automatic retry. Finally cleanup releases admission, and each metadata batch checks connection identity/readiness. Real 10-request case passes (2 admitted, 8 rejected; subsequent scan succeeds). Final Redis/Valkey regression **50/50**, eight suites, `redis-admission-final`, exit 0, 8.33s. COUNT remains a native hint, not a strict cardinality cap; socket response bytes remain bounded at 4 MiB.
- Final typecheck/build `lane-final-build` passed exit 0, 15.70s. Final targeted ESLint `lane-final-lint` passed exit 0, 0.98s (earlier full owned lint also passed). `lane-final-desktop` passed **2/2**, exit 0, 20.48s. Initial desktop failures were incorrect test selectors, retained in separate logs; not acceptance.

### Exact shared-file reconciliation

Do not replace coordinator-owned shared files wholesale. Reconcile only: contracts type-import `MongoFileAPI` and `HarborAPI extends MongoFileAPI`; preload five file API invokes; IPC import schemas/service type, five input schemas, optional final service argument, five native file/review/job handlers and cancelForConnection at save/delete/disconnect; main service import/construct/close/register argument. ConnectionDialog adds OracleConnectionFields import/render, Oracle radio option, empty Oracle username, FREEPDB1 service default, unsupported URL-import exclusion and service-name label/placeholder. Preserve root Trino and other concurrent changes. Earlier Valkey changes remain in this copy, already integrated; Sidebar requires no new hunks.

### Baseline and candidate hashes

| File | Baseline SHA256 | Candidate SHA256 |
| --- | --- | --- |
| src/main/engines/oracle.ts | 77595f71a8665f0bc1b0f80d50075b54f8179bb902d374703d93ce3035c3c1a4 | cb8e77137018b6a4ae7ae9930634f612edf26f3596cbe088e8665b6aaf4434e6 |
| src/main/engines/oracle-values.ts | 36b35b47de0a7e0da51bfb4a04901465e1b0f9510e30d0f82d0175bb0fe1374a | bce4e5ff78aadf3121a22ba1ddd29ab27da2e2a02f139a89ef11f85421d43710 |
| src/renderer/src/components/OracleConnectionFields.tsx | new | 50c78e4ceefa42556a63fb84feb58cc19ba2a074e68d0f1fc25fd6055c54247b |
| tests/oracle.integration.test.ts | ad65124ec74abb30e78fd51f1678c9696c5ba4265ad70a0e0bb4baba19b5cc82 | 2ee1a66aad40bdf9df5de3a2792b34a37091b0be774cf47a62a2625dfcd758a3 |
| tests/oracle-values.test.ts | dea11e62a65fd0e877a6e41ff546df08dd43fca74e25ffad1498f982b38c7ee5 | 58a4aecda6de0eeefe47720f7564aa9db4f02a800f31aa40c230b5e5e2eb0dc5 |
| tests/oracle-transport.integration.test.ts | 2c377d1a441488c836d824e4b7b462cc6a7acbfdcd23ca9e1e44c43d45abebbe | 131eaeacb7a9cfb4d7c898b0878e03178e83a588469540d27d6d0443b829cf70 |
| tests/oracle-ui.e2e.ts | new | bfe6710b664b240868b55c52edecdd83e4adafb292a7f09c232ea6f5b8e3caa1 |
| docs/roadmap/driver-preflight-oracle.md | bfee3351c63ff1db011158c53dfeb7367eb8b2d56a1024a8e0cd10fdaab883a4 | 9473130d981e277df2ba0f62d3a184c45cc5e65bd99dcb95f29be966979da485 |
| src/shared/mongo-files.ts | new | a9d1e74674986daf1563c0ef15cf226ed81655d62ffee921911cd55465278cd4 |
| src/main/persistence/mongo-files.ts | new | 2783e11e84ca718162bba27743c581265f29cf7dd66a376e50dc9d88c06556de |
| src/main/engines/mongo-file-session.ts | new | 39dd10ea7e48802dcafe3c70e1b13c62ade9a952019020184ab19737c4165b2d |
| src/main/engines/mongo.ts | c7ecb51594be85065f18913c57448befe5ebe066ba478eadad2fe9aad23c1901 | f01f34c5398a1d969f8f6e990f7760328d4b21726025c6e99173db603bd2ea9d |
| src/renderer/src/components/MongoFileTools.tsx | new | d674e3ab00996838fa902863a9d3619e2562a4e85de138a8053bba92e899ae53 |
| src/renderer/src/components/MongoBrowser.tsx | 2e0e0ce0eb5d127349a0675c6b3a403db71e4bf51c9e04e76feb5cfefccc544d | fb6578c133255f7203ba26417dbb7d62c25b753890c7f37c9b4111e31ba2d9eb |
| tests/mongo-files.integration.test.ts | new | df7fc65cffecf63ff50f1fcdd671f8a4f970cbdfedfecede02eff8991d5c3fa7 |
| tests/mongo-files.e2e.ts | new | b4e5922f1fa11db2919a565ede3868fb060386e8e57e338deeea3c3c17752333 |
| docs/roadmap/driver-preflight-mongodb-topology.md | 2b76df7297068d226ad3255eed05ff4691f2a9e38711038a898727a271b3ce48 | fefd50f57e7839160c782a050074f87bd7d99f7f98bf683421218c9d33141857 |
| src/main/engines/redis.ts | e75e65564186ddc2a3d221885c14ccac92cba91383a4036252840074f55ab130 | af17064d5da137a17ea66950b9077dbf6ad333819c1476a66a632c754c095e7a |
| tests/redis.integration.test.ts | 98c9049f295b8b8fff462ca0030afa52c2614ba15f8927f5ead3d0c066b1e13a | 77176f5d99140194de859a0de5110171541cec49e7d91633fcdc123c6915bb91 |
| src/shared/contracts.ts | c653ecbdb68f4174e9d92a05995ce75ca148c50cb71ea4b3cdd19327bcce7612 | 56e1da015c7a12d21c4ef26d8d6eba7e95f45f2cf1c0f9ed5e3853c6a832139c |
| src/main/ipc.ts | 6db8b7b2ab37f2a9ad08834015d34c10cfe379306ca504609f23745c07a35b9d | 429858d932083f44040f76c65c3f32e177fc35bc3e371b7fb6ef5749a856e2d0 |
| src/main/index.ts | bb18614fb40235755d228437e448727bcf0d359a777cc8fcdb03a82ce7bdd082 | 083cc73a8371ca2c004ac4e3db62d0bf77ab5946ce2bff9a7be8baad0bcf744f |
| src/preload/index.ts | 7991e6dd9c7cd81a5d18be0b94f1619a5fa03db6a5c2fdfdd6621a132eb4d733 | 6a3bb29bc0f22f5112bcae27ab367de3a101f7118941c28bbd1c6b4b9d0ab52b |
| src/renderer/src/components/ConnectionDialog.tsx | 8f5929e0deb654894f755742205f92d53420c88a1116f19cbfc32981e951a216 | 356dedfff40e1a45490c773733c88f9d197db803d5b49ed1eeea23ede2713329 |


## CouchDB DB20 checkpoint ready

Native 8/8; combined regressions 55/55; final build/lint pass; Electron 1/1 (`couch-desktop`, exit 0, 2.53s). Root and B notified of Electron release. CouchDB fixture stopping before sequential Neo4j lease. Exact feature limits and source links in driver-preflight-couchdb.md. No package/platform/cluster acceptance claim.

Frozen source snapshot: `work/checkpoints/couchdb/`, preserving relative paths. Eight owned/new files can copy directly. Eleven shared files require only CouchDB hunks; preserve coordinator additions. These are engine enum/API extension, couch workspace kind, capability definition, registry/main lifecycle/five IPC schemas and methods, closeSession routing, preload forwards, name/port map, form option/reset/disclosure, Sidebar nonrelational routing, App new-tab/render routing and the single QueryEditor language-map entry. No query editor execution behavior changed. No new dependency is needed for CouchDB. Neo4j dependency additions in the live copy are explicitly excluded from this checkpoint.

| File | Worker pre-CouchDB SHA256 | Candidate SHA256 |
| --- | --- | --- |
| compose.couchdb.yaml | new | ba1f5356ee0b6ae037e7e5e426faf7dcc05e758b2df65395fb9e380eb3485c48 |
| src/shared/couchdb.ts | new | 3f276b2d4e68fe17129a75e596cb9fe3049f349d62b98cce09603fc17a14a488 |
| src/main/engines/couchdb.ts | new | 298d8be909d9548998deb1bade24c756aa96732aa40c176455c9b04ecbd8b2c8 |
| src/main/engines/couchdb-http.ts | new | 0ded4accc21c5a080263bae82073ea22afd5ca7cfc032547e10be3d28184a0a0 |
| src/renderer/src/components/CouchdbBrowser.tsx | new | 021f7a2afc7afb94ac6e6272aa8e778d7cae8a9603b2fd4f66231371915c7243 |
| tests/couchdb.integration.test.ts | new | 3bcb26b947ac48884dd43423064106a9b6e830e77fb4d76004021db883e58a5e |
| tests/couchdb-ui.e2e.ts | new | b3ca00218288351652a09466af328a19ec6a54f820bfaca53d087fa9ee52e09b |
| docs/roadmap/driver-preflight-couchdb.md | new | 6405879c92a2bf5847e325a2af1deaf1ac6d0553935cdf8ba4f248d206d17dd0 |
| src/shared/contracts.ts | 56e1da015c7a12d21c4ef26d8d6eba7e95f45f2cf1c0f9ed5e3853c6a832139c | c8d3960ab3c9d302a179eb697b53ad5d39e81e2f95ed82cce049f25cdfcdca5f |
| src/shared/workspaces.ts | 9a3b154a9373852bcd14336284c7ee66482c62d6cc90697f7ecb4f8da727d0b2 | 003d9d9370edd1d34b3053ca1991fc007828529dcf54feb554bfbfde5aa8777a |
| src/shared/capabilities.ts | 5d1f337c90375cd785fab794aea5bff55a3409110029bbdefdc33fdfc372904f | b86944790c7a1717a2d5f4351fa702bec5cb50560c88ad17a2588fe0dff64d57 |
| src/main/index.ts | 083cc73a8371ca2c004ac4e3db62d0bf77ab5946ce2bff9a7be8baad0bcf744f | 10ab2b526bb929e6055f454418bcec5d5ebab5073edaf5feef10c8f1a81cb130 |
| src/main/ipc.ts | 429858d932083f44040f76c65c3f32e177fc35bc3e371b7fb6ef5749a856e2d0 | 03bc8f03e0580715484751f385f44f4a7aa1c84b937e6211ed5738c3483c06a0 |
| src/preload/index.ts | 6a3bb29bc0f22f5112bcae27ab367de3a101f7118941c28bbd1c6b4b9d0ab52b | 52ad315c98da00794d4911bb5ac41775854c08625d5479d1c2bbd4a857308e0c |
| src/renderer/src/lib/utils.ts | 25512bff009c1d142a3d39a429ab7f0a1734dcf2a0def631b742206f72d96aaf | 67ccc73616e98c84817027b1222f0fafd106d17f99f17e15eaafc429732cdba3 |
| src/renderer/src/components/ConnectionDialog.tsx | 356dedfff40e1a45490c773733c88f9d197db803d5b49ed1eeea23ede2713329 | 0fdd8ff60f38b6344c03fa3249bc6e1c209a929c8ec58bd06eec41777b09f146 |
| src/renderer/src/components/Sidebar.tsx | 549d5cef0775fa44226507ac4f2c19b6231f476560d80a8a2a05597e1745f78c | 6a3d94bd4801598831dd10a9190f29a20c2cc1911996a771629a8820370d34b4 |
| src/renderer/src/App.tsx | f2d5080b7b1779030e9febc5116565e124162f03ccbd57772d5092632fbeb935 | 363779eccdb08348b088cd3b3e8874c8e650a669784a94f9fee640efea4505be |
| src/renderer/src/components/QueryEditor.tsx | b9cf3b895c911a41d7562105e1f5ee35ebe7618665a9c0f227362a42939abc61 | 9766a8e3944e81f454f25b86de3016358bc4d07dcc18aa391aeaf398825ca3f5 |


## Neo4j DB15 checkpoint ready

Frozen source snapshot: `work/checkpoints/neo4j/`. Eight new/owned files may copy directly. Thirteen shared files require exact reconciliation, preserving root additions. Incremental shared patch against the frozen CouchDB snapshot is included as `shared-couchdb-to-neo4j.patch`; package files require the narrow `neo4j-driver: 6.2.0` dependency and its six-package lock addition, not wholesale replacement.

- Final backend **58/58** across six suites, including **11 actual native cases**, `neo4j-final-backend`, exit 0, 5.04 s runner. Real lost-COMMIT-ack case persisted exactly once and reported uncertainty; actual executing cancellation and oversized mutation rollback were verified.
- Final build `neo4j-cancel-ui-build` passed exit 0, 17.03 s; owned lint passed (six new TS files then final renderer/test changes). Full-copy lint's three inherited errors were reported to root and remain outside this checkpoint.
- Final expanded Electron **1/1**, `neo4j-cancel-desktop`, exit 0, 4.14 s runner / 2.9 s test. Includes form/version, exact integers, native paging, graph nodes and relationships, properties, prepared expansion, reviewed native write, active-query Cancel, cursor target lock and privacy. Slot released to B.
- Supported target and limitations are explicit in `driver-preflight-neo4j.md`: direct Bolt Neo4j 5.26.x, Basic auth, verified TLS, no query/mutation replay, max two cursors / 1,000 rows / 8 MiB serialized execution / 60-second deadline, graph 200 nodes / 400 edges. Decoded cell bound is not a wire-size guarantee. No Enterprise/Aura/cluster/platform/package acceptance claimed.

Shared reconciliation: Neo4j enum/API extension and graph capability; workspace kind; registry/main lifecycle/four IPC methods and close routing; preload forwards; engine name/port; form option and safe defaults; Sidebar graph routing; App tab/render; one QueryEditor language-map entry. Root owns shared ledgers; this record does not set global ticket acceptance.

| File | Worker pre-Neo4j SHA256 | Candidate SHA256 |
| --- | --- | --- |
| compose.neo4j.yaml | new | 44ec2b2a6bdba5a86d1129ee46b68372a4e8a880958050fa03763c7a0f270e31 |
| src/shared/neo4j.ts | new | 34e558eb9eda9577d971e51dee24aa59f7b6f523c2b73bac87273f5bc0bc5fcb |
| src/main/engines/neo4j.ts | new | b136b5ede76621eb16ed392505faa07fba72c8d1d15f8e78595ccd128c996c01 |
| src/main/engines/neo4j-values.ts | new | cae28d500ab6fc2aeb9da0470d5f8c159cf6c96bba6884fec2ebc6e1f20d8b57 |
| src/renderer/src/components/Neo4jBrowser.tsx | new | 94d0072e8158c164bcbdcf281aef0d1d163e657fe20d19945bdecbd9908c0e90 |
| tests/neo4j.integration.test.ts | new | fa6416e606b7de6824608d8584c7bff223555c1f2dc0a1383a470f54d4f44f83 |
| tests/neo4j-ui.e2e.ts | new | 5330021629710913f84afc5818638193e3dc8d233a86bae95aef93310f3a844e |
| docs/roadmap/driver-preflight-neo4j.md | new | 872b84797fc772505aec62e4fac4b35c2c77917b1ba63ad085422760244083b3 |
| src/shared/contracts.ts | c8d3960ab3c9d302a179eb697b53ad5d39e81e2f95ed82cce049f25cdfcdca5f | d472b1160944d14d211a90cec3b9bc7ce54db93a929eb4da15fda74d92f56a78 |
| src/shared/workspaces.ts | 003d9d9370edd1d34b3053ca1991fc007828529dcf54feb554bfbfde5aa8777a | 547fefb7cb9ff67cffa3fdde1d48cf3620bbfa455dd5698d217ff3215f89b487 |
| src/shared/capabilities.ts | b86944790c7a1717a2d5f4351fa702bec5cb50560c88ad17a2588fe0dff64d57 | 4080071888ea3f073349c09b728bb57ca1028c3a35f0255e6a7ebe8c534d2e0a |
| src/main/index.ts | 10ab2b526bb929e6055f454418bcec5d5ebab5073edaf5feef10c8f1a81cb130 | 8c494f2aae717d012705773c781fb2c6f6af2fbab5aaa8ec784186fbe9329d34 |
| src/main/ipc.ts | 03bc8f03e0580715484751f385f44f4a7aa1c84b937e6211ed5738c3483c06a0 | 96ef02e4f92d4916a14d3b118d6777fb83fb0e93c325eb41ee0e84212ae78b6c |
| src/preload/index.ts | 52ad315c98da00794d4911bb5ac41775854c08625d5479d1c2bbd4a857308e0c | 330051fc1e5eca41e203fc49dcf4a3dc2b308107d38bc5759961ab946045d1bd |
| src/renderer/src/lib/utils.ts | 67ccc73616e98c84817027b1222f0fafd106d17f99f17e15eaafc429732cdba3 | 56450fe2c0ac193d0e69535c41b526b40d2fcfc5a834ac87a728e6abf960078a |
| src/renderer/src/components/ConnectionDialog.tsx | 0fdd8ff60f38b6344c03fa3249bc6e1c209a929c8ec58bd06eec41777b09f146 | 5de912a9c155d846c75dbf389a676ed3295021c0443efa6337d5d8a5d396e159 |
| src/renderer/src/components/Sidebar.tsx | 6a3d94bd4801598831dd10a9190f29a20c2cc1911996a771629a8820370d34b4 | e5e669092a6f3438e1db77bfb8b06eee353cd6b796de180eeec6dd65686a347f |
| src/renderer/src/App.tsx | 363779eccdb08348b088cd3b3e8874c8e650a669784a94f9fee640efea4505be | baa835a817e4c87fd0fb83ead8d58fa8612f0d5ade0b7a3fba9177087064a88c |
| src/renderer/src/components/QueryEditor.tsx | 9766a8e3944e81f454f25b86de3016358bc4d07dcc18aa391aeaf398825ca3f5 | 5f8389f06d42a577eb757c2058f86a8bf9d44cc6e65a167123748dea045a7a5e |
| package.json | 919194558f86a2442c1d239be27ca8d9e21addd8c612f22b30cdcfa42b0abfac | 4d5a42b116e85c02c09bdc3e127096c62de305b9892037ead8b9f2ce110ffa5b |
| package-lock.json | a42ee66e568866f9bde695fb1762a944424a5262ac70825504c3bd570757dbd3 | 7e0a0402a5f980af95cdca7a0a83c923d388da808378586929ce009a7b42b9c1 |


## Cassandra DB17 in progress / next-engine boundaries

Cassandra native and desktop verification complete; checkpoint freeze in progress. Exact Apache driver4.9.0 installed without hooks. Native protocol4 frame-bounded bridge, exact typed CQL, guarded partition/conditional operations and dedicated UI are in the live worker copy only. `cql-native-build` passed16.71s; offline regression60/60 plus12 explicitly skipped native cases; complete test typecheck passed9.07s. See `driver-preflight-cassandra.md`. Actual pinned ARM Cassandra5.0.9 native13/13 plus7/7 safety passed (`cql-final-native`,12.21s); built Electron1/1 passed (`cql-desktop`,18.52s), screenshot inspected. Lost native write ack persisted once/no retry, active cancellation, TLS trust, restricted native role denial, conditional insert/update/delete/conflicts and exact typed values verified. Electron released and Cassandra stopped after evidence. Source unchanged after successful desktop/build; later additions are tests/docs only.

C retains DB17 Cassandra, DB18 ScyllaDB and DB19 Couchbase. DB20 CouchDB completed earlier; DB21/22 and DB23/24 now belong to B/root respectively. Scylla official6.2.3 ARM pin verified (6.2.5 tag absent); this older AGPL line is not described as current/latest. Cassandra protocol compatibility alone is not Scylla acceptance.

Couchbase official4.7.1 SDK Electron ARM package404; installation hook would fall back to unapproved native CMake compilation, so no install/hook. Root accepted guarded REST feasibility provided actual raw SELECT preserves exact lexemes and CAS string comparison protects whole original documents; unsafe numeric representations must remain explicitly read-only and be refused before dispatch. Native proof pending; see `driver-preflight-couchbase.md`.

## DynamoDB DB16 checkpoint ready

Frozen source snapshot: `work/checkpoints/dynamodb/`, 23 source files plus hashes/LANE. Ten owned files may copy directly. Eleven shared source files and package/lock need exact reconciliation against `work/checkpoints/neo4j/`; incremental patch included as `shared-neo4j-to-dynamodb.patch`. Preserve root Athena and other concurrent changes. Package additions are exact `@aws-sdk/client-dynamodb@3.1135.0` and `@smithy/node-http-handler@4.12.1`; root already has Smithy for Athena and should reconcile its own lock.

- Shared/native regression **56/56**, six suites, `dynamodb-regression`, exit 0, 2.55 s; final native **11/11**, `dynamodb-response-native`, exit 0, 1.10 s. Final additions prove four-request admission and native persisted writes with lost or oversized acknowledgments stay uncertain without replay. Exact types, conditional conflicts, paging/Scan consent/GSI consistency and raw 8 MiB bounds verified.
- Owned ESLint passed, latest failure/UI changes `dynamodb-response-lint`, exit 0, 0.94 s. Final source typecheck/build `dynamodb-label-build`, exit 0, 16.79 s.
- Built native Electron **1/1**, `dynamodb-final-desktop`, exit 0, 2.89 s, then one display-only on-demand-capacity label correction (build verified, desktop not repeated). Native read/write behavior, stale draft retention, privacy, light compact layout and regional context verified. Screenshot inspected. Electron slot released.
- Actual fixture is official ARM64 DynamoDB Local3.3.1, localhost18000, 512 MiB/1 CPU, stopped after verification. Local emulator does not prove AWS IAM, expiration, billing/throttling or hosted TLS. Source includes explicit regional/account guards, same Athena credential JSON shape through encrypted Secrets.password, no ambient provider, maxAttempts1 and bounded raw HTTP response. No cloud/platform/package acceptance claim.

Shared hunks add `dynamo` profile defaults/API extension/engine enum, workspace kind, document capability, service lifecycle and six IPC/preload methods, close routing, name/port, dedicated credential form and reset, engine-specific App/Sidebar tab + region labels, and only a QueryEditor language-map entry. Root owns global ledgers. Cassandra compose/transport drafts in live copy are excluded from this snapshot.

| File | Worker pre-DynamoDB SHA256 | Candidate SHA256 |
| --- | --- | --- |
| compose.dynamodb.yaml | new | 023f66989475c6344b3de6555868ec592dba62d31a70819c0a450ea5326fd723 |
| src/shared/dynamodb.ts | new | 763d0b0cd4e409e49ab38b7c1ffb0f4d7c58ec9191d31957b1713f52e3a4a198 |
| src/main/engines/dynamodb.ts | new | b9d7e602dfe4853472cf044c7d73d8152fbef12bd0c50680a7463cd68ab8e3e6 |
| src/main/engines/dynamodb-values.ts | new | e673e045de917f8bee90305f9baf36a9a7a474ab9e204f6680f3476cefc21aa6 |
| src/main/engines/dynamodb-http.ts | new | 98ad5c4c1112bebfb9a63e0d3e60dded02aaa6529b4b366d1ff807a49a902344 |
| src/renderer/src/components/DynamoBrowser.tsx | new | d4e7e45f3cc97c26a2adc7ea1f127cc1c9e259ee4264a6e140b349829e92b71a |
| src/renderer/src/components/DynamoConnectionFields.tsx | new | 3ba1ffdc0402b7dc0e8f521fa68eaf78062182d5c6f0ce4265eda61ff78f20eb |
| tests/dynamodb.integration.test.ts | new | 3581a2d0e9fe6c451a5118c696df0f850b36ec03b68ffd3bc125773c85a6b0a2 |
| tests/dynamodb-ui.e2e.ts | new | 6a776aded140ed82e9e6ed44c03c3038612dd507ed145404e9711bac0124feb9 |
| docs/roadmap/driver-preflight-dynamodb.md | new | 0a804ee68880c5ce9579fd40c3c7be2c458ce8c457e053176fc133f96a020bab |
| src/shared/contracts.ts | d472b1160944d14d211a90cec3b9bc7ce54db93a929eb4da15fda74d92f56a78 | 002beedccd1b834e182d8759bcd390462063dbe124f57f820ebb6fd92d90f99e |
| src/shared/workspaces.ts | 547fefb7cb9ff67cffa3fdde1d48cf3620bbfa455dd5698d217ff3215f89b487 | c3454e4e91339a4de4339b394204ae05776f6e35fbe0a057aadb810299f7b3ac |
| src/shared/capabilities.ts | 4080071888ea3f073349c09b728bb57ca1028c3a35f0255e6a7ebe8c534d2e0a | e1d034962ffec3f0e6349ec30400c9cd88cc18bc745c1a3f7c09554c5cfe7715 |
| src/main/index.ts | 8c494f2aae717d012705773c781fb2c6f6af2fbab5aaa8ec784186fbe9329d34 | afcca98aa2f7d7d91f7a19ba4bd4b87362f60aa93d3c2141a9f9f0d5313d1da6 |
| src/main/ipc.ts | 96ef02e4f92d4916a14d3b118d6777fb83fb0e93c325eb41ee0e84212ae78b6c | b936ef881d93272107a1c86453bda26b30580c50cd91d5e8aa23150f302f83ab |
| src/preload/index.ts | 330051fc1e5eca41e203fc49dcf4a3dc2b308107d38bc5759961ab946045d1bd | 156adc1bc6fb72816c2cc5c0c401f2030db21d2bf9316a81130d9e28dc346f7d |
| src/renderer/src/lib/utils.ts | 56450fe2c0ac193d0e69535c41b526b40d2fcfc5a834ac87a728e6abf960078a | 5a98d30ce1fcfd6254e8d9ba25099feeb88369379456a2dacb9b491fe326199d |
| src/renderer/src/components/ConnectionDialog.tsx | 5de912a9c155d846c75dbf389a676ed3295021c0443efa6337d5d8a5d396e159 | cade358a06aca39cba35a91cb0863ae21bf000f4f415fd3fa3cfe1a17eccee2b |
| src/renderer/src/components/Sidebar.tsx | e5e669092a6f3438e1db77bfb8b06eee353cd6b796de180eeec6dd65686a347f | 71cd139fb77c99a2a112e30dc4f2c436eb4c6be6b459af4bbdc977170d2ccecf |
| src/renderer/src/App.tsx | baa835a817e4c87fd0fb83ead8d58fa8612f0d5ade0b7a3fba9177087064a88c | 9d5b3dd3ac648b7b985186e4844772e11f839833086503a704fdddd5fc06f91d |
| src/renderer/src/components/QueryEditor.tsx | 5f8389f06d42a577eb757c2058f86a8bf9d44cc6e65a167123748dea045a7a5e | 2728a1f0062101c56a42c6614d67770ae7ec9b44130a15ce603a1336dc6aaef9 |
| package.json | 4d5a42b116e85c02c09bdc3e127096c62de305b9892037ead8b9f2ce110ffa5b | b26053ff92068e5f73ff8e85350c331d253d8161e67a86960f2539b572a0aad7 |
| package-lock.json | 7e0a0402a5f980af95cdca7a0a83c923d388da808378586929ce009a7b42b9c1 | fccd5f7c9867bea9f8110013772d4444db0d0ba531b5823baba6f0ff12ca23c1 |


## Cassandra DB17 checkpoint ready

Frozen `work/checkpoints/cassandra/`: 13 owned files,12 shared files and2 package files (27 source files total), hashes plus incremental `shared-dynamodb-to-cassandra.patch`. Final test typecheck passed8.03s (`cql-final-types`). Native13/13 plus7/7 safety passed12.21s; desktop1/1 passed18.52s; source build passed16.71s. Fixture stopped and Electron released.

Reconcile exact Cassandra hunks into root. Preserve root dynamic `Object.keys(engineNames)` picker and all concurrent engines. IPC execution identity already contains root dynamo: add only cql there. Portable metadata patch is intentionally cql-only (root already has dynamo); full portable file is reference only. Package addition exact cassandra-driver4.9.0, ignore-scripts; reconcile root lock independently. No Scylla/Couchbase draft included.
