import NodeExecution from '../models/NodeExecution.js';
import AgentExecution from '../models/AgentExecution.js';
import logger from './logger.js';
import type { AgentStateType } from '../graph/state-schema.js';

export async function trackNodeStart(executionId: string, nodeName: string, input: any) {
    try {
        const execution = new NodeExecution({
            executionId,
            nodeName,
            input,
            status: 'RUNNING'
        });
        await execution.save();
        return execution._id;
    } catch (error) {
        logger.error(`Error tracking node start for ${nodeName}:`, error);
        return null;
    }
}

export async function trackNodeEnd(recordId: any, output: any, error?: Error) {
    if (!recordId) return;

    try {
        const update: any = {
            endTime: new Date(),
            status: error ? 'ERROR' : 'SUCCESS',
            output
        };

        if (error) {
            update.error = error.message;
        }

        await NodeExecution.findByIdAndUpdate(recordId, update);
    } catch (err) {
        logger.error(`Error tracking node end:`, err);
    }
}

export async function trackAgentStart(executionId: string, userMessage: string) {
    try {
        const execution = new AgentExecution({
            executionId,
            userMessage,
            status: 'RUNNING'
        });
        await execution.save();
    } catch (error) {
        logger.error('Error tracking agent start:', error);
    }
}

export async function trackAgentEnd(executionId: string, status: 'SUCCESS' | 'ERROR' | 'STOPPED', error?: any) {
    try {
        const update: any = {
            endTime: new Date(),
            status
        };

        if (error) {
            update.error = error instanceof Error ? error.message : String(error);
        }

        await AgentExecution.findOneAndUpdate({ executionId }, update);
    } catch (err) {
        logger.error('Error tracking agent end:', err);
    }
}

// Higher-order function to wrap graph nodes
export function wrapNode(nodeName: string, nodeFn: (state: AgentStateType, config?: any) => Promise<Partial<AgentStateType>>) {
    return async function wrappedNode(state: AgentStateType, config?: any): Promise<Partial<AgentStateType>> {
        const meta = state.meta || {};
        const executionId = meta.executionId; // Must be passed in initial state

        if (!executionId) {
            // If no execution ID, just run normally (or log warning)
            // logger.warn(`No executionId found for node ${nodeName}`);
            return await nodeFn(state, config);
        }

        // Track Start
        const recordId = await trackNodeStart(executionId, nodeName, {
            // Log relevant parts of state input
            messagesCount: state.messages.length,
            lastMessage: state.messages.length > 0 ? state.messages[state.messages.length - 1] : null,
            plan: state.plan
        });

        try {
            // Run Node
            const result = await nodeFn(state, config);

            // Track Success
            await trackNodeEnd(recordId, result);

            return result;
        } catch (error: any) {
            // Track Error
            await trackNodeEnd(recordId, null, error);
            throw error;
        }
    };
}
