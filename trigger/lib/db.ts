// Thin wrapper that re-exports the existing database service.
// Uses lazy loading to avoid instantiating OpenAI/services at import time
// (Trigger.dev indexer imports all files to discover tasks — env vars may not be available).

function lazyProxy(loader: () => any): any {
  let cached: any;
  return new Proxy({}, {
    get(_t, prop) {
      if (!cached) cached = loader();
      const val = cached[prop];
      return typeof val === "function" ? val.bind(cached) : val;
    },
  });
}

// All services lazy-loaded to survive Trigger.dev indexing phase
const db: any = lazyProxy(() => require("../../services/database"));
export default db;

export const aiService: any = lazyProxy(() => require("../../services/ai-service"));
export const decisionMemory: any = lazyProxy(() => require("../../services/decision-memory-service"));
export const logger: any = lazyProxy(() => require("../../services/logger"));

export const emailExecutor: any = lazyProxy(() => require("../../services/executor-adapter").emailExecutor);
export const portalExecutor: any = lazyProxy(() => require("../../services/executor-adapter").portalExecutor);

export function generateExecutionKey(...args: any[]) {
  const ea = require("../../services/executor-adapter");
  return ea.generateExecutionKey(...args);
}

export function createExecutionRecord(...args: any[]) {
  const ea = require("../../services/executor-adapter");
  return ea.createExecutionRecord(...args);
}

export const EXECUTION_MODE = "LIVE";
