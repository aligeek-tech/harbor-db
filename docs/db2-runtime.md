# Db2 LUW runtime and verification prerequisites

This implementation is a bounded, guarded reader. Native Db2 and packaged-driver acceptance are **not complete**. Driver-double, process-protocol and generic TLS tests do not establish native server behavior. No CLI license was accepted and no privileged Db2 container was started for this checkpoint.

## Supported implementation boundary

- One explicitly configured LUW 11.5 or 12.1 database and schema; every physical connection checks `SQL_DBMS_NAME`, `SQL_DBMS_VER` and database code page 1208. IBM i, z/OS, Informix, non-UTF-8 databases and unknown product markers are refused.
- At most four query children plus one metadata child per profile. Each child has a 128 MiB JavaScript heap limit; this does not bound proprietary native allocations. Native-memory benchmarking remains blocked. Main-process deadlines terminate a blocked child with SIGKILL. Nothing reconnects or replays it automatically.
- Catalogs inspect at most 1,000 tables/views and 128 columns per table, including primary-key order. Defaults, indexes, foreign keys and complete DDL are explicitly uninspected. Structured equality/order/null filters and server pagination are provided; `contains` filters are unavailable.
- Display rows are bounded by the requested count and 8 MiB aggregate; one row is bounded to 1 MiB. Full query export sends one acknowledged row at a time. Its total deadline includes consumer time. The export is a fresh query under the server's configured isolation; no multi-table snapshot is promised.
- Db2 guards accept one SELECT/WITH/VALUES statement. They reject data-change table expressions, writes and session controls. A SELECT can invoke database functions; restricted database grants remain authoritative. No transactions, writes, grid edits, import, schema changes, native backup, administration or automatic credential renewal are implemented.
- Native cancellation is not exposed by the pinned driver. Closing the child stops local work and transport. **Server completion is unconfirmed**, including after network failure. No rollback guarantee is reported.

## Exact values and driver constraints

Inspected `ibm_db@4.0.1` C++ source converts DECIMAL/NUMERIC/DECFLOAT to a JavaScript double and TIMESTAMP to a millisecond Date. Both ordinary and block-fetch strings use a NUL-terminated constructor. `getData` uses the same numeric/time conversion and contains length handling unsuitable for Harbor's bounded binary contract. Harbor does not call that API or patch/redistribute a modified native binding.

Raw queries allow checked small integers, string BIGINT, IEEE floating values, date/time ASCII, booleans and binary columns declaring at most 511 bytes. Raw text/decimal/timestamp, unknown types, LOB/XML and larger binary outputs are refused from metadata before fetching a row. For explicit SQL inspection, return a bounded binary expression, for example `CAST(CAST(amount AS VARCHAR(128)) AS VARBINARY(511))`; it displays as bytes. Casting values to a smaller size is the user's explicit query decision.

Table/catalog queries use internal HEX projections, which fit the driver's initial 1,022-byte buffer. Text is decoded with a fatal UTF-8 decoder; binary stays bytes; NULL remains NULL. Table text/binary columns may declare at most 511 bytes. Decimal and timestamp values are converted to sufficiently bounded text by the server before HEX encoding. This avoids native decimal/Date conversion and preserves embedded NUL. Large declared text columns are refused even if the current rows happen to be short. Native tests must verify all these source-derived expectations before acceptance.

TLS uses a loopback plaintext bridge between the child and Node's verified TLS socket. Node checks the original target hostname and configured CA, including across the existing pinned SSH tunnel. Nothing forwards before TLS verification succeeds. Passwords travel over process IPC, never argv or environment. No arbitrary native module path or connection-string suffix is accepted. Client-certificate authentication is unavailable. The generic TLS test proves this bridge's CA/hostname boundary, not a real Db2 TLS handshake.

## Runtime provisioning and platform matrix

The manifest has an **optional exact peer** `ibm_db: 4.0.1`. Ordinary install/build does not fetch it or execute IBM's installer. The package's LICENSE/package.json say MIT; its installer banner contains different licensing wording and separately refers to proprietary IBM CLI terms. Do not infer permission to redistribute the CLI from the Node package license.

The read-only inspected npm tarball `ibm_db-4.0.1.tgz` has SHA-256 `54deb4dad413844e9104f5c099bf3b4fb8a00d40e906da7f275558c1da189774`. This identifies the inspected Node source/prebuilt bundle, not a verified IBM CLI or usable native installation.

| Platform | Official driver preflight | Acceptance status |
|---|---|---|
| macOS ARM64 | ibm_db >=3.3 supports ARM; CLI 12.x archive exists. Pin 12.1.2 for this candidate. | Archive request returned HTTP 403; no CLI execution or native fixture. |
| macOS x64 | Official installer requires CLI 11.5.x; proposed exact prerequisite 11.5.9. It silently ignores a 12.x pin. | Artifact, addon, packaging and native fixture unverified. |
| Linux x64 | CLI 12.1.2 archive exists; Community server container is x86_64. | Native client and server unverified. |
| Windows x64 | CLI 12.1.2 archive exists. | Native addon/DLL placement, signing and native fixture unverified. |
| Linux/Windows ARM64 | Pinned installer does not support the requested native combination. | Blocked; do not substitute an emulated production package. |

