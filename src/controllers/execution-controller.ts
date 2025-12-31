import type { Request, Response } from 'express';
import AgentExecution from '../models/AgentExecution.js';
import NodeExecution from '../models/NodeExecution.js';
import logger from '../utils/logger.js';
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { v4 as uuidv4 } from 'uuid';
import { connectToMCP } from '../tools/mcp-client.js';
import { trackAgentEnd, trackAgentStart } from '../utils/execution-tracker.js';
import { buildAgent } from '../graph/agent-graph.js';
import { ConversationCardModel, type ConversationCard } from '../models/ConversationCards.js';
import { saveMessage } from '../utils/message-saver.js';
import { Message, type IMessage } from '../models/Message.js';
import { generateText } from '../graph/generate-text.js';

import { registerExecution, removeExecution, cancelExecution } from '../utils/active-executions.js';
import type { Document, Types } from 'mongoose';

// List executions with optional filtering
export const listExecutions = async (req: Request, res: Response) => {
    try {
        const { status, startDate, endDate, limit = 20, skip = 0 } = req.query;

        const query: any = {};

        if (status) {
            query.status = status;
        }

        if (startDate || endDate) {
            query.startTime = {};
            if (startDate) query.startTime.$gte = new Date(startDate as string);
            if (endDate) query.startTime.$lte = new Date(endDate as string);
        }

        const executions = await AgentExecution.find(query)
            .sort({ startTime: -1 })
            .limit(Number(limit))
            .skip(Number(skip));

        const total = await AgentExecution.countDocuments(query);

        res.json({
            data: executions,
            pagination: {
                total,
                limit: Number(limit),
                skip: Number(skip)
            }
        });
    } catch (error: any) {
        logger.error('Error in listExecutions:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get single execution details
export const getExecution = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const execution = await AgentExecution.findOne({ executionId: id });

        if (!execution) {
            return res.status(404).json({ error: 'Execution not found' });
        }

        res.json(execution);
    } catch (error: any) {
        logger.error('Error in getExecution:', error);
        res.status(500).json({ error: error.message });
    }
};

// Get nodes for a specific execution
export const getExecutionNodes = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        // Ensure execution exists first
        const execution = await AgentExecution.findOne({ executionId: id });
        if (!execution) {
            return res.status(404).json({ error: 'Execution not found' });
        }

        // Fetch nodes sorted by Time
        const nodes = await NodeExecution.find({ executionId: id })
            .sort({ startTime: 1 });

        res.json(nodes);
    } catch (error: any) {
        logger.error('Error in getExecutionNodes:', error);
        res.status(500).json({ error: error.message });
    }
};

// Stop an execution
export const stopExecution = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({ error: 'Execution ID is required' });
        }

        const execution = await AgentExecution.findOne({ executionId: id });
        if (!execution) {
            return res.status(404).json({ error: 'Execution not found' });
        }

        // 1. Mark as STOPPED in DB
        execution.status = 'STOPPED';
        execution.endTime = new Date();
        await execution.save();

        // 2. Abort running process if active
        // cancelExecution returns true if it found and aborted an active controller
        const wasActive = cancelExecution(id);

        res.json({
            message: 'Execution stopped successfully',
            wasActive,
            executionId: id
        });
    } catch (error: any) {
        logger.error('Error in stopExecution:', error);
        res.status(500).json({ error: error.message });
    }
}

