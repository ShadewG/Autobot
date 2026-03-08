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
  let originalGetCaseEmailEvents;

  beforeEach(function () {
    originalGetCaseById = db.getCaseById;
    originalQuery = db.query;
    originalGetProposalById = db.getProposalById;
    originalGetProposalContentVersions = db.getProposalContentVersions;
    originalGetPortalSubmissions = db.getPortalSubmissions;
    originalGetCaseEmailEvents = db.getCaseEmailEvents;
  });

  afterEach(function () {
    db.getCaseById = originalGetCaseById;
    db.query = originalQuery;
    db.getProposalById = originalGetProposalById;
    db.getProposalContentVersions = originalGetProposalContentVersions;
    db.getPortalSubmissions = originalGetPortalSubmissions;
    db.getCaseEmailEvents = originalGetCaseEmailEvents;
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
    db.getCaseEmailEvents = async (caseId, options) => {
      assert.strictEqual(caseId, 25169);
      assert.strictEqual(options.limit, 50);
      return [
        {
          id: 700,
          message_id: 91,
          provider_message_id: 'sg-msg-1',
          event_type: 'delivered',
          event_timestamp: '2026-03-08T10:05:00.000Z',
          raw_payload: { token: 'secret-token', event: 'delivered' },
        },
      ];
    };
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
              sendgrid_message_id: 'sg-msg-1',
              provider_payload: { provider: 'sendgrid', direction: 'outbound', authorization: 'Bearer abc' },
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
              provider_payload: { provider: 'sendgrid', jobId: 'job_123', api_key: 'abc123' },
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
    assert.strictEqual(response.body.email_events.length, 1);
    assert.strictEqual(response.body.summary.email_event_count, 1);
    assert.strictEqual(response.body.messages[0].provider_payload.provider, 'sendgrid');
    assert.strictEqual(response.body.executions[0].provider_payload.jobId, 'job_123');
    assert.strictEqual(response.body.messages[0].provider_payload.authorization, '[redacted]');
    assert.strictEqual(response.body.executions[0].provider_payload.api_key, '[redacted]');
    assert.strictEqual(response.body.email_events[0].raw_payload.token, '[redacted]');
  });

  it('returns a correlated provider payload detail for a message', async function () {
    db.getCaseById = async () => ({ id: 25169, case_name: 'QA Case' });
    db.getCaseEmailEvents = async () => ([
      {
        id: 700,
        message_id: 91,
        provider_message_id: 'sg-msg-1',
        event_type: 'processed',
        event_timestamp: '2026-03-08T10:05:00.000Z',
        raw_payload: { secret: 'should-hide', event: 'processed' },
      },
    ]);

    let callCount = 0;
    db.query = async (sql) => {
      callCount += 1;
      if (callCount === 1) {
        assert.match(sql, /FROM messages/);
        return {
          rows: [
            {
              id: 91,
              case_id: 25169,
              direction: 'outbound',
              subject: 'Subject',
              sendgrid_message_id: 'sg-msg-1',
              provider_payload: { provider: 'sendgrid', authorization: 'Bearer 123' },
            },
          ],
        };
      }

      assert.match(sql, /FROM executions/);
      return {
        rows: [
          {
            id: 101,
            case_id: 25169,
            proposal_id: 900,
            action_type: 'SEND_INITIAL_REQUEST',
            provider_message_id: 'sg-msg-1',
            provider_payload: { token: 'execution-secret', provider: 'sendgrid' },
          },
        ],
      };
    };

    const app = express();
    app.use('/api/requests', caseManagementRouter);

    const response = await supertest(app).get('/api/requests/25169/provider-payloads/messages/91');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.source, 'messages');
    assert.strictEqual(response.body.entry.provider_payload.authorization, '[redacted]');
    assert.strictEqual(response.body.related.executions.length, 1);
    assert.strictEqual(response.body.related.executions[0].provider_payload.token, '[redacted]');
    assert.strictEqual(response.body.related.email_events[0].raw_payload.secret, '[redacted]');
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

  it('returns a unified audit stream for a case', async function () {
    db.getCaseById = async () => ({ id: 25169, case_name: 'QA Case' });
    db.getPortalSubmissions = async () => ([
      {
        id: 44,
        status: 'failed',
        started_at: '2026-03-08T10:04:00.000Z',
      },
    ]);
    db.getCaseEmailEvents = async () => ([
      {
        id: 700,
        event_type: 'delivered',
        event_timestamp: '2026-03-08T10:05:00.000Z',
      },
    ]);

    let callCount = 0;
    db.query = async (sql) => {
      callCount += 1;
      if (callCount === 1) {
        assert.match(sql, /FROM case_event_ledger/);
        return {
          rows: [
            {
              id: 1,
              event: 'CASE_ESCALATED',
              created_at: '2026-03-08T10:00:00.000Z',
            },
          ],
        };
      }

      if (callCount === 2) {
        assert.match(sql, /FROM activity_log/);
        return {
          rows: [
            {
              id: 2,
              event_type: 'manual_override',
              description: 'Operator changed course',
              created_at: '2026-03-08T10:03:00.000Z',
            },
          ],
        };
      }

      assert.match(sql, /FROM error_events/);
      return {
        rows: [
          {
            id: 3,
            source_service: 'notion_service',
            operation: 'sync_status',
            error_message: 'Notion unavailable',
            created_at: '2026-03-08T10:04:30.000Z',
          },
        ],
      };
    };

    const app = express();
    app.use('/api/requests', caseManagementRouter);

    const response = await supertest(app).get('/api/requests/25169/audit-stream?limit=10');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.count, 5);
    assert.deepStrictEqual(
      response.body.entries.map((entry) => entry.source),
      ['email_events', 'error_events', 'portal_submissions', 'activity_log', 'case_event_ledger']
    );
    assert.strictEqual(response.body.summary.by_source.error_events, 1);
  });

  it('filters the audit stream by source', async function () {
    db.getCaseById = async () => ({ id: 25169, case_name: 'QA Case' });
    db.getPortalSubmissions = async () => ([{ id: 44, started_at: '2026-03-08T10:04:00.000Z' }]);
    db.getCaseEmailEvents = async () => ([{ id: 700, event_timestamp: '2026-03-08T10:05:00.000Z' }]);

    let callCount = 0;
    db.query = async () => {
      callCount += 1;
      if (callCount === 1) return { rows: [{ id: 1, created_at: '2026-03-08T10:00:00.000Z' }] };
      if (callCount === 2) return { rows: [{ id: 2, created_at: '2026-03-08T10:03:00.000Z' }] };
      return { rows: [{ id: 3, created_at: '2026-03-08T10:04:30.000Z' }] };
    };

    const app = express();
    app.use('/api/requests', caseManagementRouter);

    const response = await supertest(app).get('/api/requests/25169/audit-stream?source=email_events,error_events');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.deepStrictEqual(
      response.body.entries.map((entry) => entry.source),
      ['email_events', 'error_events']
    );
    assert.strictEqual(response.body.summary.total, 2);
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
