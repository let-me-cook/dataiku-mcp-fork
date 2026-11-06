# Security baseline

This fork focuses on source, artifact, and dependency hardening. Tool-level authorization and enterprise deployment are intentionally out of scope for this phase.

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

## Agent extension verification

Run `make test` from the repository root for offline 14.7.1 API contract tests and MCP stdio discovery. These tests use dummy credentials and mocked HTTP responses; they do not establish live instance compatibility. See [AGENTS-API.md](AGENTS-API.md) for supported operations and exact upstream API provenance. No runtime dependencies were added for this extension.

## Pilot operations verification

Typecheck, build, all 33 tests, and the production dependency audit pass. A fresh
MCP stdio connection exposes 87 unique tools and reads a live pilot project graph and
bounded dataset sample. See [Operations API](OPERATIONS-API.md) for all live checks,
write-test limits, artifact retention, fixed import diagnostics, and best-effort
concurrency. There is no generic remote-code execution tool in the new operations.

## Original baseline verification (before the agent extension)

- TypeScript typecheck: passed.
- Production build: passed.
- MCP initialize handshake: passed, protocol 2025-11-25.
- Tool discovery: passed, 44 tools.
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

The fresh MCP connection exposes 94 unique tools; all 55 tests pass. Optional
intake-service credentials are separate from DSS credentials, with an operator-set
URL and project allowlist. Upload registration and keyed metadata writes require
a compatible backend and do not fall back to direct file/table mutations.
Database inspection executes only fixed PostgreSQL catalog queries through DSS.
See [Intake API](INTAKE-API.md) for backend guarantees, retry rules, verification
limits, and read-back checks on library/zone changes. No dependencies were added.
