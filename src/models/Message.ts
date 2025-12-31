import mongoose, { Schema, Document } from 'mongoose';

export interface IMessage extends Document {
    conversationId: mongoose.Types.ObjectId;
    userId?: mongoose.Types.ObjectId;
    role: string;
    content: any;
    attachments?: Array<{
        url: string;
        name?: string;
        contentType?: string;
    }>;
    metadata?: any;
    createdAt: Date;
    updatedAt: Date;
}

const MessageSchema: Schema = new Schema(
    {
        conversationId: { type: Schema.Types.ObjectId, ref: 'ConversationCards', required: true },
        userId: { type: Schema.Types.ObjectId, ref: 'User' },
        role: { type: String, required: true },
        content: { type: Schema.Types.Mixed, required: true },
        attachments: [{
            type: { type: String }, // e.g. "image" (reserved keyword 'type' handling in mongoose?) - better use 'fileType' or just verify structure
            url: String,
            name: String,
            contentType: String
        }],
        metadata: { type: Schema.Types.Mixed },
    },
    { timestamps: true }
);

export const Message = mongoose.model<IMessage>('Message', MessageSchema);
