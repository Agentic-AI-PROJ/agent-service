// src/gemini-client.ts
// Removed direct GoogleGenerativeAI dependency in favor of llm-chat-service

import logger from "../utils/logger.js";

export interface GenerateTextResponse {
    text: string;
    raw: any;
}

const LLM_SERVICE_URL = 'http://localhost:3005';

export async function generateText(
    prompt: string | any[],
    modelName: string = 'gemini-2.5-flash'
): Promise<GenerateTextResponse> {
    try {
        const payload = {
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
            model_id: modelName,
        };

        const response = await fetch(`${LLM_SERVICE_URL}/non-stream`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`LLM Service Error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const data: any = await response.json();
        const text = data.data;

        return {
            text,
            raw: data
        };
    } catch (error) {
        logger.error('Error calling LLM service:', error);
        throw error;
    }
}

export async function generateTextStream(
    prompt: string | any[],
    modelName: string = 'gemini-2.5-flash',
    onChunk?: (text: string) => void,
    signal?: AbortSignal
): Promise<GenerateTextResponse> {
    if (signal) {
        logger.info(`[GenerateTextStream] Called with signal. Aborted: ${signal.aborted}`);
    } else {
        logger.info(`[GenerateTextStream] Called WITHOUT signal`);
    }
    try {
        const payload = {
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
            model_id: modelName,
        };

        const response = await fetch(`${LLM_SERVICE_URL}/stream`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: signal || null
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`LLM Service Error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        if (!response.body) {
            throw new Error('No response body for stream');
        }

        // @ts-ignore - ReadableStream is available in Node 18+ global fetch
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';

        while (true) {
            if (signal?.aborted) {
                // If aborted, stop reading
                break;
            }

            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep the incomplete line in buffer

            for (const line of lines) {
                if (line.trim() === '') continue;

                if (line.startsWith('event: ')) {
                    // Check event type if needed
                } else if (line.startsWith('data: ')) {
                    const dataStr = line.substring(6);
                    try {
                        let textChunk = dataStr;
                        // Handle JSON data from LLM service
                        if (dataStr.trim().startsWith('{')) {
                            try {
                                const parsed = JSON.parse(dataStr);
                                if (parsed.content !== undefined) {
                                    textChunk = parsed.content;
                                } else if (parsed.detail) {
                                    logger.warn("Stream received message with detail:", parsed);
                                    textChunk = '';
                                }
                            } catch (e) {
                                // Not JSON, assume text
                            }
                        }

                        if (onChunk && textChunk) {
                            onChunk(textChunk);
                        }
                        fullText += textChunk;
                    } catch (e) {
                        logger.error('Error parsing stream chunk', e);
                    }
                }
            }
        }

        return {
            text: fullText,
            raw: {}
        };

    } catch (error: any) {
        if (error.name === 'AbortError') {
            // Rethrow abort error so caller knows
            throw error;
        }
        logger.error('Error calling LLM service (stream):', error);
        throw error;
    }
}
