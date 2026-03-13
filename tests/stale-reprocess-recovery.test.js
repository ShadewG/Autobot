const assert = require('assert');
const path = require('path');
const sinon = require('sinon');

function loadCronService({ dbStub, triggerDispatchStub }) {
  const cronServicePath = path.resolve(__dirname, '../services/cron-service.js');
  const cronPath = require.resolve('cron');
  const notionPath = path.resolve(__dirname, '../services/notion-service.js');
  const followupPath = path.resolve(__dirname, '../services/followup-scheduler.js');
  const dbPath = path.resolve(__dirname, '../services/database.js');
  const constantsPath = path.resolve(__dirname, '../constants/action-types.js');
  const stuckResponsePath = path.resolve(__dirname, '../services/stuck-response-detector.js');
  const agencySyncPath = path.resolve(__dirname, '../services/agency-notion-sync.js');
  const pdContactPath = path.resolve(__dirname, '../services/pd-contact-service.js');
  const triggerDispatchPath = path.resolve(__dirname, '../services/trigger-dispatch-service.js');
  const discordPath = path.resolve(__dirname, '../services/discord-service.js');
  const draftQualityEvalPath = path.resolve(__dirname, '../services/draft-quality-eval-service.js');
  const qualityReportPath = path.resolve(__dirname, '../services/quality-report-service.js');
  const errorTrackingPath = path.resolve(__dirname, '../services/error-tracking-service.js');
  const portalStatusMonitorPath = path.resolve(__dirname, '../services/portal-status-monitor-service.js');
  const feeWorkflowPath = path.resolve(__dirname, '../services/fee-workflow-service.js');
  const staleProposalRecoveryPath = path.resolve(__dirname, '../services/stale-proposal-recovery-service.js');
  const caseRuntimePath = path.resolve(__dirname, '../services/case-runtime.js');
  const triggerSdkPath = require.resolve('@trigger.dev/sdk');

  const originals = {
    cronService: require.cache[cronServicePath],
    cron: require.cache[cronPath],
    notion: require.cache[notionPath],
    followup: require.cache[followupPath],
    db: require.cache[dbPath],
    constants: require.cache[constantsPath],
    stuckResponse: require.cache[stuckResponsePath],
    agencySync: require.cache[agencySyncPath],
    pdContact: require.cache[pdContactPath],
    triggerDispatch: require.cache[triggerDispatchPath],
    discord: require.cache[discordPath],
    draftQualityEval: require.cache[draftQualityEvalPath],
    qualityReport: require.cache[qualityReportPath],
    errorTracking: require.cache[errorTrackingPath],
    portalStatusMonitor: require.cache[portalStatusMonitorPath],
    feeWorkflow: require.cache[feeWorkflowPath],
    staleProposalRecovery: require.cache[staleProposalRecoveryPath],
    caseRuntime: require.cache[caseRuntimePath],
    triggerSdk: require.cache[triggerSdkPath],
  };

  require.cache[cronPath] = { id: cronPath, filename: cronPath, loaded: true, exports: { CronJob: function CronJob() {} } };
  require.cache[notionPath] = { id: notionPath, filename: notionPath, loaded: true, exports: {} };
  require.cache[followupPath] = { id: followupPath, filename: followupPath, loaded: true, exports: { start: sinon.stub(), stop: sinon.stub() } };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
  require.cache[constantsPath] = { id: constantsPath, filename: constantsPath, loaded: true, exports: { DRAFT_REQUIRED_ACTIONS: [] } };
  require.cache[stuckResponsePath] = { id: stuckResponsePath, filename: stuckResponsePath, loaded: true, exports: {} };
  require.cache[agencySyncPath] = { id: agencySyncPath, filename: agencySyncPath, loaded: true, exports: {} };
  require.cache[pdContactPath] = { id: pdContactPath, filename: pdContactPath, loaded: true, exports: {} };
  require.cache[triggerDispatchPath] = { id: triggerDispatchPath, filename: triggerDispatchPath, loaded: true, exports: triggerDispatchStub };
  require.cache[discordPath] = { id: discordPath, filename: discordPath, loaded: true, exports: { notify: sinon.stub().resolves() } };
  require.cache[draftQualityEvalPath] = { id: draftQualityEvalPath, filename: draftQualityEvalPath, loaded: true, exports: {} };
  require.cache[qualityReportPath] = { id: qualityReportPath, filename: qualityReportPath, loaded: true, exports: {} };
  require.cache[errorTrackingPath] = { id: errorTrackingPath, filename: errorTrackingPath, loaded: true, exports: { captureException: sinon.stub().resolves() } };
  require.cache[portalStatusMonitorPath] = { id: portalStatusMonitorPath, filename: portalStatusMonitorPath, loaded: true, exports: {} };
  require.cache[feeWorkflowPath] = { id: feeWorkflowPath, filename: feeWorkflowPath, loaded: true, exports: {} };
  require.cache[staleProposalRecoveryPath] = { id: staleProposalRecoveryPath, filename: staleProposalRecoveryPath, loaded: true, exports: { runStaleProposalRecoverySweep: sinon.stub().resolves({ scanned: 0, recovered: 0, failed: 0 }) } };
  require.cache[caseRuntimePath] = {
    id: caseRuntimePath,
    filename: caseRuntimePath,
    loaded: true,
    exports: { transitionCaseRuntime: sinon.stub().resolves(), CaseLockContention: class CaseLockContention extends Error {} },
  };
  require.cache[triggerSdkPath] = { id: triggerSdkPath, filename: triggerSdkPath, loaded: true, exports: { tasks: { trigger: sinon.stub().resolves({ id: 'run_123' }) } } };
  delete require.cache[cronServicePath];

  const cronService = require(cronServicePath);

  return {
    cronService,
    restore() {
      for (const [key, cachePath] of Object.entries({
        cronService: cronServicePath,
        cron: cronPath,
        notion: notionPath,
        followup: followupPath,
        db: dbPath,
        constants: constantsPath,
        stuckResponse: stuckResponsePath,
        agencySync: agencySyncPath,
        pdContact: pdContactPath,
        triggerDispatch: triggerDispatchPath,
        discord: discordPath,
        draftQualityEval: draftQualityEvalPath,
        qualityReport: qualityReportPath,
        errorTracking: errorTrackingPath,
        portalStatusMonitor: portalStatusMonitorPath,
        feeWorkflow: feeWorkflowPath,
        staleProposalRecovery: staleProposalRecoveryPath,
        caseRuntime: caseRuntimePath,
        triggerSdk: triggerSdkPath,
      })) {
        if (originals[key]) require.cache[cachePath] = originals[key];
        else delete require.cache[cachePath];
      }
    },
  };
}

