import { mergeSettings } from './agent-client.js';

type Settings = Record<string, any>;

/**
 * Block templates for DSS Structured Visual Agents (STRUCTURED_AGENT).
 *
 * Defaults come from structured agents saved by the DSS 15 GUI. Only block types seen in such a
 * saved document are supported; the others are listed with `dssType: null` because their DSS
 * type string and field names are unconfirmed. Use a raw block (`type` + `raw`) for them.
 * Free text, targets and LLM IDs from the reference document are not part of the defaults.
 */
export const STRUCTURED_BLOCK_KINDS: ReadonlyArray<{ label: string; kind: string | null; dssType: string | null; supported: boolean }> = [
  { label: 'Agentic Loop', kind: 'agent_loop', dssType: 'CORE_LOOP', supported: true },
  { label: 'LLM Request', kind: 'llm', dssType: 'LLM_REQUEST', supported: true },
  { label: 'Delegate to Other Agent', kind: null, dssType: null, supported: false },
  { label: 'Mandatory Tool Call', kind: 'tool_call', dssType: 'MANDATORY_TOOL_CALL', supported: true },
  { label: 'Manual Tool Call', kind: null, dssType: null, supported: false },
  { label: 'Routing', kind: 'routing', dssType: 'ROUTING', supported: true },
  { label: 'For Each', kind: null, dssType: null, supported: false },
  { label: 'Parallel', kind: null, dssType: null, supported: false },
  { label: 'Reflection', kind: 'reflection', dssType: 'REFLECTION', supported: true },
  { label: 'Set State Entries', kind: null, dssType: null, supported: false },
  { label: 'Set Scratchpad Entries', kind: null, dssType: null, supported: false },
  { label: 'Context Compression', kind: null, dssType: null, supported: false },
  { label: 'Generate Text Output', kind: 'output', dssType: 'GENERATE_OUTPUT', supported: true },
  { label: 'Generate Artifact', kind: null, dssType: null, supported: false },
  { label: 'Python Code', kind: null, dssType: null, supported: false },
];

const completion = () => ({ stopSequences: [], tools: [], outputTrajectory: true });
/** A tool reference as the GUI saves it in MANDATORY_TOOL_CALL.tool and CORE_LOOP.tools. */
export const explicitTool = (toolRef: string): Settings => ({
  forwardContext: true, returnArtifacts: true, returnSources: true, enableSetArgs: false, setArgs: [],
  outputHandling: 'ADD_TO_MESSAGES', treatAsJSON: false, type: 'EXPLICIT_TOOL', toolRef,
});
/** A routing clause as the GUI saves it: a CEL expression and its target block. */
export const celClause = (expression: string, nextBlock: string): Settings => ({
  clause: { type: 'EXPRESSION', expression: { language: 'CEL', expression } }, nextBlock,
});

const DEFAULTS: Record<string, () => Settings> = {
  ROUTING: () => ({
    type: 'ROUTING', routingMode: 'CLAUSES', emptyDefaultNextBlockBehavior: 'FAIL', clausesBasedDecisions: [],
    resultDispatchMatchOperator: 'EXACT', resultDispatchCaseSensitive: true, resultDispatch: [], validNextBlocksFromExpression: [],
  }),
  MANDATORY_TOOL_CALL: () => ({
    type: 'MANDATORY_TOOL_CALL', completionSettings: completion(), stateAware: false, outputMode: 'ADD_TO_MESSAGES',
  }),
  CORE_LOOP: () => ({
    type: 'CORE_LOOP', tools: [], skillRefs: [], maxLoopIterations: 25, maxParallelToolExecutions: 2, stateAware: false,
    scratchpadAware: false, exitConditions: [], passConversationHistory: true, completionSettings: completion(),
    streamOutput: true, outputMode: 'ADD_TO_MESSAGES',
  }),
  LLM_REQUEST: () => ({
    type: 'LLM_REQUEST', passConversationHistory: true, completionSettings: completion(), streamOutput: true, outputMode: 'ADD_TO_MESSAGES',
  }),
  REFLECTION: () => ({
    type: 'REFLECTION', mode: 'CRITIQUE_AND_REFINE', passConversationHistory: false, streamOutput: true, outputMode: 'ADD_TO_MESSAGES',
    retryWithFeedback: true, critiqueCompletionSettings: completion(), critiqueMaxIterations: 3, failOnMaxIterations: true,
    synthesizeCompletionSettings: { stopSequences: [], outputTrajectory: true }, synthesizeIterations: 3, maxThreads: 32,
  }),
  GENERATE_OUTPUT: () => ({
    type: 'GENERATE_OUTPUT', templateType: 'CEL_EXPANSION', streamOutput: true, outputMode: 'ADD_TO_MESSAGES',
  }),
};

