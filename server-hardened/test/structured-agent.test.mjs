import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { DataikuClient } from '../dist/dataiku-client.js';
import { callAgentTool } from '../dist/agent-tools.js';
import { buildStructuredAgentSettings, validateStructuredAgentSettings, STRUCTURED_BLOCK_KINDS } from '../dist/structured-agent.js';

const LLM = 'connection:model';
// Optional local copy of a structured agent saved on DEV; not part of the repository.
const SAMPLE = process.env.STRUCTURED_AGENT_SAMPLE ?? '';
const TOOL = 'search-tool';
const CEL = 'message contains X';
const completion = { stopSequences: [], tools: [], outputTrajectory: true };
const toolObject = { forwardContext: true, returnArtifacts: true, returnSources: true, enableSetArgs: false, setArgs: [], outputHandling: 'ADD_TO_MESSAGES', treatAsJSON: false, type: 'EXPLICIT_TOOL', toolRef: TOOL };
const clause = { clause: { type: 'EXPRESSION', expression: { language: 'CEL', expression: CEL } }, nextBlock: 'tool' };
// Block shapes as saved by the DSS 15 GUI (one block of each confirmed type), with placeholder ids, tool and text.
const saved = {
  blocks: [
    { type: 'ROUTING', routingMode: 'CLAUSES', defaultNextBlock: 'tool', emptyDefaultNextBlockBehavior: 'FAIL', clausesBasedDecisions: [clause], resultDispatchMatchOperator: 'EXACT', resultDispatchCaseSensitive: true, resultDispatch: [], validNextBlocksFromExpression: [], id: 'route' },
    { type: 'MANDATORY_TOOL_CALL', tool: toolObject, llmId: LLM, completionSettings: completion, stateAware: false, nextBlock: 'loop', outputMode: 'ADD_TO_MESSAGES', id: 'tool' },
    { type: 'CORE_LOOP', tools: [toolObject], skillRefs: [], maxLoopIterations: 25, maxParallelToolExecutions: 2, stateAware: false, scratchpadAware: false, exitConditions: [], defaultNextBlock: 'out', llmId: LLM, passConversationHistory: true, systemPromptAfterHistory: 'answer from documents', completionSettings: completion, streamOutput: true, outputMode: 'ADD_TO_MESSAGES', id: 'loop' },
    { type: 'LLM_REQUEST', nextBlock: 'out', llmId: LLM, passConversationHistory: true, systemPromptAfterHistory: 'summarize', completionSettings: completion, streamOutput: true, outputMode: 'ADD_TO_MESSAGES', id: 'llm' },
    { type: 'REFLECTION', mode: 'CRITIQUE_AND_REFINE', generatorBlockId: 'llm', passConversationHistory: false, nextBlockIfPass: 'out', streamOutput: true, outputMode: 'ADD_TO_MESSAGES', retryWithFeedback: true, expectationsPrompt: 'any judge instruction', critiqueCompletionSettings: completion, critiqueMaxIterations: 3, failOnMaxIterations: true, synthesizeCompletionSettings: { stopSequences: [], outputTrajectory: true }, synthesizeIterations: 3, maxThreads: 32, id: 'judge' },
    { type: 'GENERATE_OUTPUT', templateType: 'CEL_EXPANSION', template: '{{answer}}', streamOutput: true, outputMode: 'ADD_TO_MESSAGES', id: 'out' },
  ],
  startingBlockId: 'route',
};
const spec = {
  start: 'route',
  blocks: [
    { id: 'route', kind: 'routing', branches: [{ when: CEL, to: 'tool' }], else: 'tool' },
    { id: 'tool', kind: 'tool_call', llm: LLM, tool: TOOL, next: 'loop' },
    { id: 'loop', kind: 'agent_loop', llm: LLM, tools: [TOOL], instructions: 'answer from documents', maxIterations: 25, next: 'out' },
    { id: 'llm', kind: 'llm', llm: LLM, prompt: 'summarize', next: 'out' },
    { id: 'judge', kind: 'reflection', generator: 'llm', expectations: 'any judge instruction', maxIterations: 3, next: 'out' },
    { id: 'out', kind: 'output', template: '{{answer}}' },
  ],
};
const unreachable = ['block llm is unreachable from startingBlockId', 'block judge is unreachable from startingBlockId'];
const sortKeys = value => Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
const clone = value => structuredClone(value);