describe('Stale reprocess recovery sweep', function () {
  it('retries stale reset-to-inbound cases that have no active run or proposal', async function () {
    const dbStub = {
      query: sinon.stub(),
      logActivity: sinon.stub().resolves(),
      createAgentRunFull: sinon.stub().resolves({ id: 4001 }),
    };
    dbStub.query.onFirstCall().resolves({
      rows: [{
        case_id: 26682,
        autopilot_mode: 'SUPERVISED',
        substatus: 'Reset to inbound #2721; reprocessing',
        message_id: 2721,
      }],
    });
    dbStub.query.onSecondCall().resolves({ rows: [] }); // update messages
    dbStub.query.onThirdCall().resolves({ rows: [] }); // update cases

    const triggerDispatchStub = { triggerTask: sinon.stub().resolves({ handle: { id: 'run_xyz' } }) };

    const { cronService, restore } = loadCronService({ dbStub, triggerDispatchStub });
    try {
      const result = await cronService.runStaleReprocessRecoverySweep({ minAgeMinutes: 15, limit: 10 });
      assert.strictEqual(result.scanned, 1);
      assert.strictEqual(result.retried, 1);
      assert.strictEqual(result.failed, 0);
      sinon.assert.calledOnce(dbStub.createAgentRunFull);
      sinon.assert.calledOnce(triggerDispatchStub.triggerTask);
      sinon.assert.calledWithMatch(triggerDispatchStub.triggerTask, 'process-inbound', sinon.match({
        caseId: 26682,
        messageId: 2721,
        triggerType: 'STALE_REPROCESS_RECOVERY',
      }));
    } finally {
      restore();
    }
  });

  it('records failures when re-triggering stale reprocess cases fails', async function () {
    const dbStub = {
      query: sinon.stub().resolves({
        rows: [{
          case_id: 25136,
          autopilot_mode: 'SUPERVISED',
          substatus: 'Resolving: reprocess',
          message_id: 679,
        }],
      }),
      logActivity: sinon.stub().resolves(),
      createAgentRunFull: sinon.stub().rejects(new Error('db exploded')),
    };
    const triggerDispatchStub = { triggerTask: sinon.stub().resolves() };

    const { cronService, restore } = loadCronService({ dbStub, triggerDispatchStub });
    try {
      const result = await cronService.runStaleReprocessRecoverySweep({ minAgeMinutes: 15, limit: 10 });
      assert.strictEqual(result.scanned, 1);
      assert.strictEqual(result.retried, 0);
      assert.strictEqual(result.failed, 1);
      sinon.assert.notCalled(triggerDispatchStub.triggerTask);
      sinon.assert.calledWithMatch(
        dbStub.logActivity,
        'stale_reprocess_retrigger_failed',
        sinon.match.string,
        sinon.match({ case_id: 25136, message_id: 679, source_service: 'cron_service' })
      );
    } finally {
      restore();
    }
  });
});
