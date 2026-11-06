# Operations API

These operations address findings from a pilot project. Run `make test`
and `make build` from the repository root, then restart the MCP client to load
the rebuilt server and its updated tool schemas. Keep using the existing `.env`.

See [Intake API](INTAKE-API.md) for subsequent improvements to library creation, zone verification, database inspection, extraction summaries, and optional backend adapters.

## Corrected tools

| Tool | Contract |
| --- | --- |
| `get_project_flow` | Supported `/flow/graph/` plus `/flow/zones`; typed nodes, directed edges, primary/shared zone membership and available zone positions. Does not invent node coordinates. |
| `get_dataset_sample` | `/schema` plus `/data/` in TSV format; rows keyed by schema names, values returned as strings. Handles quoted tabs and multiline cells. |
| `get_recipe_info`, `get_recipe_code` | Read the recipe settings envelope and its `payload`, matching Python `get_settings().get_code()`. Empty code remains an empty string. |
| `export_project_config` | POST export returning a ZIP artifact, SHA-256 and byte count. `include_manifest: true` adds an entry inventory and bounded parsed root JSON metadata. No JSON/YAML export option. |
| `update_dataset`, `update_recipe`, `update_scenario` | Required typed `patch`, optional `dry_run`, `expected_hash`, and `expected_version`. Preserve omitted fields and replace supplied arrays. |

Sampling defaults: 100 returned rows, 128 KiB row JSON, 1 MiB scanned bytes,
10,000 scanned rows. Maximums: 1,000 rows, 1 MiB row JSON, 10 MiB scan,
100,000 scanned rows. Use `columns`, `partition`, and `filters` with
`column`, `operator` (`eq`, `ne`, `contains`), and string `value`.
Filters run **client-side over the bounded scan**, not over the whole dataset.
Inspect `truncated`, `scan_complete`, and the returned counts/limits. A partial
scan with no matches does not prove the dataset has no matching rows.

## Guarded changes

Read `get_dataset_info`, `get_recipe_info`, or `get_scenario_info` for
`revision.sha256` and, where available, `revision.version`. Example:

```json
{
  "project_key": "MY_PROJECT",
  "recipe_name": "example_recipe",
  "patch": {"description": "Updated description"},
  "dry_run": true,
  "expected_version": 3
}
```

Dry runs perform schema validation and local invariant checks, returning a
sanitized preview without saving or running DSS validation/builds. Send the same
patch with `dry_run: false` when ready. Python recipe updates validate the final
settings: exactly one output and at most 1,000 lines including blanks/comments.
Native-first selection and visual organization remain agent instructions, not
provable server invariants across every possible write path.

Settings writes are serialized within this server, with a second read immediately
before PUT. **This is best-effort optimistic concurrency, not atomic CAS.** DSS
public settings and library APIs do not expose an atomic conditional write here.
External clients can race after the check. A conflict requires a fresh read and
review, not a blind retry. Never copy `[REDACTED]` values into a replacement.

## Added operations

| Family | Tools and behavior |
| --- | --- |
| Managed folders | `list_managed_folders`, `list_managed_folder_files` (bounded page), `download_managed_folder_file`, `upload_managed_folder_file`. Upload requires artifact hash and explicit `overwrite: fail` or `replace`; optional remote hash check; reads back to verify checksum. Overwrite checks are not atomic. |
| Flow zones | `list_flow_zones`, `create_flow_zone`, `move_flow_objects`, `share_flow_object`, `update_flow_zone`. Creation reuses a case-insensitive existing name; zone updates accept name/color/position and revision guards. Moving objects can move generating recipes too. |
| Python library | `list_project_library`, `read_project_library_file`, `write_project_library_file`. Scoped to `python/*.py` paths, with nested directories allowed. Writes require explicit create/update mode; updates require the prior content hash. Supports dry runs; does not execute the file. |
| Variables | `get_project_variables`, `merge_project_variables`. Merge one `standard` or `local` scope, requiring the whole variables snapshot hash and preserving unrelated values, including secrets omitted from the patch. |
| Environments | `inspect_code_environment` returns package inventory, which alone cannot prove imports work. `validate_code_environment_imports` runs a fixed import checker using a temporary InlinePython tool in the selected environment. |
| Jobs | `start_job` returns immediately with the DSS job identifier. Poll `get_job_details` until `terminal`; only `success: true` confirms completion. `get_job_activity_log` returns a bounded log prefix with a truncation flag and optional activity selection. |
| Knowledge banks | `list_knowledge_banks`, `get_knowledge_bank`, `get_knowledge_bank_status`, `configure_knowledge_bank_filters`. Inspect upstream source nodes and retained build history; configure filterability of existing metadata columns. A successful build does not prove document coverage. |
| Agent diagnostics | `check_agent_tool_startup` requests the real descriptor and reports startup errors. Existing `run_agent` and `run_agent_tool` return sanitized invocation output, available traces and usage; large responses become artifacts. Descriptor success does not test an LLM transport. |
| Scenarios | `add_scenario_build_step` appends a typed native `build_flowitem` step, including saved-model builds/training. It preserves existing steps, rejects duplicate IDs, and defaults to continuing only after success/warning. Supports dry run and revision checks. |

