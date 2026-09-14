# Validation record

Validation date: 2026-09-14. These results describe the local host and generated fixtures below. They do not establish behavior on other operating systems, server versions or network conditions.

## Host and fixtures

- Linux x86-64, kernel 7.0.0-31-generic; Node.js 24.12.0 for development commands.
- Actual application runtime: Electron 44.3.0, Node.js 24.20.0, Chromium 152.0.7977.78 and bundled SQLite 3.53.4.
- Real Docker services: PostgreSQL 17, MariaDB 11.4 and standalone Redis 8, using loopback-only ports and the development credentials in Compose.
- Seeded datasets: 100,000 order rows and 12 customers per SQL engine, plus 100,000 Redis benchmark keys and examples of each supported value type.
- Electron tests use isolated application-data directories and generated fixture schemas, databases and keys. No user production database was accessed.

## Automated checks

| Check                                                | Result                                        |
| ---------------------------------------------------- | --------------------------------------------- |
| Strict TypeScript, ESLint and Prettier               | Passed                                        |
| Unit and real-engine integration suite               | 132 passed; one opt-in benchmark skipped      |
| Dependency audit, including development dependencies | 0 reported vulnerabilities at validation time |
| Electron desktop acceptance                          | 2 passed                                      |
| Electron SQL UI acceptance                           | 3 passed                                      |
| Electron Redis UI acceptance                         | 1 passed                                      |
| Electron MariaDB server explorer                     | 1 passed                                      |
| Electron table SQL and multi-row deletion            | 2 passed                                      |
| Electron explicit PostgreSQL database chooser        | 1 passed                                      |
| Electron PostgreSQL server explorer                  | 1 passed                                      |
| Electron saved-query persistence and theme contrast  | 1 passed                                      |
| Packaged Linux acceptance and OS-keyring restart     | Passed                                        |

A clean `npm ci`, including Electron's binary installation, passed in an empty temporary directory. Production compilation and Linux unpacked packaging passed. The packaged application reported `app.isPackaged`, loaded local `file:`/ASAR assets, used bundled SQLite and all three real database drivers, preserved exact decimal results and editor drafts, and produced no renderer page errors.

Integration tests use real servers. Credential, migration and selected failure cases use controlled boundaries. Five PostgreSQL startup-fallback cases inject only the initial connection error, then use real connections for successful fallbacks. The export E2E substitutes a temporary path for the native save-dialog response; IPC validation, the serialization worker and the disk write remain real.

### Database and editing coverage

Desktop acceptance covers profile creation, full-process restart and draft restoration, file export, all three engine bridges, numeric precision, transaction isolation, cancellation, Redis TTL and the command palette. SQL UI acceptance covers PostgreSQL and MariaDB table edits and discard, pending work across navigation, binary fidelity, exact count, read-only controls, CSV mapping and rollback, and connection-bound query tabs. Redis acceptance covers incremental discovery, draft preservation, string and hash edits, TTL preservation, concurrent-change conflicts and read-only rejection.

The MariaDB explorer regression uses a profile with no default database. Backend tests distinguish populated and empty databases, verify permission-filtered discovery and qualified reads/edits, and confirm that `DATABASE()` remains NULL. Electron coverage expands database nodes, displays real rows, reconnects a collapsed connection and changes to an explicit default without retaining another database's cached objects.

PostgreSQL coverage includes both explicitly configured databases and a blank Database server profile. The explicit chooser opens a separate profile while preserving production/read-only settings; the original profile and query tab keep their target. The server explorer uses two generated databases with identically named `public.records` tables and distinct values. Database/schema expansion, table reads, query targeting, unbound-tab selection, saved-query execution, catalog refresh and reconnect preserve each database context. Thirteen backend cases cover metadata/structure, edits, pending-session isolation, transactions, cancellation, reserved metadata-session identifiers, startup fallback policy and disconnect cleanup.

The table workbench's displayed SELECT follows server filtering, sorting and pagination. Real-engine tests compare the executable editor SQL with parameterized table reads under both PostgreSQL string modes and MariaDB backslash modes. Authored query results cannot be submitted as base-table edits. Both Electron workbench flows select two rows from a filtered 60-row table, cancel deletion and verify all rows remain, then confirm deletion and verify only the selected rows disappeared. Real-engine tests verify whole-batch rollback when a later selected row changes concurrently. Pending edits block query execution, and read-only connections or tables without a primary key disable deletion.

Selection regressions compare row highlights and checkboxes after cell and row-number clicks, Cmd/Ctrl toggles, Shift-click ranges, Shift-arrow changes, checkbox changes and Clear selection. Filtered ranges exclude hidden intervening rows. Rendered cell selection is checked; this regression does not validate system clipboard copying.

