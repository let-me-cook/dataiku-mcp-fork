# Audited Dataiku MCP server

This public repository contains the audited Dataiku DSS MCP integration used with Codex. It includes a hardened TypeScript server, the Codex plugin metadata, and the Dataiku operations skill.

The server exposes **114 tools** by default and **118 tools** with an intake backend. See the [capability list](server-hardened/CAPABILITIES.md).

## Scope

- Uses the Dataiku DSS REST API over HTTPS by default, with explicit HTTP opt-in.
- Reads `DSS_HOST` and `DSS_API_KEY` from the environment; credentials are never committed.
- Validates the DSS host and rejects embedded credentials, query strings, and fragments.
- Uses a pinned MCP SDK dependency and includes an SBOM and security notes.
- Excludes `node_modules`, build output, caches, and local secrets.

## Quick start

Requires **Node.js 22+**, npm, and Make. Run these commands from the repository root:

```sh
make setup
```

Setup installs the locked dependencies, typechecks and builds the server, and creates a private, Git-ignored `.env`. Running setup again preserves your existing `.env`.

Edit `.env` with your Dataiku connection details:

```dotenv
DSS_HOST=https://your-dataiku-instance.example.com
DSS_API_KEY=your-api-key
```

Then start the server:

```sh
make run
```

This is an MCP **stdio** server: it waits for an MCP client on standard input, and does not open a web page or HTTP port. Press Ctrl+C to stop it when running interactively.

Node loads the root `.env` directly; existing process environment variables take precedence. HTTPS requires a trusted certificate. Never put real credentials in `.mcp.json` or source files.

For an HTTP-only instance on a trusted network, use its `http://` URL and add `DSS_ALLOW_HTTP=true` to `.env`. HTTP sends the API key and data without transport encryption. The opt-in does not disable certificate verification for HTTPS or allow redirects.

For an MCP client, use `make` as the command with arguments `--no-print-directory`, `-s`, `-C`, `/absolute/path/to/mcp-dataiku-audited`, `run`. Run `make setup` before connecting the client. The existing `.mcp.json` launches Node directly and still expects credentials in the host environment.

## Safety switches

Set these in `.env` or the MCP client environment. Only the exact value `true` turns a switch on.

| Variable | Default | Effect |
| --- | --- | --- |
| `DSS_INSTANCE_TYPE` | `design` | `automation` refuses every tool that edits a project, while reads and runs of existing assets stay available. Any other value stops the server at startup. |
| `DSS_ALLOW_DESTRUCTIVE` | off | Allows `clear_dataset` and the delete tools. |
| `DSS_INTAKE_URL` | unset | Lists the four intake tools. They need a compatible backend; see the [Intake API](server-hardened/INTAKE-API.md). |

To use more than one DSS instance, add one MCP server entry per instance. The server never stores profiles or switches instances itself.

## Client setup

- **Codex:** the plugin metadata is in `.codex-plugin/`. Run `make setup` first.
- **Claude Code:** run `make setup`, then start with `claude --plugin-dir /absolute/path/to/mcp-dataiku-audited` and set the variables above in that environment. The manifest is in `.claude-plugin/`.

Do not enable this server and Dataiku Headless in the same client, because they share tool names.

## Development

```sh
make check  # TypeScript validation
make build  # Rebuild after source changes
make test   # Offline API contract tests and MCP handshake
make audit  # Audit production dependencies
make help   # List commands
```

## Standing Flow design rules

Every MCP connection receives these instructions during initialization. They are also available through `get_usage_rules` and repeated in relevant design/edit tool descriptions:

1. Prefer native visual recipes/processors. Use Python only when native functionality is insufficient, and explain why.
2. Each Python recipe/node must have exactly one output and no more than 1,000 lines, including comments and blank lines. Split larger code into focused nodes.
3. Organize flows neatly into Bronze, Silver, and Gold zones. Prioritize appearance, consistent naming, and readable connections; strict medallion semantics are optional.

Every connection receives the rules, but client adherence is not guaranteed. `update_recipe` enforces the Python output/line limits on the resulting recipe settings. Native-first choices and appearance remain agent guidance; this is not complete enforcement across all write paths or prompts installed in DSS agents. Flow-zone tools now support creation, placement and sharing. Existing objects are not automatically reorganized.

The canonical rules live in `server-hardened/src/usage-rules.ts`. After changing them, run `make build` and reconnect your MCP client to receive the updated initialization instructions.

## Agent management tools

The server includes tools for creating and managing simple visual, structured visual, Python code, and plugin agents, plus their managed tools, including a builder and validator for structured visual agents. It supports version-specific configuration, visual-agent tool attachment, agent/tool invocation, and agent wakeup/shutdown.

`list_agents` and `get_agent` return compact summaries by default; pass `detail: "full"` for complete settings. See the [agent usage guide](server-hardened/AGENTS-API.md) for the tool catalog, examples, prerequisites, and validation limits. After upgrading, run `make build` and restart your MCP connection to discover the new tools.

## Pilot operations improvements

Flow graphs, bounded dataset samples, recipe code,
ZIP exports, and typed update patches use the DSS contracts. Added operations
cover folders, zones, Python library files, scoped variables, environments, jobs,
knowledge banks, startup diagnostics, and native scenario Build/Train steps.

See [Operations API](server-hardened/OPERATIONS-API.md) for schemas, artifact handling,
provider schema transport, concurrency limits, and live versus mocked verification.
Run `make build` and restart the MCP client after upgrading.

## Intake improvements

Library creation now checks the tree and verifies saved content; zone updates verify
persisted coordinates. New tools inspect PostgreSQL tables/constraints and summarize
run-scoped extraction evidence independently of job status. Typed upload-registration
and metadata-row adapters are available for a configured backend; they report not
configured until a compatible service is connected.

See [Intake API](server-hardened/INTAKE-API.md) for the backend contract, exact limits,
and verification. No access to the existing application's source is required to use
the independent Dataiku improvements.

## Provisioning improvements

`create_dataset` now sends the SDK-required `projectKey` and verifies saved settings.
New tools create verified managed folders on existing connections, connect external
PostgreSQL tables, and preview/save detected schemas with revision checks.
See [Provisioning API](server-hardened/PROVISIONING-API.md) for examples and partial-failure
handling.

## Upstream

This server is a hardened fork of [steven0lisa/mcp-dataiku](https://github.com/steven0lisa/mcp-dataiku) v1.0.7; see [UPSTREAM.md](server-hardened/UPSTREAM.md). Several features were reimplemented after reviewing [dataiku/dataiku-headless](https://github.com/dataiku/dataiku-headless) (Apache-2.0); no Headless code is included. This is not an official Dataiku product.

## License

MIT. See `server-hardened/LICENSE`.
