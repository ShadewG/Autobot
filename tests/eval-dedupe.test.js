const assert = require('assert');
const path = require('path');
const express = require('express');
const supertest = require('supertest');

describe('Eval backend dedupe', function () {
  function loadEvalRouter({ dbStub, triggerStub = { tasks: { trigger: async () => ({ id: 'run_test' }) } } }) {
    const routePath = path.resolve(__dirname, '../routes/eval.js');
    const dbPath = path.resolve(__dirname, '../services/database.js');
    const triggerSdkPath = require.resolve('@trigger.dev/sdk');

    const originals = {
      db: require.cache[dbPath],
      trigger: require.cache[triggerSdkPath],
      route: require.cache[routePath],
    };

    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
    require.cache[triggerSdkPath] = { id: triggerSdkPath, filename: triggerSdkPath, loaded: true, exports: triggerStub };
    delete require.cache[routePath];

    const router = require(routePath);

    return {
      router,
      restore() {
        if (originals.db) require.cache[dbPath] = originals.db;
        else delete require.cache[dbPath];
        if (originals.trigger) require.cache[triggerSdkPath] = originals.trigger;
        else delete require.cache[triggerSdkPath];
        delete require.cache[routePath];
        if (originals.route) require.cache[routePath] = originals.route;
      },
    };
  }

  it('uses a deduped eval-case scope for the cases list', async function () {
    let capturedSql = '';
    const dbStub = {
      query: async (sql) => {
        capturedSql = sql;
        return {
          rows: [
            {
              id: 12,
              proposal_id: 44,
              case_id: 25169,
              trigger_message_id: 9,
              expected_action: 'SEND_FOLLOWUP',
              notes: 'Auto-captured from monitor decision: APPROVE',
              created_at: '2026-03-06T12:00:00.000Z',
              simulated_subject: null,
              proposal_action: 'RESEARCH_AGENCY',
              case_name: 'Case 25169',
              agency_name: 'Porter County',
              last_run_id: 88,
              last_predicted_action: 'RESEARCH_AGENCY',
              last_action_correct: false,
              last_judge_score: 2,
              last_failure_category: 'WRONG_ROUTING',
              last_ran_at: '2026-03-06T12:05:00.000Z',
            },
          ],
        };
      },
    };
    const { router, restore } = loadEvalRouter({ dbStub });

    try {
      const app = express();
      app.use('/api/eval', router);

      const response = await supertest(app).get('/api/eval/cases');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(response.body.cases.length, 1);
      assert.match(capturedSql, /WITH ranked_eval_cases/i);
      assert.match(capturedSql, /ROW_NUMBER\(\) OVER/i);
      assert.match(capturedSql, /Auto-captured from monitor decision:%/i);
      assert.match(capturedSql, /FROM deduped_eval_cases ec/i);
    } finally {
      restore();
    }
  });

  it('uses the same deduped scope for summary metrics and failure breakdown', async function () {
    const sqlCalls = [];
    const dbStub = {
      query: async (sql) => {
        sqlCalls.push(sql);
        if (sql.includes('COUNT(DISTINCT ec.id)')) {
          return {
            rows: [
              {
                total_cases: 3,
                runs_last_7d: 5,
                avg_score_7d: '3.50',
                correct_7d: 2,
                total_7d: 5,
              },
            ],
          };
        }
        if (sql.includes('GROUP BY failure_category')) {
          return {
            rows: [{ failure_category: 'WRONG_ROUTING', count: 3 }],
          };
        }
        throw new Error(`Unexpected summary SQL: ${sql}`);
      },
    };
    const { router, restore } = loadEvalRouter({ dbStub });

    try {
      const app = express();
      app.use('/api/eval', router);

      const response = await supertest(app).get('/api/eval/summary');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(response.body.summary.total_cases, 3);
      assert.strictEqual(response.body.summary.runs_last_7d, 5);
      assert.strictEqual(response.body.summary.avg_score_7d, 3.5);
      assert.strictEqual(response.body.summary.pass_rate_7d, 0.4);
      assert.deepStrictEqual(response.body.failure_breakdown, [
        { failure_category: 'WRONG_ROUTING', count: 3 },
      ]);
      assert.strictEqual(sqlCalls.length, 2);
      assert.match(sqlCalls[0], /FROM deduped_eval_cases ec/i);
      assert.match(sqlCalls[1], /JOIN deduped_eval_cases ec/i);
    } finally {
      restore();
    }
  });
});
