const assert = require('assert');
const path = require('path');
const sinon = require('sinon');
const express = require('express');
const supertest = require('supertest');

const db = require('../services/database');

describe('Case agency and run guards', function () {
  describe('getActiveRunForCase', function () {
    let originalQuery;

    beforeEach(function () {
      originalQuery = db.query;
    });

    afterEach(function () {
      db.query = originalQuery;
    });

    it('treats processing runs as active', async function () {
      let capturedSql = '';
      db.query = async (sql, params) => {
        capturedSql = sql;
        assert.deepStrictEqual(params, [123]);
        return { rows: [{ id: 7, status: 'processing' }] };
      };

      const activeRun = await db.getActiveRunForCase(123);

      assert(activeRun, 'expected an active run to be returned');
      assert.strictEqual(activeRun.status, 'processing');
      assert.match(capturedSql, /'processing'/);
    });
  });

  describe('addCaseAgency dedup primary handling', function () {
    it('switches the matched row to primary when a duplicate insert requests primary', async function () {
      const existingRow = {
        id: 88,
        case_id: 55,
        agency_id: 9,
        agency_name: 'Test Police Department',
        agency_email: null,
        portal_url: null,
        portal_provider: null,
        notes: null,
        is_primary: false,
      };
      const refreshedRow = {
        ...existingRow,
        agency_email: 'records@testpd.gov',
      };
      const switchedRow = {
        ...refreshedRow,
        is_primary: true,
      };

      const fakeDb = {
        query: sinon.stub(),
        switchPrimaryAgency: sinon.stub().resolves(switchedRow),
        syncPrimaryAgencyToCase: sinon.stub().resolves(),
      };

      fakeDb.query.onCall(0).resolves({ rows: [existingRow] });
      fakeDb.query.onCall(1).resolves({ rows: [] });
      fakeDb.query.onCall(2).resolves({ rows: [refreshedRow] });

      const result = await db.addCaseAgency.call(fakeDb, 55, {
        agency_id: 9,
        agency_name: 'Test Police Department',
        agency_email: 'records@testpd.gov',
        is_primary: true,
      });

      sinon.assert.calledOnce(fakeDb.switchPrimaryAgency);
      sinon.assert.calledWithExactly(fakeDb.switchPrimaryAgency, 55, 88);
      sinon.assert.notCalled(fakeDb.syncPrimaryAgencyToCase);
      assert.deepStrictEqual(result, switchedRow);
    });
  });

  describe('case agency research fallback', function () {
    function loadCaseAgenciesRouter({ dbStub, notionStub, pdContactStub }) {
      const routePath = path.resolve(__dirname, '../routes/case-agencies.js');
      const dbPath = path.resolve(__dirname, '../services/database.js');
      const notionPath = path.resolve(__dirname, '../services/notion-service.js');
      const pdPath = path.resolve(__dirname, '../services/pd-contact-service.js');

      const originals = {
        db: require.cache[dbPath],
        notion: require.cache[notionPath],
        pd: require.cache[pdPath],
        route: require.cache[routePath],
      };

      require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
      require.cache[notionPath] = { id: notionPath, filename: notionPath, loaded: true, exports: notionStub };
      require.cache[pdPath] = { id: pdPath, filename: pdPath, loaded: true, exports: pdContactStub };
      delete require.cache[routePath];

      const router = require(routePath);

      return {
        router,
        restore() {
          if (originals.db) require.cache[dbPath] = originals.db;
          else delete require.cache[dbPath];
          if (originals.notion) require.cache[notionPath] = originals.notion;
          else delete require.cache[notionPath];
          if (originals.pd) require.cache[pdPath] = originals.pd;
          else delete require.cache[pdPath];
          delete require.cache[routePath];
          if (originals.route) require.cache[routePath] = originals.route;
        },
      };
    }

    it('reuses existing case-agency signals when lookup returns no data', async function () {
      const dbStub = {
        getCaseById: sinon.stub().resolves({
          id: 25169,
          state: 'IN',
          agency_email: null,
          alternate_agency_email: null,
          portal_url: null,
          portal_provider: null,
        }),
        getCaseAgencyById: sinon.stub().resolves({
          id: 24,
          case_id: 25169,
          agency_name: 'Porter County Central Communications',
          agency_email: '911audio@portercountyin.gov',
          portal_url: null,
          portal_provider: null,
          is_primary: false,
          status: 'pending',
        }),
        updateCaseAgency: sinon.stub().callsFake(async (id, updates) => ({
          id,
          case_id: 25169,
          agency_name: 'Porter County Central Communications',
          is_primary: false,
          ...updates,
        })),
        logActivity: sinon.stub().resolves(),
      };
      const pdContactStub = {
        lookupContact: sinon.stub().resolves(null),
      };
      const { router, restore } = loadCaseAgenciesRouter({
        dbStub,
        notionStub: {},
        pdContactStub,
      });

      try {
        const app = express();
        app.use('/api/cases', router);

        const response = await supertest(app)
          .post('/api/cases/25169/agencies/24/research')
          .send({});

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.success, true);
        assert.strictEqual(response.body.research.source, 'existing-case-data');
        assert.strictEqual(response.body.research.contact_email, '911audio@portercountyin.gov');
        sinon.assert.calledOnce(pdContactStub.lookupContact);
        sinon.assert.calledWithExactly(
          dbStub.updateCaseAgency,
          24,
          sinon.match({
            agency_email: '911audio@portercountyin.gov',
            status: 'pending',
            contact_research_notes: sinon.match.string,
          })
        );
        sinon.assert.calledWithExactly(
          dbStub.logActivity,
          'case_agency_research_reused_existing',
          sinon.match.string,
          sinon.match({
            case_id: 25169,
            case_agency_id: 24,
            fallback_reason: 'lookup_returned_no_data',
            reused_email: '911audio@portercountyin.gov',
          })
        );
      } finally {
        restore();
      }
    });

    it('returns 504 when lookup times out and no existing signals are available', async function () {
      const dbStub = {
        getCaseById: sinon.stub().resolves({
          id: 88,
          state: 'TX',
          agency_email: null,
          alternate_agency_email: null,
          portal_url: null,
          portal_provider: null,
        }),
        getCaseAgencyById: sinon.stub().resolves({
          id: 9,
          case_id: 88,
          agency_name: 'Unknown Agency',
          agency_email: null,
          portal_url: null,
          portal_provider: null,
          is_primary: false,
          status: 'pending',
        }),
        updateCaseAgency: sinon.stub().resolves(null),
        logActivity: sinon.stub().resolves(),
      };
      const pdContactStub = {
        lookupContact: sinon.stub().rejects(new Error('Research lookup timed out after 30s')),
      };
      const { router, restore } = loadCaseAgenciesRouter({
        dbStub,
        notionStub: {},
        pdContactStub,
      });

      try {
        const app = express();
        app.use('/api/cases', router);

        const response = await supertest(app)
          .post('/api/cases/88/agencies/9/research')
          .send({});

        assert.strictEqual(response.status, 504);
        assert.strictEqual(response.body.success, false);
        assert.match(response.body.error, /timed out/i);
        sinon.assert.notCalled(dbStub.updateCaseAgency);
      } finally {
        restore();
      }
    });
  });
});
