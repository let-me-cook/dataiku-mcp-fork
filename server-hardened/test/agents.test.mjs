import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DataikuClient } from '../dist/dataiku-client.js';
import { agentTools, callAgentTool } from '../dist/agent-tools.js';

const project_key = 'PROJECT';
const agent_id = 'agent1';
const tool_id = 'tool1';
const agentArgs = { project_key, agent_id };
const toolArgs = { project_key, tool_id };
const original = {
  projectKey: project_key, id: agent_id, type: 'TOOLS_USING_AGENT', name: 'Agent', activeVersion: 'v1',
  versions: [
    { versionId: 'v1', toolsUsingAgentSettings: { llmId: 'old-llm', tools: [{ toolRef: 'existing', extra: true }], keep: 7 } },
    { versionId: 'v2', toolsUsingAgentSettings: { llmId: 'other-llm', tools: [] } },
  ],
  tags: ['preserved'],
};

function harness(t, responses = []) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), ...options, body: options.body === undefined ? undefined : JSON.parse(options.body) });
    assert.ok(responses.length, 'Unexpected HTTP request');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response instanceof Response ? response : new Response(response === null ? null : JSON.stringify(response), { status: response === null ? 204 : 200 });
  });
  const client = new DataikuClient({ host: 'https://dss.example/prefix', apiKey: 'test-key' });
  t.after(() => assert.equal(responses.length, 0, 'Not all expected HTTP responses were used'));
  return { client, requests, call: (name, args) => callAgentTool(client.agents, name, args) };
}

function value(result) {
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

test('HTTP requires explicit opt-in and retains URL and redirect restrictions', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'http://dss.example:11000/public/api/projects/PROJECT/agents');
    assert.equal(options.redirect, 'error');
    return new Response('[]');
  });
  const config = { host: 'http://dss.example:11000', apiKey: 'test-key', allowHttp: false };
  assert.throws(() => new DataikuClient(config), /requires HTTPS by default/);
  const client = new DataikuClient({ ...config, allowHttp: true });
  assert.deepEqual(await client.agents.listAgents('PROJECT'), []);
  for (const host of ['ftp://dss.example', 'http://user:password@dss.example', 'http://dss.example?key=secret', 'http://dss.example#fragment']) {
    assert.throws(() => new DataikuClient({ ...config, host, allowHttp: true }));
  }
  assert.throws(() => new DataikuClient({ ...config, allowHttp: true, insecureTls: true }), /not supported/);
  const saved = process.env.DSS_ALLOW_HTTP;
  try {
    process.env.DSS_ALLOW_HTTP = 'true';
    assert.doesNotThrow(() => new DataikuClient({ host: config.host, apiKey: config.apiKey }));
    assert.throws(() => new DataikuClient(config), /requires HTTPS by default/);
    process.env.DSS_ALLOW_HTTP = 'false';
    assert.throws(() => new DataikuClient({ host: config.host, apiKey: config.apiKey }), /requires HTTPS by default/);
  } finally {
    if (saved === undefined) delete process.env.DSS_ALLOW_HTTP;
    else process.env.DSS_ALLOW_HTTP = saved;
  }
});

test('read tools use DSS 14.7.1 endpoints, query parameters and API-key Basic authentication', async t => {
  const cases = [
    ['list_agents', { project_key, detail: 'full' }, '/agents', [original]],
    ['get_agent', { ...agentArgs, detail: 'full' }, '/agents/agent1', original],
    ['list_llms', { project_key }, '/llms?purpose=GENERIC_COMPLETION', [{ id: 'llm1' }]],
    ['list_agent_tools', { project_key, include_shared: true }, '/agents/tools?includeDescriptions=false&foreign=true', { tools: [{ id: tool_id }] }],
    ['get_agent_tool', toolArgs, '/agents/tools/tool1', { id: tool_id }],
    ['get_agent_tool_descriptor', toolArgs, '/agents/tools/tool1/descriptor', { inputSchema: { type: 'object' } }],
  ];
  const h = harness(t, cases.map(c => c[3]));
  for (const [name, args, path, response] of cases) {
    assert.deepEqual(value(await h.call(name, args)), name === 'list_agent_tools' ? response.tools : response);
    const req = h.requests.at(-1);
    assert.equal(req.url, `https://dss.example/prefix/public/api/projects/PROJECT${path}`);
    assert.equal(req.method, 'GET');
    assert.equal(req.body, undefined);
    assert.equal(req.headers.Authorization, `Basic ${Buffer.from('test-key:').toString('base64')}`);
    assert.equal(req.redirect, 'error');
  }
});

