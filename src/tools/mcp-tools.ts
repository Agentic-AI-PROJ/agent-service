// src/tools/mcp-tools.ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { MCPClient, MCPTool } from './mcp-client.js';

/**
 * Convert JSON Schema properties to Zod schema
 */
/**
 * Convert JSON Schema properties to Zod schema recursively
 */
function jsonSchemaToZod(schema: any): z.ZodTypeAny {
    if (!schema) {
        return z.any();
    }

    let zodType: z.ZodTypeAny;

    // Handle explicit types
    switch (schema.type) {
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
            const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.any();
            zodType = z.array(itemSchema);
            break;
        case 'object':
            if (schema.properties) {
                const shape: Record<string, z.ZodTypeAny> = {};
                for (const [key, value] of Object.entries(schema.properties)) {
                    let propZod = jsonSchemaToZod(value);
                    const isRequired = schema.required?.includes(key);
                    if (!isRequired) {
                        propZod = propZod.optional();
                    }
                    shape[key] = propZod;
                }
                zodType = z.object(shape);
            } else {
                // Free-form object if no properties defined
                zodType = z.record(z.string(), z.any());
            }
            break;
        default:
            // If type is not specified but properties exist, treat as object (common in root schemas)
            if (schema.properties) {
                const shape: Record<string, z.ZodTypeAny> = {};
                for (const [key, value] of Object.entries(schema.properties)) {
                    let propZod = jsonSchemaToZod(value);
                    const isRequired = schema.required?.includes(key);
                    if (!isRequired) {
                        propZod = propZod.optional();
                    }
                    shape[key] = propZod;
                }
                zodType = z.object(shape);
            } else {
                zodType = z.any();
            }
    }

    // Add description if available
    if (schema.description) {
        zodType = zodType.describe(schema.description);
    }

    return zodType;
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
