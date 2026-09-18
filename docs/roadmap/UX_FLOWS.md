# Proposed interaction flows

These are small planning wireframes in the existing dense desktop-workbench language. They are **not implemented screens or acceptance evidence**. Reconcile each flow with the current components before editing. Preserve compact controls, clear target labels, system/light/dark themes, keyboard access and the optional inspector. The baseline minimum window is 1024×700; validate that size and a normal 1440×900 view, plus supported zoom/font settings.

Use realistic disposable fixtures to measure task completion, unnecessary steps, keyboard/focus recovery, visible target identity and error recovery. Do not use a polished static screen as proof of an engine workflow.

## F1 — Find, connect and diagnose

Tickets: FIX-04, UX-01–03, UX-11.

```text
Harbor DB                 [Search connections and objects…] [Command palette]
Connections              Workbench
[Search…]                [Environment] Engine · server · database · schema
★ Favorites              State: disconnected · last checked 10:42:08
↻ Recent targets         [Connect] [Edit profile] [New query]
▸ Local
▸ Development            First use: Add a connection
▸ Production             No database is queried just by selecting a profile.
```

Flow: search → choose target → inspect identity → connect → browse lazily. Adding a connection uses engine-specific fields; URI parsing produces a redacted field preview. Test, save and save-and-connect remain distinct. Duplicating a profile keeps metadata but does not silently duplicate credentials.

Failure: preserve editable inputs and focus; show the supported classification (DNS/routing/SSH/TLS/auth/permission/database) without inventing precision. Keep test feedback visible at compact sizes. Network failure marks stale data and shows the last observation; reconnect is explicit where a transaction or write outcome is uncertain. Never suggest disabling certificate checks by default.

Keyboard: search is reachable through the shared shortcut map; Arrow keys navigate results, Enter selects, Escape returns focus without changing the active tab target. Screen readers receive status changes without repeated announcements on every poll.

## F2 — Open a saved or parameterized query safely

Tickets: FIX-02–03, UX-04–05, UX-10.

```text
Open “Recent orders”                       [Escape: cancel]
Saved dialect: PostgreSQL · database: sales
[Search compatible targets…]
( ) Local sales    PostgreSQL · 127.0.0.1 · sales · public · local
( ) Stage sales    PostgreSQL · stage-host · sales · public · staging
 —  Redis cache    Unavailable: incompatible query model
                                   [Cancel] [Open editor]

Query tab: Recent orders · Local sales / sales / public · read-only
[Run statement ⌘Enter] [Run script] [Parameters] [Save]
Parameter        Type       Value          Persist value?
customer_id      int64      [42]           [ ]
from_time        timestamp  [date/time]    [ ]
token            secret     [••••••]       excluded from default history
```

Flow: choose saved query → resolve a compatible target when binding is missing/deleted/ambiguous → open without execution → review parameters → run. An existing valid binding remains explicit; selecting another sidebar item does not retarget it. Bind values with native driver parameters. Identifier insertion is a separate validated action, never parameter text substitution.

Empty/error: zero compatible profiles shows an explanation and an add-connection action; cancel leaves the workspace unchanged. Validation errors point to fields without logging secret values. Changing a target invalidates catalog suggestions and stale responses. Keyboard execution asserts the editor has the intended text before tests run it.

## F3 — Inspect a row and follow a real relationship

Tickets: UX-06–07, ADV-03, ADV-05, EXT-01.

```text
Local sales / sales / public / orders      [Filter on server] [Columns]
Breadcrumb: orders #42 → customer #7       [Back to previous result]
┌ id ─┬ customer_id ─┬ total ─┬ created_at ─┐  Value inspector
│ 42  │ 7 ↗         │ 12.30  │ …          │  Exact type + full bounded value
└─────┴─────────────┴───────┴─────────────┘
200 loaded rows · sort/filter scope: server · page 1
```

Flow: inspect catalog foreign-key metadata → select referenced key → review destination → open a context-bound result with breadcrumbs. Composite foreign keys use all columns; NULL or missing referenced rows have useful empty states. A same-name column is not proof of a relationship. Cross-schema targeting and permission-denied targets are explicit.

Grid controls distinguish sorting/filtering loaded rows from server work, retain duplicate-column identity by position, and preserve selection when sorting. Keyboard users can open relationships and return to their original row/focus. JSON, multiline, binary, NULL and empty values are distinguishable. ER diagrams begin with the selected neighborhood rather than loading every table at once.

## F4 — Stage, review and commit changes

Tickets: UX-08, ADV-02, ADV-04, ADV-11.

```text
Target: Local sales / sales / public / orders     Transaction: OPEN · tab A
Pending changes: 2 updates · 1 insert · 0 deletes
Row/key     Field       Original      Proposed       Validation
42          status      pending       shipped        valid
43          total       10.00         invalid text   decimal required
                        [Discard staged] [Review changes]

Review exact target + changes + engine transaction/DDL implications
                        [Back] [Apply reviewed changes]
```

Flow: edit → stage → inspect tray → validate → review → apply → report outcome. Pending changes stay visible across relevant navigation. Closing/switching/removing a target protects draft work and active transactions. Validation and conflict errors keep useful user input. Review/application and commit are separate when the database has an open explicit transaction.

