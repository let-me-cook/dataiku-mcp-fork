#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DataikuClient } from './dataiku-client.js';
import { usageRules } from './usage-rules.js';
import { callTool, listTools } from './tool-registry.js';
import { readPolicy } from './tool-policy.js';

/**
 * MCP Server for Dataiku DSS integration
 */
export class DataikuMcpServer {
  private server: Server;
  private client: DataikuClient;

  constructor() {
    const policy = readPolicy();
    this.server = new Server(
      { name: 'dataiku-dss-mcp', version: '1.0.0' },
      { instructions: usageRules, capabilities: { tools: {} } }
    );
    this.client = new DataikuClient();
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools(policy) }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      callTool(this.client, request.params.name, request.params.arguments, policy));
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Dataiku DSS MCP Server running on stdio');
  }
}

// Start the server
try {
  const server = new DataikuMcpServer();
  server.run().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
} catch (error) {
  console.error('Server error:', error instanceof Error ? error.message : 'Startup failed');
  process.exit(1);
}
