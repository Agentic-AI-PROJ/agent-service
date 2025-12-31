// src/tools/mcp-tools.ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { MCPClient, MCPTool } from './mcp-client.js';

/**
 * Convert JSON Schema properties to Zod schema
 */
function jsonSchemaToZod(schema: any): z.ZodTypeAny {
    if (!schema || !schema.properties) {
        return z.object({});
    }

    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, value] of Object.entries(schema.properties)) {
        const prop = value as any;
        let zodType: z.ZodTypeAny;

        // Determine the Zod type based on JSON Schema type
        switch (prop.type) {
            case 'string':
                zodType = z.string();
                break;
            case 'number':
            case 'integer':
                zodType = z.number();
                break;
            case 'boolean':
                zodType = z.boolean();
                break;
            case 'array':
                zodType = z.array(z.any());
                break;
            case 'object':
                zodType = z.record(z.string(), z.any());
                break;
            default:
                zodType = z.any();
        }

        // Add description if available
        if (prop.description) {
            zodType = zodType.describe(prop.description);
        }

        // Check if the field is required
        const required = schema.required || [];
        if (!required.includes(key)) {
            zodType = (zodType as any).optional();
        }

        shape[key] = zodType;
    }

    return z.object(shape);
}

/**
 * Create LangChain tools from MCP tools
 */
export async function createMCPTools(mcpClient: MCPClient): Promise<DynamicStructuredTool[]> {
    const mcpTools = await mcpClient.listTools();

    return mcpTools.map((tool: MCPTool) => {
        // Convert the MCP tool's input schema to a Zod schema
        const zodSchema = jsonSchemaToZod(tool.inputSchema);

        return new DynamicStructuredTool({
            name: tool.name,
            description: tool.description || 'No description available',
            schema: zodSchema,
            func: async (input: any) => {
                try {
                    const result = await mcpClient.callTool(tool.name, input);
                    return result;
                } catch (error: any) {
                    return `Error: ${error.message}`;
                }
            },
        });
    });
}

/**
 * Format tools for display in prompts
 */
export function formatToolsForPrompt(tools: DynamicStructuredTool[]): string {
    return tools.map(tool => {
        const schema = tool.schema as z.ZodObject<any>;
        const shape = schema.shape;

        // Extract parameter names and descriptions
        const params = Object.entries(shape).map(([key, zodType]) => {
            const desc = (zodType as any)._def?.description || '';
            return `${key}${desc ? `: ${desc}` : ''}`;
        }).join(', ');

        return `- ${tool.name}(${params}): ${tool.description}`;
    }).join('\n');
}