const unused = {
  ragllmSettings: { printSources: true, retrievalColumns: [], guardrailsPipelineSettings: { guardrails: [] } },
  guardrailsPipelineSettings: { guardrails: [] }, pluginAgentSettings: { dkuProperties: [] },
  pythonAgentSettings: { codeEnvSelection: { envMode: 'INHERIT' }, interactionLoggingSelection: {} },
  quickTestQueryStr: '',
};
const tag = { versionNumber: 3, lastModifiedBy: { login: 'builder' }, lastModifiedOn: 1760000000000 };
const longPrompt = 'P'.repeat(500);
const structuredFull = {
  projectKey: project_key, id: agent_id, type: 'STRUCTURED_AGENT', name: 'Structured', activeVersion: 'v1', tags: [],
  customFields: { big: 'x'.repeat(1000) },
  versions: [{
    versionId: 'v1', versionTag: tag, creationTag: tag, ...unused,
    toolsUsingAgentSettings: { tools: [], llmId: null, completionSettings: {} },
    structuredAgentSettings: {
      startingBlockId: 'route', nextTurnBehaviour: 'START_OVER', dkuProperties: [], interactionLoggingSelection: {},
      blocks: [
        { id: 'route', type: 'ROUTING', routingMode: 'CLAUSES', defaultNextBlock: 'loop', resultDispatch: [],
          clausesBasedDecisions: [{ clause: { type: 'EXPRESSION', expression: { language: 'CEL', expression: 'state.x == 1' } }, nextBlock: 'call' }] },
        { id: 'call', type: 'MANDATORY_TOOL_CALL', llmId: 'llm1', nextBlock: 'loop', completionSettings: { stopSequences: [], tools: [] },
          tool: { type: 'EXPLICIT_TOOL', toolRef: 'kb', forwardContext: true, setArgs: [] } },
        { id: 'loop', type: 'CORE_LOOP', llmId: 'llm1', maxLoopIterations: 20, scratchpadAware: true, passConversationHistory: false,
          tools: [{ type: 'EXPLICIT_TOOL', toolRef: 'find' }, { type: 'EXPLICIT_TOOL', toolRef: 'read' }], defaultNextBlock: 'check',
          systemPromptAfterHistory: longPrompt, completionSettings: { stopSequences: [], tools: [], outputTrajectory: true }, exitConditions: [] },
        { id: 'check', type: 'REFLECTION', generatorBlockId: 'loop', nextBlockIfPass: 'out', critiqueMaxIterations: 2, expectationsPrompt: 'Be exact.' },
        { id: 'out', type: 'GENERATE_OUTPUT', template: '{{ state.answer }}', templateType: 'CEL_EXPANSION' },
      ],
    },
  }],
};

