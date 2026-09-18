# Search-engine preflight — DB-06 / DB-07

Investigated 2026-09-18 against baseline `d009cc8`, which did not implement either engine. This is local implementation and verification evidence, not release acceptance. Elasticsearch and OpenSearch retain different adapter identities, version checks and PIT protocols.

## Driver, licensing and platform decision

The adapters use asynchronous Node `http`/`https` and the already pinned `lossless-json` 4.3.1 dependency. No search-specific native module, Java/JVM client dependency or additional package was installed in the desktop application. The search servers run only in disposable local containers; their binaries are not bundled into Harbor. This avoids native ABI packaging requirements but does not establish other-platform or packaged-artifact execution.

Elastic's [licensing FAQ](https://www.elastic.co/pricing/faq/licensing) distinguishes the default distribution under ELv2 from the optional licenses for portions of its source. This fixture uses the default binary distribution, the Basic feature set, and no trial or paid service. Review the [ELv2 terms](https://www.elastic.co/licensing/elastic-license) before changing distribution or hosting scope. [OpenSearch's FAQ](https://opensearch.org/faq/) identifies its software as Apache 2.0 licensed. No managed search service or external account was provisioned.

Official setup references: [Elasticsearch Docker installation](https://www.elastic.co/docs/deploy-manage/deploy/self-managed/install-elasticsearch-with-docker), [Elastic image catalog](https://www.docker.elastic.co/r/elasticsearch/elasticsearch), [Elastic-maintained Docker Hub image](https://hub.docker.com/r/elastic/elasticsearch), [OpenSearch Docker installation](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/), and [OpenSearch version artifacts](https://opensearch.org/artifacts/by-version/). The Elastic registry request timed out locally; the publisher-maintained `elastic/elasticsearch` image was used instead. An attempted Docker Library image lookup did not find the selected version; it was not substituted with an older unverified product.

| Product | Exact local server | Container image manifest | Executed platform |
| --- | --- | --- | --- |
| Elasticsearch | 9.5.4 | `elastic/elasticsearch@sha256:82ac14f43fe701992e601f4cc81e1c0d7dbc5a2576d8cd736006452925df4026` | Linux arm64 container on macOS arm64 |
| OpenSearch | 3.8.0 | `opensearchproject/opensearch@sha256:fafe3fc3587088674669235575aa166228c48bdb940294a8cdbbc1da75236a40` | Linux arm64 container on macOS arm64 |

The client admits Elasticsearch majors 8/9 with an `X-Elastic-Product: Elasticsearch` response and OpenSearch major 3, minor 4 or later, with `version.distribution: opensearch`. These checks reject wrong-product compatibility responses. Only the exact two fixture versions above were executed; an admitted version range is not a tested compatibility matrix. OpenSearch 3.4 introduced the `_shard_doc` support needed here: [upstream change](https://github.com/opensearch-project/OpenSearch/pull/18924), [3.4 release notes](https://github.com/opensearch-project/opensearch-build/blob/main/release-notes/opensearch-release-notes-3.4.0.md).

## Authentication and transport

Both adapters accept explicit unauthenticated or Basic-auth endpoints. Elasticsearch additionally accepts an **encoded API key** in the existing private credential slot. OpenSearch rejects this API-key mode. Passwords/API keys stay in native credentials and are not returned in profiles, results, drafts or logs. Main-process fixed endpoint/path-prefix configuration is used; there is no redirect following, node sniffing or automatic retry. Invalid proxy traversal, query/fragment and encoded path separators are rejected.

The [Elasticsearch cluster-info API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-info) requires monitor access for the identity handshake. Index-scoped reads, metadata and writes still require their native privileges. The API-key test grants cluster monitor and read/view-index-metadata for one disposable index: read succeeds, write is denied, and revocation produces authentication-failed status. An ordinary missing document, denied operation or invalid DSL does not alone mark the connection degraded. Transport/5xx failures do; a fresh successful explicit request can recover readiness without replaying a prior operation.

TLS uses the shared verified hostname/CA transport; the connection form defaults search profiles to verified HTTPS. Existing SSH configuration is available in the native transport but search-over-SSH was not separately exercised. The Elasticsearch local fixture intentionally uses authenticated loopback HTTP. OpenSearch uses its bundled demo TLS configuration; native tests prove strict verification rejects that self-signed certificate and that the explicitly unverified disposable profile connects. This does not recommend disabling certificate verification for real connections. AWS SigV4, managed service-specific discovery, Cloud IDs, OIDC/SSO flows and OpenSearch Serverless are unsupported.

## Engine-native workflow and bounds

`SearchClusterService` underlies the distinct `ElasticsearchService` and `OpenSearchService` adapters. The connection registry registers them as nonrelational; SQL, table edits and transactions cannot fall through to another adapter. `SearchWorkbench` provides explicit index/catalog loading, mappings/aliases, raw JSON DSL, hit/aggregation views, document preview and reviewed single-document mutations. It never loads a catalog or executes a search just because a tab is mounted or restored. Saved drafts carry DSL/index/page size only; document bodies, results, credentials and PIT tokens are runtime state.

Native results preserve numeric JSON tokens through lossless parsing/serialization. The renderer displays/copies the returned source text and never parses/re-encodes it through JavaScript numbers. This preserves tokens returned by the engine; it does not claim that Elasticsearch/OpenSearch mappings or aggregation arithmetic retain arbitrary decimal precision internally. Source filtering can return partial source in search results, so clicking a hit explicitly reloads its full current document before replacement review.

Bounds: 1 MB DSL/document input, 1,000 hits per page, 8 MiB HTTP response before parse and 8 MiB returned display payload, 1,000 catalog indices, 50,000 JSON nodes and 64 levels, aggregation size 1,000/shard-size 5,000, 10,000 bounded nested/returned buckets. Broad server queries can still be computationally expensive within those bounds. Engine-reported timeout, shard failure and `gte` total relations are displayed; partial results cannot continue as if complete. Aggregations apply to the entire query, not merely the loaded page, and native approximation/error fields are retained.

Deep paging follows the documented [Elasticsearch PIT/search-after strategy](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results) and the distinct [OpenSearch PIT API](https://docs.opensearch.org/latest/api-reference/search-apis/point-in-time-api/). Each search owns its PIT, `_shard_doc` tie-breaker, latest PIT ID and search-after tuple. A renderer receives only an opaque token bound to exact connection/tab/index/DSL/page-size. At most 16 snapshots per profile are retained, with a 110-second local token lifetime and two-minute server keep-alive. Expiry rejects continuation; there is no silent switch to a live query. Snapshots close on final page, explicit close, new search, errors, tab close or disconnect; server expiry bounds residual resources after process loss.

Cancellation closes the active HTTP request. It **does not confirm server-task cancellation**. The UI deliberately says **Stop waiting**, with an explicit warning for writes. A request interruption or non-definitive mutation response leaves an uncertain write outcome and blocks blind retry until inspection. No operation is automatically replayed.

Document create uses `_create`; replacement/deletion require the observed `if_seq_no` and `if_primary_term`, following [native optimistic concurrency](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/optimistic-concurrency-control). Exact target phrases are required for every mutation and include the profile name in production. Native read-only checks apply independently of the UI. Writes accept only an existing concrete nonsystem index, with explicit routing preserved; aliases, patterns, automatic index creation and data streams are rejected. There is no multi-document transaction, bulk writer, delete-by-query or arbitrary REST console. Acknowledged primary success with failed shard copies produces a warning, not a retry.

## Local resources and reproduction

The parent task's isolated directory is `/var/folders/tx/rf_fyjp13vqgywb46ydkh9_80000gn/T/harbor-onboarding-20260918-y6pr0dek`. It contains `elasticsearch-compose.yml`, `opensearch-compose.yml` and mode-0600 `search-test.private.env`. The private file contains newly generated disposable `HARBOR_ELASTIC_TEST_PASSWORD` and `HARBOR_OPENSEARCH_TEST_PASSWORD`; never print its values. Both services are single-node with two CPUs, 2 GiB container memory, 512 MiB JVM heap, 512 MiB tmpfs data, no restart policy and `node.store.allow_mmap=false`. No host sysctl was changed.

| Resource | Local address | State at backend checkpoint |
| --- | --- | --- |
| `harbor-elastic-roadmap-20260918-elasticsearch-1` | `http://127.0.0.1:19200` | Stopped after native desktop gates to free fixture capacity |
| `harbor-search-roadmap-20260918-opensearch-1` | `https://127.0.0.1:19201` | Stopped after native desktop gates to free fixture capacity |

With `task_tmp` set to that exact task directory, stop only the owned resources using:

```sh
rtk proxy docker compose --env-file "$task_tmp/search-test.private.env" -f "$task_tmp/elasticsearch-compose.yml" down
rtk proxy docker compose --env-file "$task_tmp/search-test.private.env" -f "$task_tmp/opensearch-compose.yml" down
```

At the later capacity checkpoint both were stopped with `docker compose ... stop`, not removed. Restart using the same two compose/credential arguments with `start` instead of `down`. Images, container definitions and private disposable credentials remain available. Because the data directories are tmpfs, stopping does not preserve database contents; all test-owned indices had already been removed, and a later gate must recreate its own fixtures. No existing user data was present in these task-created services.

The Node 24 runner is `python3 "$task_tmp/implement.py" <label> [explicit environment assignments] npm ...`; it runs from the repository and preserves logs outside source. Both native service and desktop suites require `HARBOR_SEARCH_TEST_ENV_FILE="$task_tmp/search-test.private.env"`. Each creates uniquely named `harbor_test_*`/`harbor_ui_*` indices and removes its own indices in cleanup. Tests do not touch unknown existing indices.

## Actual verification, remaining gates

`npm exec -- vitest run tests/search-cluster.integration.test.ts tests/search-http.test.ts` passed **23/23** on 2026-09-18 in 16.38 seconds, exit 0, log `implementation-search-native-final2.log`. This comprises 16 real-product cases and seven focused protocol/limit tests. Native coverage includes identity, Basic auth, ES API keys/revocation/permission denial, OpenSearch strict TLS failure, aliases/mappings, 10,003-document deep paging with snapshot consistency, exact 64-bit/source-decimal tokens, aggregation scope, reviewed CRUD, routed documents, read-only/alias denial, wrong/expired cursor context, invalid DSL and truthful HTTP cancellation. Protocol tests separately verify no redirect following, response byte cap, timeout/abort, invalid UTF-8 and error-body redaction.

Earlier failed runs are not passes: ordinary 404/409 responses were incorrectly treated as network degradation because the HTTP error also had a `code` property; classification now excludes those statuses. The API-key fixture initially lacked the monitor privilege required by the identity endpoint; it now grants monitor explicitly while preserving index write denial. An HTTP response-size race was fixed by settling the limit failure before destroying the response.

Targeted ESLint of search/backend/UI integration passed (exit 0, `implementation-search-ui-lint.log`). The integrated typecheck and Electron build belong to the parent gate. `tests/search-workbench.e2e.ts` defines one full native UI flow per product; at this document's checkpoint it is **prepared, not yet executed**. Those cases exercise real form/connection, catalog/mappings, DSL/aggregations, paging, exact preview, concurrent stale replacement rejection/reload, reviewed create/replace/delete, saved context and explicit no-query restore. Trace capture is disabled to avoid recording credential entry.

The native desktop gate subsequently passed **2/2** in 17.35 seconds, exit 0 (`implementation-search-desktop-native2.log`), against the parent's successful integrated `search-native-build`. Both real products completed every workflow described above without page errors. The first run failed only at the restore prerequisite: a renderer reload with auto-reconnect disabled intentionally has no connected status. The test now explicitly reconnects in the UI before opening the restored draft, and still proves no query/catalog automatically executes. Both test apps, private profile directories and uniquely named indices were removed. Synthetic-data screenshots were inspected and copied to task logs as `elasticsearch-search-workbench.png`, `opensearch-search-workbench.png` and the corresponding `search-conflict.png` files. Visual inspection prompted a local CSS token/contrast and search-target header correction; those cosmetic changes await the next integrated visual check.

Pending evidence: final visual recheck, packaged macOS smoke and wider version/platform tests. No Windows/Linux desktop runtime, real managed cloud service, SSH search path, signed artifact or published release has been verified. These limitations must remain visible in the support matrix; backend passing tests alone do not accept either complete roadmap ticket.
