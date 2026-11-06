# Security baseline

This fork focuses on source, artifact, and dependency hardening. Enterprise deployment is out of scope. A small tool policy (below) adds coarse guards, but it does not replace DSS permissions: the API key's rights still apply.

## Controls applied

- Pinned `@modelcontextprotocol/sdk` to `1.30.0`.
- Removed Axios and dotenv.
- Uses the Node.js native `fetch` implementation.
- Sends DSS API keys using HTTP Basic authentication (key as username, empty password), matching the official DSS 14.7.1 client.
- Defaults to HTTPS for `DSS_HOST`. Explicit `DSS_ALLOW_HTTP=true` permits HTTP on a trusted network; the API key and data then travel without transport encryption. This does not bypass HTTPS certificate validation or the redirect restriction.
- Rejects insecure TLS mode, redirects, credentials in URLs, query strings, and fragments.
- Applies a 30 second request timeout.
- Agent/tool invocations use a 120 second timeout by default, explicitly adjustable to 1–600 seconds. A timeout does not cancel remote execution.
- Streams API responses with a default 5 MiB cap; artifact operations allow explicit limits up to 100 MiB. Inline tool JSON is limited to 256 KiB; larger sanitized results become private local artifacts.
- Redacts known credentials and secret-like fields in tool results and structured HTTP errors. Arbitrary secrets in prose cannot be recognized reliably; raw downloadable artifacts remain private and are not content-redacted.
- Pins all direct dependencies and commits a lockfile.
- Disables npm lifecycle scripts through `.npmrc`.
- Uses only `https://registry.npmjs.org/`.
- New agent MCP tools validate input schemas before dispatch, encode URL path segments, and preserve unspecified settings during updates. Invocation tools do not automatically approve DSS tool validation requests.

## Tool policy

Every tool call passes through one gate in `tool-registry.ts` before any request is sent, and every tool's arguments are validated against its schema. See the [capability list](CAPABILITIES.md).

- `DSS_INSTANCE_TYPE=automation` refuses all non-read tools except an explicit list of run and abort tools, so a new write tool is refused until it is listed. An unknown value stops startup. The value is declared by the operator, not detected from DSS.
- `DSS_ALLOW_DESTRUCTIVE=true` is needed for `clear_dataset`, `delete_recipe`, `delete_dataset`, `delete_scenario`, `delete_agent`, `delete_agent_tool`, `batch_update_objects`, `duplicate_project_structure` and approving a Cobuild deletion. It covers only this list: other writes can still lose data, including `remove_scenario_trigger`, `upload_managed_folder_file` with `overwrite: replace`, `shutdown_agent` with `force`, and any build.
- Cobuild tools are hidden and refused unless `DSS_ENABLE_COBUILD=true` on a design instance. Cobuild is another agent acting inside DSS, so its edits have no `dry_run` or revision check here; read changed objects back.
- User, group and plugin tools are read-only and return allow-listed fields. Emails and settings are not returned.

## Code execution on DSS

There is no generic remote-code execution tool, but this server can still cause arbitrary Python or SQL to run on DSS: `create_recipe` or `update_recipe` with `run_recipe` or `start_job`, a `PYTHON_AGENT` with `run_agent`, an inline Python tool from `create_agent_tool` or `update_agent_tool` with `run_agent_tool`, and project library files used by those. This is intended for normal recipe work and is not gated. Treat an agent connected to this server as able to run code with the DSS permissions of its key and code environments.

## Older upstream tools

The upstream tools now have schemas with bounds, annotations and URL segment encoding. `check_dataset_metrics` and `create_scenario` were corrected to the SDK request shape, and their filters now apply client-side, but none of this has run against a live instance. Several call endpoints that were not found in the `dataiku-api-client` 14.7.1 source and may fail on a real instance: `run_recipe`, `build_dataset`, `clear_dataset`, `validate_recipe_syntax`, `test_recipe_dry_run`, `add_scenario_trigger`, `remove_scenario_trigger`, `get_scenario_logs`, `get_scenario_run_history`, `clone_scenario`, `search_project_objects`, `batch_update_objects`, `duplicate_project_structure`, and the project-scoped forms of `get_code_environments` and `get_connections`. Their descriptions say so.

## Headless-derived tools verification

Request shapes for the job, profile, library search, data quality, ML, agent review, project, folder, admin and Cobuild tools were checked against the `dataiku-api-client` 14.7.1 source and tested offline with mocked HTTP. They have not been run against a live instance. No dependencies were added.

## Agent extension verification

Run `make test` from the repository root for offline 14.7.1 API contract tests and MCP stdio discovery. These tests use dummy credentials and mocked HTTP responses; they do not establish live instance compatibility. See [AGENTS-API.md](AGENTS-API.md) for supported operations and exact upstream API provenance. No runtime dependencies were added for this extension.

## Pilot operations verification

Typecheck, build, the tests at that point, and the production dependency audit passed. A fresh
MCP stdio connection read a live pilot project graph and
bounded dataset sample. See [Operations API](OPERATIONS-API.md) for all live checks,
write-test limits, artifact retention, fixed import diagnostics, and best-effort
concurrency. There is no generic remote-code execution tool in the new operations.

## Original baseline verification (before the agent extension)

- TypeScript typecheck: passed.
- Production build: passed.
- MCP initialize handshake: passed, protocol 2025-11-25.
- Tool discovery: passed.
- Read-only Dataiku `list_projects`: passed.
- Production npm audit: 0 known vulnerabilities.
- Registry signatures: 97 of 97 packages verified.
- Lockfile registry check: passed.
- Static scan found no Axios, dotenv, home-directory env loading, telemetry, analytics, or application-level command execution.

## Reproduce

```powershell
npm ci
npm run check
npm run build
npm audit --omit=dev --audit-level=high
npm audit signatures
```

Do not use `npx` or install dependencies at runtime. Build from the committed lockfile.

## Intake upgrade

Optional
intake-service credentials are separate from DSS credentials, with an operator-set
URL and project allowlist. Upload registration and keyed metadata writes require
a compatible backend and do not fall back to direct file/table mutations.
Database inspection executes only fixed PostgreSQL catalog queries through DSS.
See [Intake API](INTAKE-API.md) for backend guarantees, retry rules, verification
limits, and read-back checks on library/zone changes. No dependencies were added.
