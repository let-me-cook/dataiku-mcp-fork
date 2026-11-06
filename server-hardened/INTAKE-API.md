# Intake MCP improvements

The Dataiku inspection, extraction summary, library, and zone improvements work
without access to the frontend/backend source. Upload registration and metadata
row tools are **adapters for an external service**, not a replacement backend.
They do not perform a file upload followed by an unrelated full-table rewrite.

The four backend tools (`get_intake_capabilities`, `register_document_upload`, `read_metadata_row`, `upsert_metadata_row`) are listed only when `DSS_INTAKE_URL` is set.

Run `make build` and restart the MCP client to load the new tools. Existing
running processes retain their loaded code until restarted.

## Available Dataiku operations

### Database discovery and inspection

- `list_database_tables`: supply `project_key` and `dataset_name` to select the
  PostgreSQL connection. Optional `schema_name`, literal `table_prefix`, and
  `limit` (default 100, maximum 1,000). Returns database/schema/table names and
  relation kinds, with explicit truncation. This is catalog metadata, not rows.
- `inspect_database_table`: inspect that dataset's configured relation, expanding
  the documented `${projectKey}` variable. Optional `schema_name` and `table_name`
  select an exact physical target without changing dataset settings. Returns
  columns/types/defaults/nullability, ordered primary-key columns, constraints,
  and actual database identity. Other unresolved templates remain unknown.

Only fixed, read-only PostgreSQL catalog queries are executed. Identifier values
are encoded as UTF-8 hex literals; they cannot become SQL syntax. Tools do not
accept SQL, pre/post queries, connection credentials, or arbitrary connection
names. DSS's supported SQL query API runs the query, streams bounded results
(1 MiB), and verifies stream completion. Standalone indexes and triggers are not
included. Other database types return unsupported status rather than fabricated
keys or constraints. Catalog visibility does not establish permission to read
table rows. Exact names are used; case folding and search-path equivalence are
not assumed.

### Extraction evidence

`get_extraction_outcome_summary` accepts `project_key`, `job_id`, and optionally
an `outcomes` dataset mapping:

```json
{
  "project_key": "MY_PROJECT",
  "job_id": "DSS_JOB_ID",
  "outcomes": {
    "dataset_name": "extraction_outcomes",
    "run_column": "run_id",
    "document_column": "document_id",
    "status_column": "status",
    "output_count_column": "output_rows"
  }
}
```

This example dataset is a producer contract, **not a dataset created by this
upgrade**. It must contain one final row per document, including failed/skipped
inputs. The run column defaults to matching the exact DSS job ID. Set
`outcomes.run_value` for a distinct ingestion batch ID after establishing its
relationship to the job. The MCP does not independently verify that relationship.

Default status values are case-sensitive:

| Category | Values |
| --- | --- |
| Succeeded | `SUCCEEDED`, `SUCCESS` |
| Skipped | `SKIPPED` |
| Failed | `FAILED` |
| Pending | `PENDING`, `RUNNING` |

Override all four arrays with `outcomes.status_values`; overlapping categories
are invalid. Counts include files attempted (= succeeded + failed), succeeded,
skipped, failed, pending/unknown, and reported output rows. Skipped files are not
counted as attempted. Output counts are reported by the producer, not independently
recounted from the output dataset.

The scan defaults to 1 MiB / 10,000 rows, with maximums 10 MiB / 100,000 rows.
`truncated`, duplicate document rows, invalid counts, unknown statuses, an empty
run manifest, and pending work prevent a claim of completed extraction. Observed
counts remain available for diagnosis; uncertain totals are `null`. A job marked
`DONE` can still have `extraction_success: false`. Without per-file evidence, both
extraction success and counts are unknown. `manifest_coverage_verified` is always
false: omitted inputs cannot be detected solely from the outcome rows.

### Reliable library creation and zone verification

`write_project_library_file` checks the library tree to distinguish absent files
from access errors and directories. It does not GET a nonexistent file and assume
DSS will return 404; DSS can return “Not a file.” Parent folders must already
exist. Create refuses existing files; update requires a hash; dry runs do not
write. After POST, the tool reads back the file and verifies the content hash.

`update_flow_zone` reads back saved settings after PUT. Inspect
`persistence_verified`, `saved_position`, and `mismatched_fields`. A successful
HTTP response with ignored coordinates is an MCP error, not a successful layout
claim. A failed read-back reports that the write occurred but verification failed.
These checks detect persistence failures; they do not create atomic DSS writes.

## Backend adapters

| Tool | Purpose |
| --- | --- |
| `get_intake_capabilities` | Report configuration and backend-declared consistency guarantees. |
| `register_document_upload` | Send a local artifact plus metadata; return the backend's stable document ID and registration state. |
| `read_metadata_row` | Read one uniquely keyed row and its version. |
| `upsert_metadata_row` | Patch/create one keyed row with a mandatory expected version and idempotency key. |

No existing backend endpoints were accessible during implementation. The contract
below is **this adapter's contract**, not a claimed native DSS API or a claim about
the existing application's routes. A backend implementation or translating
gateway must implement it before these three data operations are usable.
Until then, `get_intake_capabilities` reports `configured: false`; data operations
return `IntakeNotConfigured` without attempting DSS writes.

### Optional configuration

```dotenv
DSS_INTAKE_URL=https://intake.example/api/
DSS_INTAKE_TOKEN=<separate service credential>
DSS_INTAKE_PROJECTS=MY_PROJECT
DSS_INTAKE_ALLOW_HTTP=false
```

