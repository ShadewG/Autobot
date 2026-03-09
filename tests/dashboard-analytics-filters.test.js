const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

function injectModule(modulePath, exportsValue, tracker) {
  const resolved = require.resolve(modulePath);
  tracker.push({ resolved, previous: require.cache[resolved] });
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

describe('dashboard analytics filters', function () {
  let injected = [];

  afterEach(function () {
    const routerPath = require.resolve('../routes/api');
    const dashboardServicePath = require.resolve('../services/dashboard-service');
    delete require.cache[routerPath];
    delete require.cache[dashboardServicePath];

    for (const { resolved, previous } of injected.reverse()) {
      if (previous) {
        require.cache[resolved] = previous;
      } else {
        delete require.cache[resolved];
      }
    }
    injected = [];
  });

  it('filters test cases out of /dashboard/outcomes analytics queries', async function () {
    const seenSql = [];
    injectModule('../services/database', {
      query: async (sql) => {
        seenSql.push(sql);
        if (sql.includes('FROM cases') && sql.includes('completion_rate')) {
          return { rows: [{ total_cases: '10', completed: '5', active: '3', awaiting_response: '2', completion_rate: '50.0', avg_response_days: '4.0', avg_case_duration_days: '8.0' }] };
        }
        if (sql.includes('FROM cases c') && sql.includes('GROUP BY c.state')) {
          return { rows: [] };
        }
        if (sql.includes('FROM response_analysis ra')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT status, COUNT(*) as count')) {
          return { rows: [] };
        }
        throw new Error(`Unexpected analytics SQL: ${sql}`);
      },
      getCasesByStatus: async () => ([]),
    }, injected);
    injectModule('../services/notion-service', {}, injected);
    injectModule('../services/portal-service-test-only', {}, injected);
    injectModule('../services/dashboard-service', {}, injected);
    injectModule('../queues/email-queue', { generateQueue: {}, emailQueue: {} }, injected);

    const router = require('../routes/api');
    const app = express();
    app.use('/api', router);

    const response = await supertest(app).get('/api/dashboard/outcomes');
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.ok(seenSql.every((sql) => sql.includes("notion_page_id LIKE 'test-%'") || sql.includes("FROM response_analysis ra")));
    assert.ok(seenSql.some((sql) => sql.includes('shadewofficial')));
    assert.ok(seenSql.some((sql) => sql.includes('@matcher.com')));
  });

  it('filters test cases out of hourly activity and message volume service queries', async function () {
    const originalDb = require('../services/database');
    const dashboardServicePath = require.resolve('../services/dashboard-service');
    delete require.cache[dashboardServicePath];
    const seenSql = [];
    const originalQuery = originalDb.query;
    originalDb.query = async (sql) => {
      seenSql.push(sql);
      if (sql.includes('FROM activity_log')) {
        return { rows: [] };
      }
      if (sql.includes('WITH days AS')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected dashboard service SQL: ${sql}`);
    };

    try {
      const dashboardService = require('../services/dashboard-service');
      await dashboardService.getHourlyActivity();
      await dashboardService.getMessageVolumeByDay();
      assert.ok(seenSql.some((sql) => sql.includes("notion_page_id LIKE 'test-%'")));
      assert.ok(seenSql.some((sql) => sql.includes('shadewofficial')));
      assert.ok(seenSql.some((sql) => sql.includes('@matcher.com')));
    } finally {
      originalDb.query = originalQuery;
      delete require.cache[dashboardServicePath];
    }
  });
});
