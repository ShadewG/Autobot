const assert = require('assert');
const path = require('path');

describe('FOIA case agent startup', function () {
  it('does not instantiate OpenAI during module load', function () {
    const agentPath = path.resolve(__dirname, '../services/foia-case-agent.js');
    const openAiPath = require.resolve('openai');
    const dbPath = path.resolve(__dirname, '../services/database.js');
    const aiServicePath = path.resolve(__dirname, '../services/ai-service.js');
    const notificationServicePath = path.resolve(__dirname, '../services/notification-service.js');
    const actionValidatorPath = path.resolve(__dirname, '../services/action-validator.js');
    const loggerPath = path.resolve(__dirname, '../services/logger.js');
    const caseRuntimePath = path.resolve(__dirname, '../services/case-runtime.js');

    const originals = {
      agent: require.cache[agentPath],
      openai: require.cache[openAiPath],
      db: require.cache[dbPath],
      aiService: require.cache[aiServicePath],
      notificationService: require.cache[notificationServicePath],
      actionValidator: require.cache[actionValidatorPath],
      logger: require.cache[loggerPath],
      caseRuntime: require.cache[caseRuntimePath],
    };

    let openAiConstructCount = 0;
    const FakeOpenAI = function FakeOpenAI() {
      openAiConstructCount += 1;
      return { chat: { completions: { create: async () => ({ choices: [] }) } } };
    };

    require.cache[openAiPath] = { id: openAiPath, filename: openAiPath, loaded: true, exports: { OpenAI: FakeOpenAI } };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
    require.cache[aiServicePath] = { id: aiServicePath, filename: aiServicePath, loaded: true, exports: {} };
    require.cache[notificationServicePath] = { id: notificationServicePath, filename: notificationServicePath, loaded: true, exports: {} };
    require.cache[actionValidatorPath] = { id: actionValidatorPath, filename: actionValidatorPath, loaded: true, exports: {} };
    require.cache[loggerPath] = {
      id: loggerPath,
      filename: loggerPath,
      loaded: true,
      exports: { forAgent: () => ({ info() {}, warn() {}, error() {} }) },
    };
    require.cache[caseRuntimePath] = {
      id: caseRuntimePath,
      filename: caseRuntimePath,
      loaded: true,
      exports: { transitionCaseRuntime: async () => ({}), CaseLockContention: class CaseLockContention extends Error {} },
    };
    delete require.cache[agentPath];

    try {
      const agent = require(agentPath);
      assert.ok(agent);
      assert.strictEqual(typeof agent.handleCase, 'function');
      assert.strictEqual(openAiConstructCount, 0);
    } finally {
      if (originals.agent) require.cache[agentPath] = originals.agent;
      else delete require.cache[agentPath];
      if (originals.openai) require.cache[openAiPath] = originals.openai;
      else delete require.cache[openAiPath];
      if (originals.db) require.cache[dbPath] = originals.db;
      else delete require.cache[dbPath];
      if (originals.aiService) require.cache[aiServicePath] = originals.aiService;
      else delete require.cache[aiServicePath];
      if (originals.notificationService) require.cache[notificationServicePath] = originals.notificationService;
      else delete require.cache[notificationServicePath];
      if (originals.actionValidator) require.cache[actionValidatorPath] = originals.actionValidator;
      else delete require.cache[actionValidatorPath];
      if (originals.logger) require.cache[loggerPath] = originals.logger;
      else delete require.cache[loggerPath];
      if (originals.caseRuntime) require.cache[caseRuntimePath] = originals.caseRuntime;
      else delete require.cache[caseRuntimePath];
    }
  });
});
