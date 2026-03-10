const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

const proposalsRouter = require('../routes/requests/proposals');
const db = require('../services/database');

describe('Request proposals route regressions', function () {
  let originalGetCaseById;
  let originalGetPendingProposalsByCaseId;
  let originalGetThreadsByCaseId;
  let originalGetMessagesByThreadId;

  beforeEach(function () {
    originalGetCaseById = db.getCaseById;
    originalGetPendingProposalsByCaseId = db.getPendingProposalsByCaseId;
    originalGetThreadsByCaseId = db.getThreadsByCaseId;
    originalGetMessagesByThreadId = db.getMessagesByThreadId;
  });

  afterEach(function () {
    db.getCaseById = originalGetCaseById;
    db.getPendingProposalsByCaseId = originalGetPendingProposalsByCaseId;
    db.getThreadsByCaseId = originalGetThreadsByCaseId;
    db.getMessagesByThreadId = originalGetMessagesByThreadId;
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

  it('suppresses pending proposals when the latest inbound is a mismatched manual paste', async function () {
    db.getCaseById = async () => ({
      id: 25148,
      status: 'responded',
    });
    db.getPendingProposalsByCaseId = async () => ([
      {
        id: 1183,
        proposal_key: '25148:990:SEND_REBUTTAL:0',
        action_type: 'SEND_REBUTTAL',
        status: 'PENDING_APPROVAL',
        draft_subject: 'RE: Public Records Request',
        draft_body_text: 'Hello',
        reasoning: [],
        warnings: [],
        risk_flags: [],
        can_auto_execute: false,
        requires_human: true,
        adjustment_count: 0,
        created_at: '2026-03-08T22:12:04.799Z',
      },
    ]);
    db.getThreadsByCaseId = async () => ([
      {
        id: 53,
        agency_email: 'jill.jennings@perry-ga.gov',
      },
    ]);
    db.getMessagesByThreadId = async () => ([
      {
        id: 990,
        direction: 'INBOUND',
        from_email: 'records@atlanta.gov',
        source: 'manual_paste',
        created_at: '2026-03-08T22:10:32.096Z',
      },
    ]);

    const app = express();
    app.use('/api/requests', proposalsRouter);

    const response = await supertest(app).get('/api/requests/25148/proposals');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.count, 0);
    assert.deepStrictEqual(response.body.proposals, []);
  });

  it('suppresses contradictory pending send proposals whose draft says no response is needed', async function () {
    db.getCaseById = async () => ({
      id: 25891,
      status: 'needs_human_review',
    });
    db.getPendingProposalsByCaseId = async () => ([
      {
        id: 1314,
        proposal_key: '25891:2576:SEND_CLARIFICATION:0',
        action_type: 'SEND_CLARIFICATION',
        status: 'PENDING_APPROVAL',
        draft_subject: 'RE: [Records Center] Welcome to the Records Center!',
        draft_body_text: 'No response needed. This is an automated portal/account registration message and does not require any reply.',
        reasoning: [],
        warnings: [],
        risk_flags: [],
        can_auto_execute: false,
        requires_human: true,
        adjustment_count: 0,
        created_at: '2026-03-09T12:37:25.000Z',
      },
    ]);
    db.getThreadsByCaseId = async () => ([]);
    db.getMessagesByThreadId = async () => ([]);

    const app = express();
    app.use('/api/requests', proposalsRouter);

    const response = await supertest(app).get('/api/requests/25891/proposals');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.count, 0);
    assert.deepStrictEqual(response.body.proposals, []);
  });

  it('sanitizes stale research handoff drafts that reference synthetic channels', async function () {
    db.getCaseById = async () => ({
      id: 25525,
      status: 'needs_human_review',
    });
    db.getPendingProposalsByCaseId = async () => ([
      {
        id: 1777,
        proposal_key: '25525:research:ESCALATE:0',
        action_type: 'ESCALATE',
        status: 'PENDING_APPROVAL',
        draft_subject: 'Manual handoff required',
        draft_body_text: 'Research completed but no new channels were found. Existing channels: email: test@agency.gov, portal: https://sanfrancisco.nextrequest.com. Review and decide whether to retry via existing channels or try a different approach.',
        reasoning: [
          'Research completed but no new channels were found.',
          'Existing channels: email: test@agency.gov, portal: https://sanfrancisco.nextrequest.com',
        ],
        warnings: [],
        risk_flags: [],
        can_auto_execute: false,
        requires_human: true,
        adjustment_count: 0,
        created_at: '2026-03-10T12:37:25.000Z',
      },
    ]);
    db.getThreadsByCaseId = async () => ([]);
    db.getMessagesByThreadId = async () => ([]);

    const app = express();
    app.use('/api/requests', proposalsRouter);

    const response = await supertest(app).get('/api/requests/25525/proposals');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.count, 1);
    assert.strictEqual(
      response.body.proposals[0].draft_preview,
      'Research completed but no verified existing channels were found. Review and decide whether to retry research or try a different approach.'
    );
    assert.deepStrictEqual(
      response.body.proposals[0].reasoning,
      ['Research completed but no new channels were found.']
    );
  });
});