Saved-query acceptance verifies the table Save button and ordinary query Cmd/Ctrl+S, exact SQL and target persistence through a full process restart, unchanged table-tab names and reopening without automatic execution. Fixture data remains unchanged. The Run shortcut measured 4.65:1 text contrast in light mode and 7.14:1 in dark mode, including hover, at 1440×900. At 1024×700 the compact layout hides the shortcut while retaining the visible Run label.

### Credentials and sandbox verification

Playwright's default Electron loader appends basic password-store and mock-keychain switches. Under those switches, Electron reports `basic_text`, and Harbor correctly offers session-only authentication. The separate packaged-runtime test launches the executable directly without those switches: it reports protected `gnome_libsecret` storage, saves remembered credentials for all three engines, closes the process, and reconnects after restart by profile ID without supplying passwords. Locked/unavailable-keyring recovery is covered through an injected safeStorage boundary; a real locked-keyring test and other operating-system keyrings remain unverified.

The test harness explicitly sets `chromiumSandbox: true`; Playwright's default would disable it. Desktop and packaged tests check `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`, reject sandbox-disabling switches and inspect the real Linux renderer's `/proc` status. Passing runs reported `NoNewPrivs: 1`, seccomp mode `2`, one installed filter and PID-namespace depth `3`, compared with depth `1` in the main process. Packaged restart repeated these checks. No sandbox-disabling fallback was used.

Automated launches inherited an AppArmor profile that permits user namespaces. An ordinary terminal on the same host did not inherit that permission and could fail with Electron's SUID-helper diagnostic while `kernel.apparmor_restrict_unprivileged_userns=1` was enabled. Passing automation therefore does not establish ordinary-terminal startup. `npm run setup:linux` supplies a scoped AppArmor rule for the workspace's exact Electron and unpacked executable paths; installing it requires administrator authentication and leaves the global namespace restriction intact. Setup was not applied by automation, so ordinary-terminal launch after installation remains a separate check. See [Ubuntu's explanation of user-namespace restrictions](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions).

## Performance observations

`npm run benchmark` passed separately and measured a first bounded fetch through the real adapters. These are single local observations without concurrency or remote-network simulation. Time includes connection/setup work. Serialized result size is not total driver or network traffic.

| Engine / fixture               | Requested and retained            |   Elapsed | Serialized result |
| ------------------------------ | --------------------------------- | --------: | ----------------: |
| PostgreSQL, 100,000 order rows | 200 rows                          | 116.86 ms |      28,007 bytes |
| MariaDB, 100,000 order rows    | 200 rows                          |  56.95 ms |      27,322 bytes |
| Redis, 100,000 benchmark keys  | COUNT hint 200; 200 keys returned | 260.71 ms |      20,917 bytes |

The Redis cursor remained incomplete; this is not a full-scan measurement or exact progress estimate. SQL table browsing fetches bounded pages. Arbitrary authored queries are streamed/drained after their retained display budget and can still perform substantial server work. Column virtualization, full-output streaming exports and automatic idle eviction are outside this version; see [CAPABILITIES.md](CAPABILITIES.md).

## Visual and interaction review

The generated [workbench concept](design/harbor-concept.png) was compared with actual browser and Electron screens. Browser checks cover the labeled demo and first-run experience; database workflows were checked in real Electron sessions. The committed [PostgreSQL server explorer screenshot](screenshots/postgres-server.png) contains only generated local test databases.

![PostgreSQL server explorer using generated local test databases](screenshots/postgres-server.png)

Dark and light views at 1440×900 and compact views at 1024×700 were reviewed for meaningful content, usable controls, correct page identity, no framework overlays and no renderer console errors. Checks cover the compact toolbar, sidebar, editor-over-results layout, row virtualization, scroll containment, engine-aware SQL highlighting and sticky connection-dialog actions. The compact layout collapses the optional cell inspector while keeping primary actions reachable. Engine, environment, connection and safeguard states have text labels as well as color.

Keyboard tests include actual Monaco typing, execution and save shortcuts, tab context, focusable controls, labeled dialogs and grid edit entry. Full assistive-technology certification is not claimed. Native menus/window controls, explicit demo labeling, measured timings/counts, transaction controls and reviewed edits intentionally adapt the visual reference to real operations. Additional test captures and traces are generated artifacts excluded from publication.

## Platform status

Linux x64 unpacked packaging was built and launched with isolated application data. The approximately 470 MiB unpacked directory must be kept together; it loaded ASAR assets and connected to all three engines without renderer page errors.

Windows and macOS packaging/signing configuration and CI jobs are supplied, but those platforms were not executed on this host. At the time of this validation record, Linux AppImage/deb targets were configured and only the unpacked Linux artifact had been built and launched. No signed or notarized release is claimed. See [RELEASE.md](RELEASE.md) and each [GitHub release](https://github.com/aligeek-tech/harbor-db/releases) for artifact-specific status.