/** Block types whose saved form carries an llmId. */
const LLM_TYPES = new Set(['MANDATORY_TOOL_CALL', 'CORE_LOOP', 'LLM_REQUEST']);
/** Block types that loop by design; a cycle through one of them is expected. */
const LOOP_TYPES = new Set(['CORE_LOOP', 'REFLECTION']);

type FieldMap = Record<string, { field: string; kind: 'string' | 'integer' | 'tool' | 'tools' | 'branches' }>;
const KINDS: Record<string, { type: string; fields: FieldMap; required: string[] }> = {
  routing: {
    type: 'ROUTING', required: [],
    fields: { else: { field: 'defaultNextBlock', kind: 'string' }, branches: { field: 'clausesBasedDecisions', kind: 'branches' } },
  },
  tool_call: {
    type: 'MANDATORY_TOOL_CALL', required: ['llm', 'tool'],
    fields: { llm: { field: 'llmId', kind: 'string' }, tool: { field: 'tool', kind: 'tool' }, next: { field: 'nextBlock', kind: 'string' } },
  },
  agent_loop: {
    type: 'CORE_LOOP', required: ['llm'],
    fields: {
      llm: { field: 'llmId', kind: 'string' }, instructions: { field: 'systemPromptAfterHistory', kind: 'string' },
      maxIterations: { field: 'maxLoopIterations', kind: 'integer' }, next: { field: 'defaultNextBlock', kind: 'string' },
      tools: { field: 'tools', kind: 'tools' },
    },
  },
  llm: {
    type: 'LLM_REQUEST', required: ['llm'],
    fields: { llm: { field: 'llmId', kind: 'string' }, prompt: { field: 'systemPromptAfterHistory', kind: 'string' }, next: { field: 'nextBlock', kind: 'string' } },
  },
  reflection: {
    type: 'REFLECTION', required: ['generator'],
    fields: {
      generator: { field: 'generatorBlockId', kind: 'string' }, expectations: { field: 'expectationsPrompt', kind: 'string' },
      maxIterations: { field: 'critiqueMaxIterations', kind: 'integer' }, next: { field: 'nextBlockIfPass', kind: 'string' },
    },
  },
  output: { type: 'GENERATE_OUTPUT', fields: { template: { field: 'template', kind: 'string' } }, required: ['template'] },
};

/** A tool ID becomes an EXPLICIT_TOOL reference; an object is taken as a complete saved reference. */
function toolEntry(value: unknown): Settings | null {
  if (nonEmpty(value)) return explicitTool(value);
  return isObject(value) ? structuredClone(value) : null;
}

/** {when: CEL, to: block} becomes a saved clause; an object with a clause is taken as saved. */
function branchEntry(value: unknown): Settings | null {
  if (!isObject(value)) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'clause')) return structuredClone(value);
  const keys = Object.keys(value).sort().join(',');
  return keys === 'to,when' && nonEmpty(value.when) && nonEmpty(value.to) ? celClause(value.when, value.to) : null;
}

const isObject = (value: unknown): value is Settings => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

