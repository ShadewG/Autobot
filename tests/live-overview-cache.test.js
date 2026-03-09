const assert = require('assert');
const path = require('path');
const express = require('express');
const supertest = require('supertest');
const sinon = require('sinon');

describe('Live overview cache fallback', function () {
  function loadOverviewRouter(dbStub) {
    const routePath = path.resolve(__dirname, '../routes/monitor/overview.js');
    const helpersPath = path.resolve(__dirname, '../routes/monitor/_helpers.js');
    const caseTruthPath = path.resolve(__dirname, '../lib/case-truth.js');
    const normalizationPath = path.resolve(__dirname, '../utils/request-normalization.js');

    const originals = {
      route: require.cache[routePath],
      helpers: require.cache[helpersPath],
      caseTruth: require.cache[caseTruthPath],
      normalization: require.cache[normalizationPath],
    };

    require.cache[helpersPath] = {
      id: helpersPath,
      filename: helpersPath,
      loaded: true,
      exports: {
        db: dbStub,
        normalizeProposalReasoning: (row) => row.reasoning || null,
        extractAttachmentInsights: () => [],
      },
    };
    require.cache[caseTruthPath] = {
      id: caseTruthPath,
      filename: caseTruthPath,
      loaded: true,
      exports: {
        HUMAN_REVIEW_PROPOSAL_STATUSES_SQL: "'PENDING_APPROVAL','BLOCKED','DECISION_RECEIVED','PENDING_PORTAL'",
        buildCaseTruth: () => ({ review_state: 'needs_review' }),
      },
    };
    require.cache[normalizationPath] = {
      id: normalizationPath,
      filename: normalizationPath,
      loaded: true,
      exports: {
        evaluateImportAutoDispatchSafety: () => ({ shouldBlockAutoDispatch: false }),
        extractResearchSuggestedAgency: () => null,
        normalizePortalTimeoutSubstatus: (value) => value,
        shouldSuppressPlaceholderAgencyDisplay: () => false,
      },
    };
    delete require.cache[routePath];

    const router = require(routePath);

    return {
      router,
      restore() {
        if (originals.route) require.cache[routePath] = originals.route;
        else delete require.cache[routePath];
        if (originals.helpers) require.cache[helpersPath] = originals.helpers;
        else delete require.cache[helpersPath];
        if (originals.caseTruth) require.cache[caseTruthPath] = originals.caseTruth;
        else delete require.cache[caseTruthPath];
        if (originals.normalization) require.cache[normalizationPath] = originals.normalization;
        else delete require.cache[normalizationPath];
      },
    };
  }

  it('serves cached overview data when a refresh query fails', async function () {
    const queryStub = sinon.stub();
    queryStub.onCall(0).resolves({ rows: [{ inbound_24h: '1', unmatched_inbound_total: '0', unprocessed_inbound_total: '0' }] });
    queryStub.onCall(1).resolves({ rows: [{ portal_hard_timeout_total_1h: 0, portal_soft_timeout_total_1h: 0 }] });
    queryStub.onCall(2).resolves({ rows: [{ process_inbound_superseded_total_1h: 0 }] });
    queryStub.onCall(3).resolves({ rows: [] });
    queryStub.onCall(4).resolves({ rows: [] });
    queryStub.onCall(5).resolves({ rows: [] });
    queryStub.onCall(6).resolves({ rows: [] });
    queryStub.onCall(7).resolves({ rows: [] });
    queryStub.onCall(8).resolves({ rows: [] });

    const dbStub = {
      query: queryStub,
      getUserById: async () => null,
    };

    const { router, restore } = loadOverviewRouter(dbStub);
    let now = 1_000;
    const clock = sinon.stub(Date, 'now').callsFake(() => now);

    try {
      const app = express();
      app.use('/api/monitor', router);

      const first = await supertest(app).get('/api/monitor/live-overview');
      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.body.success, true);
      assert.strictEqual(first.body.summary.inbound_24h, 1);
      assert.strictEqual(queryStub.callCount, 9);

      queryStub.resetHistory();
      queryStub.resetBehavior();
      queryStub.rejects(new Error('Connection terminated due to connection timeout'));
      now = 20_000;

      const second = await supertest(app).get('/api/monitor/live-overview');
      assert.strictEqual(second.status, 200);
      assert.strictEqual(second.body.success, true);
      assert.strictEqual(second.body.cache_state, 'stale');
      assert.match(second.body.warning, /Serving cached live overview/i);
      assert.strictEqual(second.body.summary.inbound_24h, 1);
      assert.ok(queryStub.called);
    } finally {
      clock.restore();
      restore();
    }
  });
});
