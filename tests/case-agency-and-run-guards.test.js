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
        updateCaseAgency: sinon.stub().callsFake(async (id, updates) => ({
          ...refreshedRow,
          id,
          ...updates,
        })),
        switchPrimaryAgency: sinon.stub().resolves(switchedRow),
        syncPrimaryAgencyToCase: sinon.stub().resolves(),
        mergeCaseAgencyCluster: db.mergeCaseAgencyCluster,
      };

      fakeDb.query.onCall(0).resolves({ rows: [existingRow] });

      const result = await db.addCaseAgency.call(fakeDb, 55, {
        agency_id: 9,
        agency_name: 'Test Police Department',
        agency_email: 'records@testpd.gov',
        is_primary: true,
      });

      sinon.assert.calledOnce(fakeDb.switchPrimaryAgency);
      sinon.assert.calledWithExactly(fakeDb.switchPrimaryAgency, 55, 88);
      sinon.assert.notCalled(fakeDb.syncPrimaryAgencyToCase);
      sinon.assert.calledOnce(fakeDb.updateCaseAgency);
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
        query: sinon.stub().resolves({ rows: [] }),
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
        assert.strictEqual(response.body.research.fallback_reason, 'existing_channels_available');
        assert.strictEqual(response.body.research.immediate_reuse, true);
        sinon.assert.notCalled(pdContactStub.lookupContact);
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
            fallback_reason: 'existing_channels_available',
            reused_email: '911audio@portercountyin.gov',
            immediate_reuse: true,
          })
        );
      } finally {
        restore();
      }
    });

    it('returns 504 when lookup times out and no existing signals are available', async function () {
      const dbStub = {
        query: sinon.stub().resolves({ rows: [] }),
        getCaseById: sinon.stub().resolves({
          id: 88,
          state: 'TX',
          agency_email: null,
          alternate_agency_email: null,
          portal_url: null,
          portal_provider: null,
          additional_details: null,
          contact_research_notes: null,
        }),
        getCaseAgencyById: sinon.stub().resolves({
          id: 9,
          case_id: 88,
          agency_name: 'Austin Police Department',
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

    it('does not reuse placeholder channels for unresolved unknown agencies', async function () {
      const dbStub = {
        query: sinon.stub().resolves({ rows: [] }),
        getCaseById: sinon.stub().resolves({
          id: 25243,
          state: 'GA',
          agency_email: null,
          alternate_agency_email: null,
          portal_url: null,
          portal_provider: null,
          additional_details: null,
          contact_research_notes: JSON.stringify({ cleared: true }),
        }),
        getCaseAgencyById: sinon.stub().resolves({
          id: 65,
          case_id: 25243,
          agency_id: 152,
          agency_name: 'Stow Police Department',
          agency_email: 'pending-research@placeholder.invalid',
          portal_url: null,
          portal_provider: null,
          is_primary: true,
          added_source: 'case_row_backfill',
          status: 'active',
        }),
        updateCaseAgency: sinon.stub().resolves(null),
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
          .post('/api/cases/25243/agencies/65/research')
          .send({});

        assert.strictEqual(response.status, 422);
        assert.strictEqual(response.body.success, false);
        assert.match(response.body.error, /real agency target/i);
        sinon.assert.notCalled(pdContactStub.lookupContact);
        sinon.assert.notCalled(dbStub.updateCaseAgency);
      } finally {
        restore();
      }
    });

    it('canonicalizes stale case_agency rows on read using strong email signals', async function () {
      const dbStub = {
        getCaseById: sinon.stub().resolves({
          id: 25207,
          state: '{}',
          agency_email: null,
          alternate_agency_email: null,
          portal_url: null,
          portal_provider: null,
        }),
        getCaseAgencies: sinon.stub().resolves([
          {
            id: 61,
            case_id: 25207,
            agency_id: 152,
            agency_name: 'Stow Police Department',
            agency_email: 'ORR@mylubbock.us',
            portal_url: 'https://u8387778.ct.sendgrid.net/ls/click?abc',
            portal_provider: 'govqa',
            is_primary: true,
            is_active: true,
            added_source: 'case_row_backfill',
            status: 'active',
          },
          {
            id: 62,
            case_id: 25207,
            agency_id: 152,
            agency_name: 'Stow Police Department',
            agency_email: 'ORR@mylubbock.us',
            portal_url: 'https://u8387778.ct.sendgrid.net/ls/click?def',
            portal_provider: 'govqa',
            is_primary: false,
            is_active: true,
            added_source: 'case_row_backfill',
            status: 'active',
          },
        ]),
        query: sinon.stub().resolves({
          rows: [{
            id: 1365,
            name: 'Lubbock Police Department, Texas',
            state: 'TX',
            email_main: null,
            email_foia: 'orr@mylubbock.us',
            portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
            portal_url_alt: null,
            portal_provider: 'govqa',
            score: 15,
            completeness: 3,
          }],
        }),
      };
      const { router, restore } = loadCaseAgenciesRouter({
        dbStub,
        notionStub: {},
        pdContactStub: {},
      });

      try {
        const app = express();
        app.use('/api/cases', router);

        const response = await supertest(app)
          .get('/api/cases/25207/agencies');

        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.body.success, true);
        assert(Array.isArray(response.body.agencies), 'expected agencies array');
        assert.strictEqual(response.body.agencies.length, 1);
        assert.strictEqual(response.body.agencies[0].agency_name, 'Lubbock Police Department, Texas');
        assert.strictEqual(response.body.agencies[0].agency_id, 1365);
        assert.strictEqual(response.body.agencies[0].agency_email, 'orr@mylubbock.us');
        assert.strictEqual(response.body.agencies[0].portal_url, 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx');
      } finally {
        restore();
      }
    });
  });
});
