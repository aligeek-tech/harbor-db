# Cassandra DB17 driver and verification record

## Selected boundary

Apache `cassandra-driver@4.9.0`, Apache-2.0, Node >=20, pinned exact with `--ignore-scripts`. Five package additions; no installation hook. Public driver API only. Native protocol v4 over a dedicated local bridge lets Harbor close owned sockets and reject compressed or >8 MiB native response frames before driver decoding. Explicit username/password, local data center, one selected endpoint, verified TLS/SSH transport. No cluster discovery connections, speculative execution, automatic timeout/transport replay, relational transactions or server rollback claim.

Official ARM fixture: `cassandra:5.0.9@sha256:c89d12282b69b38a78f23c37886fc35e732f33b7c18801016c0334e4c7cabf64`; ARM child `sha256:0fb9bfe2f04862d4e666156ff6089de8a428281231b41e7516b3df10b442b936`. `compose.cassandra.yaml` binds localhost19042, 2 CPU, 2 GiB, heap768 MiB, unique volume; native PasswordAuthenticator/CassandraAuthorizer. Fixture bootstrap stores its randomized credential in an external mode0600 file, never source/log text.

Guarded prepared CQL supports bounded SELECT projections and explicit partition scans/filter consent, conditional INSERT IF NOT EXISTS, and conditional UPDATE/DELETE with complete primary-key equality. DDL, batches, counters, TTL, custom timestamps, unrestricted mutation and arbitrary CQL are excluded. Native exact bigint/varint/decimal, UUID/timeuuid, date/time, millisecond timezone timestamps, blob and typed nested collections/tuple/UDT. Normal consistency is explicit; conditional operations use LOCAL_SERIAL. Native rejection codes known to precede execution are definitive; a lost or timeout mutation acknowledgement remains uncertain.

Traversal: one active request per workspace, two per connection; main-owned session-bound rotated UUID cursors; 20 cursors including reservations; 10-minute expiry, 10 pages, 1000 rows, 8 MiB aggregate; table identity rechecked. One MiB cells/parameters and depth/count bounds. No automatic data reads on catalog selection, no document or parameter persistence in history, and typed mutation confirmation.

## Verified evidence

- `cql-native-build`: source typecheck/build passed, 16.71 s.
- `cql-native-offline`: 60/60 passed in seven suites; 12 native cases skipped by explicit fixture gate, 3.22 s runner. Skips do not prove native behavior.
- `cql-complete-test-types`: typecheck including native and desktop tests passed, 9.07 s.
- `cql-native-preflight`: owned backend/proxy/native-test ESLint passed, 0.89 s (before final TLS case).
- Native suite prepared for metadata, exact nested types, opaque paging, partition/filter guard, conditional apply/conflict, explicit consistency, wrong credentials, SELECT-only native role denial, writable-profile/confirmation guard, active response cancellation, lost mutation ack/no replay, two-request admission, and trusted/untrusted TLS proxy to real server.
- Native Electron test prepared for actual connection form, metadata/draft, 25+5 paging, exact decimal display, stale condition draft retention, confirmed fresh mutation, direct native persistence, and privacy.
- `cql-native-schema`: native12/12 passed,20.52s runner19.39s Vitest. Initial fixture setup used reserved identifier `token`; corrected fixture column to `identifier` before acceptance.
- `cql-final-native`: native13/13 plus7/7 safety tests passed,20/20 total,12.21s runner11.06s Vitest. Added real conditional INSERT duplicate conflict, exact decimal/varint/blob write and conditional DELETE conflict/success with direct native reads.
- `cql-desktop`: built Electron1/1 passed,18.52s runner16.9s test, actual connection form and conditional workflow. Compact light screenshot inspected; native typed parameter draft remains after conflict. Electron slot released. Only test/doc changes followed desktop; production code unchanged from successful build.
- `cql-full-owned-lint`: all ten owned TypeScript source/test files passed,1.01s. Final native cases/typecheck recorded in LANE.
- Pinned Cassandra5.0.9 ARM container successfully booted with native auth, external randomized admin credentials and actual restricted roles. Initial bootstrap attempts occurred before default-role startup; bootstrap succeeded after the server logged role creation. Fixture stopped after evidence; no persistent product data touched.

## Sources

- https://github.com/apache/cassandra-nodejs-driver
- https://cassandra.apache.org/doc/latest/cassandra/getting-started/cassandra-quickstart.html
- https://docs.datastax.com/en/datastax-drivers/developing/query-idempotence.html

Public driver source was inspected locally from the exact npm tarball for retry/paging/shutdown behavior. This record does not claim clustered failover, multi-node consistency, hosted acceptance, Windows/Linux packaging, or Scylla compatibility.