The URL is a base path, configured by the operator, never by a tool argument.
Requests use Bearer authentication with the separate service credential; the DSS
key is not forwarded. HTTPS is required unless explicitly opted into HTTP.
Redirects and URL-embedded credentials are rejected. Project keys must appear in
the comma-separated allowlist. Existing `.env` credentials were not modified.

### `GET capabilities`

```json
{
  "contract": "dataiku-intake-v1",
  "registration": {
    "durable_idempotency": true,
    "recoverable_partial_failures": true,
    "stable_document_id": true
  },
  "metadata": {
    "parameterized": true,
    "atomic_expected_version": true,
    "key_scoped": true
  }
}
```

The adapter checks this before each data operation. These are backend declarations;
an MCP client cannot prove the implementation's transaction guarantees remotely.

### `POST documents/register`

Multipart form with:

- `file`: artifact bytes (at most 100 MiB), with a plain filename.
- `request`: JSON string containing `contract`, `project_key`, `idempotency_key`,
  `filename`, `sha256`, `size_bytes`, and `metadata` (bounded scalar field map).

Use `register_artifact` to stage local files first. The MCP verifies the artifact
checksum before submitting bytes. The backend must independently verify it too.

Example receipt:

```json
{
  "contract": "dataiku-intake-v1",
  "project_key": "MY_PROJECT",
  "idempotency_key": "upload-2026-001",
  "document_id": "stable-backend-issued-id",
  "sha256": "64-lowercase-hex-characters",
  "state": "COMMITTED",
  "replayed": false
}
```

Valid states: `COMMITTED`, `PENDING`, `FAILED`. Only `COMMITTED` means the
registration is complete. Failed states become MCP errors; pending states remain
explicitly uncommitted. Receipts must echo the request identity and checksum.

The backend owns a durable request ledger keyed by authenticated scope, project,
and idempotency key. It must allocate the document ID once, bind the key to the
entire request fingerprint, and reject the same key with a different payload
(HTTP 409). Retrying an identical request returns the same document ID. A durable
state machine must reconcile staged bytes and metadata after process crashes or
partial failures. `COMMITTED` must never precede both verified file storage and
committed metadata. Failed or pending operations must not expose a document as
ready for extraction. Compensation/recovery belongs to the service.

The adapter does not automatically retry mutations. After a timeout, lost response,
or partial failure, reconcile with the **same key and identical request**; creating
a fresh key risks a duplicate. Repeating registration is the reconciliation path
in this contract, so retain the local artifact until the outcome is settled.

### `POST metadata/read`

```json
{
  "contract": "dataiku-intake-v1",
  "project_key": "MY_PROJECT",
  "registry": "documents",
  "keys": {"id": 42}
}
```

The service must map the logical registry to an approved database table and
require an exact declared unique key (including composite keys). The MCP accepts
one to ten string/integer key columns. SQL predicates or arbitrary SQL are not
accepted. Read operations return either:

```json
{
  "contract": "dataiku-intake-v1",
  "project_key": "MY_PROJECT",
  "registry": "documents",
  "found": true,
  "row": {"id": 42, "status": "READY"},
  "version": 7
}
```

or the same identity fields with `found: false`. A present row must match every
requested key and include a nonempty string or nonnegative safe-integer version.
Backend and MCP responses must exclude secrets; the MCP additionally redacts known
credentials and secret-like fields. Arbitrary prose cannot be exhaustively scrubbed.

### `POST metadata/upsert`

Extends the read request with `values`, `expected_version`, and `idempotency_key`.
`values` is a scalar patch; omitted columns must remain unchanged. Key columns
cannot also appear in the patch. This is one row, never a table replacement.

- `expected_version: null`: insert only if the key does not exist.
- A specific version: update only if the current row version matches; increment
  or replace it with a fresh version in the same transaction.
- Conflict: HTTP 409, with no data changed.
- Success: the read response fields plus `state: COMMITTED`, `idempotency_key`,
  `replayed`, and the resulting row/version.

The backend must bind values as SQL parameters, validate registry/column allowlists,
enforce uniqueness in the database, and atomically save both the row and durable
idempotency receipt. Duplicate detection must precede the expected-version check
so replaying an already committed request returns its receipt, not a stale-version
conflict. It must reject ambiguous/nonunique keys rather than updating many rows.

## Verification and references

Tests cover the corrected DSS contracts and mock intake-service behavior, including
replayed IDs, checksum rejection, partial states, capability gating, version
conflicts, credential separation/redaction, unsafe input rejection, and no retries.
They do not validate the unavailable application's transaction implementation.

The tests, typechecking, build, and the production dependency audit passed. Read-only
live checks in a pilot project
confirmed library-tree lookup, library-create and zone-update dry runs, PostgreSQL
catalog streaming with bounded table discovery, and unknown extraction counts for
a DONE job without a per-file manifest. Exact configured and
candidate metadata table names were not found in that connection's catalog during
the check; the tools report this without assuming equivalence. No live metadata
rows, files, library contents, or Flow layouts were modified.

The DSS requests follow the official `dataiku-api-client`
`dss/projectlibrary.py` and `dss/sqlquery.py` implementations. References:
[Dataiku library REST operations](https://doc.dataiku.com/dss/api/latest/rest/),
[Dataiku storage variables](https://doc.dataiku.com/dss/latest/connecting/relocation.html),
[PostgreSQL constraints](https://www.postgresql.org/docs/current/catalog-pg-constraint.html),
and [PostgreSQL columns](https://www.postgresql.org/docs/current/catalog-pg-attribute.html).
