// src/graph/agent-graph.ts
import { StateGraph, START, END } from '@langchain/langgraph';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { generateText } from './generate-text.js';
import { getClassificationPrompt } from './prompts.js';
import { AgentState, type AgentStateType } from './state-schema.js';
import { analyzeExecutionHistory, makeDecisionNode, makeFinalAnswerNode, makePlanningNode, replannerNode, toolNodeFactory, summarizerNode, constructPrompt } from './nodes.js';

export function buildAgent(tools: DynamicStructuredTool[], streamCallback?: (chunk: string) => void) {
    // Create tools map
    const toolsByName: Record<string, any> = {};
    for (const tool of tools) {
        toolsByName[tool.name] = tool;
    }

    // Create nodes
    const planningNode = makePlanningNode(tools);
    const decisionNode = makeDecisionNode(tools);
    const finalAnswerNode = makeFinalAnswerNode(streamCallback);
    const toolNode = toolNodeFactory(toolsByName);

    // Build the state graph
    const agentBuilder = new StateGraph(AgentState)
        .addNode('planning', planningNode)
        .addNode('llm_call', decisionNode)
        .addNode('tool_node', toolNode)
        .addNode('replanner', replannerNode)
        .addNode('summarize', summarizerNode)
        .addNode('final_answer', finalAnswerNode);

    // Routing function: Determine if planning is needed
    async function needsPlanning(state: AgentStateType): Promise<string> {
        const messages = state.messages;
        const userMessages = messages.filter((m) => m._getType() === 'human');

        if (userMessages.length === 0) {
            return 'llm_call';
        }

        const userRequest = userMessages[userMessages.length - 1]!.content as string;

        // Use lightweight LLM call to classify query complexity
        const classificationPrompt = await constructPrompt(
            'classification',
            getClassificationPrompt(userRequest),
            { userRequest }
        );

        const response = await generateText(classificationPrompt, 'gemini/gemini-2.0-flash-lite');
        const classification = (response.text || 'COMPLEX').trim().toUpperCase();

        // Default to planning for safety if unclear
        if (classification.includes('SIMPLE')) {
            return 'llm_call';
        } else {
            return 'planning';
        }
    }

    // Routing function: Decide whether to continue to tool execution, final answer, or end
    function shouldContinue(state: AgentStateType): string {
        const messages = state.messages;
        const llmCalls = state.llm_calls || 0;

        // Check for summarization first (priority)
        // 1. Message count based
        if (messages.length > 12) {
            return 'summarize';
        }

        // 2. Token/Size based (approx limit)
        // Calc total length
        let totalContentLength = 0;
        for (const m of messages) {
            if (typeof m.content === 'string') {
                totalContentLength += m.content.length;
            }
        }

        if (totalContentLength > 200000 && messages.length > 5) {
            return 'summarize';
        }

        // Safety check: prevent infinite loops
        if ((state.steps || 0) >= 30) {
            return END; // Or force final answer?
        }

        // If decision node says ready to reply
        if (state.ready_to_reply) {
            return 'final_answer';
        }

        const lastMessage = messages[messages.length - 1];
        if (!lastMessage) return END;

        const lastText = lastMessage.content as string;

        // If LLM is requesting a tool → go to tool_node
        if (lastText && lastText.includes('tool_call')) {
            return 'tool_node';
        }

        // Otherwise, if we fell through, maybe force plain text answer or end
        return END;
    }

    // Routing function: Decide if we should continue planning (research) or move to execution
    function shouldContinuePlanning(state: AgentStateType): string {
        const messages = state.messages;
        const lastMessage = messages[messages.length - 1];

        // If planning node produced a tool call, route to tool execution
        if (lastMessage && typeof lastMessage.content === 'string' && lastMessage.content.includes('tool_call')) {
            return 'tool_node';
        }

        // Otherwise, it produced a plan (or text), go to Decision/LLM Call
        return 'llm_call';
    }

    // Routing function: Decide if we should replan, research more, or continue
    function shouldReplan(state: AgentStateType): string {
        // Research Phase Check: If we don't have a plan yet, we must be in research mode
        // So go back to planning to forward the tool output or make a plan
        if (!state.plan || state.plan === 'No user request found.' || state.plan.trim() === '') {
            return 'planning';
        }

        const messages = state.messages;
        const meta = state.meta || {};
        const replanCount = meta.replan_count || 0;

        // Don't replan more than 3 times (prevent infinite replanning)
        if (replanCount >= 3) {
            return 'llm_call';
        }

        // Analyze execution history
        const analysis = analyzeExecutionHistory(messages);

        // Check for repeated tool failures (2+ in recent history)
        if (analysis.failure_count >= 2) {
            return 'replanner';
        }

        // Check for loop pattern
        if (analysis.has_loop) {
            return 'replanner';
        }

        // Check if approaching execution limit
        if ((state.steps || 0) >= 20) {
            return 'replanner';
        }

        // Otherwise, continue normal flow
        return 'llm_call';
    }

    // Wire up the graph edges
    agentBuilder.addConditionalEdges(START, needsPlanning, ['planning', 'llm_call']);

    // Changed: Planning can now route to tool_node for research
    agentBuilder.addConditionalEdges('planning', shouldContinuePlanning, ['tool_node', 'llm_call']);

    agentBuilder.addConditionalEdges('llm_call', shouldContinue, ['tool_node', 'summarize', 'final_answer', END]);

    // Changed: Tool node routes to shouldReplan which now handles "back to planning"
    agentBuilder.addConditionalEdges('tool_node', shouldReplan, ['planning', 'replanner', 'llm_call']);

    agentBuilder.addEdge('replanner', 'llm_call');
    agentBuilder.addEdge('summarize', 'llm_call');
    agentBuilder.addEdge('final_answer', END);

    const agent = agentBuilder.compile();
    return agent;
}
