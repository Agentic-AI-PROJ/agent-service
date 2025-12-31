// src/graph/nodes.ts
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { AgentStateType } from './state-schema.js';
import { generateText, generateTextStream } from './generate-text.js';
import { wrapNode } from '../utils/execution-tracker.js';
import { getPlanningPrompt, getDecisionPrompt, getFinalAnswerPrompt, getReplannerPrompt, getSummarizerPrompt } from './prompts.js';
import NodeConfig from '../models/node-config.js';

// Helper to get active model config
async function getActiveModelForNode(nodeName: string, defaultModel: string): Promise<string> {
    try {
        const config = await NodeConfig.findOne({ nodeName });
        if (config && config.modelName) {
            return config.modelName;
        }
    } catch (error) {
        console.error(`Error fetching config for node ${nodeName}:`, error);
    }
    return defaultModel;
}

// Helper to construct prompt from DB config or fallback
export async function constructPrompt(
    nodeName: string,
    defaultPrompt: string,
    variables: Record<string, any>
): Promise<string> {
    try {
        const config = await NodeConfig.findOne({ nodeName });
        if (config && config.systemPrompt) {
            let prompt = config.systemPrompt;
            for (const [key, value] of Object.entries(variables)) {
                // simple replace all occurrences of {{key}}
                // We use split/join which is safer than regex for user content
                const valStr = value === undefined || value === null ? '' : String(value);
                prompt = prompt.split(`{{${key}}}`).join(valStr);
            }
            return prompt;
        }
    } catch (error) {
        console.error(`Error fetching prompt config for node ${nodeName}:`, error);
    }
    return defaultPrompt;
}

// Helper to extract images from messages
// Image extraction removed

// Planning node - creates an execution plan based on user's request
export function makePlanningNode(tools: DynamicStructuredTool[]) {
    return wrapNode('planning', async function planningNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
        const messages = state.messages;
        const userMessages = messages.filter((m) => m._getType() === 'human');

        const lastMessage = userMessages[userMessages.length - 1];

        if (!lastMessage) {
            return { plan: 'No user request found.' };
        }

        let userRequestText = '';

        if (typeof lastMessage.content === 'string') {
            userRequestText = lastMessage.content;
        } else if (Array.isArray(lastMessage.content)) {
            // Handle content array but ignore images for now as vision feature is removed
            for (const part of lastMessage.content) {
                if (part.type === 'text') {
                    userRequestText += part.text + '\n';
                }
            }
        }

        // Generate dynamic tool descriptions
        const toolDescriptions = tools.map(tool => {
            const schema = tool.schema as any;
            const shape = schema.shape || {};
            const params = Object.keys(shape).join(', ');
            return `- ${tool.name}(${params}): ${tool.description}`;
        }).join('\n');

        // Extract Research History (Tools called after user request)
        // Find the index of the last human message
        const lastHumanIndex = messages.lastIndexOf(lastMessage);
        const researchMessages = messages.slice(lastHumanIndex + 1);

        let researchHistory = '';
        for (const msg of researchMessages) {
            const type = msg._getType();
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            researchHistory += `[${type}]: ${content}\n`;
        }
        if (!researchHistory) researchHistory = "No research steps taken yet.";

        const finalPrompt = await constructPrompt(
            'planning',
            getPlanningPrompt(toolDescriptions, userRequestText, researchHistory),
            { toolDescriptions, userRequestText, researchHistory }
        );

        const modelName = await getActiveModelForNode('planning', 'gemini/gemini-2.5-flash-lite');
        const response = await generateText(finalPrompt, modelName);
        let responseText = response.text.trim();

        // Clean up markdown code blocks if present
        responseText = responseText.replace(/^```json\s*/, '').replace(/\s*```$/, '');

        try {
            // Try enabling fuzzy JSON extraction
            const jsonStart = responseText.indexOf('{');
            const jsonEnd = responseText.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd !== -1) {
                responseText = responseText.substring(jsonStart, jsonEnd + 1);
            }

            const parsed = JSON.parse(responseText);

            if (parsed.action === 'tool_call') {
                // Return a tool call message to trigger the tool node
                const aiMessage = new AIMessage(JSON.stringify({
                    reasoning: parsed.reasoning,
                    tool_call: parsed.tool_call
                }));
                // We return this as a message, so the graph will route to tool_node
                // We do NOT set the plan yet
                return {
                    messages: [aiMessage],
                    // We don't increment steps here heavily, or maybe we do? 
                    // Let's increment steps to prevent infinite loops
                    steps: (state.steps || 0) + 1
                };
            } else if (parsed.action === 'plan') {
                return {
                    plan: parsed.plan,
                    steps: (state.steps || 0) + 1
                };
            } else {
                // Fallback if action is missing but plan exists
                if (parsed.plan) {
                    return { plan: parsed.plan, steps: (state.steps || 0) + 1 };
                }
                throw new Error("Invalid planning response format");
            }

        } catch (e) {
            console.error("Planning node JSON parse error", e);
            // Fallback: If it's just text, assume it's the plan
            return { plan: response.text, steps: (state.steps || 0) + 1 };
        }
    });
}

