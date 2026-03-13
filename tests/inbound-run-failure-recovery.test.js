const assert = require('assert');
const path = require('path');
const sinon = require('sinon');

function loadRecoveryService(dbStub) {
  const servicePath = path.resolve(__dirname, '../services/inbound-run-failure-recovery.js');
  const dbPath = path.resolve(__dirname, '../services/database.js');

  const originalService = require.cache[servicePath];
  const originalDb = require.cache[dbPath];

  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
  delete require.cache[servicePath];

  const service = require(servicePath);

  return {
    service,
    restore() {
      if (originalService) require.cache[servicePath] = originalService;
      else delete require.cache[servicePath];
      if (originalDb) require.cache[dbPath] = originalDb;
      else delete require.cache[dbPath];
    },
  };
}

describe('Inbound run failure recovery', function () {
  it('creates a manual-review proposal and marks the inbound processed when no active proposal exists', async function () {
    const dbStub = {
      getCaseById: sinon.stub().resolves({ id: 26682, case_name: 'Hardeeville homicide case' }),
      query: sinon.stub().resolves({ rows: [] }),
      getMessageById: sinon.stub().resolves({
        id: 2721,
        from_email: 'messages@nextrequest.com',
        subject: 'Your City of Hardeeville request has been closed.',
      }),
      upsertProposal: sinon.stub().resolves({ id: 9001 }),
      markMessageProcessed: sinon.stub().resolves(),
      logActivity: sinon.stub().resolves(),
    };

    const { service, restore } = loadRecoveryService(dbStub);
    try {
      const result = await service.recoverInboundRunFailureToProposal({
        caseId: 26682,
        messageId: 2721,
        runId: 2863,
        error: '429 You exceeded your current quota',
        sourceService: 'trigger.dev',
      });

      assert.deepStrictEqual(result, { recovered: true, proposalId: 9001 });
      sinon.assert.calledOnce(dbStub.upsertProposal);
      sinon.assert.calledWithMatch(dbStub.upsertProposal, sinon.match({
        caseId: 26682,
        triggerMessageId: 2721,
        actionType: 'ESCALATE',
        status: 'PENDING_APPROVAL',
      }));
      sinon.assert.calledWithExactly(dbStub.markMessageProcessed, 2721, 2863, sinon.match('429'));
    } finally {
      restore();
    }
  });

  it('does not create a duplicate manual-review proposal when one already exists', async function () {
    const dbStub = {
      getCaseById: sinon.stub().resolves({ id: 25206, case_name: 'Iowa DCI case' }),
      query: sinon.stub().resolves({ rows: [{ id: 123 }] }),
      getMessageById: sinon.stub().resolves({
        id: 753,
        from_email: 'schwalba@dps.state.ia.us',
        subject: 'Re: Public Records Request',
      }),
      upsertProposal: sinon.stub().resolves({ id: 9002 }),
      markMessageProcessed: sinon.stub().resolves(),
      logActivity: sinon.stub().resolves(),
    };

    const { service, restore } = loadRecoveryService(dbStub);
    try {
      const result = await service.recoverInboundRunFailureToProposal({
        caseId: 25206,
        messageId: 753,
        runId: 2861,
        error: 'OpenAI exploded',
        sourceService: 'cron_service',
      });

      assert.deepStrictEqual(result, { recovered: false, reason: 'active_proposal_exists' });
      sinon.assert.notCalled(dbStub.upsertProposal);
      sinon.assert.calledOnce(dbStub.markMessageProcessed);
    } finally {
      restore();
    }
  });
});