Failure: read-only or insufficient privileges explain the disabled action. A conflicting original row is never silently overwritten. Partial imports identify committed and rolled-back batches; uncertain network writes remain uncertain and are not retried. Schema changes display engine-specific atomicity and lock implications. There is no generic undo promise after commit.

## F5 — Export/import as an observable job

Tickets: ADV-01–02, UX-12, ADV-09.

```text
Export scope       ( ) Loaded rows: 200   ( ) Full read result
Format             CSV / JSONL
Representation     [ ] Spreadsheet-safe CSV (changes formula-like text)
Consistency        Engine-specific snapshot statement
Destination        Selected local file
                   [Cancel] [Start export]

Job: Export orders · exact target · running
Rows written: 182,400 · bytes: 64 MiB · elapsed: 12s    [Cancel job]
Output: temporary/incomplete until finalized
```

Flow: choose explicit scope → choose format/representation and destination → inspect consistency/limits → start → see bounded progress → cancel or finish. Exporting a full result must never rerun a mutating statement. Do not show a percent when the total is unknown; count/byte progress is sufficient.

Imports preview encoding, mapping, NULL/type rules and error policy before reviewed writes. The UI differentiates validation preview from actual database acceptance and committed batches from pending work. A disk-full/disconnect/cancel result retains a clearly marked partial artifact or removes it according to the displayed policy. Retry cannot silently duplicate committed work.

## F6 — Reopen the workspace on another laptop

Tickets: ADV-13, UX-09–10, ADV-17.

```text
Export workspace
[x] Profiles (metadata only) [x] Saved queries [x] Draft tabs [x] Tags/settings
Excluded: passwords, OS credential ciphertext, session results/transactions
Review potentially sensitive query text before saving.

Import preview: 4 profiles · 12 queries · 3 drafts
Conflict: Local sales  → [Keep both / keep existing / explicit replacement]
TLS/SSH file paths: must be rebound on this machine
                                     [Cancel] [Import reviewed items]
```

Flow: explicit secret-free export → schema/version validation → preview conflicts and unsupported fields → import transactionally → rebind paths/credentials → reopen disconnected → user chooses execution. Existing IDs are not silently overwritten and malformed imports leave existing work intact. Named workspaces and tabs preserve context; active transactions, staged server operations and live results are never replayed.

Keyboard/failure: preview is navigable; validation errors identify the entry; cancel restores focus and changes nothing. Test a baseline-format migration, duplicate IDs, invalid paths, missing profiles and interrupted persistence using disposable metadata.

## F7 — Specialized engines and optional modules

Tickets: DB-05–31, EXT-03–10, ADV-14–20.

Use the same target/status/job frame but model-specific editors: SQL; Mongo Extended JSON/pipelines; Redis key/stream/topology views; search DSL/mappings; Cypher with bounded graph view; partition-aware CQL; vectors with dimension/distance/payload context; time-series range-first queries. Supported operations and disabled reasons come from capabilities, not a misleading universal CRUD toolbar.

Cloud targets show account/project/region/warehouse and relevant cost/capacity context before execution. Opening a profile must not provision compute or scan all records. Subscription views have explicit start/stop and retention limits. AI previews the exact outbound schema/query/data scope and never executes suggestions automatically. Automation setup stays visibly disabled until the user explicitly enables a job; unavailable desktop runtime is a visible constraint, not an implied cloud scheduler.

## Flow acceptance checklist

- [ ] Reconcile each flow with the existing feature before adding controls.
- [ ] Identify exact target and safeguard state before any consequential action.
- [ ] Verify primary task by pointer and keyboard with meaningful focus return.
- [ ] Exercise empty, loading, unavailable, permission-denied, validation, timeout, cancel and successful states where relevant.
- [ ] Assert no automatic query execution during opening, import, restore or navigation.
- [ ] Review normal/compact sizes, zoom/font changes and light/dark/system themes.
- [ ] Verify screen-reader status labels and absence of color-only safety cues.
- [ ] Measure steps, first useful result and responsiveness with realistic fixtures.
- [ ] Record actual real-engine/Electron evidence separately from prototypes or screenshots.

## ADV09 — reviewed database transfer (initial matrix)

Entry: query editor → Transfer to database. Reuse current selected read-only statement and typed parameters; no query or write starts when the dialog opens. Initially support PostgreSQL, SQLite and DuckDB in explicitly documented source/destination combinations, independent of other engines’ query support. Choose a different connected writable destination, its namespace and base table. Load destination catalog only on request.

Preview is an explicit fresh source read (at most20rows/256KiB, clipped display fields) and target structure read. Show both connection/database identities and source consistency. Position-based source mapping preserves duplicate output labels; users choose unique target columns and conversion types. Display destination defaults, generated/identity rules, primary-key conflicts, independent commits, triggers, precision/timezone concerns and row/batch limits. Defaults limit execution to10,000rows and100rows per batch; no implicit full-database transfer.

Start requires consent to rerun the source, independent batch commits and exact typed destination. Main consumes an expiring preview token and rechecks both profiles/schema before execution. Progress distinguishes rows read, acknowledged commits, rollback, buffered/unwritten rows, uncertain outcomes and intentional row-limit truncation. Cancel is explicit, awaits driver cleanup and never promises undo of earlier commits. No skip, retry, automatic schema creation, identity override or synchronization. No source values/parameter secrets in persistent job logs.