// LLM node factory - creates a node that decides on tool usage or final answer
export function makeDecisionNode(tools: DynamicStructuredTool[]) {
    return wrapNode('llm_call', async function decisionNode(state: AgentStateType, config?: any): Promise<Partial<AgentStateType>> {
        const messages = state.messages;
        const plan = state.plan;
        const llmCalls = state.llm_calls || 0;
        const steps = state.steps || 0;

        const summary = state.summary || 'No prior context';
        const recentMessages = messages.slice(-4);

        // Build context from conversation history
        let conversationContext = '';
        for (const msg of recentMessages) {
            const msgType = msg._getType();
            const content = msg.content as string;

            if (msgType === 'human') {
                conversationContext += `User: ${content}\n`;
            } else if (msgType === 'ai') {
                conversationContext += `Assistant: ${content}\n`;
            } else if (msgType === 'tool') {
                conversationContext += `Tool Result: ${content}\n`;
            }
        }

        // Generate dynamic tool descriptions
        const toolDescriptions = tools.map(tool => {
            const schema = tool.schema as any;
            const shape = schema.shape || {};
            const params = Object.keys(shape).join(', ');
            return `- ${tool.name}(${params}): ${tool.description}`;
        }).join('\n');

        const maxSteps = 30;
        const remainingSteps = maxSteps - steps;
        const iteration = maxSteps - remainingSteps;

        // Construct the prompt
        const defaultPrompt = getDecisionPrompt(
            summary,
            remainingSteps,
            maxSteps,
            iteration,
            plan,
            toolDescriptions,
            conversationContext
        );

        const finalPrompt = await constructPrompt('llm_call', defaultPrompt, {
            summary,
            remainingSteps,
            maxSteps,
            iteration,
            plan,
            toolDescriptions,
            conversationHistory: conversationContext
        });

        const modelName = await getActiveModelForNode('llm_call', 'gemini/gemini-2.5-flash-lite');
        const response = await generateText(finalPrompt, modelName);
        let responseText = response.text.trim();

        // Clean up markdown code blocks if present
        responseText = responseText.replace(/^```json\s * /, '').replace(/\s * ```$/, '');

        let parsedResponse;
        try {
            // Try enabling fuzzy JSON extraction
            const jsonStart = responseText.indexOf('{');
            const jsonEnd = responseText.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd !== -1) {
                responseText = responseText.substring(jsonStart, jsonEnd + 1);
            }
            parsedResponse = JSON.parse(responseText);
        } catch (e) {
            // Fallback for cases where LLM might output text despite instructions
            // Use a heuristic or return an error message to the graph
            return {
                messages: [new AIMessage(`Error: Invalid JSON response from decision node: ${responseText}`)],
                llm_calls: llmCalls + 1,
                steps: steps + 1,
            };
        }

        if (parsedResponse.action === 'final_answer') {
            // We are ready to answer, do NOT add a message yet.
            return {
                ready_to_reply: true,
                llm_calls: llmCalls + 1,
                steps: steps + 1
            };
        } else if (parsedResponse.tool_call) {
            // It's a tool call
            // We need to format it as the expected JSON string for the tool node parser
            const aiMessage = new AIMessage(JSON.stringify({
                reasoning: parsedResponse.reasoning,
                tool_call: parsedResponse.tool_call
            }));

            return {
                messages: [aiMessage],
                llm_calls: llmCalls + 1,
                ready_to_reply: false,
                steps: steps + 1
            };
        }

        // Default fallback
        return {
            ready_to_reply: true,
            llm_calls: llmCalls + 1,
            steps: steps + 1
        };
    });
}

