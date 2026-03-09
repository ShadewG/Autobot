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

  it('serves department analytics through the API route', async function () {
    injectModule('../services/database', {
      query: async () => ({ rows: [] }),
      getCasesByStatus: async () => ([]),
    }, injected);
    injectModule('../services/notion-service', {}, injected);
    injectModule('../services/portal-service-test-only', {}, injected);
    injectModule('../services/dashboard-service', {
      getDepartmentAnalytics: async ({ limit, minCases, minReviews }) => ({
        departments_considered: 2,
        cases_considered: 9,
        sample_thresholds: {
          min_cases: minCases,
          min_reviews: minReviews,
        },
        leaderboards: {
          response_rate: [{ agency_name: 'Perry Police Department, Georgia', total_cases: 5, response_rate: 80 }],
          avg_response_time: [],
          completion_rate: [],
          approval_rate: [],
          denial_rate: [],
          overdue_rate: [],
        },
        departments: [],
        received_limit: limit,
      }),
    }, injected);
    injectModule('../queues/email-queue', { generateQueue: {}, emailQueue: {} }, injected);

    const router = require('../routes/api');
    const app = express();
    app.use('/api', router);

    const response = await supertest(app)
      .get('/api/dashboard/departments?limit=7&minCases=4&minReviews=2');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.departments_considered, 2);
    assert.strictEqual(response.body.sample_thresholds.min_cases, 4);
    assert.strictEqual(response.body.sample_thresholds.min_reviews, 2);
    assert.strictEqual(response.body.leaderboards.response_rate[0].agency_name, 'Perry Police Department, Georgia');
  });

  it('aggregates department leaderboards using real-case filtering and metadata agency fallback', async function () {
    const originalDb = require('../services/database');
    const dashboardServicePath = require.resolve('../services/dashboard-service');
    delete require.cache[dashboardServicePath];
    const seenSql = [];
    const originalQuery = originalDb.query;
    originalDb.query = async (sql) => {
      seenSql.push(sql);
      return {
        rows: [
          {
            id: 1,
            case_agency_name: 'Police Department',
            case_state: 'GA',
            status: 'completed',
            send_date: '2026-01-01T00:00:00.000Z',
            last_response_date: '2026-01-03T00:00:00.000Z',
            deadline_date: '2026-01-15T00:00:00.000Z',
            additional_details: 'Police Department: Perry Police Department, Georgia',
            primary_agency_name: null,
            primary_send_date: null,
            primary_last_response_date: null,
            has_denial: false,
            total_reviews: 1,
            approve_count: 1,
          },
          {
            id: 2,
            case_agency_name: 'Perry Police Department, Georgia',
            case_state: 'GA',
            status: 'sent',
            send_date: '2026-01-01T00:00:00.000Z',
            last_response_date: null,
            deadline_date: '2026-01-02T00:00:00.000Z',
            additional_details: null,
            primary_agency_name: null,
            primary_send_date: null,
            primary_last_response_date: null,
            has_denial: false,
            total_reviews: 1,
            approve_count: 0,
          },
          {
            id: 3,
            case_agency_name: 'Police Department',
            case_state: 'GA',
            status: 'completed',
            send_date: '2026-01-01T00:00:00.000Z',
            last_response_date: '2026-01-02T00:00:00.000Z',
            deadline_date: '2026-01-10T00:00:00.000Z',
            additional_details: 'Police Department: Gwinnett County Police Department, Georgia',
            primary_agency_name: null,
            primary_send_date: null,
            primary_last_response_date: null,
            has_denial: false,
            total_reviews: 2,
            approve_count: 2,
          },
          {
            id: 4,
            case_agency_name: 'Police Department',
            case_state: 'GA',
            status: 'completed',
            send_date: '2026-01-05T00:00:00.000Z',
            last_response_date: '2026-01-06T00:00:00.000Z',
            deadline_date: '2026-01-20T00:00:00.000Z',
            additional_details: 'Police Department: Gwinnett County Police Department, Georgia',
            primary_agency_name: null,
            primary_send_date: null,
            primary_last_response_date: null,
            has_denial: false,
            total_reviews: 1,
            approve_count: 1,
          },
          {
            id: 5,
            case_agency_name: 'Marion County Sheriff’s Office',
            case_state: 'FL',
            status: 'denied',
            send_date: '2026-01-01T00:00:00.000Z',
            last_response_date: '2026-01-04T00:00:00.000Z',
            deadline_date: '2026-01-10T00:00:00.000Z',
            additional_details: null,
            primary_agency_name: null,
            primary_send_date: null,
            primary_last_response_date: null,
            has_denial: true,
            total_reviews: 0,
            approve_count: 0,
          },
          {
            id: 6,
            case_agency_name: 'Marion County Sheriff’s Office',
            case_state: 'FL',
            status: 'completed',
            send_date: '2026-01-01T00:00:00.000Z',
            last_response_date: '2026-01-03T00:00:00.000Z',
            deadline_date: '2026-01-10T00:00:00.000Z',
            additional_details: null,
            primary_agency_name: null,
            primary_send_date: null,
            primary_last_response_date: null,
            has_denial: false,
            total_reviews: 0,
            approve_count: 0,
          },
        ],
      };
    };

    try {
      const dashboardService = require('../services/dashboard-service');
      const analytics = await dashboardService.getDepartmentAnalytics({ limit: 3, minCases: 2, minReviews: 1 });

      assert.ok(seenSql[0].includes("notion_page_id LIKE 'test-%'"));
      assert.ok(seenSql[0].includes('shadewofficial'));
      assert.ok(seenSql[0].includes('@matcher.com'));
      assert.ok(seenSql[0].includes('FROM case_agencies ca'));

      assert.strictEqual(analytics.departments_considered, 3);
      assert.strictEqual(analytics.leaderboards.response_rate[0].agency_name, 'Gwinnett County Police Department, Georgia');
      assert.strictEqual(analytics.leaderboards.response_rate[0].response_rate, 100);
      assert.strictEqual(analytics.leaderboards.avg_response_time[0].agency_name, 'Gwinnett County Police Department, Georgia');
      assert.strictEqual(analytics.leaderboards.avg_response_time[0].avg_response_days, 1);
      assert.strictEqual(analytics.leaderboards.approval_rate[0].agency_name, 'Gwinnett County Police Department, Georgia');
      assert.strictEqual(analytics.leaderboards.approval_rate[0].approval_rate, 100);
      assert.strictEqual(analytics.leaderboards.denial_rate[0].agency_name, 'Marion County Sheriff’s Office');
      assert.strictEqual(analytics.leaderboards.denial_rate[0].denial_rate, 50);
      assert.strictEqual(analytics.leaderboards.overdue_rate[0].agency_name, 'Perry Police Department, Georgia');
      assert.strictEqual(analytics.leaderboards.overdue_rate[0].overdue_rate, 100);
    } finally {
      originalDb.query = originalQuery;
      delete require.cache[dashboardServicePath];
    }
  });
});
