import { createDataset as provisionDataset } from './provisioning.js';
import { OperationsClient, seg } from './operations-client.js';
import { AgentClient } from './agent-client.js';

import { SecureHttpClient } from './http-client.js';
export { SecureHttpClient } from './http-client.js';

export interface DataikuConfig {
  host: string;
  apiKey: string;
  insecureTls?: boolean;
  allowHttp?: boolean;
}

export interface DatasetSchema {
  columns: Array<{
    name: string;
    type: string;
    comment?: string;
  }>;
}

export interface DatasetMetrics {
  records: number;
  size: number;
  lastModified?: string;
}

export interface RecipeDefinition {
  type: string;
  name: string;
  inputs: string[];
  outputs: Array<{ name: string }>;
  code?: string;
  params?: Record<string, any>;
}

export interface ScenarioDefinition {
  id?: string;
  name: string;
  type: 'step_based' | 'custom_python';
  definition?: Record<string, any>;
  triggers?: Array<Record<string, any>>;
}

export interface JobInfo {
  id: string;
  type: string;
  status: string;
  startTime?: string;
  endTime?: string;
  error?: string;
}

export class DataikuClient {
  readonly agents: AgentClient;
  readonly operations: OperationsClient;
  readonly client: SecureHttpClient;
  private config: DataikuConfig;

  constructor(config?: Partial<DataikuConfig>) {
    this.config = {
      host: config?.host || process.env.DSS_HOST || '',
      apiKey: config?.apiKey || process.env.DSS_API_KEY || '',
      insecureTls: config?.insecureTls || process.env.DSS_INSECURE_TLS === 'true',
      allowHttp: config?.allowHttp ?? process.env.DSS_ALLOW_HTTP === 'true',
    };

    if (!this.config.host || !this.config.apiKey) {
      throw new Error('Dataiku DSS host and API key are required');
    }

    if (this.config.insecureTls) {
      throw new Error('DSS_INSECURE_TLS is not supported by the hardened server');
    }

    let host: URL;
    try {
      host = new URL(this.config.host);
    } catch {
      throw new Error('DSS_HOST must be a valid HTTP or HTTPS URL');
    }
    if (host.protocol !== 'https:' && host.protocol !== 'http:') {
      throw new Error('DSS_HOST must use HTTP or HTTPS');
    }
    if (host.protocol === 'http:' && !this.config.allowHttp) {
      throw new Error('DSS_HOST requires HTTPS by default. For a trusted HTTP-only instance, explicitly set DSS_ALLOW_HTTP=true; the API key will be sent without transport encryption');
    }
    if (host.username || host.password || host.search || host.hash) {
      throw new Error('DSS_HOST must not contain credentials, query parameters, or fragments');
    }

    const normalizedPath = host.pathname.replace(/\/+$/, '');
    host.pathname = normalizedPath.includes('/public/api')
      ? `${normalizedPath}/`
      : `${normalizedPath}/public/api/`;

    this.client = new SecureHttpClient(host, this.config.apiKey);
    this.agents = new AgentClient(this.client);
    this.operations = new OperationsClient(this.client);
  }

  // Project operations
  async listProjects(): Promise<Array<{ key: string; name: string; description?: string }>> {
    const response = await this.client.get('/projects/');
    return response.data.map((project: any) => ({
      key: project.projectKey || project.key || 'unknown',
      name: project.name || project.projectName || 'Unnamed Project',
      description: project.description || project.shortDesc || ''
    }));
  }

  async getProject(projectKey: string): Promise<any> {
    const response = await this.client.get(`/projects/${seg(projectKey)}`);
    return response.data;
  }

  async getProjectFlow(projectKey: string): Promise<any> {
    return this.operations.flow(projectKey);
  }