// Final Answer Node - generates the actual response to the user
export function makeFinalAnswerNode(streamCallback?: (chunk: string) => void) {
    return wrapNode('final_answer', async function finalAnswerNode(state: AgentStateType, config?: any): Promise<Partial<AgentStateType>> {
        const messages = state.messages;
        const plan = state.plan;

        // Context building
        const recentMessages = messages.slice(-6);
        let conversationContext = '';
        for (const msg of recentMessages) {
            const msgType = msg._getType();
            const content = msg.content as string;
            // Skip raw tool call JSON messages for cleaner context
            if (msgType === 'ai' && content.includes('tool_call')) continue;

            if (msgType === 'human') {
                conversationContext += `User: ${content} \n`;
            } else if (msgType === 'ai') {
                conversationContext += `Assistant: ${content} \n`;
            } else if (msgType === 'tool') {
                conversationContext += `Tool Result: ${content} \n`;
            }
        }

        const defaultPrompt = getFinalAnswerPrompt(conversationContext);
        const finalPrompt = await constructPrompt('final_answer', defaultPrompt, {
            conversationContext
        });

        const modelName = await getActiveModelForNode('final_answer', 'gemini/gemini-2.5-flash-lite');

        // Extract signal from config if available (passed from controller)
        const signal = config?.configurable?.signal;

        let response;
        if (streamCallback) {
            response = await generateTextStream(finalPrompt, modelName, streamCallback, signal);
        } else {
            response = await generateText(finalPrompt, modelName);
        }

        return {
            messages: [new AIMessage(response.text)],
            ready_to_reply: false, // reset flag
            steps: (state.steps || 0) + 1
        };
    });
}

