const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

const proposalsRouter = require('../routes/requests/proposals');
const db = require('../services/database');

describe('Request proposals route regressions', function () {
  let originalGetCaseById;
  let originalGetPendingProposalsByCaseId;

  beforeEach(function () {
    originalGetCaseById = db.getCaseById;
    originalGetPendingProposalsByCaseId = db.getPendingProposalsByCaseId;
  });

  afterEach(function () {
    db.getCaseById = originalGetCaseById;
    db.getPendingProposalsByCaseId = originalGetPendingProposalsByCaseId;
  });

  it('returns PENDING_PORTAL proposals for decision-required portal reviews', async function () {
    db.getCaseById = async () => ({
      id: 25161,
      status: 'needs_human_review',
    });
    db.getPendingProposalsByCaseId = async () => ([
      {
        id: 901,
        proposal_key: '25161:portal:SUBMIT_PORTAL:0',
        action_type: 'SUBMIT_PORTAL',
        status: 'PENDING_PORTAL',
        draft_subject: 'Portal submission requires approval',
        draft_body_text: 'Approve to continue portal submission.',
        reasoning: ['Portal form has been prepared and requires approval.'],
        confidence: 0.85,
        risk_flags: [],
        warnings: [],
        can_auto_execute: false,
        requires_human: true,
        adjustment_count: 0,
        created_at: '2026-03-06T00:00:00.000Z',
      },
    ]);

    const app = express();
    app.use('/api/requests', proposalsRouter);

    const response = await supertest(app).get('/api/requests/25161/proposals');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.count, 1);
    assert.strictEqual(response.body.proposals[0].status, 'PENDING_PORTAL');
    assert.strictEqual(response.body.proposals[0].action_type, 'SUBMIT_PORTAL');
  });
});
