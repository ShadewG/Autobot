const assert = require('assert');
const path = require('path');
const sinon = require('sinon');

function loadCronService({ dbStub }) {
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
    caseRuntime: require.cache[caseRuntimePath],
    triggerSdk: require.cache[triggerSdkPath],
  };

  require.cache[cronPath] = { id: cronPath, filename: cronPath, loaded: true, exports: { CronJob: function CronJob() {} } };
  require.cache[notionPath] = { id: notionPath, filename: notionPath, loaded: true, exports: {} };
  require.cache[followupPath] = { id: followupPath, filename: followupPath, loaded: true, exports: { start: sinon.stub() } };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
  require.cache[constantsPath] = { id: constantsPath, filename: constantsPath, loaded: true, exports: { DRAFT_REQUIRED_ACTIONS: [] } };
  require.cache[stuckResponsePath] = { id: stuckResponsePath, filename: stuckResponsePath, loaded: true, exports: {} };
  require.cache[agencySyncPath] = { id: agencySyncPath, filename: agencySyncPath, loaded: true, exports: {} };
  require.cache[pdContactPath] = { id: pdContactPath, filename: pdContactPath, loaded: true, exports: {} };
  require.cache[triggerDispatchPath] = { id: triggerDispatchPath, filename: triggerDispatchPath, loaded: true, exports: {} };
  require.cache[discordPath] = { id: discordPath, filename: discordPath, loaded: true, exports: { notify: sinon.stub().resolves() } };
  require.cache[draftQualityEvalPath] = { id: draftQualityEvalPath, filename: draftQualityEvalPath, loaded: true, exports: {} };
  require.cache[qualityReportPath] = { id: qualityReportPath, filename: qualityReportPath, loaded: true, exports: {} };
  require.cache[errorTrackingPath] = { id: errorTrackingPath, filename: errorTrackingPath, loaded: true, exports: { captureException: sinon.stub().resolves() } };
  require.cache[portalStatusMonitorPath] = { id: portalStatusMonitorPath, filename: portalStatusMonitorPath, loaded: true, exports: {} };
  require.cache[caseRuntimePath] = { id: caseRuntimePath, filename: caseRuntimePath, loaded: true, exports: { transitionCaseRuntime: sinon.stub().resolves(), CaseLockContention: class CaseLockContention extends Error {} } };
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
        caseRuntime: caseRuntimePath,
        triggerSdk: triggerSdkPath,
      })) {
        if (originals[key]) require.cache[cachePath] = originals[key];
        else delete require.cache[cachePath];
      }
    },
  };
}

describe('Priority auto-escalation', function () {
  it('raises in-window cases to urgent and logs each escalation', async function () {
    const dbStub = {
      query: sinon.stub().resolves({
        rows: [
          { id: 12, deadline_date: '2026-03-10' },
          { id: 19, deadline_date: '2026-03-11' },
        ],
      }),
      logActivity: sinon.stub().resolves(),
    };

    const { cronService, restore } = loadCronService({ dbStub });

    try {
      const result = await cronService.runPriorityAutoEscalate();

      assert.strictEqual(result.escalated, 2);
      assert.deepStrictEqual(result.caseIds, [12, 19]);
      assert.match(dbStub.query.firstCall.args[0], /UPDATE cases/);
      assert.match(dbStub.query.firstCall.args[0], /deadline_date::date <= \(CURRENT_DATE \+ INTERVAL '3 days'\)::date/);
      sinon.assert.calledTwice(dbStub.logActivity);
      sinon.assert.calledWithExactly(
        dbStub.logActivity.firstCall,
        'priority_auto_escalate',
        'Auto-escalated priority to urgent (deadline within 3 days)',
        sinon.match({
          case_id: 12,
          actor_type: 'system',
          source_service: 'cron_service',
          deadline_date: '2026-03-10',
          escalated_to_priority: 2,
        })
      );
    } finally {
      restore();
    }
  });

  it('returns cleanly when no cases need escalation', async function () {
    const dbStub = {
      query: sinon.stub().resolves({ rows: [] }),
      logActivity: sinon.stub().resolves(),
    };

    const { cronService, restore } = loadCronService({ dbStub });

    try {
      const result = await cronService.runPriorityAutoEscalate();
      assert.deepStrictEqual(result, { escalated: 0, caseIds: [] });
      sinon.assert.notCalled(dbStub.logActivity);
    } finally {
      restore();
    }
  });
});