test('list_agents defaults to a compact list; get_agent summary keeps only the structured agent settings', async t => {
  const h = harness(t, [[structuredFull, original], structuredFull, structuredFull]);
  const listed = value(await h.call('list_agents', { project_key }));
  assert.deepEqual(listed, [
    { id: agent_id, name: 'Structured', type: 'STRUCTURED_AGENT', activeVersion: 'v1', versions: [{ versionId: 'v1', lastModifiedBy: 'builder', lastModifiedOn: 1760000000000 }] },
    { id: agent_id, name: 'Agent', type: 'TOOLS_USING_AGENT', activeVersion: 'v1', versions: [
      { versionId: 'v1', lastModifiedBy: null, lastModifiedOn: null }, { versionId: 'v2', lastModifiedBy: null, lastModifiedOn: null }] },
  ]);
  const summary = value(await h.call('get_agent', agentArgs));
  assert.equal(summary.detail, 'summary');
  assert.equal(summary.customFields, undefined);
  const [version] = summary.versions;
  assert.deepEqual(Object.keys(version).sort(), ['lastModifiedBy', 'lastModifiedOn', 'structuredAgentSettings', 'versionId']);
  const settings = version.structuredAgentSettings;
  assert.equal(settings.startingBlockId, 'route');
  assert.equal(settings.dkuProperties, undefined);
  assert.deepEqual(settings.blocks[0], { id: 'route', type: 'ROUTING', defaultNextBlock: 'loop', routes: [{ when: 'state.x == 1', to: 'call' }], routingMode: 'CLAUSES' });
  assert.deepEqual(settings.blocks[1], { id: 'call', type: 'MANDATORY_TOOL_CALL', llmId: 'llm1', nextBlock: 'loop', tools: ['kb'] });
  assert.deepEqual(settings.blocks[2], {
    id: 'loop', type: 'CORE_LOOP', llmId: 'llm1', defaultNextBlock: 'check', tools: ['find', 'read'], maxLoopIterations: 20, scratchpadAware: true,
    passConversationHistory: false, prompts: { systemPromptAfterHistory: { length: 500, preview: `${'P'.repeat(200)}...` } },
  });
  assert.deepEqual(settings.blocks[3], { id: 'check', type: 'REFLECTION', nextBlockIfPass: 'out', generatorBlockId: 'loop', critiqueMaxIterations: 2, prompts: { expectationsPrompt: { length: 9, preview: 'Be exact.' } } });
  assert.deepEqual(settings.blocks[4].prompts, { template: { length: 18, preview: '{{ state.answer }}' } });
  assert.ok(JSON.stringify(summary).length * 2 < JSON.stringify(structuredFull).length);
  assert.deepEqual(value(await h.call('get_agent', { ...agentArgs, detail: 'full' })), structuredFull);
  assert.equal((await h.call('get_agent', { ...agentArgs, detail: 'partial' })).isError, true);
});

test('get_agent summary for simple visual and Python agents keeps tool refs, llmId and a code preview', async t => {
  const visual = { ...original, versions: [{ versionId: 'v1', versionTag: tag, ...unused,
    toolsUsingAgentSettings: { llmId: 'llm1', systemPromptAppend: 'Answer briefly.', completionSettings: { temperature: 0 }, tools: [{ toolRef: 'kb', additionalDescription: 'Search docs' }] } }] };
  const code = 'import dataiku\n' + '#'.repeat(400);
  const python = { ...original, type: 'PYTHON_AGENT', versions: [{ versionId: 'v1', versionTag: tag, ...unused,
    toolsUsingAgentSettings: { tools: [], llmId: null },
    pythonAgentSettings: { code, codeEnvSelection: { envMode: 'EXPLICIT_ENV', envName: 'py311' }, dependencies: [], interactionLoggingSelection: {} } }] };
  const h = harness(t, [visual, python]);
  assert.deepEqual(value(await h.call('get_agent', agentArgs)).versions, [{ versionId: 'v1', lastModifiedBy: 'builder', lastModifiedOn: 1760000000000,
    toolsUsingAgentSettings: { llmId: 'llm1', tools: [{ toolRef: 'kb', additionalDescription: 'Search docs' }], prompts: { systemPromptAppend: { length: 15, preview: 'Answer briefly.' } } } }]);
  assert.deepEqual(value(await h.call('get_agent', agentArgs)).versions, [{ versionId: 'v1', lastModifiedBy: 'builder', lastModifiedOn: 1760000000000,
    pythonAgentSettings: { codeLength: code.length, codePreview: `${code.slice(0, 300)}...`, codeEnvSelection: { envMode: 'EXPLICIT_ENV', envName: 'py311' } } }]);
});

test('create each supported agent type and managed tools with the official creation payload', async t => {
  const h = harness(t, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 't' }]);
  for (const agent_type of ['TOOLS_USING_AGENT', 'STRUCTURED_AGENT', 'PYTHON_AGENT', 'PLUGIN_AGENT']) {
    const plugin = agent_type === 'PLUGIN_AGENT' ? { plugin_agent_type: 'custom-plugin' } : {};
    value(await h.call('create_agent', { project_key, name: 'My agent', agent_type, ...plugin }));
    assert.deepEqual(h.requests.at(-1).body, { name: 'My agent', type: agent_type, pluginAgentType: plugin.plugin_agent_type ?? null });
    assert.equal(h.requests.at(-1).method, 'POST');
  }
  value(await h.call('create_agent_tool', { project_key, tool_type: 'VectorStoreSearch', creation_params: { knowledgeBankRef: 'kb1' } }));
  assert.deepEqual(h.requests.at(-1).body, { type: 'VectorStoreSearch', name: 'VectorStoreSearch', id: null, creationParams: { knowledgeBankRef: 'kb1' } });
  assert.ok(h.requests.at(-1).url.endsWith('/agents/tools'));
});

