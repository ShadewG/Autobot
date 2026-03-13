const assert = require('assert');
const path = require('path');
const sinon = require('sinon');

function loadRecoveryService({ dbStub, aiServiceStub }) {
  const servicePath = path.resolve(__dirname, '../services/stale-proposal-recovery-service.js');
  const dbPath = path.resolve(__dirname, '../services/database.js');
  const aiServicePath = path.resolve(__dirname, '../services/ai-service.js');

  const originals = {
    service: require.cache[servicePath],
    db: require.cache[dbPath],
    aiService: require.cache[aiServicePath],
  };

  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
  require.cache[aiServicePath] = { id: aiServicePath, filename: aiServicePath, loaded: true, exports: aiServiceStub };
  delete require.cache[servicePath];

  const service = require(servicePath);
  return {
    service,
    restore() {
      if (originals.service) require.cache[servicePath] = originals.service; else delete require.cache[servicePath];
      if (originals.db) require.cache[dbPath] = originals.db; else delete require.cache[dbPath];
      if (originals.aiService) require.cache[aiServicePath] = originals.aiService; else delete require.cache[aiServicePath];
    },
  };
}

describe('stale proposal recovery', function () {
  it('regenerates noisy status update drafts with the current status inquiry path', async function () {
    const dbStub = {
      query: sinon.stub().resolves({
        rows: [{
          id: 1989,
          case_id: 25155,
          action_type: 'SEND_STATUS_UPDATE',
          status: 'PENDING_APPROVAL',
          draft_body_text: 'Please have both reference numbers and security key available.',
          warnings: ['Contains personal phone number (PII)', 'Duplicate closing: "Thank you," appears twice.'],
          risk_flags: ['CONTAINS_PII'],
          updated_at: new Date().toISOString(),
        }],
      }),
      getCaseById: sinon.stub().resolves({ id: 25155, case_name: 'Santa Rosa case', agency_name: 'Santa Rosa County Sheriff\'s Office' }),
      updateProposal: sinon.stub().resolves(),
      logActivity: sinon.stub().resolves(),
    };
    const aiServiceStub = {
      generateFollowUp: sinon.stub().resolves({
        subject: 'RE: Public Records Request',
        body_text: 'Checking on the status of this request.',
        body_html: null,
        modelMetadata: { modelId: 'gpt-5.2', promptTokens: 11, completionTokens: 22, latencyMs: 33 },
      }),
    };

    const { service, restore } = loadRecoveryService({ dbStub, aiServiceStub });
    try {
      const result = await service.runStaleProposalRecoverySweep({ minAgeMinutes: 0, limit: 10 });
      assert.strictEqual(result.recovered, 1);
      sinon.assert.calledOnce(aiServiceStub.generateFollowUp);
      sinon.assert.calledWithMatch(dbStub.updateProposal, 1989, sinon.match({
        draftSubject: 'RE: Public Records Request',
        draftBodyText: 'Checking on the status of this request.',
        warnings: null,
        risk_flags: null,
        __versionSource: 'stale_recovery',
      }));
    } finally {
      restore();
    }
  });

  it('replaces fallback rebuttal shells with a real rebuttal draft', async function () {
    const dbStub = {
      query: sinon.stub().resolves({
        rows: [{
          id: 2064,
          case_id: 26682,
          trigger_message_id: 2721,
          action_type: 'SEND_REBUTTAL',
          status: 'PENDING_APPROVAL',
          draft_subject: 'Review required: SEND REBUTTAL',
          draft_body_text: 'System fallback draft generated',
          warnings: ['fallback draft generated'],
          risk_flags: ['NO_DRAFT'],
          updated_at: new Date().toISOString(),
        }],
      }),
      getCaseById: sinon.stub().resolves({ id: 26682, case_name: 'Hardeeville case', agency_name: 'Hardeeville Police Department' }),
      getMessageById: sinon.stub().resolves({ id: 2721, body_text: 'The record you asked for does not exist.' }),
      getResponseAnalysisByMessageId: sinon.stub().resolves({ classification: 'denial' }),
      updateProposal: sinon.stub().resolves(),
      logActivity: sinon.stub().resolves(),
    };
    const aiServiceStub = {
      generateDenialRebuttal: sinon.stub().resolves({
        subject: 'RE: Public Records Request - Hardeeville',
        body_text: 'Please provide the statutory basis for withholding and any segregable portions.',
        body_html: null,
        modelMetadata: { modelId: 'gpt-5.2', promptTokens: 12, completionTokens: 34, latencyMs: 56 },
      }),
    };

    const { service, restore } = loadRecoveryService({ dbStub, aiServiceStub });
    try {
      const result = await service.runStaleProposalRecoverySweep({ minAgeMinutes: 0, limit: 10 });
      assert.strictEqual(result.recovered, 1);
      sinon.assert.calledOnce(aiServiceStub.generateDenialRebuttal);
      sinon.assert.calledWithMatch(dbStub.updateProposal, 2064, sinon.match({
        draftSubject: 'RE: Public Records Request - Hardeeville',
        warnings: null,
        risk_flags: null,
      }));
    } finally {
      restore();
    }
  });

  it('rebuilds generic research handoff drafts into a structured operator handoff', async function () {
    const dbStub = {
      query: sinon.stub().resolves({
        rows: [{
          id: 2048,
          case_id: 26684,
          action_type: 'RESEARCH_AGENCY',
          status: 'PENDING_APPROVAL',
          draft_subject: 'Action needed: Kyneddi Miller’s mother sentenced in teen’s death',
          draft_body_text: '(Draft generation failed — manual action required)',
          reasoning: [{ detail: 'State police likely hold the file.' }, { detail: 'No verified email was found.' }],
          warnings: ['draft generation failed'],
          risk_flags: [],
          updated_at: new Date().toISOString(),
        }],
      }),
      getCaseById: sinon.stub().resolves({ id: 26684, case_name: 'Kyneddi Miller case', agency_name: 'Unknown agency', subject_name: 'Kyneddi Miller' }),
      updateProposal: sinon.stub().resolves(),
      logActivity: sinon.stub().resolves(),
    };
    const aiServiceStub = {};

    const { service, restore } = loadRecoveryService({ dbStub, aiServiceStub });
    try {
      const result = await service.runStaleProposalRecoverySweep({ minAgeMinutes: 0, limit: 10 });
      assert.strictEqual(result.recovered, 1);
      sinon.assert.calledWithMatch(dbStub.updateProposal, 2048, sinon.match({
        draftSubject: 'Research handoff needed: Kyneddi Miller',
        draftBodyText: sinon.match('What the system found:'),
        warnings: null,
      }));
    } finally {
      restore();
    }
  });
});
