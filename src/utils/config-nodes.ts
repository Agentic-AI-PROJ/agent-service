import NodeConfig from '../models/node-config.js';
import {
    getPlanningPrompt,
    getDecisionPrompt,
    getFinalAnswerPrompt,
    getReplannerPrompt,
    getSummarizerPrompt,
    getClassificationPrompt
} from '../graph/prompts.js';

export const DEFAULT_NODE_CONFIGS = [
    {
        nodeName: 'planning',
        systemPrompt: getPlanningPrompt('{{toolDescriptions}}', '{{userRequestText}}', '{{researchHistory}}'),
        modelName: 'gemini/gemini-2.5-flash-lite',
        description: 'Creates a step-by-step execution plan based on the user request.',
        variables: ['toolDescriptions', 'userRequestText', 'researchHistory']
    },
    {
        nodeName: 'llm_call', // Decision node
        systemPrompt: getDecisionPrompt(
            '{{summary}}',
            '{{remainingSteps}}', // remainingSteps - keeps number format
            '{{maxSteps}}', // maxSteps
            '{{iteration}}', // iteration 
            '{{plan}}',
            '{{toolDescriptions}}',
            '{{conversationHistory}}'
        ),
        modelName: 'gemini/gemini-2.5-flash-lite',
        description: 'Decides the next step: either calling a tool or providing a final answer.',
        variables: ['summary', 'remainingSteps', 'maxSteps', 'iteration', 'plan', 'toolDescriptions', 'conversationHistory']
    },
    {
        nodeName: 'final_answer',
        systemPrompt: getFinalAnswerPrompt('{{conversationContext}}'),
        modelName: 'gemini/gemini-2.5-flash-lite',
        description: 'Generates the final natural language response to the user.',
        variables: ['conversationContext']
    },
    {
        nodeName: 'replanner',
        systemPrompt: getReplannerPrompt('{{currentPlan}}', '{{replanningReason}}', '{{conversationContext}}', ['{{recentError}}']),
        modelName: 'gemini/gemini-2.5-flash-lite',
        description: 'Revises the plan when errors or loops are detected.',
        variables: ['currentPlan', 'replanningReason', 'conversationContext', 'recentErrors']
    },
    {
        nodeName: 'summarize',
        systemPrompt: getSummarizerPrompt('{{conversationContext}}'),
        modelName: 'gemini/gemini-2.0-flash-lite',
        description: 'Summarizes long conversation history to manage context window.',
        variables: ['conversationContext']
    },
    {
        nodeName: 'classification',
        systemPrompt: getClassificationPrompt('{{userRequest}}'),
        modelName: 'gemini/gemini-2.0-flash-lite',
        description: 'Classifies user queries as SIMPLE or COMPLEX to determine routing.',
        variables: ['userRequest']
    }
];

export async function seedNodeConfigs() {
    try {
        console.log('🌱 Seeding Node Configurations...');

        for (const config of DEFAULT_NODE_CONFIGS) {
            await NodeConfig.findOneAndUpdate(
                { nodeName: config.nodeName },
                {
                    ...config,
                    lastUpdated: new Date()
                },
                { upsert: true, new: true }
            );
            console.log(`   - Seeded/Updated config for ${config.nodeName}`);
        }

        console.log('✅ Node Configurations seeded successfully.');
    } catch (error) {
        console.error('❌ Error seeding node configurations:', error);
    }
}