  // Dataset operations
  async listDatasets(projectKey: string): Promise<any[]> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/datasets/`);
    return response.data;
  }

  async getDataset(projectKey: string, datasetName: string): Promise<any> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/datasets/${seg(datasetName)}`);
    return response.data;
  }

  async createDataset(projectKey: string, datasetName: string, datasetType: string, params: Record<string, any>): Promise<any> {
    return provisionDataset(this.operations, {project_key: projectKey, dataset_name: datasetName, dataset_type: datasetType, params});
  }

  async updateDataset(projectKey: string, datasetName: string, updates: Record<string, any>): Promise<any> {
    return this.operations.updateObject('datasets', { project_key: projectKey, dataset_name: datasetName, patch: updates });
  }

  async deleteDataset(projectKey: string, datasetName: string, dropData: boolean = false): Promise<any> {
    const response = await this.client.delete(`/projects/${seg(projectKey)}/datasets/${seg(datasetName)}`, {
      params: { dropData },
    });
    return response.data;
  }

  async getDatasetSchema(projectKey: string, datasetName: string): Promise<DatasetSchema> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/datasets/${seg(datasetName)}/schema`);
    return response.data;
  }

  async getDatasetMetrics(projectKey: string, datasetName: string): Promise<DatasetMetrics> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/datasets/${seg(datasetName)}/metrics/last/NP`);
    return response.data;
  }

  async getDatasetInfo(projectKey: string, datasetName: string): Promise<any> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/datasets/${seg(datasetName)}`);
    return response.data;
  }

  async clearDataset(projectKey: string, datasetName: string, partition?: string): Promise<any> {
    const response = await this.client.delete(`/projects/${seg(projectKey)}/datasets/${seg(datasetName)}/data`, { params: { partitions: partition } });
    return response.data;
  }

  async getDatasetSample(projectKey: string, datasetName: string, rows: number = 100, columns?: string[]): Promise<any> {
    return this.operations.sample({ project_key: projectKey, dataset_name: datasetName, rows, columns });
  }

  // Recipe operations
  async listRecipes(projectKey: string): Promise<any[]> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/recipes/`);
    return response.data;
  }

  async getRecipe(projectKey: string, recipeName: string): Promise<any> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/recipes/${seg(recipeName)}`);
    return response.data;
  }

  async getRecipeInfo(projectKey: string, recipeName: string): Promise<any> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/recipes/${seg(recipeName)}`);
    return response.data;
  }

  async createRecipe(projectKey: string, recipe: RecipeDefinition): Promise<any> {
    const data = {
      recipePrototype: {
        projectKey,
        type: recipe.type,
        name: recipe.name,
        inputs: { main: { items: recipe.inputs.map(ref => ({ ref })) } },
        outputs: { main: { items: recipe.outputs.map(output => ({ ref: output.name, appendMode: false })) } },
      },
      creationSettings: recipe.code === undefined ? {} : { payload: recipe.code },
    };
    const response = await this.client.post(`/projects/${seg(projectKey)}/recipes/`, data);
    return response.data;
  }

  async updateRecipe(projectKey: string, recipeName: string, updates: Record<string, any>): Promise<any> {
    return this.operations.updateObject('recipes', { project_key: projectKey, recipe_name: recipeName, patch: updates });
  }

  async deleteRecipe(projectKey: string, recipeName: string): Promise<any> {
    const response = await this.client.delete(`/projects/${seg(projectKey)}/recipes/${seg(recipeName)}`);
    return response.data;
  }

  // Scenario operations
  async getScenario(projectKey: string, scenarioId: string): Promise<any> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/scenarios/${seg(scenarioId)}`);
    return response.data;
  }

  async listScenarios(projectKey: string, scenarioType?: string, activeOnly?: boolean): Promise<any[]> {
    const params: Record<string, any> = {};
    if (scenarioType) params.type = scenarioType;
    if (activeOnly) params.active = true;

    const response = await this.client.get(`/projects/${seg(projectKey)}/scenarios/`, { params });
    return response.data;
  }

  async getScenarioRunHistory(projectKey: string, scenarioId: string, limit: number = 10, onlyFinishedRuns: boolean = false): Promise<any> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/scenarios/${seg(scenarioId)}/get-last-runs`, { params: { limit, onlyFinishedRuns } });
    return response.data;
  }

  async createScenario(projectKey: string, scenario: ScenarioDefinition): Promise<any> {
    const data = { ...(scenario.definition ?? { params: {} }), type: scenario.type, name: scenario.name };
    const response = await this.client.post(`/projects/${seg(projectKey)}/scenarios/`, data);
    return response.data;
  }

  async updateScenario(projectKey: string, scenarioId: string, updates: Record<string, any>): Promise<any> {
    return this.operations.updateObject('scenarios', { project_key: projectKey, scenario_id: scenarioId, patch: updates });
  }

  async deleteScenario(projectKey: string, scenarioId: string): Promise<any> {
    const response = await this.client.delete(`/projects/${seg(projectKey)}/scenarios/${seg(scenarioId)}`);
    return response.data;
  }

  async runScenario(projectKey: string, scenarioId: string): Promise<any> {
    const response = await this.client.post(`/projects/${seg(projectKey)}/scenarios/${seg(scenarioId)}/run`);
    return response.data;
  }

  async getScenarioInfo(projectKey: string, scenarioId: string): Promise<any> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/scenarios/${seg(scenarioId)}/info`);
    return response.data;
  }

  async getScenarioSteps(projectKey: string, scenarioId: string): Promise<any> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/scenarios/${seg(scenarioId)}/steps`);
    return response.data;
  }

  // Job operations
  async getJobs(projectKey: string, limit: number = 50, statusFilter?: string): Promise<any[]> {
    const params: Record<string, any> = { limit };
    if (statusFilter) {
      params.status = statusFilter;
    }
    const response = await this.client.get(`/projects/${seg(projectKey)}/jobs/`, { params });
    return response.data;
  }

  async getJobDetails(projectKey: string, jobId: string): Promise<JobInfo> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/jobs/${seg(jobId)}`);
    return response.data;
  }

  async cancelJob(projectKey: string, jobId: string): Promise<any> {
    const response = await this.client.post(`/projects/${seg(projectKey)}/jobs/${seg(jobId)}/abort`);
    return response.data;
  }

  // Project exploration
  // Productivity tools
  async exportProjectConfig(projectKey: string, _format?: 'json' | 'yaml'): Promise<any> {
    return this.operations.exportProject({ project_key: projectKey, include_manifest: true });
  }

  // Environment configuration
  async getCodeEnvironments(): Promise<any[]> {
    const response = await this.client.get('/admin/code-envs/');
    return Array.isArray(response.data) ? response.data : [response.data];
  }

  async getProjectVariables(projectKey: string): Promise<any> {
    const response = await this.client.get(`/projects/${seg(projectKey)}/variables/`);
    return response.data;
  }

  async getConnections(): Promise<any[]> {
    const response = await this.client.get('/admin/connections/');
    return Array.isArray(response.data) ? response.data : [response.data];
  }
}
