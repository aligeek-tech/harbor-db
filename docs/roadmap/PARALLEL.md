# Parallel implementation coordination

User approved resuming the complete roadmap and creating three worker chats on 2026-09-18. Previous pause is revoked. All work remains local; no commit, push, publication, deployment, paid resources or production credentials.

## Isolation

Common snapshot: `/Users/aligeek/Documents/harbor-db-parallel-20260918/baseline.json`; copies worker-a, worker-b and worker-c include all tracked and nonignored untracked working files and private copy-on-write dependencies. The actual checkout is coordinator-owned. Worker patches are changes relative to this snapshot, not Git HEAD. Never replace the actual checkout with an entire worker copy.

## Shared ownership

Coordinator owns src/shared/contracts.ts, capabilities.ts, adapter.ts registry boundaries, src/main/index.ts, ipc.ts, preload/index.ts, persistence/store.ts and credentials.ts, renderer/App.tsx and top-level wiring, package manifests/lockfile, build configuration, root support matrix and full-ticket ledger. Workers may propose exact hunks/API signatures; they must not apply shared mutations without a narrow explicit lease. New feature-specific shared modules are owned by their feature worker.

Worker A owns existing core renderer UX and its tests, then new reports/charts. Worker B owns import/export/database-transfer/native-backup feature modules/UI/tests. Worker C owns MongoDB/Redis/Valkey/Oracle engine-specific adapters, forms/tools/tests/preflight docs. Other file leases are assigned by coordinator in messages. Each worker uses its own docs/roadmap/worker-{a,b,c}.md for durable progress.

## Communication and acceptance

Every worker receives this coordinator thread ID and sibling IDs when creation completes. Send contract-ready, blocker, checkpoint-ready and lease requests explicitly through thread messaging; do not assume shared conversation memory. Include changed files, baseline hash, exact verification commands/results and unresolved limitations. Coordinator integrates changes after comparing hashes against the baseline/current target. If the target changed, reconcile individual hunks without overwriting newer work.

Each worker builds/tests in its own copy and uses isolated metadata/resources. Native desktop/packaging and large fixture startup require a coordinator scheduling lease. No repeated tests on unchanged code without a reason. Mock checks do not prove real compatibility. Only coordinator closes full-ticket acceptance in BACKLOG.md. Existing accepted features remain preserved.

## Initial queue

A: core UX acceptance then ADV15 analytics. B: ADV01/02/09/12, including interrupted transfer UI and real restore drill. C: FIX04/EXT03–06/ADV14 Mongo/Redis slice then DB08 Oracle. Coordinator: shared integration and independent broad-engine contracts/implementation. Continue the approved package queue from the conversation as workers finish, without milestone approval requests.

## Active thread roster

- Coordinator: `01a0b3f4-151c-7333-9552-b3d82dd0ddeb`.
- Worker A, GPT-5.6 Sol/high: `01a0b488-ec1d-7133-a36c-fa31f11b8ef7`.
- Worker B, GPT-6 Astra/xhigh: `01a0b488-edcb-7162-8f8b-2d43f5e96764`.
- Worker C, GPT-6 Astra/high: `01a0b488-f00f-7d90-b2bb-44986b0bcc55`.

All threads on local host. Coordinator currently owns independent DB12 Trino implementation/preflight in addition to shared integration. Native desktop slot initially free; workers request it before launch.

## Continued queues and active leases

A owns the native Electron slot for core UX/reports, then B transfer/backup, then C Oracle, then coordinator Trino. Only one native desktop batch at a time. Private builds may run concurrently.

Next queues authorized in coordinator messages: A ADV17–20 desktop/optional ecosystem then DB25–28 vector engines; B EXT08–10 managed/compatible deployments plus DB11 Redshift; C DB15–24 nonrelational/graph/time-series engines after Oracle/Mongo file workflow. Coordinator DB09/10/12/13/14 and DB29–31 plus shared integration. This is work allocation, not claims of implementation. Each queue requires exact roadmap acceptance, preflight, native or explicitly blocked evidence.

A leased narrow App/QueryEditor/Library report wiring; root adds strict report persistence/API and reportId draft schema. B leased narrow QueryEditor transfer import/render and SqlService.openImport column fingerprint/locked batch check; full sql.ts must not overwrite root. C Valkey approved hunks integrated; Oracle form/component lease next. C leased only proposed six native Mongo file methods in contracts/IPC/preload/main/lifecycle wiring, feature-owned modules elsewhere. Shared coordinator changes (Trino/report wiring) must be preserved on integration.
