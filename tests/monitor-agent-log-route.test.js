const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

const router = require('../routes/monitor/agent');
const db = require('../services/database');

describe('Global agent log monitor route', function () {
  let originalQuery;

  beforeEach(function () {
    originalQuery = db.query;
  });

  afterEach(function () {
    db.query = originalQuery;
  });

  it('returns a normalized global agent log stream', async function () {
    let callCount = 0;
    db.query = async (sql) => {
      callCount += 1;
      if (callCount === 1) {
        assert.match(sql, /FROM case_event_ledger/);
        return { rows: [{ id: 1, case_id: 101, event: 'CASE_UPDATED', transition_key: '101:event:1', context: { run_id: 9 }, created_at: '2026-03-10T10:00:00.000Z' }] };
      }
      if (callCount === 2) {
        assert.match(sql, /FROM activity_log/);
        return {
          rows: [
            { id: 2, case_id: 101, event_type: 'agent_run_step', description: 'Run step: decide_action', metadata: { run_id: 9, step: 'decide_action' }, created_at: '2026-03-10T10:01:00.000Z' },
            { id: 22, case_id: 101, event_type: 'external_call_completed', description: 'Completed notion fetch_page_by_id', metadata: { provider: 'notion', operation: 'fetch_page_by_id' }, created_at: '2026-03-10T10:01:30.000Z' },
          ],
        };
      }
      if (callCount === 3) {
        assert.match(sql, /FROM portal_submissions/);
        return { rows: [{ id: 3, case_id: 102, status: 'failed', portal_url: 'https://portal.example.gov', started_at: '2026-03-10T10:02:00.000Z' }] };
      }
      if (callCount === 4) {
        assert.match(sql, /FROM email_events/);
        return { rows: [{ id: 4, case_id: 103, event_type: 'delivered', provider_message_id: 'sg-1', event_timestamp: '2026-03-10T10:03:00.000Z', raw_payload: { token: 'secret' } }] };
      }
      if (callCount === 5) {
        assert.match(sql, /FROM error_events/);
        return { rows: [{ id: 5, case_id: 104, source_service: 'trigger.dev', error_message: 'boom', error_code: 'E_BROKEN', created_at: '2026-03-10T10:04:00.000Z' }] };
      }
      assert.match(sql, /FROM decision_traces/);
      return {
        rows: [{
          id: 6,
          case_id: 105,
          run_id: 77,
          classification: { intent: 'question' },
          router_output: { action_type: 'SEND_CLARIFICATION' },
          node_trace: { taskType: 'process-inbound', status: 'completed' },
          gate_decision: { pause_reason: 'PENDING_APPROVAL' },
          started_at: '2026-03-10T10:05:00.000Z',
          completed_at: '2026-03-10T10:06:00.000Z',
          created_at: '2026-03-10T10:06:00.000Z',
        }],
      };
    };

    const app = express();
    app.use('/api/monitor', router);

    const response = await supertest(app).get('/api/monitor/agent-log?limit=10');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.count, 7);
    assert.deepStrictEqual(
      response.body.entries.map((entry) => entry.kind),
      ['decision', 'error', 'provider_event', 'portal', 'external_call', 'agent_step', 'state_transition']
    );
    assert.strictEqual(response.body.entries[2].payload.raw_payload.token, '[redacted]');
    assert.strictEqual(response.body.summary.by_kind.decision, 1);
    assert.strictEqual(response.body.summary.by_kind.external_call, 1);
  });

  it('filters the global agent log by case and kind', async function () {
    let callCount = 0;
    db.query = async (sql, params) => {
      callCount += 1;
      assert.strictEqual(params[0], 25169);
      if (callCount === 1) return { rows: [{ id: 1, case_id: 25169, event: 'CASE_UPDATED', created_at: '2026-03-10T10:00:00.000Z' }] };
      if (callCount === 2) return { rows: [
        { id: 2, case_id: 25169, event_type: 'agent_run_step', metadata: { step: 'draft_response' }, created_at: '2026-03-10T10:01:00.000Z' },
        { id: 22, case_id: 25169, event_type: 'external_call_completed', metadata: { provider: 'openai' }, created_at: '2026-03-10T10:01:30.000Z' },
      ] };
      if (callCount === 3) return { rows: [] };
      if (callCount === 4) return { rows: [{ id: 4, case_id: 25169, event_type: 'delivered', event_timestamp: '2026-03-10T10:03:00.000Z' }] };
      if (callCount === 5) return { rows: [{ id: 5, case_id: 25169, source_service: 'trigger.dev', error_message: 'boom', created_at: '2026-03-10T10:04:00.000Z' }] };
      return { rows: [] };
    };

    const app = express();
    app.use('/api/monitor', router);

    const response = await supertest(app).get('/api/monitor/agent-log?case_id=25169&kind=error,provider_event,external_call');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.filters.case_id, 25169);
    assert.deepStrictEqual(response.body.entries.map((entry) => entry.kind), ['error', 'provider_event', 'external_call']);
    assert.strictEqual(response.body.summary.total, 3);
  });
});
