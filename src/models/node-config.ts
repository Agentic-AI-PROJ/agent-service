import mongoose, { Schema, Document } from 'mongoose';

export interface INodeConfig extends Document {
    nodeName: string;
    systemPrompt: string;
    modelName: string;
    description?: string;
    variables?: string[];
    lastUpdated: Date;
}

const NodeConfigSchema: Schema = new Schema({
    nodeName: { type: String, required: true, unique: true },
    systemPrompt: { type: String, required: true },
    modelName: { type: String, required: true },
    description: { type: String },
    variables: { type: [String], default: [] },
    lastUpdated: { type: Date, default: Date.now }
});

export default mongoose.model<INodeConfig>('NodeConfig', NodeConfigSchema);
