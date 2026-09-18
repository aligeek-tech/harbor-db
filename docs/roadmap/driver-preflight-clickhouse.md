# ClickHouse adapter preflight and scope

## Dependencies and fixture

- `@clickhouse/client@1.23.1`, exact manifest/lock pin: official ClickHouse HTTP(S) client, Apache-2.0, Node >=20, no runtime dependencies. Installed with lifecycle scripts disabled. Pure JavaScript transport; no native client library or architecture-specific SDK is required.
- Server: `clickhouse/clickhouse-server:26.3@sha256:810861a2e2d0188744f5f23b2d3ec9ff95812bcb9ddbb8fed13a377a7f305893`, actual `26.3.33.24`, official Apache-2.0 image with amd64/arm64 manifests. No commercial license acceptance was required.
- `compose.clickhouse.yaml`: loopback HTTP port 18123, disposable database/user, tmpfs data, 2 CPU/2 GiB limits. Verification ran natively on this arm64 Mac with an arm64 Linux container. Other desktop OS/architecture packages are not independently verified here.
- ClickHouse >=25.11 is required because its HTTP late-error framing can be identified unambiguously in raw streaming output. Startup rejects older versions rather than risking a successful-looking incomplete export.

Primary sources: [official JavaScript client](https://clickhouse.com/docs/integrations/javascript), [client repository and license](https://github.com/ClickHouse/clickhouse-js), [server license](https://github.com/ClickHouse/ClickHouse/blob/master/LICENSE), [official Docker setup](https://clickhouse.com/docs/get-started/setup/self-managed/docker), [HTTP interface](https://clickhouse.com/docs/interfaces/http), [TSV format](https://clickhouse.com/docs/interfaces/formats/TabSeparated), [read-only query settings](https://clickhouse.com/docs/operations/settings/permissions-for-queries).

## Main-process boundary

`ClickhouseService` uses the shared verified TLS/SSH transport and the official client's custom HTTP agent. Credentials remain in the main process. Default ports are HTTP 8123 and HTTPS 8443; the fixture uses 18123. Host identity is checked against the original profile hostname, including when forwarded through SSH.

Query tabs send one read-only analytical statement. Native `{name:Type}` parameters are supported, with binary values supplied explicitly as base64 text plus `base64Decode`. Raw `exec()` in the pinned driver ignores its multipart option, so Harbor constructs the documented multipart form explicitly: query parameter values do not enter URLs. Driver logging is disabled; errors crossing the boundary contain static guidance and numeric error codes, never echoed parameter/row data. This does not disable or certify server-controlled audit logging.

The main process does not offer transactions, generic row editing, SQL DDL/mutations, session SET commands, user FORMAT/SETTINGS overrides, or automatic retries/replays for this engine. Strict server readonly=1 users are detected at bootstrap and receive no prohibited client setting overrides; required TSV defaults are checked first. Other accounts execute reads with native readonly=1. Client deadlines and query_id-specific native KILL requests apply independently of server settings.

## Values, metadata, and transfers

- Raw TSV bytes are decoded incrementally with an 8 MiB row cap and awaited sink backpressure. UInt64/128/256, decimals, dates, and DateTime64 nanoseconds remain strings. NULL, literal NULL tokens, and invalid-UTF8 binary strings remain distinct. Complex types remain their native textual representation with the original column type; they are not converted to lossy JavaScript objects.
- Loaded query results have row and 8 MiB bounds. Exports use one new query and explicitly describe the absence of a multi-table transaction snapshot. Native late errors never finalize the destination file.
- Read-only catalogs expose databases, table/view/materialized-view engines, exact CREATE text, sorting/partition/sampling keys, estimated rows/bytes, bounded active parts and pending mutations. Primary indexes are never treated as unique editable-row keys. EXPLAIN PLAN is available; EXPLAIN ANALYZE is not advertised.
- Explicit import requires the additional nontransactional append consent. Only local plain MergeTree tables and supported scalar columns are accepted. Specialized/replicated/distributed engines, generated columns, and complex-column imports are rejected. Every successful synchronous batch is acknowledged; failed/interrupted dispatched batches are uncertain. No rollback, write replay, or resume is attempted. External schema changes and engine-specific materialized-view side effects remain native ClickHouse concerns; the wizard does not offer a transactional metadata lock.
- Integer ranges, decimal scale/precision, floating-point precision, calendar validity, and timestamp fractional precision are checked before dispatch. Timestamp imports require an explicit ISO offset or Z. DateTime upper-range edge days are conservatively excluded rather than risking overflow. Source parsing and file-identity safeguards are shared with the existing streaming importer.

## Reproducible verification

Run only against the disposable local fixture:

```sh
HARBOR_CLICKHOUSE=1 npm exec vitest -- run tests/clickhouse-values.test.ts tests/clickhouse.integration.test.ts tests/clickhouse-transport.integration.test.ts
HARBOR_CLICKHOUSE_BENCHMARK=1 npm exec vitest -- run tests/clickhouse-benchmark.test.ts
```

Coverage includes native exact-value reads, parameter transport/privacy, escaped identifiers, metadata, engine-aware filters, read-only roles and denied access, native cancellation plus server activity, actual late stream errors, row-size limits, EXPLAIN, explicit append consent, acknowledged imports, decimal/integer/timestamp narrowing rejection, full CSV/JSONL jobs, real HTTPS trust rejection, and a proxy that drops an already-applied INSERT acknowledgement. The latter confirms two inserted rows exist exactly once while the client reports an uncertain batch.

The opt-in benchmark exports 100,000 rows with 4096-byte payloads (over 384 MiB) into a disposable directory and asserts heap growth under 64 MiB and RSS growth under 128 MiB. Its first fixture run hit the server's 2 GiB memory limit during parallel output formatting and was correctly rejected as incomplete. The bounded implementation disables parallel output formatting and requests 8192-row native blocks for accounts allowed to change settings; the benchmark then passed. Strict readonly=1 accounts use their server-provided formatting/resource profile.

TLS was exercised through a local HTTPS proxy into the real server. ClickHouse-specific SSH forwarding was not independently exercised in this suite; it reuses the transport whose SQL-server/MySQL tests cover pinned SSH and original-host TLS identity. Cloud accounts, cluster/distributed semantics, older versions, native TCP protocol, commercial server features, and other operating systems remain unverified.