test('version patches preserve other versions and unspecified nested fields; metadata selects an existing version', async t => {
  const h = harness(t, [original, null, original, null]);
  value(await h.call('update_agent_version', { ...agentArgs, updates: { toolsUsingAgentSettings: { llmId: 'new', tools: [] } } }));
  const updated = h.requests[1].body;
  assert.equal(updated.versions[0].toolsUsingAgentSettings.llmId, 'new');
  assert.equal(updated.versions[0].toolsUsingAgentSettings.keep, 7);
  assert.deepEqual(updated.versions[0].toolsUsingAgentSettings.tools, []);
  assert.deepEqual(updated.versions[1], original.versions[1]);
  assert.deepEqual(updated.tags, original.tags);
  assert.equal(h.requests[1].method, 'PUT');
  value(await h.call('update_agent', { ...agentArgs, updates: { name: 'Renamed', activeVersion: 'v2' } }));
  assert.equal(h.requests[3].body.activeVersion, 'v2');
  assert.deepEqual(h.requests[3].body.versions, original.versions);
});

test('Python and structured agent settings can be edited through version patches', async t => {
  const code = { ...original, type: 'PYTHON_AGENT', versions: [{ versionId: 'v1', pythonAgentSettings: { code: 'old', codeEnvSelection: { envName: 'py310' } } }] };
  const structured = { ...original, type: 'STRUCTURED_AGENT', versions: [{ versionId: 'v1', structuredAgentSettings: { existing: true } }] };
  const h = harness(t, [code, null, structured, null]);
  value(await h.call('update_agent_version', { ...agentArgs, updates: { pythonAgentSettings: { code: 'new' } } }));
  assert.deepEqual(h.requests[1].body.versions[0].pythonAgentSettings, { code: 'new', codeEnvSelection: { envName: 'py310' } });
  value(await h.call('update_agent_version', { ...agentArgs, updates: { structuredAgentSettings: { customSetting: true } } }));
  assert.deepEqual(h.requests[3].body.versions[0].structuredAgentSettings, { existing: true, customSetting: true });
});

test('attachment preserves tools, deduplicates and targets only the selected version; detach preserves other references', async t => {
  const h = harness(t, [original, null, original, null, original, null]);
  value(await h.call('attach_agent_tool', { ...agentArgs, tool_ref: 'existing', additional_description: 'Extra' }));
  assert.deepEqual(h.requests[1].body.versions[0].toolsUsingAgentSettings.tools, [{ toolRef: 'existing', extra: true, additionalDescription: 'Extra' }]);
  value(await h.call('attach_agent_tool', { ...agentArgs, version_id: 'v2', tool_ref: 'SHARED.tool1' }));
  assert.deepEqual(h.requests[3].body.versions[0], original.versions[0]);
  assert.deepEqual(h.requests[3].body.versions[1].toolsUsingAgentSettings.tools, [{ toolRef: 'SHARED.tool1' }]);
  value(await h.call('detach_agent_tool', { ...agentArgs, tool_ref: 'existing' }));
  assert.deepEqual(h.requests[5].body.versions[0].toolsUsingAgentSettings.tools, []);
});

test('tool patches preserve untouched params and approval settings', async t => {
  const h = harness(t, [{ id: tool_id, type: 'VectorStoreSearch', requireHumanApproval: true, params: { knowledgeBankRef: 'kb1', maxDocuments: 5 } }, null]);
  value(await h.call('update_agent_tool', { ...toolArgs, updates: { params: { maxDocuments: 8 } } }));
  assert.deepEqual(h.requests[1].body, { id: tool_id, type: 'VectorStoreSearch', requireHumanApproval: true, params: { knowledgeBankRef: 'kb1', maxDocuments: 8 } });
});

