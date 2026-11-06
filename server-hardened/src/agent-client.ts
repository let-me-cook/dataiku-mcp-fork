import type { SecureHttpClient } from './dataiku-client.js';

type Settings = Record<string, any>;
export const AGENT_TYPES = ['TOOLS_USING_AGENT', 'STRUCTURED_AGENT', 'PYTHON_AGENT', 'PLUGIN_AGENT'];

function segment(value: string): string {
  if (!value.trim() || value === '.' || value === '..') throw new Error('Invalid Dataiku identifier');
  return encodeURIComponent(value);
}

// Deep object patches preserve DSS defaults. Arrays are explicitly replaced, never merged by index.
export function mergeSettings(current: Settings, patch: Settings): Settings {
  const result = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid settings key');
    result[key] = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? mergeSettings(current[key] !== null && typeof current[key] === 'object' && !Array.isArray(current[key]) ? current[key] : {}, value)
      : value;
  }
  return result;
}

function protect(patch: Settings, keys: string[]) {
  if (keys.some(key => Object.prototype.hasOwnProperty.call(patch, key))) throw new Error(`Cannot patch protected fields: ${keys.join(', ')}`);
}

function version(settings: Settings, versionId?: string): Settings {
  const id = versionId ?? settings.activeVersion;
  const found = settings.versions?.find((item: Settings) => item.versionId === id);
  if (!found) throw new Error('Agent version not found; inspect get_agent and specify version_id');
  return found;
}

/** REST contracts verified against the official dataiku-api-client 14.7.1 source distribution. */
export class AgentClient {
  constructor(private readonly http: SecureHttpClient) {}

  private base(project: string) { return `/projects/${segment(project)}`; }
  private agent(project: string, id: string) { return `${this.base(project)}/agents/${segment(id)}`; }
  private tool(project: string, id: string) { return `${this.base(project)}/agents/tools/${segment(id)}`; }

  async listAgents(project: string) {
    return (await this.http.get(`${this.base(project)}/agents`)).data;
  }

  async getAgent(project: string, id: string) {
    return (await this.http.get(this.agent(project, id))).data;
  }

  async createAgent(project: string, name: string, type: string, pluginAgentType?: string) {
    if (!AGENT_TYPES.includes(type)) throw new Error('Unsupported agent type');
    if (type === 'PLUGIN_AGENT' && !pluginAgentType?.trim()) throw new Error('plugin_agent_type is required for PLUGIN_AGENT');
    if (type !== 'PLUGIN_AGENT' && pluginAgentType !== undefined) throw new Error('plugin_agent_type is only valid for PLUGIN_AGENT');
    return (await this.http.post(`${this.base(project)}/agents`, { name, type, pluginAgentType: pluginAgentType ?? null })).data;
  }

  async updateAgent(project: string, id: string, patch: Settings) {
    protect(patch, ['id', 'projectKey', 'type', 'versions']);
    const settings = mergeSettings(await this.getAgent(project, id), patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'activeVersion')) version(settings, patch.activeVersion);
    await this.http.put(this.agent(project, id), settings);
    return { projectKey: project, id, updated: true };
  }

  async updateAgentVersion(project: string, id: string, patch: Settings, versionId?: string) {
    protect(patch, ['versionId']);
    const settings = await this.getAgent(project, id);
    const selected = version(settings, versionId);
    const updated = mergeSettings(selected, patch);
    settings.versions = settings.versions.map((item: Settings) => item === selected ? updated : item);
    await this.http.put(this.agent(project, id), settings);
    return { projectKey: project, id, versionId: selected.versionId, updated: true };
  }

  async changeAgentTool(project: string, id: string, toolRef: string, attach: boolean, versionId?: string, description?: string) {
    const settings = await this.getAgent(project, id);
    if (settings.type !== 'TOOLS_USING_AGENT') throw new Error('Tool attachment helpers require a Simple Visual Agent; configure code or structured agents through update_agent_version');
    const selected = version(settings, versionId);
    const visual = selected.toolsUsingAgentSettings;
    if (!visual || !Array.isArray(visual.tools)) throw new Error('Unexpected visual agent settings');
    const existing = visual.tools.find((tool: Settings) => tool.toolRef === toolRef);
    if (attach) {
      if (existing) {
        if (description !== undefined) existing.additionalDescription = description;
      } else {
        visual.tools.push({ toolRef, ...(description === undefined ? {} : { additionalDescription: description }) });
      }
    } else {
      visual.tools = visual.tools.filter((tool: Settings) => tool.toolRef !== toolRef);
    }
    await this.http.put(this.agent(project, id), settings);
    return { projectKey: project, id, versionId: selected.versionId, tools: visual.tools };
  }

  async deleteAgent(project: string, id: string) {
    await this.http.delete(this.agent(project, id));
    return { projectKey: project, id, deleted: true };
  }

  async agentAction(project: string, id: string, action: 'wakeup' | 'shutdown', versionId?: string, force = false) {
    await this.http.post(`${this.agent(project, id)}/actions/${action}`, {
      versionId: versionId ?? null, ...(action === 'shutdown' ? { force } : {}),
    });
    return { projectKey: project, id, action, requested: true };
  }

  async listLlms(project: string) {
    return (await this.http.get(`${this.base(project)}/llms`, { params: { purpose: 'GENERIC_COMPLETION' } })).data;
  }

  async runAgent(project: string, id: string, query: Settings, settings: Settings = {}, timeoutSeconds = 120) {
    const response = (await this.http.post(`${this.base(project)}/llms/completions`, {
      llmId: `agent:${id}`, queries: [query], settings,
    }, { timeoutMs: timeoutSeconds * 1000 })).data;
    if (!Array.isArray(response?.responses) || response.responses.length !== 1) throw new Error('Unexpected agent completion response');
    return response.responses[0];
  }

  async listAgentTools(project: string, includeShared = false) {
    return (await this.http.get(`${this.base(project)}/agents/tools`, {
      params: { includeDescriptions: false, foreign: includeShared },
    })).data.tools;
  }

  async getAgentTool(project: string, id: string) {
    return (await this.http.get(this.tool(project, id))).data;
  }

  async getAgentToolDescriptor(project: string, id: string) {
    return (await this.http.get(`${this.tool(project, id)}/descriptor`)).data;
  }

  async createAgentTool(project: string, type: string, name?: string, id?: string, creationParams: Settings = {}) {
    return (await this.http.post(`${this.base(project)}/agents/tools`, {
      type, name: name ?? type, id: id ?? null, creationParams,
    })).data;
  }

  async updateAgentTool(project: string, id: string, patch: Settings) {
    protect(patch, ['id', 'projectKey', 'type']);
    const settings = mergeSettings(await this.getAgentTool(project, id), patch);
    await this.http.put(this.tool(project, id), settings);
    return { projectKey: project, id, updated: true };
  }

  async deleteAgentTool(project: string, id: string) {
    await this.http.delete(this.tool(project, id));
    return { projectKey: project, id, deleted: true };
  }

  async runAgentTool(project: string, id: string, invocation: Settings, timeoutSeconds = 120) {
    return (await this.http.post(`${this.tool(project, id)}/invocations`, {
      toolId: id, input: invocation,
    }, { timeoutMs: timeoutSeconds * 1000 })).data;
  }
}
