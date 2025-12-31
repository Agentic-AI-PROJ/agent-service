// src/graph/state-schema.ts
import { BaseMessage } from '@langchain/core/messages';
import { Annotation } from '@langchain/langgraph';

// Define the AgentState using LangGraph's Annotation API
export const AgentState = Annotation.Root({
    // Messages are appended when new LLM outputs are produced
    messages: Annotation<BaseMessage[]>({
        reducer: (current, update) => current.concat(update),
        default: () => [],
    }),

    // Track number of LLM calls
    llm_calls: Annotation<number>({
        reducer: (_, update) => update,
        default: () => 0,
    }),

    // Store the agent's execution plan
    plan: Annotation<string>({
        reducer: (_, update) => update,
        default: () => '',
    }),

    // Store conversation summary
    summary: Annotation<string>({
        reducer: (_, update) => update,
        default: () => '',
    }),

    // Arbitrary metadata (tokens, replanning info, etc.)
    meta: Annotation<Record<string, any>>({
        reducer: (current, update) => ({ ...current, ...update }),
        default: () => ({}),
    }),

    // Flag to indicate if the agent is ready to generate the final answer
    ready_to_reply: Annotation<boolean>({
        reducer: (_, update) => update,
        default: () => false,
    }),

    // Track total graph execution steps (nodes visited)
    steps: Annotation<number>({
        reducer: (_, update) => update,
        default: () => 0,
    }),
});

export type AgentStateType = typeof AgentState.State;