// Tool node factory - creates a node that executes tools
export function toolNodeFactory(toolsByName: Record<string, StructuredToolInterface>) {
    return wrapNode('tool_node', async function toolNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
        const messages = state.messages;

        if (messages.length === 0) {
            return {};
        }

        const lastMessage = messages[messages.length - 1];

        const steps = state.steps || 0;

        if (!lastMessage) {
            return { steps: steps + 1 };
        }

        const lastText = lastMessage.content as string;

        // Try to parse tool call from the message
        let toolCall: any = null;
        try {
            // Look for JSON in the message
            const jsonMatch = lastText.match(/\{[\s\S]*"tool_call"[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                toolCall = parsed.tool_call;
            }
        } catch (e) {
            // If parsing fails, return error
            const errorMsg = new ToolMessage({
                content: 'Error: Could not parse tool call from LLM response',
                tool_call_id: 'error',
            });
            return { messages: [errorMsg], steps: steps + 1 };
        }

        if (!toolCall || !toolCall.name) {
            const errorMsg = new ToolMessage({
                content: 'Error: No valid tool call found',
                tool_call_id: 'error',
            });
            return { messages: [errorMsg], steps: steps + 1 };
        }

        const toolName = toolCall.name;
        const toolArgs = toolCall.args || {};

        // Execute the tool
        const tool = toolsByName[toolName];
        if (!tool) {
            const errorMsg = new ToolMessage({
                content: `Error: Tool '${toolName}' not found`,
                tool_call_id: toolName,
            });
            return { messages: [errorMsg], steps: steps + 1 };
        }

        try {
            const result = await tool.invoke(toolArgs);

            let toolContent: any = `Tool completed successfully.Key result: ${JSON.stringify(result)} `;

            // Check if result has our specific structure or contains "Image URL"
            // The FireTV tool returns { content: [ { type: 'text', text: '...' }, { type: 'text', text: 'Image URL: ...' } ] }
            // LangChain tool invoke might return this object directly or a string.

            // We'll inspect the result to see if we can extract an image URL
            let imageUrl: string | null = null;

            try {
                // If result is object with content array (MCP style)
                if (typeof result === 'object' && result !== null && Array.isArray((result as any).content)) {
                    for (const item of (result as any).content) {
                        if (item.type === 'text' && item.text.includes('Image URL: file://')) {
                            const match = item.text.match(/Image URL: (file:\/\/[^\s]+)/);
                            if (match && match[1]) {
                                imageUrl = match[1];
                            }
                        }
                    }
                }
                // Fallback string check
                else if (typeof result === 'string' && result.includes('Image URL: file://')) {
                    const match = result.match(/Image URL: (file:\/\/[^\s]+)/);
                    if (match && match[1]) {
                        imageUrl = match[1];
                    }
                }
            } catch (e) {
                // ignore parsing errors
            }

            if (imageUrl) {
                toolContent = `Tool completed successfully. Image captured at: ${imageUrl}`;
            }

            const toolMsg = new ToolMessage({
                content: toolContent,
                tool_call_id: toolName,
            });
            return { messages: [toolMsg], steps: steps + 1 };
        } catch (error: any) {
            const errorMsg = new ToolMessage({
                content: `Error executing tool: ${error.message}`,
                tool_call_id: toolName,
            });
            return { messages: [errorMsg], steps: steps + 1 };
        }
    });
}

// Detect if the same tool is being called repeatedly
export function detectToolLoop(messages: any[], windowSize: number = 4): boolean {
    if (messages.length < windowSize) {
        return false;
    }

    const recentMessages = messages.slice(-windowSize);
    const toolSignatures: string[] = [];

    for (const msg of recentMessages) {
        const content = msg.content as string;
        if (typeof content === 'string' && content.includes('tool_call')) {
            try {
                const jsonMatch = content.match(/\{[\s\S]*"tool_call"[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    const toolName = parsed.tool_call?.name;
                    const toolArgs = parsed.tool_call?.args || {};

                    if (toolName) {
                        // Create a signature based on name AND arguments
                        // We sort keys to ensure key order doesn't matter
                        const sortedArgs = Object.keys(toolArgs).sort().reduce((obj: any, key) => {
                            obj[key] = toolArgs[key];
                            return obj;
                        }, {});

                        toolSignatures.push(`${toolName}:${JSON.stringify(sortedArgs)}`);
                    }
                }
            } catch (e) {
                // Ignore parse errors
            }
        }
    }

    // Check if we have the same tool signature called multiple times
    // If we have duplicate signatures, it means same tool + same args
    if (toolSignatures.length >= 2) {
        const uniqueSignatures = new Set(toolSignatures);
        return uniqueSignatures.size < toolSignatures.length;
    }

    return false;
}

// Analyze execution history to detect issues
export function analyzeExecutionHistory(messages: any[]): {
    failure_count: number;
    has_loop: boolean;
    recent_errors: string[];
} {
    let failureCount = 0;
    const recentErrors: string[] = [];
    const recentWindow = messages.slice(-6);

    for (const msg of recentWindow) {
        if (msg._getType() === 'tool') {
            const content = msg.content as string;
            if (content.startsWith('Error:') || content.startsWith('Error ')) {
                failureCount++;
                recentErrors.push(content.substring(0, 100));
            }
        }
    }

    const hasLoop = detectToolLoop(messages);

    return {
        failure_count: failureCount,
        has_loop: hasLoop,
        recent_errors: recentErrors,
    };
}

// Replanner node - re-evaluates and revises the plan
export const replannerNode = wrapNode('replanner', async function replannerNodeImpl(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const messages = state.messages;
    const currentPlan = state.plan;
    const meta = state.meta || {};
    const replanCount = meta.replan_count || 0;

    // Analyze what went wrong
    const analysis = analyzeExecutionHistory(messages);

    let replanningReason = 'Unknown issue detected';
    if (analysis.failure_count >= 2) {
        replanningReason = `Multiple tool failures detected(${analysis.failure_count} errors)`;
    } else if (analysis.has_loop) {
        replanningReason = 'Tool execution loop detected';
    } else {
        replanningReason = 'Approaching LLM call limit, revising strategy';
    }

    // Build conversation context
    const recentMessages = messages.slice(-6);
    let recentHistory = '';

    for (const msg of recentMessages) {
        const msgType = msg._getType();
        const content = (msg.content as string).substring(0, 500); // Truncate individual messages if needed
        recentHistory += `[${msgType}]: ${content} \n`;
    }

    const conversationContext = `
        Summary:
${state.summary || 'No prior context'}

Recent Execution History:
${recentHistory}

Recent errors:
${analysis.recent_errors.join('\n')}
        `;

    const replanPrompt = await constructPrompt(
        'replanner',
        getReplannerPrompt(currentPlan, replanningReason, conversationContext, analysis.recent_errors),
        {
            currentPlan,
            replanningReason,
            conversationContext,
            recentErrors: analysis.recent_errors.join('\n'),
            recentError: analysis.recent_errors.join('\n') // Alias for singular usage in seed
        }
    );

    const modelName = await getActiveModelForNode('replanner', 'gemini/gemini-2.5-flash-lite');
    const response = await generateText(replanPrompt, modelName);
    const revisedPlan = response.text;

    return {
        plan: revisedPlan,
        meta: {
            ...meta,
            replan_count: replanCount + 1,
            replanned: true,
            replanning_reason: replanningReason,
        },
        steps: (state.steps || 0) + 1,
    };
});

export const summarizerNode = wrapNode('summarize', async function summarizerNodeImpl(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const messages = state.messages.slice(0, -4); // summarize old stuff
    if (messages.length < 2) return {};

    let text = '';
    for (const m of messages) {
        text += `[${m._getType()}] ${String(m.content).slice(0, 200)} \n`;
    }

    const defaultPrompt = getSummarizerPrompt(text);
    const prompt = await constructPrompt('summarize', defaultPrompt, {
        conversationContext: text
    });

    const modelName = await getActiveModelForNode('summarize', 'gemini/gemini-2.0-flash-lite');
    const response = await generateText(prompt, modelName);

    return {
        summary: response.text,
        messages: state.messages.slice(-4), // 🔥 FLUSH
        steps: (state.steps || 0) + 1,
    };
});