const sendEvent = (res: Response, event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const findConversation = async (conversationId: string) => {
    const conversation = await ConversationCardModel.findOne({ guid: conversationId });
    return conversation;
}

export const agentExecute = async (req: Request, res: Response) => {
    const { message, attachments } = req.body;
    const { conversationId } = req.params;
    const userId = req.headers['x-user-id'];

    if (!conversationId) {
        return res.status(400).json({ error: 'Conversation ID is required' });
    }

    const conversation = await findConversation(conversationId as string);
    if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    const reqId = uuidv4();

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    logger.info(`Starting execution ${reqId}`);
    sendEvent(res, 'metadata', { run_id: reqId });

    // Track Agent Start
    await trackAgentStart(reqId, message);

    // Fetch recent messages from MongoDB
    const recentMessages = await Message.find({
        conversationId: conversation._id,
        role: { $in: ['user', 'assistant'] }
    })
        .sort({ createdAt: -1 })
        .limit(8); // Last 4 interactions (approx)

    // Generate title if this is the first message
    await generateTitleIfFirstMessage(recentMessages, message, conversation, res);

    // Convert previous messages to LangChain message format (chronological order) and exclude system messages if any
    const convertedMessages = recentMessages
        .reverse()
        .map((msg: any) => {
            if (msg.role === 'user') {
                let content = msg.content;
                // Append attachments if any (for history context) - though ideally we just trust the text context if it was markdown
                // or if we stored it separately, we might need to re-attach. 
                // For now, assuming msg.content has the full context or we just use text.
                // If we want to be robust:
                if (msg.attachments && msg.attachments.length > 0) {
                    // Add images to content if your LLM supports it in this format, or just append Markdown
                    const attachmentText = msg.attachments.map((a: any) => `![${a.name || 'image'}](${a.url})`).join('\n');
                    content = `${content}\n\n${attachmentText}`;
                }
                return new HumanMessage(content);
            } else if (msg.role === 'assistant') {
                return new AIMessage(msg.content);
            }
            return null;
        })
        .filter((msg): msg is HumanMessage | AIMessage => msg !== null);

    // Add the new user message
    // Construct prompt with attachments
    let fullPrompt = message;
    if (attachments && attachments.length > 0) {
        const attachmentText = attachments.map((a: any) => `![${a.name || 'image'}](${a.url})`).join('\n');
        fullPrompt = `${message}\n\n${attachmentText}`;
    }

    const userMsg = new HumanMessage(fullPrompt);

    // Save user message with separate attachments
    await saveMessage(conversation._id, 'user', message, userId as string, { runId: reqId }, attachments);

    const initialState = {
        messages: [...convertedMessages, userMsg],
        llm_calls: 0,
        plan: '',
        meta: {
            executionId: reqId
        },
    };
    let stepNum = 1;

    // Create execution controller
    const controller = new AbortController();
    registerExecution(reqId, controller);

    try {
        const tools = await connectToMCP();

        // Define streaming callback
        const streamCallback = (chunk: string) => {
            sendEvent(res, 'final_answer', {
                step: stepNum,
                content: chunk
            });
        };

        const agent = buildAgent(tools, streamCallback);

        // Stream the agent execution
        const stream = await agent.stream(initialState, {
            recursionLimit: 30,
            configurable: {
                signal: controller.signal
            }
        });

        let finalAnswerSent = false;

        for await (const step of stream) {
            if (controller.signal.aborted) {
                logger.info(`Execution ${reqId} aborted by signal.`);
                break;
            }
            for (const [nodeName, nodeOutput] of Object.entries(step)) {
                if (nodeName === 'planning') {
                    const plan = (nodeOutput as any).plan || '';
                    if (plan) {
                        sendEvent(res, 'planning', { plan });
                    }

                    // NEW: Check for tool calls initiated by planning (Research Phase)
                    const messages = (nodeOutput as any).messages || [];
                    for (const msg of messages) {
                        const content = msg.content as string;

                        // Check if it's a tool call (same logic as llm_call)
                        if (content && content.includes('tool_call')) {
                            try {
                                // Parse the tool call JSON
                                const jsonMatch = content.match(/\{[\s\S]*"tool_call"[\s\S]*\}/);
                                if (jsonMatch) {
                                    const parsed = JSON.parse(jsonMatch[0]);
                                    const reasoning = parsed.reasoning || '';
                                    const tc = parsed.tool_call || {};
                                    const toolName = tc.name || 'unknown';
                                    const args = tc.args || {};

                                    sendEvent(res, 'tool_call', {
                                        step: stepNum,
                                        toolName,
                                        args,
                                        reasoning
                                    });

                                    await saveMessage(conversation._id, 'tool_call', {
                                        step: stepNum,
                                        toolName,
                                        args,
                                        reasoning
                                    }, undefined, { runId: reqId });

                                    stepNum++;
                                }
                            } catch (e) {
                                logger.error('Error parsing planning tool call:', e);
                            }
                        }
                    }
                } else if (nodeName === 'llm_call') {
                    // Extract and display what the LLM is doing
                    const messages = (nodeOutput as any).messages || [];

                    for (const msg of messages) {
                        const content = msg.content as string;

                        // Check if it's a tool call
                        if (content && content.includes('tool_call')) {
                            try {
                                // Parse the tool call JSON
                                const jsonMatch = content.match(/\{[\s\S]*"tool_call"[\s\S]*\}/);
                                if (jsonMatch) {
                                    const parsed = JSON.parse(jsonMatch[0]);
                                    const reasoning = parsed.reasoning || '';
                                    const tc = parsed.tool_call || {};
                                    const toolName = tc.name || 'unknown';
                                    const args = tc.args || {};

                                    sendEvent(res, 'tool_call', {
                                        step: stepNum,
                                        toolName,
                                        args,
                                        reasoning
                                    });

                                    await saveMessage(conversation._id, 'tool_call', {
                                        step: stepNum,
                                        toolName,
                                        args,
                                        reasoning
                                    }, undefined, { runId: reqId });

                                    stepNum++;
                                }
                            } catch (e) {
                                sendEvent(res, 'thought', {
                                    step: stepNum,
                                    content: "LLM is thinking..."
                                });
                                stepNum++;
                            }
                        } else {
                            // Logic change: llm_call no longer produces final answers.
                            // If we get here, it might be an error or debug info, but for now we ignore plain text
                            // unless it looks like a final answer fallback (which we shouldn't have with new logic)
                            // Optionally send a 'thought' event
                            sendEvent(res, 'thought', {
                                step: stepNum,
                                content: "Agent is deciding next step..."
                            });
                            stepNum++;
                        }
                    }
                } else if (nodeName === 'final_answer') {
                    // Extract and display the final answer
                    const messages = (nodeOutput as any).messages || [];
                    for (const msg of messages) {
                        const content = msg.content as string;
                        // Streaming handled via callback. We only save to DB here.
                        // sendEvent(res, 'final_answer', { step: stepNum, content }); <--- REMOVED to avoid duplicates

                        // Save assistant message
                        await saveMessage(conversation._id, 'assistant', content, undefined, { runId: reqId });
                        finalAnswerSent = true;
                        stepNum++;
                    }
                } else if (nodeName === 'replanner') {
                    // Display replanning activity
                    const plan = (nodeOutput as any).plan || '';
                    const meta = (nodeOutput as any).meta || {};
                    const reason = meta.replanning_reason || 'Unknown reason';
                    const replanCount = meta.replan_count || 1;

                    sendEvent(res, 'replan', {
                        replanCount,
                        reason,
                        plan
                    });
                } else if (nodeName === 'tool_node') {
                    // Display tool execution result
                    const messages = (nodeOutput as any).messages || [];
                    for (const msg of messages) {
                        const content = msg.content as string;
                        sendEvent(res, 'tool_result', {
                            result: content
                        });
                        await saveMessage(conversation._id, 'tool_result', content, undefined, { runId: reqId });
                    }
                }
            }
        }

        if (controller.signal.aborted) {
            sendEvent(res, 'final_answer', {
                step: stepNum,
                content: ""
            });
            // Don't save "Agent stopped" as an assistant message if you don't want it in history, 
            // or save it if you want the conversation to show it. 
            // User requested: "stop the agent after the complete response is done" for non-stream. 
            // If we aborted, it means we stopped.
            // Status is already updated to STOPPED by the stop endpoint.
            // We can just end here.
        } else if (!finalAnswerSent) {
            sendEvent(res, 'final_answer', {
                step: stepNum,
                content: "The agent stopped without a final answer. This might be due to an execution limit or an interruption."
            });
            await saveMessage(conversation._id, 'assistant', "The agent stopped without a final answer. This might be due to an execution limit or an interruption.", undefined, { runId: reqId });
        }

        sendEvent(res, 'complete', {});

        if (controller.signal.aborted) {
            // Ensure we track it as stopped
            await trackAgentEnd(reqId, 'STOPPED');
        } else {
            await trackAgentEnd(reqId, 'SUCCESS');
        }

        res.end();
    } catch (error: any) {
        if (controller.signal.aborted || error.name === 'AbortError') {
            // Handle abort
            logger.info(`Execution ${reqId} aborted (caught AbortError).`);
            sendEvent(res, 'final_answer', {
                content: "\n[Agent stopped by user]"
            });
            sendEvent(res, 'complete', {});
            await trackAgentEnd(reqId, 'STOPPED');
            res.end();
            return;
        }

        logger.error('\n❌ Error during execution:', error.message);
        sendEvent(res, 'final_answer', {
            content: `I encountered a critical error during execution: ${error.message}`
        });
        if (conversation) {
            await saveMessage(conversation._id, 'assistant', `I encountered a critical error during execution: ${error.message}`, undefined, { runId: reqId });
        }
        sendEvent(res, 'error', { message: error.message });
        await trackAgentEnd(reqId, 'ERROR', error);
        res.end();
    } finally {
        removeExecution(reqId);
    }
}
async function generateTitleIfFirstMessage(recentMessages: (Document<unknown, {}, IMessage, {}, {}> & IMessage & Required<{ _id: Types.ObjectId; }> & { __v: number; })[], message: any, conversation: Document<unknown, {}, ConversationCard, {}, {}> & ConversationCard & { _id: Types.ObjectId; } & { __v: number; }, res: Response<any, Record<string, any>>) {
    if (recentMessages.length === 0) {
        try {
            const titleResponse = await generateText(
                `Generate a short, concise title (max 5 words) for a conversation that starts with this message: "${message}". Return only the title, no quotes or extra text fullstop or any special characters.`,
                'gemini/gemini-2.0-flash-lite'
            );

            if (titleResponse && titleResponse.text) {
                const newTitle = titleResponse.text.trim();
                await ConversationCardModel.findByIdAndUpdate(conversation._id, {
                    name: newTitle
                });
                sendEvent(res, 'metadata', { title: newTitle });
            }
        } catch (error) {
            logger.error('Error generating conversation title:', error);
            // Non-blocking error, continue execution
        }
    }
}

