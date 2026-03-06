const assert = require('assert');
const path = require('path');
const sinon = require('sinon');

describe('Portal timeout normalization', function () {
  function loadCronService({ dbStub, notionStub, followupStub, stuckResponseStub, agencySyncStub, pdContactStub, triggerDispatchStub, discordStub, caseRuntimeStub }) {
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
    const caseRuntimePath = path.resolve(__dirname, '../services/case-runtime.js');

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
      caseRuntime: require.cache[caseRuntimePath],
    };

    require.cache[cronPath] = { id: cronPath, filename: cronPath, loaded: true, exports: { CronJob: function CronJob() {} } };
    require.cache[notionPath] = { id: notionPath, filename: notionPath, loaded: true, exports: notionStub };
    require.cache[followupPath] = { id: followupPath, filename: followupPath, loaded: true, exports: followupStub };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
    require.cache[constantsPath] = { id: constantsPath, filename: constantsPath, loaded: true, exports: { DRAFT_REQUIRED_ACTIONS: [] } };
    require.cache[stuckResponsePath] = { id: stuckResponsePath, filename: stuckResponsePath, loaded: true, exports: stuckResponseStub };
    require.cache[agencySyncPath] = { id: agencySyncPath, filename: agencySyncPath, loaded: true, exports: agencySyncStub };
    require.cache[pdContactPath] = { id: pdContactPath, filename: pdContactPath, loaded: true, exports: pdContactStub };
    require.cache[triggerDispatchPath] = { id: triggerDispatchPath, filename: triggerDispatchPath, loaded: true, exports: triggerDispatchStub };
    require.cache[discordPath] = { id: discordPath, filename: discordPath, loaded: true, exports: discordStub };
    require.cache[caseRuntimePath] = { id: caseRuntimePath, filename: caseRuntimePath, loaded: true, exports: caseRuntimeStub };
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
          caseRuntime: caseRuntimePath,
        })) {
          if (originals[key]) require.cache[cachePath] = originals[key];
          else delete require.cache[cachePath];
        }
      },
    };
  }

  it('normalizes stale created portal status into a consistent 30 minute escalation message', async function () {
    const dbStub = {
      query: sinon.stub().callsFake(async () => ({ rows: [] })),
      upsertProposal: sinon.stub().resolves(),
      logActivity: sinon.stub().resolves(),
    };

    dbStub.query.onCall(0).resolves({
      rows: [
        {
          id: 25152,
          case_name: 'Roanoke portal case',
          status: 'portal_in_progress',
          updated_at: '2026-03-06T10:00:00.000Z',
          portal_url: 'https://portal.example.com',
          last_portal_details: JSON.stringify({ status: 'created' }),
          last_portal_recording_url: 'https://recording.example.com',
          last_portal_task_url: 'https://task.example.com',
        },
      ],
    });
    const caseRuntimeStub = {
      transitionCaseRuntime: sinon.stub().resolves(),
      CaseLockContention: class CaseLockContention extends Error {},
    };

    const { cronService, restore } = loadCronService({
      dbStub,
      notionStub: { syncStatusToNotion: sinon.stub().resolves() },
      followupStub: { start: sinon.stub() },
      stuckResponseStub: {},
      agencySyncStub: {},
      pdContactStub: {},
      triggerDispatchStub: {},
      discordStub: { notify: sinon.stub().resolves() },
      caseRuntimeStub,
    });

    try {
      const result = await cronService.sweepStuckPortalCases();

      assert.strictEqual(result.portalEscalated, 1);
      sinon.assert.calledWithExactly(
        caseRuntimeStub.transitionCaseRuntime,
        25152,
        'PORTAL_STUCK',
        sinon.match({
          substatus: sinon.match(/>30 min/i),
        })
      );
      sinon.assert.calledWithExactly(
        dbStub.upsertProposal,
        sinon.match({
          actionType: 'SUBMIT_PORTAL',
          reasoning: sinon.match((reasoning) =>
            Array.isArray(reasoning) &&
            reasoning.some((line) => /30\+ minutes/i.test(line)) &&
            reasoning.some((line) => /No active submit-portal run; last portal task status was created/i.test(line))
          ),
          draftBodyText: sinon.match(/No active submit-portal run; last portal task status was created/i),
        })
      );
      sinon.assert.calledWithExactly(
        dbStub.logActivity,
        'portal_stuck_escalated',
        sinon.match(/stuck >30min/i),
        sinon.match({
          case_id: 25152,
          portal_error: 'No active submit-portal run; last portal task status was created',
        })
      );
    } finally {
      restore();
    }
  });
});
