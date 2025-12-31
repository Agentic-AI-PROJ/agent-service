import mongoose from 'mongoose';

const NodeExecutionSchema = new mongoose.Schema({
    executionId: {
        type: String,
        required: true,
        index: true
    },
    nodeName: {
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
    input: {
        type: mongoose.Schema.Types.Mixed
    },
    output: {
        type: mongoose.Schema.Types.Mixed
    },
    status: {
        type: String,
        enum: ['RUNNING', 'SUCCESS', 'ERROR'],
        default: 'RUNNING'
    },
    error: {
        type: String
    }
}, {
    timestamps: true
});

// Compound index for efficient retrieval of traces by executionId, sorted by time
NodeExecutionSchema.index({ executionId: 1, startTime: 1 });

const NodeExecution = mongoose.model('NodeExecution', NodeExecutionSchema);

export default NodeExecution;