An authorized administrator/packager must provide:

1. The exact `ibm_db@4.0.1` npm artifact and its verified integrity, plus all resolved transitive dependencies in an offline approved dependency directory. Initial extraction/install may use `--ignore-scripts`; this alone does not create a usable native runtime.
2. The matching versioned IBM CLI archive from the official directory (macOS ARM: `v12.1.2/macarm64_odbc_cli.tar.gz`; macOS x64: `v11.5.9/macos64_odbc_cli.tar.gz`; Linux x64: `v12.1.2/linuxx64_odbc_cli.tar.gz`; Windows x64: `v12.1.2/ntx64_odbc_cli.zip`). Record the downloaded archive SHA-256 and inspect its actual license files **before execution or redistribution**. No archive checksum is asserted here because the Mac ARM download failed.
3. Explicit authorization for the applicable CLI terms and use, with an approved decision on redistribution. Provision it only within the package's `installer/clidriver` directory; no global `IBM_DB_HOME`, system driver registration or host configuration changes are needed. Build/load the N-API addon only after that approval. Do not use the installer's floating latest download or GitHub fallback as a substitute for the selected verified archive.
4. A build of the native addon for the exact target OS/architecture and Node/Electron runtime. The configured child entry/shared main chunks and `node_modules/ibm_db/**` are unpacked from ASAR. Verify that all native transitive libraries and CLI resources are actually present in the packaged artifact; optional peer inclusion must be checked, not assumed. Launch the packaged child and test the real driver before release. No packaged/signing gate is passed by source-only build success.
5. A pre-existing authorized disposable LUW 11.5/12.1 UTF-8 server with explicit host/port/database, reader credentials, TLS CA and a resource boundary. The reader should have CONNECT plus only the required SELECT/catalog permissions. Do not grant schema-write/admin rights just to make a catalog query pass.

Official Community-container instructions require `LICENSE=accept` and `--privileged=true`. Neither is authorized in this task. Read-only manifest inspection found no ARM64 image; amd64 manifest digest was `sha256:e48ca934c29ab72d9e8b602929e6a52b64841cb7f8ef9426ee8cf5e1bc3e5fb3`. This does not prove a server version. An approved x86_64 fixture or already authorized endpoint is required. Do not run the container on this Mac merely to bypass that boundary.

## Disposable fixture contract

An authorized fixture owner creates schema `HARBOR_B_DB2` in database `HARBOR`, on a non-production UTF-8 server, then grants the test reader SELECT. The native test never creates objects or accepts server licenses.

```sql
CREATE SCHEMA HARBOR_B_DB2;
CREATE TABLE HARBOR_B_DB2.TYPED_VALUES (
  ID BIGINT NOT NULL PRIMARY KEY,
  AMOUNT DECIMAL(31,8),
  STAMP TIMESTAMP(12),
  TXT VARCHAR(511),
  BYTES VARBINARY(511),
  NOTHING INTEGER
);
INSERT INTO HARBOR_B_DB2.TYPED_VALUES VALUES (
  9223372036854775807,
  9007199254740993.12345678,
  TIMESTAMP('2026-09-18-12.13.14.123456789012'),
  CAST(X'D8B3D984D8A7D98500F09F9982' AS VARCHAR(511)),
  X'00FF',
  NULL
);
-- Grant CONNECT/SELECT to the exact approved test reader; do not grant public access.
```

With the approved native runtime installed, first build the separate worker. Run `tests/db2.integration.test.ts` with `HARBOR_DB2=1`, the exact `HARBOR_DB2_HOST`, `HARBOR_DB2_PORT`, `HARBOR_DB2_DATABASE`, `HARBOR_DB2_SCHEMA`, `HARBOR_DB2_USER`, `HARBOR_DB2_PASSWORD` and, for TLS, `HARBOR_DB2_TLS=1` plus PEM `HARBOR_DB2_CA`. Supply credentials only in command-scoped protected environment, never logs or committed files. Remove the exact fixture objects through the fixture owner after testing. The required native matrix also includes wrong credentials, insufficient grants, native TLS/SSH, native timeout/cancel, connection loss, large-result memory bounds, packaging and each supported OS/architecture; the current three fixture tests alone are not full acceptance.

Primary references: [official Node driver](https://github.com/ibmdb/node-ibm_db), [versioned CLI directory](https://public.dhe.ibm.com/ibmdl/export/pub/software/data/db2/drivers/odbc_cli/v12.1.2/), [SQLGetInfo product/encoding information](https://www.ibm.com/docs/en/db2/12.1.x?topic=functions-sqlgetinfo-function-get-general-information), [IBM application code pages](https://www.ibm.com/docs/en/db2/12.1.x?topic=support-derivation-code-page-values), [Community Docker prerequisites](https://www.ibm.com/docs/en/db2/12.1.x?topic=deployments-db2-community-edition-docker).
