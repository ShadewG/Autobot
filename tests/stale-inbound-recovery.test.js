const assert = require('assert');
const path = require('path');
const sinon = require('sinon');

function loadCronService({ dbStub, triggerDispatchStub, inboundFailureRecoveryStub }) {
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
  const inboundFailureRecoveryPath = path.resolve(__dirname, '../services/inbound-run-failure-recovery.js');
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
    inboundFailureRecovery: require.cache[inboundFailureRecoveryPath],
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
  require.cache[inboundFailureRecoveryPath] = {
    id: inboundFailureRecoveryPath,
    filename: inboundFailureRecoveryPath,
    loaded: true,
    exports: inboundFailureRecoveryStub || { recoverInboundRunFailureToProposal: sinon.stub().resolves({ recovered: false, reason: 'not_configured' }) },
  };
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
        inboundFailureRecovery: inboundFailureRecoveryPath,
        caseRuntime: caseRuntimePath,
        triggerSdk: triggerSdkPath,
      })) {
        if (originals[key]) require.cache[cachePath] = originals[key];
        else delete require.cache[cachePath];
      }
    },
  };
}

describe('Stale inbound recovery sweep', function () {
  it('marks already-handled inbound messages processed instead of retriggering them', async function () {
    const dbStub = {
      query: sinon.stub().resolves({
        rows: [
          {
            message_id: 724,
            case_id: 25156,
            subject: 'Submission Confirmation',
            from_email: 'records@nextrequest.com',
            body_preview: 'Submission confirmation for your request',
            case_status: 'needs_human_review',
            active_proposal_count: 1,
            message_proposal_count: 1,
            later_outbound_count: 0,
            portal_submission_count: 0,
            run_count: 1,
            failed_run_count: 0,
            active_run_count: 0,
            last_run_id: 145,
            last_run_status: 'waiting',
          },
        ],
      }),
      markMessageProcessed: sinon.stub().resolves(),
      logActivity: sinon.stub().resolves(),
      createAgentRunFull: sinon.stub().resolves({ id: 999 }),
    };
    const triggerDispatchStub = { triggerTask: sinon.stub().resolves() };

    const { cronService, restore } = loadCronService({ dbStub, triggerDispatchStub });
    try {
      const result = await cronService.runStaleInboundRecoverySweep({ maxAgeMinutes: 15, limit: 10 });

      assert.strictEqual(result.markedProcessed, 1);
      assert.strictEqual(result.retried, 0);
      sinon.assert.calledWithExactly(
        dbStub.markMessageProcessed,
        724,
        145,
        sinon.match('marked processed during cleanup: active_proposal,message_proposal')
      );
      sinon.assert.notCalled(triggerDispatchStub.triggerTask);
    } finally {
      restore();
    }
  });

  it('creates a manual-review proposal when a matched inbound already failed processing', async function () {
    const dbStub = {
      query: sinon.stub().resolves({
        rows: [
          {
            message_id: 2721,
            case_id: 26682,
            subject: 'Request Closed',
            from_email: 'hardeeville.nextrequest.com',
            body_preview: 'The record you asked for does not exist',
            case_status: 'awaiting_response',
            autopilot_mode: 'SUPERVISED',
            active_proposal_count: 0,
            message_proposal_count: 0,
            later_outbound_count: 0,
            portal_submission_count: 0,
            run_count: 1,
            failed_run_count: 1,
            active_run_count: 0,
            last_run_id: 2829,
            last_run_status: 'failed',
          },
        ],
      }),
      markMessageProcessed: sinon.stub().resolves(),
      logActivity: sinon.stub().resolves(),
      createAgentRunFull: sinon.stub().resolves({ id: 3001 }),
    };
    const triggerDispatchStub = { triggerTask: sinon.stub().resolves({ handle: { id: 'run_abc' } }) };
    const inboundFailureRecoveryStub = {
      recoverInboundRunFailureToProposal: sinon.stub().resolves({ recovered: true, proposalId: 9001 }),
    };

    const { cronService, restore } = loadCronService({ dbStub, triggerDispatchStub, inboundFailureRecoveryStub });
    try {
      const result = await cronService.runStaleInboundRecoverySweep({ maxAgeMinutes: 15, limit: 10 });

      assert.strictEqual(result.markedProcessed, 0);
      assert.strictEqual(result.recoveredFailures, 1);
      assert.strictEqual(result.retried, 0);
      sinon.assert.notCalled(dbStub.createAgentRunFull);
      sinon.assert.notCalled(triggerDispatchStub.triggerTask);
      sinon.assert.calledOnce(inboundFailureRecoveryStub.recoverInboundRunFailureToProposal);
      sinon.assert.calledWithMatch(
        inboundFailureRecoveryStub.recoverInboundRunFailureToProposal,
        sinon.match({
          caseId: 26682,
          messageId: 2721,
          runId: 2829,
        })
      );
    } finally {
      restore();
    }
  });

  it('marks duplicate inbound bursts processed when a matching sibling was already handled', async function () {
    const dbStub = {
      query: sinon.stub().resolves({
        rows: [
          {
            message_id: 819,
            case_id: 25202,
            subject: 'FINAL WARNING - DO NOT CONTACT AGAIN',
            from_email: 'records@agency.gov',
            body_preview: 'Hostile duplicate inbound',
            case_status: 'needs_review',
            active_proposal_count: 0,
            message_proposal_count: 0,
            later_outbound_count: 0,
            portal_submission_count: 0,
            processed_duplicate_count: 1,
            run_count: 1,
            failed_run_count: 1,
            active_run_count: 0,
            last_run_id: 1478,
            last_run_status: 'failed',
          },
        ],
      }),
      markMessageProcessed: sinon.stub().resolves(),
      logActivity: sinon.stub().resolves(),
      createAgentRunFull: sinon.stub().resolves({ id: 3002 }),
    };
    const triggerDispatchStub = { triggerTask: sinon.stub().resolves() };

    const { cronService, restore } = loadCronService({ dbStub, triggerDispatchStub });
    try {
      const result = await cronService.runStaleInboundRecoverySweep({ maxAgeMinutes: 15, limit: 10 });

      assert.strictEqual(result.markedProcessed, 1);
      assert.strictEqual(result.retried, 0);
      sinon.assert.calledWithExactly(
        dbStub.markMessageProcessed,
        819,
        1478,
        sinon.match('marked processed during cleanup: duplicate_inbound_burst')
      );
      sinon.assert.notCalled(triggerDispatchStub.triggerTask);
    } finally {
      restore();
    }
  });

  it('recovers already-processed inbound failures that still have no proposal', async function () {
    const dbStub = {
      query: sinon.stub().resolves({
        rows: [
          {
            case_id: 25204,
            message_id: 730,
            inbound_at: new Date().toISOString(),
            run_id: 2860,
            failure_error: '429 You exceeded your current quota',
          },
        ],
      }),
      logActivity: sinon.stub().resolves(),
    };
    const triggerDispatchStub = { triggerTask: sinon.stub().resolves() };
    const inboundFailureRecoveryStub = {
      recoverInboundRunFailureToProposal: sinon.stub().resolves({ recovered: true, proposalId: 9004 }),
    };

    const { cronService, restore } = loadCronService({ dbStub, triggerDispatchStub, inboundFailureRecoveryStub });
    try {
      const result = await cronService.runFailedInboundRecoverySweep({ maxAgeMinutes: 5, limit: 10 });

      assert.strictEqual(result.scanned, 1);
      assert.strictEqual(result.recovered, 1);
      assert.strictEqual(result.failed, 0);
      sinon.assert.calledOnce(inboundFailureRecoveryStub.recoverInboundRunFailureToProposal);
      sinon.assert.notCalled(triggerDispatchStub.triggerTask);
    } finally {
      restore();
    }
  });
});
