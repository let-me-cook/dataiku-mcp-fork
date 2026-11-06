# Dataset and managed-folder provisioning (DSS 14.7.1)

This upgrade addresses a missing `projectKey`, managed-folder
creation, external PostgreSQL definitions, and schema detection.
Existing objects do not need to be recreated.

## `create_dataset`

Existing arguments remain: `project_key`, `dataset_name`, `dataset_type`, `params`.
The request now includes the SDK's required **`projectKey` in the JSON body**, plus
`formatType` and `formatParams`. Optional MCP arguments:

- `managed`: explicit DSS managed flag, default **false** (external).
- `format_type`, `format_params`: file format settings.
- `autodetect_schema`: default false; currently PostgreSQL table mode only.
- `dry_run`: default false; preview creation after checking name availability.
- `if_exists`: `fail` (default) or `reuse`. Reuse requires matching type, requested
  connector/format settings and managed flag. It never overwrites the existing
  object or reruns detection; if detection was requested, existing columns must
  already be present.

Creation reads back saved settings. If DSS ignores the managed flag on creation,
the tool saves it explicitly with revision checks and verifies it. If requested,
schema detection/save follows. The result includes verified settings, managed
state, column count and revision. The legacy TypeScript client method delegates
to this corrected implementation too.

To change an existing definition, `update_dataset` now also accepts a typed
`patch.managed` boolean alongside connector `params`, `dry_run`, and revision
guards. A managed flag changes DSS ownership semantics, not database permissions.

## `create_external_postgresql_dataset`

A scoped convenience tool for an **existing** table:

```json
{
  "project_key": "MY_PROJECT",
  "dataset_name": "new_external_input",
  "connection_name": "idx-catalyst-db",
  "schema_name": "catalyst",
  "table_name": "source_table",
  "autodetect_schema": true,
  "dry_run": true
}
```

Sets DSS type `PostgreSQL`, `params.mode: table`, explicit connection/schema/table,
optional `catalog_name`, and **`managed: false`**. Detection defaults to true for
this helper. A dry run previews settings and checks name collisions; it does not
test table access. Set `dry_run: false` to create the definition and detect/save
columns. No recipe, dataset build, SQL migration, truncate or table recreation is
issued by these operations. External inputs are not automatically database-read-only.

## `autodetect_dataset_schema`

```json
{
  "project_key": "MY_PROJECT",
  "dataset_name": "source_table",
  "save": false
}
```

Calls DSS's SQL `testAndDetectSettings/externalSQL` action and returns
`schemaDetection.newSchema`, matching the SDK's detection path. Preview is the
default. Only PostgreSQL table-mode datasets are supported in this implementation.
Invalid/empty or duplicate-column detection results are errors.

Use `save: true` to save the detected schema. Optional `expected_hash` and
`expected_version` guard the initial read; a fresh revision check also detects
changes while detection ran. Saving replaces the schema only, preserves other
settings, and reads back the saved schema. As with other DSS settings updates,
checks are best-effort and not atomic across external clients. Detection may query
the source database; it does not save unless requested.

## `create_managed_folder`

```json
{
  "project_key": "MY_PROJECT",
  "name": "new_upload_folder",
  "connection_name": "filesystem_folders",
  "dry_run": true
}
```

Requires an existing visible connection. Optional `folder_type` lets the operator
specify the DSS storage type; omission lets DSS infer it. The payload matches the
SDK, including `projectKey` and storage path `/${projectKey}/${odbId}`. It creates
no global connection. Dry runs verify name availability and connection visibility;
actual storage compatibility/permissions are checked by DSS during creation.

Read-back verifies the allocated ID, name, connection and optional storage type.
The `if_exists` policy defaults to `fail`; `reuse` requires exactly one matching
folder and matching storage settings. Ambiguous names are errors.

## Partial failures and concurrency

A definition or folder may exist even if schema detection or verification fails.
Errors include the project/object identity, stage, and known/unknown creation
state. Inspect that object before retrying. No automatic deletion, rollback or
rebuild is attempted; a timed-out request may have completed in DSS. Creation
preflight checks are not an atomic uniqueness guarantee across independent
clients, especially for folder display names. This is not file-plus-metadata
transactional registration.

## Verification and references

Contract tests cover SDK payloads, legacy-client delegation, external/managed
state, schema preview/save, concurrent edits, collisions/reuse, existing connection
checks, saved-state mismatches, and partial failures. Live read-only verification
in a pilot project detected 8 columns for `source_table` without saving; folder and
external-dataset creation passed dry runs. No live creation/save was attempted and
no existing objects were changed. Creation/save behavior is covered by mocked HTTP
tests, not a live write test.

Request shapes were checked directly against the official `dataiku-api-client`
**14.7.1** source: `dss/project.py` (`create_dataset`, `create_managed_folder`) and
`dss/dataset.py` (`test_and_detect`, `autodetect_settings`, `set_table`). See the
[official project API](https://developer.dataiku.com/latest/api-reference/python/projects.html)
and [dataset API](https://developer.dataiku.com/latest/api-reference/python/datasets.html)
for conceptual references; the local pinned source determines the 14.7.1 contract.

Controlled SQL migrations remain a separate future capability. This upgrade does
not add arbitrary SQL execution or migration/transaction handling.

Run `make build` after source changes and restart the MCP client.