export type StructuredBlockSpec = { id: string; kind?: string; type?: string; raw?: Settings; [field: string]: unknown };
export type StructuredAgentSpec = { start: string; blocks: StructuredBlockSpec[]; raw?: Settings };
export type ValidationReport = { valid: boolean; errors: string[]; warnings: string[] };
export type BuildResult = ValidationReport & { settings: Settings | null };

function buildBlock(spec: StructuredBlockSpec, index: number, errors: string[], warnings: string[]): Settings | null {
  const where = `blocks[${index}]`;
  if (!isObject(spec)) { errors.push(`${where} must be an object`); return null; }
  if (!nonEmpty(spec.id)) { errors.push(`${where}.id must be a non-empty string`); return null; }
  const label = `${where} (${spec.id})`;
  if (spec.raw !== undefined && !isObject(spec.raw)) { errors.push(`${label}.raw must be an object`); return null; }
  const raw = spec.raw ?? {};
  for (const key of ['id', 'type']) if (Object.prototype.hasOwnProperty.call(raw, key)) errors.push(`${label}.raw cannot set ${key}`);

  if (spec.kind === undefined) {
    // Pass-through for block types without a confirmed template.
    const extra = Object.keys(spec).filter(key => !['id', 'type', 'raw'].includes(key));
    if (!nonEmpty(spec.type)) { errors.push(`${label} needs kind (${Object.keys(KINDS).join(', ')}) or type plus raw`); return null; }
    if (extra.length) errors.push(`${label}: a raw block accepts only id, type and raw (got ${extra.join(', ')})`);
    if (!DEFAULTS[spec.type]) warnings.push(`${label}: block type ${spec.type} has no confirmed template; passed through unchanged`);
    return mergeSettings({ type: spec.type }, { ...raw, id: spec.id });
  }

  const kind = KINDS[spec.kind];
  if (!kind) { errors.push(`${label}: unsupported kind ${String(spec.kind)}; use ${Object.keys(KINDS).join(', ')}, or type plus raw`); return null; }
  if (spec.type !== undefined) errors.push(`${label}: give kind or type, not both`);
  const block = DEFAULTS[kind.type]();
  for (const [key, value] of Object.entries(spec)) {
    if (['id', 'kind', 'type', 'raw'].includes(key)) continue;
    const mapping = kind.fields[key];
    if (!mapping) { errors.push(`${label}: unknown field ${key} for kind ${spec.kind}`); continue; }
    if (mapping.kind === 'string' && !nonEmpty(value)) { errors.push(`${label}.${key} must be a non-empty string`); continue; }
    if (mapping.kind === 'integer' && !(Number.isInteger(value) && (value as number) >= 1)) { errors.push(`${label}.${key} must be a positive integer`); continue; }
    if (mapping.kind === 'tool') {
      const entry = toolEntry(value);
      if (!entry) errors.push(`${label}.${key} must be a tool ID or a saved tool object`);
      else block[mapping.field] = entry;
      continue;
    }
    if (mapping.kind === 'tools' || mapping.kind === 'branches') {
      const convert = mapping.kind === 'tools' ? toolEntry : branchEntry;
      const entries = Array.isArray(value) ? value.map(convert) : [null];
      if (entries.some(entry => entry === null)) {
        errors.push(mapping.kind === 'tools' ? `${label}.${key} must be an array of tool IDs or saved tool objects`
          : `${label}.${key} must be an array of {when: CEL expression, to: block id} or saved clause objects`);
      } else block[mapping.field] = entries;
      continue;
    }
    block[mapping.field] = value;
  }
  for (const key of kind.required) if (spec[key] === undefined && raw[kind.fields[key].field] === undefined) errors.push(`${label}.${key} is required`);
  return mergeSettings(block, { ...raw, id: spec.id });
}

