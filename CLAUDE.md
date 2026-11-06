# CLAUDE.md

Guidance for Claude Code in this repository: a hardened MCP **stdio** server for Dataiku DSS 14.7.1, plus Codex plugin
metadata (`.codex-plugin/`) and a Dataiku operations skill (`skills/dataiku-operations/`). The repository is public
(MIT); treat everything committed here as published.

## Hard rules

- **Secrets:** never read, print, copy or commit `.env`, `.env.*` (except `.env.example`) or any API key. Check
  configuration by key (e.g. "is `DSS_HOST` set?"), never by dumping files. Real credentials never go in `.mcp.json`,
  source, tests, docs or commit messages; tests use dummy hosts/keys (`https://dss.example`).
- **No live Dataiku from development work.** `make test` is offline (mocked `fetch`). Talking to a real DSS instance
  (this server, or its MCP tools if connected) needs an explicit request from the user; start read-only and confirm
  before any write (create/update/delete, builds, scenario runs, clearing data).
- **Security posture is the product.** Do not weaken the controls in `server-hardened/SECURITY.md`: HTTPS by default
  (HTTP only with `DSS_ALLOW_HTTP=true`), `DSS_INSECURE_TLS=true` rejected, no redirects, no credentials/query/fragment in
  `DSS_HOST`, request timeouts, response size caps, result redaction, path-segment encoding, input-schema validation
  before dispatch. No generic remote-code execution tool, no telemetry, no home-directory env loading, no `child_process`.
- **Dependencies:** pinned exact versions, committed lockfile, `.npmrc` disables lifecycle scripts and pins the npm
  registry. Install only with `npm ci` (via `make install`); no `npx`, no runtime installs. Adding a dependency is a
  decision for the user: ask first, then update `sbom.cdx.json` and SECURITY.md.

## Commands (repository root; Node.js 22+)

```sh
make setup   # npm ci, typecheck, build, create a private .env from .env.example (keeps an existing .env)
make check   # tsc --noEmit
make build   # tsc -> server-hardened/dist (git-ignored)
make test    # build + node --test server-hardened/test/*.test.mjs (offline contract tests + MCP stdio handshake)
make audit   # npm audit --omit=dev --audit-level=high
make run     # start the server with .env (stdio; waits for an MCP client, no HTTP port)
```

Tests import from `dist/`, so `make test` (which builds first) is the reliable way to run them. Run `make check` and
`make test` before calling a change done; run `make audit` after any dependency change.

## Code map (`server-hardened/src`)

- `mcp-server.ts`: thin MCP `Server` setup. `tool-registry.ts` holds the catalog and `callTool`, the single path every
  call takes. `tool-policy.ts` is the gate in front of it (`DSS_INSTANCE_TYPE`, `DSS_ALLOW_DESTRUCTIVE`,
  `DSS_ENABLE_COBUILD`). New write tools are refused on automation nodes until added to `automationWrites`.
- `tool-def.ts`: `def(name, description, properties, required, run, readOnly)` and schema helpers. Use it for new tools.
- `operations-tools.ts` + `operations-client.ts`, and `coverage-tools.ts`: the newer tools, validated with Ajv before
  dispatch. `legacy-tools.ts`: upstream tools calling `DataikuClient`; several use endpoints absent from the SDK.
- `agent-tools.ts`, `agent-client.ts`, `agent-summary.ts`, `structured-agent.ts`: DSS agent and agent-tool management
  (see `AGENTS-API.md`).
- `provisioning.ts` (datasets, managed folders, schema autodetect; `PROVISIONING-API.md`), `intake-service.ts` and
  `intake-inspection.ts` (optional intake backend, PostgreSQL table inspection; `INTAKE-API.md`).
- `http-client.ts`: fetch wrapper (timeouts, size caps, redaction, error details). `artifacts.ts`: private local
  artifacts for large results (`.artifacts/`, git-ignored). `dataiku-client.ts`: host/key validation and clients.
- `usage-rules.ts`: the Flow design rules sent as MCP `instructions` on every connection and via `get_usage_rules`
  (native recipes first; one output and <= 1,000 lines per Python recipe, enforced in `update_recipe`; Bronze/Silver/Gold
  zones). Canonical text lives here; rebuild and reconnect the client after changing it.

## Conventions

- Code style is dense, matching the existing files; keep changes minimal and in the file's style.
- Every new or changed tool: an input schema with bounds (`minLength`, `maximum`, `maxItems`, `additionalProperties:
  false`), correct `readOnlyHint`/`destructiveHint`, URL segments through `seg()`, a description that states what it
  does NOT do, and an offline test in `server-hardened/test/` that mocks `fetch` and asserts the exact request
  (URL, method, body) and that no unexpected request is made.
- Write tools that update settings preserve unspecified fields and support `dry_run` / expected version or hash
  where the DSS API allows it; report partial state on failure instead of retrying blindly.
- When adding tools, update docs in the same change (`README.md`, the matching `*-API.md`, `SECURITY.md` verification
  notes). `test/docs.test.mjs` enforces tool counts; regenerate the table with
  `UPDATE_CAPABILITIES=1 make test`.

## Known doc drift (fix when touching these files)

- The lower part of `server-hardened/README.md` and `TODO.md` (Chinese) are upstream text, kept for provenance
  (`UPSTREAM.md`).
- `.mcp.json` starts `node server-hardened/dist/mcp-server.js` and expects `DSS_HOST`/`DSS_API_KEY` in the client's
  environment; the README's `make -C <repo> run` form reads `.env` instead.

## Git

Remote: `origin` on GitHub. Commit or push only when the user asks; never force-push. Do not commit `dist/`,
`node_modules/`, `.artifacts/`, logs or any env file.
