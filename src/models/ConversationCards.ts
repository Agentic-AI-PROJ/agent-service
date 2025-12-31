import { model, Schema } from "mongoose";

export interface ConversationCard extends Document {
    name: string;
    summary: string;
    guid: string;
    status: string;
    createdBy: Schema.Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const ConversationCardSchema = new Schema<ConversationCard>(
    {
        name: { type: String, required: true, default: 'New Conversation' },
        summary: { type: String, required: false },
        guid: { type: String, required: true },
        status: {
            type: String,
            enum: [
                'active',
                'deleted',
            ],
            default: 'active',
        },
        createdBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
    },
    {
        timestamps: true,
    }
);

ConversationCardSchema.index({ guid: 1 }, { unique: true });

export const ConversationCardModel = model<ConversationCard>('ConversationCard', ConversationCardSchema, 'ConversationCards');