The import checker **mutates DSS temporarily**: create tool, configure the named
environment, invoke a fixed list of imports, delete tool. It accepts module names,
not arbitrary Python. Imports can have side effects. Inspect each import result;
startup and cleanup failures are errors. On failed cleanup, the response identifies
the diagnostic tool for removal. Environment inspection may require admin rights.
Descriptor checks can initialize user-written code even without a business invocation.

## Artifacts and bounded results

Artifacts default to the repository's `.artifacts/`, configurable with
`DSS_ARTIFACT_DIR`. New directories use mode 0700, files 0600. Responses contain
`artifact_id`, `sha256`, `size_bytes`, `media_type`, and `local_path`, not raw bytes.
The paths belong to the machine running the MCP server. Files persist until an
operator removes them; there is no automatic expiry. Downloads and exports are
bounded to at most 100 MiB. Raw archives/files may contain sensitive data and are
not content-redacted; they stay outside model tool results.

To upload a verified local catalog ZIP:

1. Create `.artifacts/inbox/` privately and stage the file there.
2. Compute its SHA-256 locally.
3. Call `register_artifact` with its plain `filename` and `sha256`.
4. Call `upload_managed_folder_file` with the returned artifact ID, matching hash,
   project/folder/path, and explicit overwrite policy.

No arbitrary local path or large inline/base64 upload is accepted. JSON results
larger than 256 KiB become sanitized JSON artifacts. Most HTTP metadata responses
are bounded to 5 MiB before parsing; larger responses fail explicitly. Folder
pagination is local over that bounded listing, not DSS server pagination.

## Errors, secrets, and Gemini schema transport

HTTP errors return `isError: true` with sanitized DSS type, message, bounded nested
cause, status and an `operation_id`. The operation ID is generated by this MCP for
the request; it is not a DSS job ID or guaranteed DSS log correlation ID. Known
credentials and secret-like fields are redacted; numeric token usage is retained.
Avoid putting secrets in arbitrary prose: pattern-based redaction cannot recognize
every possible secret. Request bodies and raw responses are never dumped to stdout.

MCP results are JSON **text content**, without a structured schema object in
`structuredContent`. JSON Schema `$ref`, `required`, and other validation constraints
are preserved. Inputs remain validated by the server's JSON Schema validator.

This transport change does not automatically rewrite existing managed-tool handlers
inside DSS. If such a handler returns a schema to Gemini, validate with the original
schema and serialize only the schema field in the returned output. For example:

```python
import json
import jsonschema

def validated_output(candidate, schema):
    jsonschema.validate(instance=candidate, schema=schema)
    return {"output": {"result": candidate, "schema_json": json.dumps(schema)}}
```

The selected code environment still needs `jsonschema`. Do not remove `$ref` or
relax validation to work around provider interpretation. Arbitrary nested business
results containing schemas need the same deliberate handler-side serialization.

## Reference and verification

Endpoint methods and request shapes were checked against the official
[dataiku-api-client source distribution](https://pypi.org/project/dataiku-api-client/)
and [DSS public API documentation](https://doc.dataiku.com/dss/latest/publicapi/index.html).

Read-only verification on a pilot project returned 48 Flow nodes, 51 edges, four zones,
bounded dataset rows, the existing Python recipe payload, five native scenario
steps, nine folders, a Python library file, variables with revision metadata,
knowledge-bank source/build linkage, and a valid ZIP export with 148 entries.
Dataset/recipe/scenario updates and native step creation also passed live dry runs.
No project objects were changed by those checks.

`make test` covers mocked HTTP contracts, validation, stale revisions, bounded
streaming, error redaction, binary artifacts, checksum uploads, import-check cleanup,
schema transport and an actual MCP stdio handshake. Writes and runtime import
diagnostics have not been exercised against the live instance. Gemini transport
behavior has not been retested with a live Gemini invocation. These are explicit
verification limits, not claims of full DSS integration coverage.
