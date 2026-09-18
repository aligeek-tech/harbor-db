# Redis topology and live-tools verification

Local implementation checkpoint, 2026-09-18. EXT04/05 and Redis portions of ADV14. This does not certify managed providers or untested versions.

## Implementation

- Existing locked `redis@6.2.1` driver, no new dependency. `redis-topology-client.ts` uses explicit primary routing, bounded MOVED/ASK handling, disabled offline queues/socket replay, separate Sentinel authentication, and per-node TLS identity validation. Cluster multi-key operations require one hash slot; no fan-out write substitution. Standalone profiles remain the default.
- Cluster/Sentinel mode, seeds, service name and explicit address mappings are persisted without secrets. Sentinel password uses the existing protected credential store; metadata schema4 adds a credential-presence flag with a recoverable migration backup. Export/handoff excludes credentials.
- The key browser walks primary nodes explicitly, with bounded opaque main-owned cursors, node progress, expiry, single consumption and known-topology-change rejection. SCAN is not a snapshot. Whole-cluster flush and raw topology SCAN are unavailable; one-host SSH tunnels do not cover discovered endpoints and are rejected.
- Manual topology inspection does not sample values. Reads use primaries. Driver-discovered replicas are shown without treating their existence as a consistency guarantee. Failed mutations are never retried by Harbor. Manual reconnect is needed after a terminal timeout/socket failure; Sentinel may discover a newly promoted primary before a later explicit operation is dispatched.
- Stream group/consumer inspection is read-only and bounded. Pub/sub capture is explicitly started for one channel; it never publishes. A separate RESP2 decoder rejects payload length headers over64KiB before reading the full payload, caps wire buffering128KiB and capture500messages/2MiB/60seconds. Disconnect/close stops the capture. No replay or resubscription; data stays in memory. Closing the view stops the associated capture.

## Real fixtures and evidence

Pinned ARM64 server image: `redis@sha256:becdda6c7f4b3fb42e42fd7f120bbf5c54c4caaaf16f26da24e4563d2c1f0576`, Redis8.10.1. Six-process Cluster and two-data/three-Sentinel topology run in separate disposable containers. This exercises independent Redis processes, not independent physical hosts or network fault domains.

Task directory: `/var/folders/tx/rf_fyjp13vqgywb46ydkh9_80000gn/T/harbor-onboarding-20260918-y6pr0dek/redis-topology`. Configs/start scripts and private credential JSON live there; never copy the credentials into documentation. Each process uses separate tmpfs data, no persistence or restart policy.

| Container | Loopback ports | Bound |
| --- | --- | --- |
| `harbor-roadmap-redis-cluster-y6pr0dek` |26371–26376 |512MiB,1CPU,192MiB tmpfs |
| `harbor-roadmap-redis-sentinel-y6pr0dek` |26381–26382 data;26391–26393 Sentinel |256MiB,1CPU,192MiB tmpfs |

Real verification includes all16384slots/all-primary scan, exact binary values, shared-tag scripts, cross-slot rejection, expired/mismatched/consumed scan tokens, distinct Sentinel credentials, logical DB3, real Sentinel promotion, Cluster replica promotion/MOVED, TLS discovery/data address mapping, wrong certificate identity rejection, and a lost acknowledgement with the persisted increment remaining exactly1. Pub/sub tests capture binary messages, reject100KiB payloads, and expire captures; stream groups are inspected without acknowledgement.

`implementation-redis-all-check` ran from the actual repository using Node24.19.0:

```text
HARBOR_INTEGRATION=1 HARBOR_REDIS_TOPOLOGY_ENV_FILE=<private fixture JSON> npx vitest run tests/redis-topology.test.ts tests/redis-live-tools.test.ts tests/redis-topology.integration.test.ts tests/redis-topology-transport.integration.test.ts tests/redis.integration.test.ts tests/persistence.test.ts tests/ipc.test.ts tests/portable-workspace.test.ts
```

64/64 passed,8files,exit0,8.22s. Earlier failures are preserved in the progress ledger: stale role display corrected; migration-test backup version and binary comparison corrected. `implementation-redis-static-lint` passed the focused15file ESLint gate. Native `implementation-m3-topology-admin-native` passed Redis form/DB0 guard/all-node scan/topology view/explicit capture and private metadata assertions, along with three other M3 desktop workflows (4/4,exit0,17.17s). No browser trace contains fixture credentials. Later small scan/capture bound refinements still need the next consolidated candidate check.

Stop only these fixtures:

```text
docker stop harbor-roadmap-redis-cluster-y6pr0dek harbor-roadmap-redis-sentinel-y6pr0dek
```

They are running at this checkpoint. Stopping clears tmpfs topology state; starting the Cluster again requires reinitializing its slots and replicas. Use the retained external start/config files and seed the six empty nodes again with `redis-cli --cluster create ... --cluster-replicas 1 --cluster-yes`, supplying its private password through the command environment. Do not reuse another server or production credentials.

## Limits

Real server versions other than Redis8.10.1, managed cloud topology/auth variants, native Windows/Linux desktop behavior, and signed packaging are not verified here. Redis6 uses EVAL for bounded reads and therefore needs corresponding ACL permission; Redis7+ uses EVAL_RO. Source implementation does not establish compatibility with Valkey (separate EXT06 ticket).

Primary references checked alongside installed6.2.1 implementation: [node-redis Cluster](https://github.com/redis/node-redis/blob/master/docs/clustering.md), [node-redis Sentinel](https://github.com/redis/node-redis/blob/master/docs/sentinel.md), [Redis Pub/Sub semantics](https://redis.io/docs/latest/develop/pubsub/). Runtime contracts above are grounded in the actual pinned driver and tests, not the moving master documentation alone.
