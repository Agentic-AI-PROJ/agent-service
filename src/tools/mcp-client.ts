// src/tools/mcp-client.ts
/**
 * HTTP client for communicating with the MCP server REST API
 */

import logger from "../utils/logger.js";
import { createMCPTools } from "./mcp-tools.js";

export interface MCPTool {
    name: string;
    server: string;
    description: string;
    inputSchema: any;
}

export interface MCPToolResult {
    result: {
        content: Array<{
            type: string;
            text: string;
        }>;
    };
}

export class MCPClient {
    private baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    /**
     * Fetch all available tools from the MCP server
     */
    async listTools(): Promise<MCPTool[]> {
        try {
            const response = await fetch(`${this.baseUrl}/tools`);

            if (!response.ok) {
                throw new Error(`Failed to fetch tools: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            return (data as { tools: MCPTool[] }).tools || [];
        } catch (error: any) {
            logger.error('Error fetching tools from MCP server:', error.message);
            throw new Error(`MCP server connection failed: ${error.message}`);
        }
    }

    /**
     * Execute a tool on the MCP server
     */
    async callTool(toolName: string, args: any): Promise<string> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

        try {
            const response = await fetch(`${this.baseUrl}/tools/${toolName}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ arguments: args }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Failed to call tool: ${response.status} ${response.statusText}`);
            }

            const data = await response.json() as MCPToolResult;

            // Extract text from the result
            if (data.result?.content && Array.isArray(data.result.content)) {
                const textContent = data.result.content
                    .filter((item) => item.type === 'text')
                    .map((item) => item.text)
                    .join('\n');
                return textContent;
            }

            return JSON.stringify(data.result);
        } catch (error: any) {
            clearTimeout(timeoutId);
            logger.error(`Error calling tool ${toolName}:`, error.message);
            if (error.name === 'AbortError') {
                throw new Error(`Tool execution timed out after 60s`);
            }
            throw new Error(`Tool execution failed: ${error.message}`);
        }
    }

    /**
     * Check if the MCP server is reachable
     */
    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/health`);
            return response.ok;
        } catch (error) {
            return false;
        }
    }
}

export const connectToMCP = async () => {
    logger.info('🔌 Connecting to MCP server...');

    // Initialize MCP client (use environment variable or default to localhost:3011)
    const mcpServerUrl = process.env.MCP_CLIENT_URL || 'http://localhost:3011';
    const mcpClient = new MCPClient(mcpServerUrl);

    // Check if MCP server is reachable
    const isHealthy = await mcpClient.healthCheck();
    if (!isHealthy) {
        const errorMsg = `Error: MCP server is not reachable at ${mcpServerUrl}`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }

    logger.info('Connected to MCP server');

    logger.info('Fetching tools from MCP server...');
    const tools = await createMCPTools(mcpClient);
    // logger.info(`Loaded ${tools.length} tools from MCP server:`);
    tools.forEach(tool => {
        // logger.info(`   - ${tool.name}: ${tool.description}`);
    });
    return tools;
}