test('the six confirmed kinds build the exact block shape DSS saved', () => {
  const result = buildStructuredAgentSettings(spec);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.deepEqual(sortKeys(result.settings), sortKeys(saved));
  assert.ok(unreachable.every(warning => result.warnings.includes(warning)));
  // Defaults are fresh copies, not shared between blocks or builds.
  result.settings.blocks[1].completionSettings.stopSequences.push('x');
  assert.deepEqual(buildStructuredAgentSettings(spec).settings.blocks[2].completionSettings, completion);
});

test('the template list names all 15 GUI block types and confirms only the six sampled ones', () => {
  assert.equal(STRUCTURED_BLOCK_KINDS.length, 15);
  assert.deepEqual(STRUCTURED_BLOCK_KINDS.filter(kind => kind.supported).map(kind => kind.dssType).sort(),
    ['CORE_LOOP', 'GENERATE_OUTPUT', 'LLM_REQUEST', 'MANDATORY_TOOL_CALL', 'REFLECTION', 'ROUTING']);
  assert.ok(STRUCTURED_BLOCK_KINDS.filter(kind => !kind.supported).every(kind => kind.dssType === null && kind.kind === null));
});

test('malformed spec fields are refused before anything is built', () => {
  const cases = [
    [{ id: 'route', kind: 'routing', branches: [{ when: '', to: 'out' }], else: 'out' }, /branches must be an array of \{when/],
    [{ id: 'route', kind: 'routing', branches: [{ when: 'x', to: 'out', extra: 1 }] }, /branches must be an array of \{when/],
    [{ id: 'route', kind: 'tool_call', llm: LLM, next: 'out' }, /tool is required/],
    [{ id: 'route', kind: 'tool_call', llm: LLM, tool: ['x'], next: 'out' }, /tool must be a tool ID/],
    [{ id: 'route', kind: 'agent_loop', llm: LLM, tools: 'search', next: 'out' }, /tools must be an array of tool IDs/],
    [{ id: 'route', kind: 'agent_loop', llm: LLM, tools: [''], next: 'out' }, /tools must be an array of tool IDs/],
    [{ id: 'route', kind: 'agent_loop', next: 'out' }, /llm is required/],
    [{ id: 'route', kind: 'agent_loop', llm: LLM, maxIterations: 0 }, /positive integer/],
    [{ id: 'route', kind: 'output', template: '{{a}}', templat: 'typo' }, /unknown field templat/],
    [{ id: 'route', kind: 'for_each' }, /unsupported kind for_each/],
    [{ id: 'route', kind: 'output', template: 'x', raw: { id: 'other' } }, /raw cannot set id/],
  ];
  for (const [block, message] of cases) {
    const result = buildStructuredAgentSettings({ start: 'route', blocks: [block, { id: 'out', kind: 'output', template: '{{a}}' }] });
    assert.equal(result.valid, false);
    assert.equal(result.settings, null);
    assert.ok(result.errors.some(error => message.test(error)), `${message}: ${result.errors}`);
  }
  assert.equal(buildStructuredAgentSettings({ start: 'a', blocks: [], extra: 1 }).valid, false);
});

test('raw sub-objects pass through; unsupported block types pass through untouched with a warning', () => {
  const clause = { clause: { type: 'OTHER_KIND', opaque: true }, nextBlock: 'out' };
  const tools = [{ ...toolObject, returnSources: false }];
  const result = buildStructuredAgentSettings({
    start: 'route', raw: { nextTurnBehaviour: 'STARTING_BLOCK' },
    blocks: [
      { id: 'route', kind: 'routing', else: 'loop', branches: [clause], raw: { emptyDefaultNextBlockBehavior: 'FAIL' } },
      { id: 'loop', kind: 'agent_loop', llm: LLM, tools, next: 'each' },
      { id: 'each', type: 'SOMETHING_NEW', raw: { anyField: [1, 2], nextBlock: 'out' } },
      { id: 'out', kind: 'output', template: '{{a}}' },
    ],
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.settings.nextTurnBehaviour, 'STARTING_BLOCK');
  assert.deepEqual(result.settings.blocks[0].clausesBasedDecisions, [clause]);
  assert.deepEqual(result.settings.blocks[1].tools, tools);
  assert.deepEqual(result.settings.blocks[2], { type: 'SOMETHING_NEW', anyField: [1, 2], nextBlock: 'out', id: 'each' });
  assert.ok(result.warnings.some(warning => /SOMETHING_NEW has no confirmed template/.test(warning)));
  assert.ok(result.warnings.some(warning => /clause type OTHER_KIND is not checked/.test(warning)));
  assert.ok(!result.warnings.some(warning => /unreachable/.test(warning)));
});

test('validation reports ids, references, missing LLMs, unreachable blocks and cycles', () => {
  assert.deepEqual(validateStructuredAgentSettings(saved), { valid: true, errors: [], warnings: unreachable });

  const broken = clone(saved);
  broken.startingBlockId = 'nowhere';
  broken.blocks[1].nextBlock = 'missing';
  broken.blocks[2].llmId = '';
  broken.blocks[4].generatorBlockId = 'gone';
  broken.blocks.push({ ...broken.blocks[5] });
  broken.blocks[0].clausesBasedDecisions = [{ ...clause, nextBlock: 'absent' }, { clause: { type: 'EXPRESSION', expression: { language: 'CEL', expression: ' ' } }, nextBlock: 'out' }];
  broken.blocks[1].tool = { ...toolObject, toolRef: '' };
  broken.blocks[2].tools = [toolObject, { ...toolObject, toolRef: undefined }];
  broken.blocks[3].nextBlock = 'void';
  broken.blocks[4].nextBlockIfPass = 'nil';
  const report = validateStructuredAgentSettings(broken);
  assert.equal(report.valid, false);
  for (const message of ['duplicate block id out', 'startingBlockId nowhere is not a block id', 'block tool.nextBlock points to missing block missing',
    'block loop (CORE_LOOP) needs llmId', 'block judge.generatorBlockId points to missing block gone', 'block route.clausesBasedDecisions[0].nextBlock points to missing block absent',
    'block route.clausesBasedDecisions[1] needs a non-empty CEL expression', 'block tool.tool needs a toolRef', 'block loop.tools[1] needs a toolRef',
    'block llm.nextBlock points to missing block void', 'block judge.nextBlockIfPass points to missing block nil']) {
    assert.ok(report.errors.includes(message), message);
  }

  const cycle = { startingBlockId: 'a', blocks: [
    { id: 'a', type: 'MANDATORY_TOOL_CALL', llmId: LLM, tool: toolObject, nextBlock: 'b' },
    { id: 'b', type: 'ROUTING', defaultNextBlock: 'a', validNextBlocksFromExpression: ['c'] },
    { id: 'c', type: 'GENERATE_OUTPUT', template: 'x' },
  ] };
  const plain = validateStructuredAgentSettings(cycle);
  assert.equal(plain.valid, true);
  assert.ok(plain.warnings.includes('cycle without an agentic loop or reflection block: a -> b'));
  cycle.blocks[0].type = 'CORE_LOOP';
  assert.ok(!validateStructuredAgentSettings(cycle).warnings.some(warning => /cycle/.test(warning)));
  assert.ok(validateStructuredAgentSettings({ startingBlockId: 'a', blocks: [{ id: 'a', type: 'MANDATORY_TOOL_CALL', llmId: LLM }] }).errors.includes('block a (MANDATORY_TOOL_CALL) needs a tool'));
  for (const bad of [null, {}, { blocks: [{ type: 'ROUTING' }], startingBlockId: 'x' }]) assert.equal(validateStructuredAgentSettings(bad).valid, false);
});

function harness(t, responses = []) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), ...options, body: options.body === undefined ? undefined : JSON.parse(options.body) });
    assert.ok(responses.length, 'Unexpected HTTP request');
    const response = responses.shift();
    return new Response(response === null ? null : JSON.stringify(response), { status: response === null ? 204 : 200 });
  });
  const client = new DataikuClient({ host: 'https://dss.example', apiKey: 'test-key' });
  t.after(() => assert.equal(responses.length, 0, 'Not all expected HTTP responses were used'));
  return { requests, call: (name, args) => callAgentTool(client.agents, name, args) };
}
const agentArgs = { project_key: 'PROJECT', agent_id: 'agent1' };
const structured = {
  projectKey: 'PROJECT', id: 'agent1', type: 'STRUCTURED_AGENT', activeVersion: 'v1',
  versions: [
    { versionId: 'v1', structuredAgentSettings: { blocks: [{ id: 'old', type: 'GENERATE_OUTPUT', template: 'x' }], startingBlockId: 'old', shortTermMemoryEnabled: true } },
    { versionId: 'v2', structuredAgentSettings: clone(saved) },
  ],
};

