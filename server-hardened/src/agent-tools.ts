import { errorDetails } from './http-client.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AGENT_TYPES, AgentClient } from './agent-client.js';
import { buildStructuredAgentSettings, validateStructuredAgentSettings } from './structured-agent.js';
import { DETAIL_VALUES, getAgentView, listAgentsView } from './agent-summary.js';

const text = (description: string) => ({ type: 'string', minLength: 1, pattern: '\\S', description });
const object = (description: string) => ({ type: 'object', additionalProperties: true, description });
const project = { project_key: text('Dataiku project key') };
const agent = { ...project, agent_id: text('Agent ID returned by list_agents or create_agent') };
const tool = { ...project, tool_id: text('Managed agent tool ID') };
const version = { version_id: text('Version ID from get_agent. Defaults to the active version; fails if none is active.') };
const detail = (summary: string) => ({ detail: { type: 'string', enum: DETAIL_VALUES, default: 'summary', description: `summary (default) = ${summary}; full = complete DSS settings, including unused defaults of other agent types (large). Read full before patching arrays such as blocks or tools.` } });
const timeout = { timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 120, description: 'HTTP timeout; also configure the MCP client timeout. Timing out does not cancel execution in DSS.' } };
const patchDescription = 'Nested object patch: omitted fields are preserved, arrays are replaced, null is stored as null. Read current settings first.';

type Definition = { tool: Tool; run: (client: AgentClient, args: any) => Promise<unknown> };
function define(name: string, description: string, properties: Record<string, object>, required: string[], run: Definition['run'], readOnly = false, destructive = false): Definition {
  return {
    tool: {
      name, description,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: true },
    },
    run,
  };
}

async function structuredVersion(client: AgentClient, project: string, id: string, versionId?: string) {
  const settings = await client.getAgent(project, id);
  if (settings?.type !== 'STRUCTURED_AGENT') throw new Error('Structured agent tools require an agent of type STRUCTURED_AGENT');
  const selectedId = versionId ?? settings.activeVersion;
  const selected = Array.isArray(settings.versions) ? settings.versions.find((item: any) => item?.versionId === selectedId) : undefined;
  if (!selected) throw new Error('Agent version not found; inspect get_agent and specify version_id');
  return selected;
}

async function buildStructuredAgent(client: AgentClient, a: any) {
  const built = buildStructuredAgentSettings(a.spec);
  const dryRun = a.dry_run !== false;
  const report = { projectKey: a.project_key, id: a.agent_id, dryRun, valid: built.valid, errors: built.errors, warnings: built.warnings, structuredAgentSettings: built.settings };
  if (dryRun) return report;
  if (!built.valid || !built.settings) return { ...report, success: false, applied: false, error: 'Validation errors; nothing was saved' };
  const selected = await structuredVersion(client, a.project_key, a.agent_id, a.version_id);
  const saved = await client.updateAgentVersion(a.project_key, a.agent_id, { structuredAgentSettings: built.settings }, selected.versionId);
  return { ...report, versionId: saved.versionId, applied: true };
}

async function validateStructuredAgent(client: AgentClient, a: any) {
  const selected = await structuredVersion(client, a.project_key, a.agent_id, a.version_id);
  return { projectKey: a.project_key, id: a.agent_id, versionId: selected.versionId, ...validateStructuredAgentSettings(selected.structuredAgentSettings) };
}