test('invocations preserve completion envelopes, context, memory and approval requests, and use bounded timeouts', async t => {
  const response = { success: true, text: 'Waiting', toolValidationRequests: [{ id: 'approval1' }], memoryFragment: { state: 1 } };
  const h = harness(t, [{ responses: [response] }, { output: 'ok' }]);
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => { timeouts.push(milliseconds); return new AbortController().signal; });
  const query = { messages: [{ role: 'user', content: 'hello' }], context: { foo: 'bar' }, memoryFragment: { state: 0 } };
  assert.deepEqual(value(await h.call('run_agent', { ...agentArgs, query, settings: { temperature: 0.2 } })), response);
  assert.deepEqual(h.requests[0].body, { llmId: 'agent:agent1', queries: [query], settings: { temperature: 0.2 } });
  assert.ok(h.requests[0].url.endsWith('/llms/completions'));
  const invocation = { input: { searchQuery: 'question' }, subtoolName: 'search', context: { locale: 'en' } };
  value(await h.call('run_agent_tool', { ...toolArgs, invocation, timeout_seconds: 300 }));
  assert.deepEqual(h.requests[1].body, { toolId: tool_id, input: invocation });
  assert.ok(h.requests[1].url.endsWith('/agents/tools/tool1/invocations'));
  assert.deepEqual(timeouts, [120000, 300000]);
});

test('deletion and lifecycle requests use exact endpoints and do not claim completed startup', async t => {
  const h = harness(t, [null, null, null, null]);
  assert.equal(value(await h.call('delete_agent', agentArgs)).deleted, true);
  assert.equal(value(await h.call('delete_agent_tool', toolArgs)).deleted, true);
  assert.equal(value(await h.call('wake_up_agent', agentArgs)).requested, true);
  value(await h.call('shutdown_agent', { ...agentArgs, version_id: 'v2', force: true }));
  assert.deepEqual(h.requests.map(r => [r.method, new URL(r.url).pathname.split('/PROJECT')[1], r.body]), [
    ['DELETE', '/agents/agent1', undefined], ['DELETE', '/agents/tools/tool1', undefined],
    ['POST', '/agents/agent1/actions/wakeup', { versionId: null }],
    ['POST', '/agents/agent1/actions/shutdown', { versionId: 'v2', force: true }],
  ]);
});

test('invalid arguments, protected identifiers and plugin prerequisites fail before HTTP calls', async t => {
  const h = harness(t);
  for (const [name, args] of [
    ['list_agents', {}], ['get_agent', { ...agentArgs, agent_id: 12 }],
    ['list_agents', { project_key: '  ' }], ['list_agents', { project_key: '..' }], ['list_agents', { project_key, detail: 'all' }],
    ['list_agent_tools', { project_key, include_shared: 'false' }],
    ['create_agent', { project_key, name: 'a', agent_type: 'INVALID' }],
    ['create_agent', { project_key, name: 'a', agent_type: 'PLUGIN_AGENT' }],
    ['update_agent', { ...agentArgs, updates: { id: 'different' } }],
    ['update_agent', { ...agentArgs, updates: { versions: [] } }],
    ['update_agent_version', { ...agentArgs, updates: { versionId: 'different' } }],
    ['update_agent_tool', { ...toolArgs, updates: { type: 'different' } }],
    ['run_agent', { ...agentArgs, query: { messages: [] } }],
    ['run_agent_tool', { ...toolArgs, invocation: {} }],
    ['run_agent_tool', { ...toolArgs, invocation: { input: {} }, timeout_seconds: 601 }],
    ['list_agents', { project_key, unexpected: 'secret-value' }],
  ]) {
    const result = await h.call(name, args);
    assert.equal(result.isError, true, name);
    assert.ok(!result.content[0].text.includes('secret-value'));
  }
  assert.equal(h.requests.length, 0);
});

