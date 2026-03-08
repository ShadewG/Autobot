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

describe('Adaptive learning retirement regressions', function () {
  let injected = [];

  function loadRouter() {
    injectModule('../services/database', {
      query: async () => {
        throw new Error('db.query should not be called for retired adaptive-learning endpoints');
      },
      getCasesByStatus: async () => ([]),
    }, injected);
    injectModule('../services/notion-service', {
      syncCasesFromNotion: async () => [],
      processSinglePage: async () => ({ id: 1, case_name: 'Case', agency_name: 'Agency', status: 'ready_to_send' }),
    }, injected);
    injectModule('../services/portal-service', {}, injected);
    injectModule('../services/dashboard-service', {}, injected);
    injectModule('../queues/email-queue', {
      generateQueue: { add: async () => ({}) },
      emailQueue: {},
    }, injected);

    const routerPath = require.resolve('../routes/api');
    delete require.cache[routerPath];
    return require('../routes/api');
  }

  afterEach(function () {
    const routerPath = require.resolve('../routes/api');
    delete require.cache[routerPath];

    for (const { resolved, previous } of injected.reverse()) {
      if (previous) {
        require.cache[resolved] = previous;
      } else {
        delete require.cache[resolved];
      }
    }
    injected = [];
  });

  it('returns a deprecated empty insights response without touching the retired service', async function () {
    const router = loadRouter();
    const app = express();
    app.use('/api', router);

    const response = await supertest(app).get('/api/insights/Synthetic%20PD?state=TX');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.deprecated, true);
    assert.strictEqual(response.body.agency, 'Synthetic PD');
    assert.strictEqual(response.body.state, 'TX');
    assert.deepStrictEqual(response.body.insights, []);
    assert.match(response.body.message, /retired/i);
  });

  it('returns safe zeroed strategy performance for the retired adaptive-learning dashboard', async function () {
    const router = loadRouter();
    const app = express();
    app.use('/api', router);

    const response = await supertest(app).get('/api/strategy-performance');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.deprecated, true);
    assert.deepStrictEqual(response.body.stats, {
      total_cases: 0,
      approvals: 0,
      denials: 0,
      completion_rate: 0,
    });
    assert.deepStrictEqual(response.body.topStrategies, []);
  });
});
