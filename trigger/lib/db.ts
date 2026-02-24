// Thin wrapper that re-exports the existing database service.
// The JS service is a singleton — we just import and re-export it for TS usage.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db: any = require("../../services/database");
export default db;

// Re-export common executor adapter functions
const executorAdapter: any = require("../../services/executor-adapter");
export const emailExecutor: any = executorAdapter.emailExecutor;
export const portalExecutor: any = executorAdapter.portalExecutor;
export const generateExecutionKey: any = executorAdapter.generateExecutionKey;
export const createExecutionRecord: any = executorAdapter.createExecutionRecord;
export const EXECUTION_MODE: string = executorAdapter.EXECUTION_MODE;

const _aiService: any = require("../../services/ai-service");
export const aiService: any = _aiService;

const _decisionMemory: any = require("../../services/decision-memory-service");
export const decisionMemory: any = _decisionMemory;

const _logger: any = require("../../services/logger");
export const logger: any = _logger;
