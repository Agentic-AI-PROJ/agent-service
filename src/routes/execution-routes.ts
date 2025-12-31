import express from 'express';
import { listExecutions, getExecution, getExecutionNodes, agentExecute, stopExecution } from '../controllers/execution-controller.js';

const router = express.Router();

router.get('/executions', listExecutions);
router.get('/executions/:id', getExecution);
router.get('/executions/:id/nodes', getExecutionNodes);
router.post('/execute/:conversationId', agentExecute);
router.post('/stop/:id', stopExecution);

export default router;
