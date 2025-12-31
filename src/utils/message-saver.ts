import { Message } from '../models/Message.js';
import mongoose from 'mongoose';

export const saveMessage = async (
    conversationId: string | mongoose.Types.ObjectId,
    role: string,
    content: any,
    userId?: string | mongoose.Types.ObjectId,
    metadata?: any,
    attachments?: Array<{ url: string; name?: string; contentType?: string }>
) => {
    try {
        const messageData: any = {
            conversationId,
            role,
            content,
            metadata,
        };

        if (userId) {
            messageData.userId = userId;
        }

        if (attachments) {
            messageData.attachments = attachments;
        }

        const message = new Message(messageData);
        await message.save();
        return message;
    } catch (error) {
        console.error('Error saving message:', error);
        // Continue execution even if saving fails to avoid breaking the agent flow
        return null;
    }
};
