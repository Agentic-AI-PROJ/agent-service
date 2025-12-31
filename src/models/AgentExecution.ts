import mongoose from 'mongoose';

const AgentExecutionSchema = new mongoose.Schema({
    executionId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    userMessage: {
        type: String,
        required: true
    },
    startTime: {
        type: Date,
        default: Date.now
    },
    endTime: {
        type: Date
    },
    status: {
        type: String,
        enum: ['RUNNING', 'SUCCESS', 'ERROR', 'STOPPED'],
        default: 'RUNNING'
    },
    error: {
        type: String
    }
}, {
    timestamps: true
});

// Indexes for faster filtering and sorting
AgentExecutionSchema.index({ startTime: -1 });
AgentExecutionSchema.index({ status: 1 });

const AgentExecution = mongoose.model('AgentExecution', AgentExecutionSchema);

export default AgentExecution;