test('build_structured_agent dry run makes no DSS request; apply saves only the selected version', async t => {
  const h = harness(t, [structured, structured, null]);
  const dry = JSON.parse((await h.call('build_structured_agent', { ...agentArgs, spec })).content[0].text);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.valid, true);
  assert.deepEqual(sortKeys(dry.structuredAgentSettings), sortKeys(saved));
  assert.equal(h.requests.length, 0);

  const applied = await h.call('build_structured_agent', { ...agentArgs, version_id: 'v1', spec, dry_run: false });
  assert.notEqual(applied.isError, true, applied.content[0].text);
  assert.equal(JSON.parse(applied.content[0].text).applied, true);
  const put = h.requests.at(-1);
  assert.equal(put.method, 'PUT');
  assert.ok(put.url.endsWith('/projects/PROJECT/agents/agent1'));
  assert.deepEqual(sortKeys(put.body.versions[0].structuredAgentSettings), sortKeys({ ...saved, shortTermMemoryEnabled: true }));
  assert.deepEqual(put.body.versions[1], structured.versions[1]);
});

test('build_structured_agent refuses invalid specs and non-structured agents without a PUT', async t => {
  const h = harness(t, [{ ...structured, type: 'TOOLS_USING_AGENT' }]);
  const invalid = await h.call('build_structured_agent', { ...agentArgs, spec: { start: 'missing', blocks: [{ id: 'out', kind: 'output', template: 'x' }] }, dry_run: false });
  assert.equal(invalid.isError, true);
  assert.equal(JSON.parse(invalid.content[0].text).applied, false);
  assert.equal(h.requests.length, 0);
  assert.equal((await h.call('build_structured_agent', { ...agentArgs, spec, dry_run: false })).isError, true);
  assert.ok(h.requests.every(request => request.method === 'GET'));
  assert.equal((await h.call('build_structured_agent', { ...agentArgs, spec: { blocks: [] } })).isError, true);
});

