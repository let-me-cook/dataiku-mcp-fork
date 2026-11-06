# Agent management for Dataiku DSS

Run `make setup`, configure the root `.env`, then connect your MCP client using the [root quick start](../README.md#quick-start). After a source update, run `make build` and restart the MCP connection.

## Available MCP tools

| Task | Tools |
|---|---|
| Discover agents and usable LLMs | `list_agents`, `get_agent`, `list_llms` |
| Create, configure, delete agents | `create_agent`, `update_agent`, `update_agent_version`, `delete_agent` |
| Attach/detach Simple Visual Agent tools | `attach_agent_tool`, `detach_agent_tool` |
| Build and check Structured Visual Agents | `build_structured_agent`, `validate_structured_agent` |
| Invoke and manage instances | `run_agent`, `wake_up_agent`, `shutdown_agent` |
| Discover managed tools | `list_agent_tools`, `get_agent_tool`, `get_agent_tool_descriptor` |
| Create, configure, delete managed tools | `create_agent_tool`, `update_agent_tool`, `delete_agent_tool` |
| Invoke a managed tool | `run_agent_tool` |

Creation supports `TOOLS_USING_AGENT` (simple visual), `STRUCTURED_AGENT` (structured visual), `PYTHON_AGENT` (code), and `PLUGIN_AGENT` (requires an installed plugin component ID). Creation returns a scaffold; configure it before invoking it.

## Summary and full detail

A saved DSS agent carries defaults for every agent type in each version (`ragllmSettings`, guardrails, interaction logging, Python and plugin settings), so complete settings are about 10k tokens per agent. `list_agents` and `get_agent` therefore return a summary by default; pass `"detail": "full"` for the complete DSS settings.

- `list_agents` summary: `[{id, name, type, activeVersion, versions: [{versionId, lastModifiedBy, lastModifiedOn}]}]` (`lastModifiedBy` is the login from `versionTag`).
- `get_agent` summary: `id`, `projectKey`, `name`, `type`, `activeVersion`, `tags`, `detail: "summary"` and, per version, the version header plus only the settings of the agent's own type:
  - `STRUCTURED_AGENT`: `structuredAgentSettings` with `startingBlockId`, `nextTurnBehaviour` and `blocks` reduced to `id`, `type`, `llmId`, links (`nextBlock`, `nextBlockIfPass`, `defaultNextBlock`, `generatorBlockId`, routing `routes: [{when, to}]`), `tools` (tool refs), `maxLoopIterations`, `critiqueMaxIterations`, `scratchpadAware`, `stateAware`, `passConversationHistory`, `outputMode`, `mode`, `routingMode`, and `prompts: {field: {length, preview}}` (first 200 characters of each prompt, instruction or template field).
  - `TOOLS_USING_AGENT`: `toolsUsingAgentSettings` with `llmId`, `tools: [{toolRef, additionalDescription}]` and prompt previews.
  - `PYTHON_AGENT`: `pythonAgentSettings` with `codeLength`, `codePreview` (first 300 characters) and `codeEnvSelection`.
  - `PLUGIN_AGENT`: `pluginAgentSettings` unchanged.

Read `detail: "full"` before you patch with `update_agent_version`: patches replace arrays, so editing `blocks` or `tools` needs the complete current entries. `update_agent_version`, `attach_agent_tool`, `build_structured_agent` and `validate_structured_agent` always read the complete settings themselves. `get_agent_tool` is small and has no detail flag.

## Example: create a visual agent and connect a knowledge-bank tool

These are MCP tool names and their JSON arguments. Substitute IDs returned by DSS; `v1` below is an example, so inspect the actual version IDs with `get_agent` (the default summary lists them).

1. Find an available model with `list_llms`:

   ```json
   {"project_key":"MYPROJECT"}
   ```

2. Call `create_agent`:

   ```json
   {"project_key":"MYPROJECT","name":"Knowledge assistant","agent_type":"TOOLS_USING_AGENT"}
   ```

3. Call `get_agent` with the returned ID, then `update_agent_version`:

   ```json
   {"project_key":"MYPROJECT","agent_id":"AGENT_ID","version_id":"v1","updates":{"toolsUsingAgentSettings":{"llmId":"LLM_ID"}}}
   ```

4. Call `create_agent_tool` using an existing, accessible knowledge bank:

   ```json
   {"project_key":"MYPROJECT","tool_type":"VectorStoreSearch","name":"Search knowledge","creation_params":{"knowledgeBankRef":"KNOWLEDGE_BANK_ID"}}
   ```

5. Call `attach_agent_tool` with the returned tool ID:

   ```json
   {"project_key":"MYPROJECT","agent_id":"AGENT_ID","version_id":"v1","tool_ref":"TOOL_ID"}
   ```

6. If necessary, select the configured version with `update_agent`:

   ```json
   {"project_key":"MYPROJECT","agent_id":"AGENT_ID","updates":{"activeVersion":"v1"}}
   ```

7. Call `run_agent`:

   ```json
   {"project_key":"MYPROJECT","agent_id":"AGENT_ID","query":{"messages":[{"role":"user","content":"Summarize the available documentation."}]},"timeout_seconds":120}
   ```

## Code, structured, and plugin agents

Create a code agent with `agent_type: "PYTHON_AGENT"`, then inspect `get_agent` with `detail: "full"`. Use `update_agent_version` to patch the returned version's `pythonAgentSettings`, including its source and code-environment configuration. Use the exact fields returned by your instance. This MCP sends code to DSS; it does not execute that Python locally.

Code agents require a DSS Python 3.10+ code environment. The remote environment must contain any libraries used by the code. Their Python can invoke a managed tool as follows:

```python
import dataiku

tool = dataiku.api_client().get_project("MYPROJECT").get_agent_tool("TOOL_ID")
result = tool.run({"searchQuery": "A question"})
```

Read `get_agent_tool_descriptor` to discover each tool's input schema. For example, a direct `run_agent_tool` call for the search tool is:

```json
{"project_key":"MYPROJECT","tool_id":"TOOL_ID","invocation":{"input":{"searchQuery":"A question"}}}
```

For structured agents, build the blocks from a compact spec with `build_structured_agent` (next section), or patch the returned `structuredAgentSettings` directly. For plugin agents, supply `plugin_agent_type` when creating and patch `pluginAgentSettings`. The attachment helpers apply specifically to Simple Visual Agents; code and structured agents use their own configuration mechanisms.

Managed tool creation accepts the DSS tool type and its `creation_params`. Use `get_agent_tool` followed by `update_agent_tool` to edit the returned `params`, metadata, or approval settings. Built-in and custom/plugin tool types depend on what is available on your instance; the MCP does not install plugins or create code environments.

## Structured Visual Agents from a compact spec

`build_structured_agent` turns a short spec into the `structuredAgentSettings` blocks DSS saves, and validates them. With `dry_run` (default `true`) it sends no request and returns `structuredAgentSettings`, `valid`, `errors` and `warnings`. With `dry_run: false` it checks that the agent is a `STRUCTURED_AGENT` and the version exists, then saves through `update_agent_version`: `blocks` and `startingBlockId` are replaced, other settings are kept. It refuses to save when validation has errors. `validate_structured_agent` reads a version (default: active) with `get_agent` and runs the same checks.

Each block starts from the defaults DSS saved for its type; the spec only overrides mapped fields. Six block types are confirmed from blocks saved by the DSS 15 GUI:

| `kind` | DSS `type` | Spec field → DSS field |
|---|---|---|
| `routing` | `ROUTING` | `branches: [{when, to}]` → `clausesBasedDecisions: [{clause: {type: "EXPRESSION", expression: {language: "CEL", expression: when}}, nextBlock: to}]`, `else` → `defaultNextBlock` |
| `tool_call` | `MANDATORY_TOOL_CALL` | `llm` → `llmId` (required), `tool` → `tool` (required), `next` → `nextBlock` |
| `agent_loop` | `CORE_LOOP` | `llm` → `llmId` (required), `tools` → `tools`, `instructions` → `systemPromptAfterHistory`, `maxIterations` → `maxLoopIterations`, `next` → `defaultNextBlock` |
| `llm` | `LLM_REQUEST` | `llm` → `llmId` (required), `prompt` → `systemPromptAfterHistory`, `next` → `nextBlock` |
| `reflection` | `REFLECTION` | `generator` → `generatorBlockId` (required), `expectations` → `expectationsPrompt`, `maxIterations` → `critiqueMaxIterations`, `next` → `nextBlockIfPass` |
| `output` | `GENERATE_OUTPUT` | `template` → `template` (required) |

A tool ID in `tool` or `tools` becomes the reference the GUI saves: `{"forwardContext":true,"returnArtifacts":true,"returnSources":true,"enableSetArgs":false,"setArgs":[],"outputHandling":"ADD_TO_MESSAGES","treatAsJSON":false,"type":"EXPLICIT_TOOL","toolRef":"TOOL_ID"}`. A tool object is used as given, and so is a branch object that already has a `clause`.

Every block accepts `raw`, which is deep-merged last (it cannot change `id` or `type`); `spec.raw` is merged into the top-level settings. The other nine GUI block types (Delegate to Other Agent, Manual Tool Call, For Each, Parallel, Set State Entries, Set Scratchpad Entries, Context Compression, Generate Artifact, Python Code) have no confirmed template: give them as `{"id": ..., "type": "<DSS type>", "raw": {...}}` and they pass through untouched with a warning.

Validation errors:

- duplicate or missing block ids, or a `startingBlockId` that is not a block;
- a `nextBlock`, `nextBlockIfPass`, `defaultNextBlock`, `generatorBlockId` or `clausesBasedDecisions[].nextBlock` that points to a missing block;
- a missing `llmId` on `MANDATORY_TOOL_CALL`, `CORE_LOOP` or `LLM_REQUEST`;
- a `MANDATORY_TOOL_CALL` without a tool, or an `EXPLICIT_TOOL` reference without `toolRef`;
- a routing clause without a `clause`, or an `EXPRESSION` clause without a non-empty CEL expression.

Warnings:

- blocks unreachable from the start (a Reflection's generator counts as reached);
- cycles that pass through no `CORE_LOOP` or `REFLECTION`;
- routing without clauses;
- block types, clause types and tool types with no confirmed format.

`resultDispatch` and `validNextBlocksFromExpression` (other routing modes) are unconfirmed. Their targets are checked by key names containing `block` and as plain block IDs.

Example `build_structured_agent` call using the six confirmed kinds (substitute `LLM_ID` from `list_llms` and `TOOL_ID` from `list_agent_tools`):

```json
{"project_key":"MYPROJECT","agent_id":"AGENT_ID","version_id":"v1","dry_run":true,"spec":{
  "start":"route",
  "blocks":[
    {"id":"route","kind":"routing","branches":[{"when":"message contains 'search'","to":"tool"}],"else":"loop"},
    {"id":"tool","kind":"tool_call","llm":"LLM_ID","tool":"TOOL_ID","next":"loop"},
    {"id":"loop","kind":"agent_loop","llm":"LLM_ID","tools":["TOOL_ID"],"instructions":"Answer from the documents.","maxIterations":8,"next":"judge"},
    {"id":"draft","kind":"llm","llm":"LLM_ID","prompt":"Summarize the answer.","next":"out"},
    {"id":"judge","kind":"reflection","generator":"draft","expectations":"Every claim cites a document.","maxIterations":2,"next":"out"},
    {"id":"out","kind":"output","template":"{{answer}}"}
  ]}}
```

Review the returned settings and warnings, then repeat with `"dry_run":false`. Follow with `validate_structured_agent` (`{"project_key":"MYPROJECT","agent_id":"AGENT_ID","version_id":"v1"}`) to check what DSS stored.

## Editing and execution behavior

- Settings updates fetch the current document, recursively merge object fields, and save the full document. Omitted fields remain unchanged, arrays are replaced, and null is stored as null. Avoid simultaneous edits in DSS and the MCP: these are read-modify-write operations, without atomic conflict detection.
- `update_agent_version` edits one existing version. With no `version_id`, it uses `activeVersion` and fails if there is no matching version. Creating/cloning agent versions is not exposed.
- Top-level agent identity, type, and the versions array are protected from generic patches. Tool identity and type are also protected. Select an existing active version through `update_agent`.
- `run_agent` invokes the active version using text messages through LLM Mesh. It returns the full completion response, including trace, memory, sources, and tool validation requests when present. It does not automatically grant approval. To continue, pass the corresponding DSS query fields, such as `memoryFragment` and explicitly supplied `toolValidationResponses`.
- Agent and tool invocations may incur LLM costs and execute mutations. The default HTTP timeout is 120 seconds, configurable from 1 to 600 seconds per invocation. Configure the MCP client's timeout accordingly. A timeout does not cancel an operation on DSS; inspect the instance before retrying a mutation. Streaming is not exposed.
- Wakeup/shutdown results acknowledge the request; they do not prove that an instance has finished starting or stopping. Instance status polling is not exposed.
- HTTPS is the default; HTTP-only instances require explicit `DSS_ALLOW_HTTP=true` and send credentials without transport encryption. Existing API-key permissions apply to every operation. DSS agent/LLM availability, project permissions, and remote code-environment setup must be configured on the instance.

## Verification and API provenance

`make test` runs offline HTTP contract tests and an actual MCP stdio handshake through `make run`, with dummy credentials and no requests to Dataiku. It covers creation for all four agent types, settings preservation, tool wiring, invocation payloads, authentication, validation, errors, timeouts, and endpoint encoding.

The endpoint methods and payloads were checked against Dataiku's official [dataiku-api-client source distribution](https://pypi.org/project/dataiku-api-client/), specifically `dss/project.py`, `dss/agent.py`, `dss/agent_tool.py`, `dss/llm.py`, and `dssclient.py`. The source archive SHA-256 is `195f392dbfc61db3cb66093f5e7349b9e7a9d51de7c34dee7d36e208ad054339`. The Python package is a development reference and is not installed or required at runtime.

These tests verify the client contract, not a live DSS deployment. See also Dataiku's [DSS Code Agents documentation](https://doc.dataiku.com/dss/latest/agents/code-agents.html).
