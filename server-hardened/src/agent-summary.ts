type Settings = Record<string, any>;

/**
 * Compact views of DSS agent settings. A saved agent carries defaults for every agent type
 * (ragllmSettings, guardrails, logging, Python and plugin settings) whether or not they are used;
 * the summaries keep only what the agent's own type uses. Use detail "full" to read or patch
 * complete settings.
 */
export const DETAIL_VALUES = ['summary', 'full'];

const PROMPT_PREVIEW = 200;
const CODE_PREVIEW = 300;
const PROMPT_FIELD = /prompt|instructions|template|expectations/i;
const NOT_PROMPT_FIELD = /type$|mode$/i;
const LINK_FIELDS = ['nextBlock', 'nextBlockIfPass', 'defaultNextBlock', 'generatorBlockId'];
const BLOCK_FIELDS = ['maxLoopIterations', 'critiqueMaxIterations', 'scratchpadAware', 'stateAware', 'passConversationHistory', 'outputMode', 'mode', 'routingMode'];

const isObject = (value: unknown): value is Settings => value !== null && typeof value === 'object' && !Array.isArray(value);
const defined = (entries: Array<[string, unknown]>): Settings =>
  Object.fromEntries(entries.filter(([, value]) => value !== undefined));

function preview(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** Non-empty prompt-like string fields of one object, as {field: {length, preview}}. */
function prompts(settings: Settings) {
  const found = Object.entries(settings)
    .filter(([key, value]) => PROMPT_FIELD.test(key) && !NOT_PROMPT_FIELD.test(key) && typeof value === 'string' && value.trim() !== '')
    .map(([key, value]) => [key, { length: (value as string).length, preview: preview(value as string, PROMPT_PREVIEW) }] as [string, unknown]);
  return found.length ? Object.fromEntries(found) : undefined;
}

function toolRefs(value: unknown) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const refs = list.map(entry => isObject(entry) ? (entry.toolRef ?? entry.type ?? null) : entry);
  return refs.length ? refs : undefined;
}

function routes(block: Settings) {
  if (!Array.isArray(block.clausesBasedDecisions) || !block.clausesBasedDecisions.length) return undefined;
  return block.clausesBasedDecisions.map((clause: unknown) => {
    if (!isObject(clause)) return clause;
    const expression = clause.clause?.expression?.expression;
    return defined([['when', typeof expression === 'string' ? preview(expression, PROMPT_PREVIEW) : undefined], ['to', clause.nextBlock]]);
  });
}

function summarizeBlock(block: unknown) {
  if (!isObject(block)) return block;
  return defined([
    ['id', block.id], ['type', block.type], ['llmId', block.llmId],
    ...LINK_FIELDS.map(field => [field, block[field] ?? undefined] as [string, unknown]),
    ['routes', routes(block)],
    ['tools', toolRefs(block.tools ?? block.tool)],
    ...BLOCK_FIELDS.map(field => [field, block[field]] as [string, unknown]),
    ['prompts', prompts(block)],
  ]);
}

function summarizeStructured(settings: Settings) {
  return defined([
    ['startingBlockId', settings.startingBlockId], ['nextTurnBehaviour', settings.nextTurnBehaviour],
    ['blocks', Array.isArray(settings.blocks) ? settings.blocks.map(summarizeBlock) : settings.blocks],
  ]);
}

function summarizeToolsUsing(settings: Settings) {
  const tools = Array.isArray(settings.tools) ? settings.tools.map((entry: unknown) => isObject(entry)
    ? defined([['toolRef', entry.toolRef], ['additionalDescription', typeof entry.additionalDescription === 'string' ? preview(entry.additionalDescription, PROMPT_PREVIEW) : undefined]])
    : entry) : settings.tools;
  return defined([['llmId', settings.llmId], ['tools', tools], ['prompts', prompts(settings)]]);
}

function summarizePython(settings: Settings) {
  const code = typeof settings.code === 'string' ? settings.code : undefined;
  return defined([
    ['codeLength', code?.length ?? 0], ['codePreview', code === undefined ? undefined : preview(code, CODE_PREVIEW)],
    ['codeEnvSelection', settings.codeEnvSelection],
  ]);
}

const BY_TYPE: Record<string, { field: string; summarize: (settings: Settings) => Settings }> = {
  STRUCTURED_AGENT: { field: 'structuredAgentSettings', summarize: summarizeStructured },
  TOOLS_USING_AGENT: { field: 'toolsUsingAgentSettings', summarize: summarizeToolsUsing },
  PYTHON_AGENT: { field: 'pythonAgentSettings', summarize: summarizePython },
  PLUGIN_AGENT: { field: 'pluginAgentSettings', summarize: settings => structuredClone(settings) },
};

/** {versionId, lastModifiedBy (login), lastModifiedOn} from a version's versionTag. */
function versionHeader(version: Settings) {
  const tag = isObject(version.versionTag) ? version.versionTag : {};
  const by = isObject(tag.lastModifiedBy) ? tag.lastModifiedBy.login : tag.lastModifiedBy;
  return { versionId: version.versionId, lastModifiedBy: by ?? null, lastModifiedOn: tag.lastModifiedOn ?? null };
}

function versions(agent: Settings, body?: (version: Settings) => Settings) {
  if (!Array.isArray(agent.versions)) return agent.versions;
  return agent.versions.map((version: unknown) => isObject(version) ? { ...versionHeader(version), ...(body ? body(version) : {}) } : version);
}

/** One list_agents entry: identity, type, active version and version history only. */
export function agentListEntry(agent: unknown) {
  if (!isObject(agent)) return agent;
  return { id: agent.id, name: agent.name, type: agent.type, activeVersion: agent.activeVersion ?? null, versions: versions(agent) };
}

/** get_agent summary: per version, only the settings of the agent's own type, reduced. */
export function agentSummary(agent: unknown) {
  if (!isObject(agent)) return agent;
  const handler = BY_TYPE[agent.type];
  const body = (version: Settings) => {
    if (!handler) return {};
    const settings = version[handler.field];
    return { [handler.field]: isObject(settings) ? handler.summarize(settings) : settings ?? null };
  };
  return defined([
    ['id', agent.id], ['projectKey', agent.projectKey], ['name', agent.name], ['type', agent.type],
    ['pluginAgentType', agent.pluginAgentType], ['activeVersion', agent.activeVersion ?? null], ['tags', agent.tags],
    ['detail', 'summary'], ['versions', versions(agent, body)],
  ]);
}

export function listAgentsView(agents: unknown, detail: string | undefined) {
  if (detail === 'full' || !Array.isArray(agents)) return agents;
  return agents.map(agentListEntry);
}

export function getAgentView(agent: unknown, detail: string | undefined) {
  return detail === 'full' ? agent : agentSummary(agent);
}