const definitions: Definition[] = [
  define('list_agents', 'List DSS agents in a project, including visual, structured, Python, and plugin agents. Default is a compact list; detail="full" returns every agent\'s complete settings.', {
    ...project, ...detail('{id, name, type, activeVersion, versions: [{versionId, lastModifiedBy, lastModifiedOn}]}'),
  }, ['project_key'], async (c, a) => listAgentsView(await c.listAgents(a.project_key), a.detail), true),
  define('get_agent', 'Read agent settings. Default detail="summary" keeps, per version, only the settings of the agent\'s own type: structured blocks reduced to id, type, llmId, links, tool refs, loop flags and 200-char prompt previews; tool refs, llmId and prompt previews for simple visual agents; code length, first 300 characters and code env for Python agents. detail="full" returns the complete DSS settings.', {
    ...agent, ...detail('compact per-type settings'),
  }, ['project_key', 'agent_id'], async (c, a) => getAgentView(await c.getAgent(a.project_key, a.agent_id), a.detail), true),
  define('create_agent', 'Create an agent scaffold in DSS. Read get_agent and configure its returned version with update_agent_version before running.', {
    ...project, name: text('Agent display name'),
    agent_type: { type: 'string', enum: AGENT_TYPES, description: 'TOOLS_USING_AGENT = simple visual; STRUCTURED_AGENT = structured visual; PYTHON_AGENT = code; PLUGIN_AGENT = installed plugin.' },
    plugin_agent_type: text('Installed plugin component ID; required only for PLUGIN_AGENT'),
  }, ['project_key', 'name', 'agent_type'], (c, a) => c.createAgent(a.project_key, a.name, a.agent_type, a.plugin_agent_type)),
  define('update_agent', `Update agent metadata or select an existing activeVersion. ${patchDescription} Cannot change id, projectKey, type, or versions; use update_agent_version for version settings.`, {
    ...agent, updates: object(patchDescription),
  }, ['project_key', 'agent_id', 'updates'], (c, a) => c.updateAgent(a.project_key, a.agent_id, a.updates)),
  define('update_agent_version', `Configure one existing version, preserving other versions. Supports toolsUsingAgentSettings, pythonAgentSettings, structuredAgentSettings, and pluginAgentSettings as returned by get_agent with detail="full". ${patchDescription} Cannot change versionId.`, {
    ...agent, ...version, updates: object(patchDescription),
  }, ['project_key', 'agent_id', 'updates'], (c, a) => c.updateAgentVersion(a.project_key, a.agent_id, a.updates, a.version_id)),
  define('delete_agent', 'Permanently delete a DSS agent.', agent, ['project_key', 'agent_id'],
    (c, a) => c.deleteAgent(a.project_key, a.agent_id), false, true),
  define('attach_agent_tool', 'Attach a managed tool to a Simple Visual Agent version without duplicating existing references. Code agents call tools in Python; structured agents configure steps through update_agent_version.', {
    ...agent, ...version, tool_ref: text('Tool ID, or PROJECT.toolId for a tool shared from another project'), additional_description: text('Optional agent-specific description appended to the tool description'),
  }, ['project_key', 'agent_id', 'tool_ref'], (c, a) => c.changeAgentTool(a.project_key, a.agent_id, a.tool_ref, true, a.version_id, a.additional_description)),
  define('detach_agent_tool', 'Remove a tool reference from a Simple Visual Agent version. Does not delete the managed tool.', {
    ...agent, ...version, tool_ref: text('Exact tool reference to remove'),
  }, ['project_key', 'agent_id', 'tool_ref'], (c, a) => c.changeAgentTool(a.project_key, a.agent_id, a.tool_ref, false, a.version_id)),
  define('list_llms', 'List LLM IDs usable for generic completion in this project, for configuring agent llmId.', project, ['project_key'],
    (c, a) => c.listLlms(a.project_key), true),
  define('run_agent', 'Invoke the active agent through LLM Mesh (non-streaming). May incur LLM cost and execute mutating tools. Returns the full completion, including trace, memory and any tool validation requests; does not auto-approve them.', {
    ...agent, ...timeout,
    query: {
      ...object('DSS single completion query. Supply messages; optional context, memoryFragment, toolValidationResponses and other DSS query fields are passed through.'),
      properties: { messages: { type: 'array', minItems: 1, items: { type: 'object', properties: { role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] }, content: { type: 'string' } }, required: ['role', 'content'], additionalProperties: true } } },
      required: ['messages'],
    },
    settings: object('DSS completion settings such as temperature and maxOutputTokens'),
  }, ['project_key', 'agent_id', 'query'], (c, a) => c.runAgent(a.project_key, a.agent_id, a.query, a.settings, a.timeout_seconds), false, true),
  define('wake_up_agent', 'Request an agent instance to start if none is running.', { ...agent, ...version }, ['project_key', 'agent_id'],
    (c, a) => c.agentAction(a.project_key, a.agent_id, 'wakeup', a.version_id)),
  define('shutdown_agent', 'Shut down instances of an agent version. force=true cancels requests being processed.', {
    ...agent, ...version, force: { type: 'boolean', default: false },
  }, ['project_key', 'agent_id'], (c, a) => c.agentAction(a.project_key, a.agent_id, 'shutdown', a.version_id, a.force), false, true),
  define('list_agent_tools', 'List managed agent tools; optionally include tools shared from other projects.', {
    ...project, include_shared: { type: 'boolean', default: false },
  }, ['project_key'], (c, a) => c.listAgentTools(a.project_key, a.include_shared), true),
  define('get_agent_tool', 'Read complete managed tool settings, including type, params and approval settings.', tool, ['project_key', 'tool_id'],
    (c, a) => c.getAgentTool(a.project_key, a.tool_id), true),
  define('get_agent_tool_descriptor', 'Read a managed tool description and input schema before invoking it.', tool, ['project_key', 'tool_id'],
    (c, a) => c.getAgentToolDescriptor(a.project_key, a.tool_id), true),
  define('create_agent_tool', 'Create a managed agent tool. Tool types and creation parameters must match DSS and installed plugins. Configure the returned tool with update_agent_tool.', {
    ...project, tool_type: text('DSS tool type, for example VectorStoreSearch'), name: text('Display name; defaults to tool_type'), tool_id: text('Optional unique ID; generated by DSS if omitted'),
    creation_params: object('Type-specific creation parameters; VectorStoreSearch uses knowledgeBankRef'),
  }, ['project_key', 'tool_type'], (c, a) => c.createAgentTool(a.project_key, a.tool_type, a.name, a.tool_id, a.creation_params)),
  define('update_agent_tool', `Update managed tool settings, including params, name and description. ${patchDescription} Cannot change id, projectKey or type.`, {
    ...tool, updates: object(patchDescription),
  }, ['project_key', 'tool_id', 'updates'], (c, a) => c.updateAgentTool(a.project_key, a.tool_id, a.updates)),
  define('delete_agent_tool', 'Permanently delete a managed agent tool. Inspect agent references first.', tool, ['project_key', 'tool_id'],
    (c, a) => c.deleteAgentTool(a.project_key, a.tool_id), false, true),
  define('run_agent_tool', 'Invoke a managed tool directly. May modify DSS or external systems. Read get_agent_tool_descriptor first. Returns output, trace and validation data without automatically approving requests.', {
    ...tool, ...timeout,
    invocation: { ...object('DSS invocation envelope containing input, plus optional context, subtoolName, memoryFragment and toolValidationResponses.'), required: ['input'], properties: { input: {} } },
  }, ['project_key', 'tool_id', 'invocation'], (c, a) => c.runAgentTool(a.project_key, a.tool_id, a.invocation, a.timeout_seconds), false, true),
  define('build_structured_agent', 'Build Structured Visual Agent blocks from a compact spec and validate them. Kinds: routing, tool_call, agent_loop, llm, reflection, output; other DSS block types pass through as {id, type, raw}. Fields with an unconfirmed DSS format must be given through raw. dry_run (default true) only returns the settings and validation, with no DSS request. dry_run=false replaces structuredAgentSettings.blocks and startingBlockId of the version through update_agent_version, and refuses when validation has errors.', {
    ...agent, ...version,
    spec: { ...object('{start, blocks: [{id, kind, ...fields, raw?}], raw?}; see AGENTS-API.md for the field mapping'), required: ['start', 'blocks'] },
    dry_run: { type: 'boolean', default: true, description: 'true = build and validate only; false = save to DSS when valid' },
  }, ['project_key', 'agent_id', 'spec'], (c, a) => buildStructuredAgent(c, a)),
  define('validate_structured_agent', 'Read a Structured Visual Agent version with get_agent and validate its blocks: unique ids, start block, references, unreachable blocks, cycles without a loop block, and llmId where required.', {
    ...agent, ...version,
  }, ['project_key', 'agent_id'], (c, a) => validateStructuredAgent(c, a), true),
];

const validator = new AjvJsonSchemaValidator();
const registry = new Map(definitions.map(definition => [definition.tool.name, {
  ...definition, validate: validator.getValidator(definition.tool.inputSchema),
}]));

export const agentTools = definitions.map(definition => definition.tool);
export function isAgentTool(name: string): boolean { return registry.has(name); }

export async function callAgentTool(client: AgentClient, name: string, args: unknown): Promise<CallToolResult> {
  try {
    const definition = registry.get(name);
    if (!definition) throw new Error('Unknown agent tool');
    const validation = definition.validate(args);
    // Do not echo arbitrary argument values (which can contain secrets) in validation errors.
    if (!validation.valid) throw new Error(`Invalid arguments for ${name}; use the tool input schema`);
    const result = await definition.run(client, validation.data);
    const failed = result !== null && typeof result === 'object' && 'success' in result && result.success === false;
    return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }], ...(failed ? { isError: true } : {}) };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({error:errorDetails(error)}) }], isError: true };
  }
}