test('validate_structured_agent reads the selected version and validates it', async t => {
  const h = harness(t, [structured, structured, { ...structured, type: 'PYTHON_AGENT' }]);
  const active = JSON.parse((await h.call('validate_structured_agent', agentArgs)).content[0].text);
  assert.equal(active.versionId, 'v1');
  assert.equal(active.valid, true);
  const second = JSON.parse((await h.call('validate_structured_agent', { ...agentArgs, version_id: 'v2' })).content[0].text);
  assert.equal(second.versionId, 'v2');
  assert.deepEqual(second.warnings.filter(warning => /unreachable/.test(warning)), unreachable);
  assert.equal((await h.call('validate_structured_agent', agentArgs)).isError, true);
  assert.ok(h.requests.every(request => request.method === 'GET'));
});

test('the saved DEV sample round-trips exactly from a spec', { skip: !existsSync(SAMPLE) && 'reference sample not present' }, () => {
  const settings = JSON.parse(readFileSync(SAMPLE, 'utf8')).versions[0].structuredAgentSettings;
  const [route, tool, loop, llm, judge, out] = settings.blocks;
  const result = buildStructuredAgentSettings({
    start: settings.startingBlockId,
    raw: Object.fromEntries(Object.entries(settings).filter(([key]) => !['blocks', 'startingBlockId'].includes(key))),
    blocks: [
      { id: route.id, kind: 'routing', branches: route.clausesBasedDecisions.map(c => ({ when: c.clause.expression.expression, to: c.nextBlock })), else: route.defaultNextBlock },
      { id: tool.id, kind: 'tool_call', llm: tool.llmId, tool: tool.tool.toolRef, next: tool.nextBlock },
      { id: loop.id, kind: 'agent_loop', llm: loop.llmId, tools: loop.tools.map(t => t.toolRef), instructions: loop.systemPromptAfterHistory, maxIterations: loop.maxLoopIterations, next: loop.defaultNextBlock },
      { id: llm.id, kind: 'llm', llm: llm.llmId, prompt: llm.systemPromptAfterHistory, next: llm.nextBlock },
      { id: judge.id, kind: 'reflection', generator: judge.generatorBlockId, expectations: judge.expectationsPrompt, maxIterations: judge.critiqueMaxIterations, next: judge.nextBlockIfPass },
      { id: out.id, kind: 'output', template: out.template },
    ],
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(sortKeys(result.settings), sortKeys(settings));
});
