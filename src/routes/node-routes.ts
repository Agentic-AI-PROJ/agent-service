import express from 'express';
import NodeConfig from '../models/node-config.js';

const router = express.Router();

// GET /agent-nodes
router.get('/', async (req, res) => {
    try {
        const nodes = await NodeConfig.find({}).sort({ nodeName: 1 });
        res.json(nodes);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch node configurations' });
    }
});

// PUT /agent-nodes/:nodeName
router.put('/:nodeName', async (req, res) => {
    try {
        const { nodeName } = req.params;
        const updates = req.body;

        const node = await NodeConfig.findOneAndUpdate(
            { nodeName },
            {
                ...updates,
                lastUpdated: new Date()
            },
            { new: true }
        );

        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }

        res.json(node);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update node configuration' });
    }
});

export default router;
