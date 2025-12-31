
// Map to store AbortController for each execution ID
const executions = new Map<string, AbortController>();

export const registerExecution = (executionId: string, controller: AbortController) => {
    console.log(`[ActiveExecutions] Registering ${executionId}`);
    executions.set(executionId, controller);
};

export const removeExecution = (executionId: string) => {
    console.log(`[ActiveExecutions] Removing ${executionId}`);
    executions.delete(executionId);
};

export const cancelExecution = (executionId: string) => {
    const controller = executions.get(executionId);
    if (controller) {
        console.log(`[ActiveExecutions] Cancelling ${executionId}`);
        controller.abort();
        executions.delete(executionId);
        return true;
    }
    console.log(`[ActiveExecutions] Cancel failed - not found ${executionId}`);
    return false;
};

export const isExecutionActive = (executionId: string) => {
    return executions.has(executionId);
};
