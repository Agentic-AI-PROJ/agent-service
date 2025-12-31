import express, { type Request, type Response } from "express";
import dotenv from "dotenv";

import connectDB from "./config/db.js";

import logger from "./utils/logger.js";
import executionRoutes from "./routes/execution-routes.js";
import nodeRoutes from "./routes/node-routes.js";
import { seedNodeConfigs } from "./utils/config-nodes.js";

dotenv.config();
connectDB();

// Seed node configurations on startup
seedNodeConfigs();

const app = express();
const PORT = process.env.PORT || 3006;

app.use(express.json());
app.use('/', executionRoutes);
app.use('/agent-nodes', nodeRoutes);

app.get("/health", (req: Request, res: Response) => {
    res.send("RUNNING");
});
app.get("/db-health", async (req: Request, res: Response) => {
    try {
        await connectDB();
        res.send("RUNNING");
    } catch (error) {
        console.error(error);
        res.status(500).send("Database connection failed");
    }
});

app.listen(PORT, () => {
    logger.info(`agent-service server running at http://localhost:${PORT}`);
});