const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

const caseManagementRouter = require('../routes/requests/case-management');
const proposalsRouter = require('../routes/requests/proposals');
const db = require('../services/database');

describe('Request audit/debug routes', function () {
  let originalGetCaseById;
  let originalQuery;
  let originalGetProposalById;
  let originalGetProposalContentVersions;
  let originalGetPortalSubmissions;

  beforeEach(function () {
    originalGetCaseById = db.getCaseById;
    originalQuery = db.query;
    originalGetProposalById = db.getProposalById;
    originalGetProposalContentVersions = db.getProposalContentVersions;
    originalGetPortalSubmissions = db.getPortalSubmissions;
  });

  afterEach(function () {
    db.getCaseById = originalGetCaseById;
    db.query = originalQuery;
    db.getProposalById = originalGetProposalById;
    db.getProposalContentVersions = originalGetProposalContentVersions;
    db.getPortalSubmissions = originalGetPortalSubmissions;
  });

  it('returns event ledger rows for a case', async function () {
    db.getCaseById = async () => ({ id: 25169, case_name: 'QA Case' });
    db.query = async (sql) => {
      assert.match(sql, /FROM case_event_ledger/);
      return {
        rows: [
          {
            id: 1,
            case_id: 25169,
            event: 'CASE_ESCALATED',
            transition_key: '25169:event:1',
            context: { pauseReason: 'RESEARCH_HANDOFF' },
            mutations_applied: { status: 'needs_human_review' },
            projection: { status: 'needs_human_review' },
            created_at: '2026-03-08T10:00:00.000Z',
          },
        ],
      };
    };

    const app = express();
    app.use('/api/requests', caseManagementRouter);

    const response = await supertest(app).get('/api/requests/25169/event-ledger?limit=20');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.count, 1);
    assert.strictEqual(response.body.events[0].event, 'CASE_ESCALATED');
  });

  it('returns sanitized provider payloads for messages and executions', async function () {
    db.getCaseById = async () => ({ id: 25169, case_name: 'QA Case' });
    let callCount = 0;
    db.query = async (sql) => {
      callCount += 1;
      if (callCount === 1) {
        assert.match(sql, /FROM messages/);
        return {
          rows: [
            {
              id: 91,
              direction: 'outbound',
              subject: 'Subject',
              provider_payload: { provider: 'sendgrid', direction: 'outbound' },
            },
          ],
        };
      }
      assert.match(sql, /FROM executions/);
      return {
        rows: [
          {
            id: 101,
            proposal_id: 900,
            action_type: 'SEND_INITIAL_REQUEST',
            provider_payload: { provider: 'sendgrid', jobId: 'job_123' },
          },
        ],
      };
    };

    const app = express();
    app.use('/api/requests', caseManagementRouter);

    const response = await supertest(app).get('/api/requests/25169/provider-payloads');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.messages.length, 1);
    assert.strictEqual(response.body.executions.length, 1);
    assert.strictEqual(response.body.messages[0].provider_payload.provider, 'sendgrid');
    assert.strictEqual(response.body.executions[0].provider_payload.jobId, 'job_123');
  });

  it('returns portal submission history for a case', async function () {
    db.getCaseById = async () => ({ id: 25169, case_name: 'QA Case' });
    db.getPortalSubmissions = async (caseId, options) => {
      assert.strictEqual(caseId, 25169);
      assert.strictEqual(options.limit, 10);
      return [
        {
          id: 44,
          case_id: 25169,
          portal_url: 'https://portal.example.gov/request/123',
          status: 'failed',
          confirmation_number: null,
        },
      ];
    };

    const app = express();
    app.use('/api/requests', caseManagementRouter);

    const response = await supertest(app).get('/api/requests/25169/portal-submissions?limit=10');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.count, 1);
    assert.strictEqual(response.body.submissions[0].status, 'failed');
  });

  it('returns proposal content versions for a case proposal', async function () {
    db.getProposalById = async () => ({ id: 901, case_id: 25169 });
    db.getProposalContentVersions = async () => ([
      {
        id: 1,
        proposal_id: 901,
        version_number: 1,
        change_source: 'created',
        draft_subject: 'Initial subject',
      },
      {
        id: 2,
        proposal_id: 901,
        version_number: 2,
        change_source: 'approval_edit',
        draft_subject: 'Edited subject',
      },
    ]);

    const app = express();
    app.use('/api/requests', proposalsRouter);

    const response = await supertest(app).get('/api/requests/25169/proposals/901/versions');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.count, 2);
    assert.strictEqual(response.body.versions[1].change_source, 'approval_edit');
  });
});