/** Turn a compact spec into structuredAgentSettings fields ({startingBlockId, blocks}), then validate them. */
export function buildStructuredAgentSettings(spec: StructuredAgentSpec): BuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObject(spec)) return { valid: false, errors: ['spec must be an object'], warnings, settings: null };
  for (const key of Object.keys(spec)) if (!['start', 'blocks', 'raw'].includes(key)) errors.push(`spec: unknown field ${key}`);
  if (!nonEmpty(spec.start)) errors.push('spec.start must be a block id');
  if (!Array.isArray(spec.blocks) || spec.blocks.length === 0) errors.push('spec.blocks must be a non-empty array');
  if (spec.raw !== undefined && (!isObject(spec.raw) || ['blocks', 'startingBlockId'].some(key => Object.prototype.hasOwnProperty.call(spec.raw, key)))) {
    errors.push('spec.raw must be an object without blocks or startingBlockId');
  }
  if (errors.length) return { valid: false, errors, warnings, settings: null };
  const blocks = spec.blocks.map((block, index) => buildBlock(block, index, errors, warnings));
  if (errors.length) return { valid: false, errors, warnings, settings: null };
  const settings = mergeSettings(spec.raw ?? {}, { startingBlockId: spec.start });
  settings.blocks = blocks;
  const report = validateStructuredAgentSettings(settings);
  return { ...report, warnings: [...warnings, ...report.warnings], settings };
}

/** Collect string values under keys that name a block, from resultDispatch entries of unconfirmed shape. */
function routingTargets(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(item => routingTargets(item, found));
  else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (/block/i.test(key) && typeof item === 'string') found.push(item);
      else if (/block/i.test(key) && Array.isArray(item) && item.every(entry => typeof entry === 'string')) found.push(...item);
      else routingTargets(item, found);
    }
  }
  return found;
}

/** Outgoing references of one block, as [field, target id]. */
function edges(block: Settings): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const field of ['nextBlock', 'nextBlockIfPass', 'defaultNextBlock', 'generatorBlockId']) {
    if (block[field] !== undefined && block[field] !== null) result.push([field, block[field]]);
  }
  if (block.type === 'ROUTING') {
    if (Array.isArray(block.clausesBasedDecisions)) {
      block.clausesBasedDecisions.forEach((clause: unknown, index: number) => result.push([`clausesBasedDecisions[${index}].nextBlock`, isObject(clause) ? clause.nextBlock : undefined]));
    }
    for (const target of routingTargets(block.resultDispatch)) result.push(['resultDispatch', target]);
    if (Array.isArray(block.validNextBlocksFromExpression)) {
      for (const target of block.validNextBlocksFromExpression) result.push(['validNextBlocksFromExpression', typeof target === 'string' ? target : routingTargets(target)[0]]);
    }
  }
  return result;
}

function checkTool(id: string, field: string, entry: unknown, errors: string[], warnings: string[]) {
  if (!isObject(entry)) errors.push(`block ${id}.${field} must be a tool object`);
  else if (entry.type !== 'EXPLICIT_TOOL') warnings.push(`block ${id}.${field}: tool type ${String(entry.type)} is not checked (no confirmed format)`);
  else if (!nonEmpty(entry.toolRef)) errors.push(`block ${id}.${field} needs a toolRef`);
}

