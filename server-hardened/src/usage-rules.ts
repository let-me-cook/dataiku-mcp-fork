import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const usageRules = `Dataiku Flow Design Rules
Apply these rules whenever creating or modifying Dataiku flows with this MCP:

1. Prefer native nodes. Use Dataiku's built-in visual recipes and processors whenever they can perform the task. Use Python only when native functionality is insufficient, and briefly explain why Python is necessary.

2. Keep Python nodes small and focused. Each Python recipe/node must have exactly one output. Each node's Python code must contain no more than 1,000 lines, including comments and blank lines. Split larger implementations into smaller, purpose-specific nodes; each must follow the same output and line limits.

3. Organize the Flow into three zones named Bronze, Silver, and Gold. Prioritize a visually clean layout, consistent naming, and readable connections. These are flexible organizational groups; strict medallion architecture semantics are not required. When convenient, place inputs in Bronze, intermediate transformations in Silver, and final outputs in Gold.

Inspect existing objects before editing them. Apply these rules within the user's requested scope; read-only requests do not authorize restructuring existing flows. Reuse existing zones case-insensitively with list_flow_zones; use the scoped zone tools to create, move, share, and position objects. Report any remaining layout limitations rather than claiming the layout is complete. These are instructions for agents using this MCP; they are not automatically installed as prompts in DSS agents.`;

export const usageRulesTool: Tool = {
  name: 'get_usage_rules',
  description: `Read the standing rules before designing or changing Dataiku flows. ${usageRules}`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const designTools = new Set([
  'create_managed_folder', 'create_external_postgresql_dataset',
  'create_flow_zone', 'update_flow_zone', 'move_flow_objects', 'share_flow_object', 'add_scenario_build_step',
  'create_recipe', 'update_recipe', 'create_dataset', 'update_dataset',
  'create_scenario', 'update_scenario', 'clone_scenario',
  'create_agent', 'update_agent', 'update_agent_version',
  'create_agent_tool', 'update_agent_tool', 'batch_update_objects', 'duplicate_project_structure',
]);

export function withUsageRules(tool: Tool): Tool {
  if (!designTools.has(tool.name)) return tool;
  return {
    ...tool,
    description: `${tool.description ?? ''} Flow design rules: prefer native visual nodes; justify Python when needed. Each Python recipe/node must have exactly one output and at most 1,000 lines including comments and blanks. Organize flows neatly into Bronze, Silver, and Gold zones with flexible semantics. See get_usage_rules for full instructions.`,
  };
}
