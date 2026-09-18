# Harbor DB implementation roadmap

This is the working backlog for the universal database workbench direction authorized on 2026-09-18. It contains **78 tickets**: 5 FIX, 12 UX, 20 ADV, 31 DB, and 10 EXT. A ticket describes an outcome, not a claim that the outcome already exists.

The source brief is `Harbor-DB-Product-and-Implementation-Roadmap.md`, prepared on 2026-09-18. Every numbered ticket and its acceptance text are preserved in [BACKLOG.md](BACKLOG.md). Implementation surfaces, dependencies, verification plans, and the explicit EXT milestone assignment are working planning decisions added here; they are not historical facts or evidence of completed implementation.

## Authorization and scope

The current user instruction authorizes local implementation across the entire roadmap. It supersedes the source brief's M0-only instruction and the requirement to request new authorization between milestones. Continue through independent, feasible work while recording concrete blockers. Do not turn that authorization into a claim that all engines or operating systems can be verified on one machine.

This work does **not** authorize publishing, pushing, deployment, changes to production/shared databases, provisioning external accounts, spending money, or using missing credentials. The normal repository release-by-default instruction is overridden for this task. Keep source completion, local acceptance, platform acceptance, and release publication separate. Do not bump a version or advertise a release merely because planning records were added.

Optional AI, team features, and automation may be implemented locally within their tickets, but external data transmission, account provisioning, and enabling a schedule remain explicit user actions. Signing identities, licensed software, inaccessible cloud test accounts, and unavailable operating systems are evidence blockers, not permission to fake support.

## Documents

- [BACKLOG.md](BACKLOG.md): all 78 ticket checkboxes, original acceptance criteria, dependencies, source entry points, and verification requirements.
- [UX_FLOWS.md](UX_FLOWS.md): proposed everyday flows, small wireframes, keyboard behavior, and failure states to validate against the existing interface before implementation.
- [EVIDENCE.md](EVIDENCE.md): starting revision, source evidence, acceptance rules, check commands, fixture boundaries, support matrix fields, and progress record template.

## Milestones

| Milestone | Tickets | Count | Exit evidence |
| --- | --- | ---: | --- |
| M0 — Trustworthy baseline | FIX-01–05 | 5 | Reported failures reproduced or correctly reclassified; relevant regressions and available-platform checks recorded. |
| M1 — Daily-use foundation | UX-01–05, UX-08, UX-11; DB-01–02 | 9 | Connection → query → inspect → reviewed edit → save/reopen on real targets; clear target identity; existing engines retain behavior. |
| M2 — Data workbench | UX-06–07, UX-09–10, UX-12; ADV-01–03, ADV-06, ADV-13; DB-03–04 | 12 | Bounded large-data workflows, secret-free workspace transfer, embedded/native packaging checks, and SQL Server limitations recorded. |
| M3 — Advanced engineering | ADV-04–05, ADV-07–08, ADV-10–11, ADV-14, ADV-16; DB-05–08; EXT-01–05, EXT-07 | 18 | Reviewed schema, plan, diagnostic, and engine-specific workflows exercised on the advertised real targets. |
| M4 — Operational maturity | ADV-09, ADV-12, ADV-15, ADV-17; EXT-06, EXT-08–10 | 8 | Transfer and restore drills, migration and delivery gates, analytics checks, and separate compatible-target evidence. |
| M5 — Broad engine portfolio | DB-09–31 | 23 | Each independently useful engine slice earns explicit capability levels; unavailable fixtures/platforms remain visible. |
| M6 — Optional ecosystem | ADV-18–20 | 3 | Local optional features have explicit data, privacy, distribution, and execution contracts; external activation stays user-controlled. |
| **Total** | **FIX 5 + UX 12 + ADV 20 + DB 31 + EXT 10** | **78** | No milestone is accepted by documentation alone. |

The source brief leaves individual EXT placement open. This plan puts current-engine depth and Redis topology work in M3; Valkey, managed deployments, and other compatibility targets in M4. Adjust that assignment with recorded reasoning if fixture availability or actual demand changes. It does not remove tickets from scope.

## Execution order and dependency meaning

Start with M0 reproduction and reconciliation, then deliver complete useful slices. M1 needs a small capability contract before new adapters; this is the **G-CAPABILITY bootstrap gate**, part of ADV-16's eventual work, not a 79th ticket. Record supported/unsupported/permission-denied/topology-unavailable/disconnected outcomes without a wholesale adapter rewrite. ADV-16 later completes extraction and conformance coverage in M3. DB-01 and DB-02 do not wait for that entire M3 refactor.

Ticket dependencies describe contracts or behaviors to reuse. They do not require halting unrelated local implementation because one dependency's Windows, signing, or cloud acceptance is unavailable. Record which dependency slice is satisfied and which acceptance remains blocked. Never mark the dependent capability verified on an untested platform.

The main sequence is:

```text
M0 trust + reproduction
  → M1 target identity, parameters, accessibility + MySQL/SQLite
  → M2 grid, jobs, transfer files, DuckDB/SQL Server
  → M3 adapter conformance, schema/diagnostics, search/topology engines
  → M4 operations + compatibility deployments
  → M5 independent engine batches
  → M6 optional local-first ecosystem
```

No dates or universal-support promises are assigned. Dependencies can run in parallel when they have disjoint ownership and no shared contract change pending.

## Progress discipline

Every ticket starts at **needs-reconciliation**, with current capability **unverified** and roadmap acceptance **not accepted**. The label means the full ticket has not been reconciled and accepted; it does not mean every constituent feature is absent. Existing profile folders, favorites, editor actions, guarded edits, or history must be extended instead of recreated.

Use these independent fields:

| Field | Values | Meaning |
| --- | --- | --- |
| Current capability | existing / partial / absent / unverified | Source-grounded classification of the complete requested scope. |
| Work status | needs-reconciliation / ready / in-progress / implemented / blocked | Planning and source work only. |
| Acceptance | not-run / passed / failed / blocked / partial | Actual final-candidate checks with scope and evidence. |
| Delivery | local-only / committed / published | This task remains local-only unless the user changes its scope. |

Check a ticket's completion box only after its full acceptance scope has evidence. An implementation with an unavailable real engine, OS, or signing check remains implemented/partially accepted or blocked; narrower verified capability rows can still be recorded. A passing test against a mock is not an integration result. Do not sum overlapping unit/integration/E2E runs into a fictitious total.

Before editing a feature, reconcile its current implementation, inspect relevant existing tests, present the concrete flow for UX changes, and choose the smallest extension. After a logical change, run focused checks. At a milestone checkpoint, validate the final candidate once with the appropriate integrated checks; rerun only for new changes or a reasoned failure investigation.

## Requirements that remain outside these 78 tickets

H2, HSQLDB, Derby, Access, additional legacy engines, and generic JDBC/ODBC remain demand-driven candidates. They have no implementation ticket here. Kafka, RabbitMQ, Kubernetes, and S3 are separate product modules if requested; file formats belong to the scoped analytics/import/export experience. Adding a named driver package, profile form, browser fixture, or successful build does not establish database support.