/** Check a structuredAgentSettings document: identifiers, references, reachability, cycles and LLM IDs. */
export function validateStructuredAgentSettings(settings: unknown): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObject(settings)) return { valid: false, errors: ['structuredAgentSettings must be an object'], warnings };
  if (!Array.isArray(settings.blocks)) return { valid: false, errors: ['structuredAgentSettings.blocks must be an array'], warnings };
  const byId = new Map<string, Settings>();
  settings.blocks.forEach((block: unknown, index: number) => {
    if (!isObject(block) || !nonEmpty(block.id)) { errors.push(`blocks[${index}] needs a non-empty string id`); return; }
    if (byId.has(block.id)) errors.push(`duplicate block id ${block.id}`);
    else byId.set(block.id, block);
    if (!nonEmpty(block.type)) errors.push(`block ${block.id} needs a type`);
    else if (!DEFAULTS[block.type]) warnings.push(`block ${block.id}: type ${block.type} is not checked beyond ids and references (no confirmed template)`);
    if (LLM_TYPES.has(block.type) && !nonEmpty(block.llmId)) errors.push(`block ${block.id} (${block.type}) needs llmId`);
    if (block.type === 'MANDATORY_TOOL_CALL') {
      if (!isObject(block.tool)) errors.push(`block ${block.id} (MANDATORY_TOOL_CALL) needs a tool`);
      else checkTool(block.id, 'tool', block.tool, errors, warnings);
    }
    if (block.type === 'CORE_LOOP' && Array.isArray(block.tools)) {
      block.tools.forEach((entry: unknown, index: number) => checkTool(block.id, `tools[${index}]`, entry, errors, warnings));
    }
    if (block.type === 'ROUTING' && Array.isArray(block.clausesBasedDecisions)) {
      block.clausesBasedDecisions.forEach((entry: unknown, index: number) => {
        const where = `block ${block.id}.clausesBasedDecisions[${index}]`;
        const clause = isObject(entry) ? entry.clause : undefined;
        if (!isObject(clause)) errors.push(`${where} needs a clause`);
        else if (clause.type !== 'EXPRESSION') warnings.push(`${where}: clause type ${String(clause.type)} is not checked (no confirmed format)`);
        else if (!isObject(clause.expression) || clause.expression.language !== 'CEL' || !nonEmpty(clause.expression.expression)) {
          errors.push(`${where} needs a non-empty CEL expression`);
        }
      });
    }
    if (block.type === 'ROUTING' && block.routingMode === 'CLAUSES' && Array.isArray(block.clausesBasedDecisions) && block.clausesBasedDecisions.length === 0) {
      warnings.push(`block ${block.id}: routing has no clauses and always goes to defaultNextBlock`);
    }
  });
  if (!nonEmpty(settings.startingBlockId)) errors.push('startingBlockId is missing');
  else if (!byId.has(settings.startingBlockId)) errors.push(`startingBlockId ${settings.startingBlockId} is not a block id`);

  const graph = new Map<string, string[]>();
  for (const [id, block] of byId) {
    const targets: string[] = [];
    for (const [field, target] of edges(block)) {
      if (!nonEmpty(target) || !byId.has(target)) errors.push(`block ${id}.${field} points to missing block ${String(target)}`);
      else targets.push(target);
    }
    graph.set(id, targets);
  }

  if (byId.has(settings.startingBlockId)) {
    const seen = new Set<string>([settings.startingBlockId]);
    const queue = [settings.startingBlockId as string];
    while (queue.length) for (const next of graph.get(queue.shift()!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    for (const id of byId.keys()) if (!seen.has(id)) warnings.push(`block ${id} is unreachable from startingBlockId`);
  }

  // Tarjan's strongly connected components: every component with a cycle needs a looping block.
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (id: string) => {
    index.set(id, counter); low.set(id, counter); counter++;
    stack.push(id); onStack.add(id);
    for (const next of graph.get(id) ?? []) {
      if (!index.has(next)) { visit(next); low.set(id, Math.min(low.get(id)!, low.get(next)!)); }
      else if (onStack.has(next)) low.set(id, Math.min(low.get(id)!, index.get(next)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const component: string[] = [];
    let member: string;
    do { member = stack.pop()!; onStack.delete(member); component.push(member); } while (member !== id);
    const cyclic = component.length > 1 || (graph.get(id) ?? []).includes(id);
    if (cyclic && !component.some(item => LOOP_TYPES.has(byId.get(item)!.type))) {
      warnings.push(`cycle without an agentic loop or reflection block: ${component.reverse().join(' -> ')}`);
    }
  };
  for (const id of byId.keys()) if (!index.has(id)) visit(id);
  return { valid: errors.length === 0, errors, warnings };
}