test('missing versions, wrong agent type and prototype pollution never produce a PUT', async t => {
  const h = harness(t, [original, original, { ...original, type: 'PYTHON_AGENT' }, original]);
  const calls = [
    ['update_agent_version', { ...agentArgs, version_id: 'missing', updates: {} }],
    ['update_agent', { ...agentArgs, updates: { activeVersion: 'missing' } }],
    ['attach_agent_tool', { ...agentArgs, tool_ref: tool_id }],
    ['update_agent', { ...agentArgs, updates: JSON.parse('{"nested":{"__proto__":{"polluted":true}}}') }],
  ];
  for (const [name, args] of calls) assert.equal((await h.call(name, args)).isError, true);
  assert.ok(h.requests.every(r => r.method === 'GET'));
  assert.equal({}.polluted, undefined);
});

test('identifiers are encoded as individual path segments', async t => {
  const h = harness(t, [{}]);
  value(await h.call('get_agent', { project_key: 'P/?#', agent_id: 'a/b ?#' }));
  assert.equal(h.requests[0].url, 'https://dss.example/prefix/public/api/projects/P%2F%3F%23/agents/a%2Fb%20%3F%23');
});

test('HTTP errors are sanitized; failed completions are MCP errors; timeouts do not claim cancellation', async t => {
  const h = harness(t, [new Response('secret details', { status: 403 }), { responses: [{ success: false, errorMessage: 'Model unavailable' }] }, new DOMException('secret details', 'TimeoutError')]);
  const denied = await h.call('get_agent', agentArgs);
  assert.equal(denied.isError, true);
  assert.ok(!denied.content[0].text.includes('secret details'));
  const query = { messages: [{ role: 'user', content: 'hello' }] };
  assert.equal((await h.call('run_agent', { ...agentArgs, query })).isError, true);
  const timeout = await h.call('run_agent', { ...agentArgs, query });
  assert.equal(timeout.isError, true);
  assert.match(timeout.content[0].text, /may still be running/);
});

test('make run loads .env and exposes all new tools over MCP stdio', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dataiku-mcp-test '));
  const file = join(dir, 'test.env');
  const client = new Client({ name: 'agent-smoke-test', version: '1.0.0' });
  try {
    await writeFile(file, 'DSS_HOST=https://example.invalid\nDSS_API_KEY="test#key with spaces"\nDSS_INTAKE_URL=https://intake.example/api/\n', { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('DSS_')));
    await client.connect(new StdioClientTransport({ command: 'make', args: ['--no-print-directory', '-s', '-C', resolve('..'), 'run', `ENV_FILE=${file}`], env, stderr: 'pipe' }));
    const { tools } = await client.listTools();
    assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
    for (const name of ['create_managed_folder', 'create_external_postgresql_dataset', 'autodetect_dataset_schema', 'get_intake_capabilities', 'register_document_upload', 'read_metadata_row', 'upsert_metadata_row', 'list_database_tables', 'inspect_database_table', 'get_extraction_outcome_summary', 'get_project_flow', 'get_dataset_sample', 'export_project_config', 'list_managed_folders', 'create_flow_zone', 'write_project_library_file', 'merge_project_variables', 'validate_code_environment_imports', 'start_job', 'get_knowledge_bank_status', 'check_agent_tool_startup', 'add_scenario_build_step']) {
      assert.ok(tools.some(t => t.name === name), name);
    }
    for (const name of ['update_dataset', 'update_recipe', 'update_scenario']) {
      const schema = tools.find(t => t.name === name).inputSchema;
      assert.ok(schema.required.includes('patch'));
      assert.ok(schema.properties.dry_run);
      assert.ok(schema.properties.expected_hash);
    }
    const instructions = client.getInstructions();
    assert.match(instructions, /exactly one output/);
    assert.match(instructions, /1,000 lines/);
    assert.match(instructions, /Bronze, Silver, and Gold/);
    assert.match(instructions, /native functionality is insufficient/);
    const rules = await client.callTool({ name: 'get_usage_rules', arguments: {} });
    assert.equal(rules.content[0].text, instructions);
    for (const name of ['create_recipe', 'update_recipe', 'update_agent_version', 'update_agent_tool']) {
      assert.match(tools.find(tool => tool.name === name).description, /exactly one output/);
    }
    for (const tool of agentTools) assert.ok(tools.some(item => item.name === tool.name), tool.name);
    assert.ok(tools.some(item => item.name === 'list_projects'));
    assert.equal((await client.callTool({ name: 'create_agent', arguments: {} })).isError, true);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
