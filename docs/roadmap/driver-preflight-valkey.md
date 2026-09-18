# Valkey support and verification boundary

Valkey has a distinct engine identity. Sharing Redis wire-protocol code does not establish product compatibility or a support claim.

## Driver, server and license preflight

- Reuses the repository's locked `redis@6.2.1` client, MIT licensed, Node >=20. No new runtime dependency or native addon is introduced. Existing native socket, bounded command, binary mapping, no-offline-queue and no-write-replay behavior is preserved.
- Official fixture `valkey/valkey:9.1.2-alpine`, index digest `sha256:a0dbf4c1d5708782907c10e2c72deff317518518b5288a58416981d9db95d30b`; native ARM64 child `sha256:78bd56f346134139888386aee0509d949bfa4fbcdf15da4b2abdfda5c8bcd308`. The official image compiles TLS support. No x86 emulation is needed.
- Server and official container project use BSD-3-Clause. The license permits local use without a click-through acceptance step. No commercial hosted service or external account is involved. [Valkey license](https://github.com/valkey-io/valkey/blob/9.1.2/COPYING), [official TLS image build](https://github.com/valkey-io/valkey-container/blob/mainline/9.1/alpine/Dockerfile).
- INFO must expose `server_name:valkey` and a valid `valkey_version`. `redis_version` is only the compatibility version and is never displayed as the native Valkey version. Native `server_mode` is preferred, with the older `redis_mode` field accepted. A Redis profile rejects an explicitly identified Valkey endpoint, and a Valkey profile rejects a Redis endpoint or missing identity evidence. [Official INFO documentation](https://valkey.io/commands/info/).

## Isolated fixture and tests

`compose.valkey.yaml` uses a unique project `harbor-roadmap-valkey-y6pr0dek`; only loopback 16479 (TCP) and 16480 (native TLS) are published. The container has a 192 MiB memory limit and a 64 MiB database limit with no eviction. Data lives in tmpfs; RDB/AOF persistence is disabled. Server configuration, random disposable ACL passwords, and self-signed TLS material are in a separate private external directory. Credentials are not committed, logged, or passed on command lines. The container runs as the owner UID of that directory, not as host root.

The fixture defines a full development account and a separate read-only ACL account. Tests use a random key prefix in logical database 13 and delete only that prefix. They do not flush a database or access user data.

Prepared native coverage: distinct product/version detection, wrong-target rejection, incremental SCAN, binary cells, exact integer replies, expected-value mutation conflicts and TTL preservation, hashes/lists/sets/sorted sets/streams, application and server ACL enforcement, native TLS verification, authentication failure, command gates, stream consumer groups and bounded explicit Pub/Sub capture.

Source checkpoint: four identity/confirmation tests plus nine existing Redis unit tests passed; whole-project TypeScript check passed. **Native standalone verification passed on 2026-09-18:** `parallel-worker-c-key-value-final`, exit0,49/49 across eight Valkey/Redis suites (14.02s). Includes eight independent Valkey native scenarios; Redis topology cases do not count as Valkey topology evidence. The initial Valkey run exposed EVAL versus EVAL_RO selection from a product-labelled display version. The fix stores native version separately and requires Valkey read scripts to use EVAL_RO; real restricted-ACL console and inspector reads pass.

`parallel-worker-c-valkey-sidebar-build` passed typecheck/build, exit0,36.15s. `parallel-worker-c-valkey-desktop-fixed` passed one actual native macOS Electron workflow, exit0,4.63s: form/test/connect with actual Valkey version, standalone-only selector, real key scanning, mutation/TTL, concurrent conflict retaining draft, topology, explicit capture, compact light view, private bootstrap, restart retaining Valkey identity. The first desktop run discovered omitted Sidebar engine guards; corrected product wiring was tested rather than bypassed. Passwords were entered only into the real form with tracing/screenshots disabled, never embedded in artifacts. Temporary app metadata and fixture keys were removed.

Exact runner prefix: `rtk proxy python3 /Users/aligeek/Documents/harbor-db-parallel-20260918/run.py worker-c`. Backend arguments: `key-value-final HARBOR_INTEGRATION=1 HARBOR_VALKEY=1 HARBOR_VALKEY_FIXTURE_DIR=<external valkey-fixture> HARBOR_REDIS_TOPOLOGY_ENV_FILE=<external topology credential-file path> npm test -- tests/valkey.integration.test.ts tests/valkey.test.ts tests/redis.test.ts tests/redis-topology.test.ts tests/redis-live-tools.test.ts tests/redis-topology.integration.test.ts tests/redis-topology-transport.integration.test.ts tests/redis.integration.test.ts`. Desktop: `valkey-desktop-fixed HARBOR_VALKEY_FIXTURE_DIR=<external valkey-fixture> npm exec -- playwright test tests/valkey-ui.e2e.ts`. Final source formatting has no behavioral changes; focused lint follows. Packaged/multi-platform support remains unverified.

## Scope limits

- The same allowlisted key/command workflows are used, not an unrestricted shell. Server administration, arbitrary Lua/function execution, blocking commands, unbounded KEYS, and unrestricted subscriptions remain rejected by the command console. The dedicated Pub/Sub capture is explicit, time-limited and bounded in messages/bytes.
- Read-only application safeguards supplement server ACLs. Native server ACL verification is independent of a client checkbox.
- This fixture establishes standalone behavior only when its tests pass. Valkey Cluster, Sentinel, failover, managed-service authentication, modules and packaging on all installer platforms require their own verification; Redis-only results do not count as Valkey evidence.
- No compatibility claim is made for every Valkey version, module, Redis extension, or cloud service.
