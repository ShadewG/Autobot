const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const canonicalAgency = require('../services/canonical-agency');

describe('canonical agency backfill', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('syncPrimaryAgencyToCase also writes cases.agency_id', async function () {
    sinon.stub(db, 'getCaseById').resolves({
      id: 10,
      agency_id: null,
      portal_url: null,
      portal_provider: null,
    });
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [] });

    await db.syncPrimaryAgencyToCase(10, {
      agency_id: 6151,
      agency_name: "Broward County Sheriff's Office",
      agency_email: 'records@example.gov',
      portal_url: null,
      portal_provider: null,
    });

    sinon.assert.calledOnce(queryStub);
    const sql = queryStub.firstCall.args[0];
    const params = queryStub.firstCall.args[1];
    assert.match(sql, /agency_id = \$2/);
    assert.strictEqual(params[1], 6151);
  });

  it('dry-run backfill identifies canonical matches without mutating data', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({
      rows: [{
        id: 25150,
        state: 'MN',
        case_agency_id: null,
        case_agency_name: 'South St. Paul Police Department, Minnesota',
        case_agency_email: null,
        case_portal_url: null,
        primary_case_agency_id: 501,
        primary_agency_id: null,
        primary_agency_name: 'South St. Paul Police Department, Minnesota',
        primary_agency_email: null,
        primary_portal_url: null,
      }],
    });
    sinon.stub(canonicalAgency, 'findCanonicalAgency').resolves({
      id: 1015,
      name: 'South St. Paul Police Department, Minnesota',
    });
    const updateStub = sinon.stub(db, 'updateCaseAgency');
    const syncStub = sinon.stub(db, 'syncPrimaryAgencyToCase');

    const result = await db.backfillCanonicalAgencyIds({
      dryRun: true,
      caseIds: [25150],
      limit: 10,
    });

    assert.strictEqual(result.scanned, 1);
    assert.strictEqual(result.matched, 1);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.cases[0].matched_agency_id, 1015);
    sinon.assert.notCalled(updateStub);
    sinon.assert.notCalled(syncStub);
    sinon.assert.calledOnce(queryStub);
  });

  it('live backfill updates the primary case agency and syncs the case row', async function () {
    sinon.stub(db, 'query').resolves({
      rows: [{
        id: 25150,
        state: 'MN',
        case_agency_id: null,
        case_agency_name: 'South St. Paul Police Department, Minnesota',
        case_agency_email: 'records@example.gov',
        case_portal_url: 'https://portal.example.gov',
        primary_case_agency_id: 501,
        primary_agency_id: null,
        primary_agency_name: 'South St. Paul Police Department, Minnesota',
        primary_agency_email: 'records@example.gov',
        primary_portal_url: 'https://portal.example.gov',
      }],
    });
    sinon.stub(canonicalAgency, 'findCanonicalAgency').resolves({
      id: 1015,
      name: 'South St. Paul Police Department, Minnesota',
    });
    const updateStub = sinon.stub(db, 'updateCaseAgency').resolves({
      case_id: 25150,
      agency_id: 1015,
      agency_name: 'South St. Paul Police Department, Minnesota',
      agency_email: 'records@example.gov',
      portal_url: 'https://portal.example.gov',
      portal_provider: 'civicplus',
      is_primary: true,
    });
    const syncStub = sinon.stub(db, 'syncPrimaryAgencyToCase').resolves();

    const result = await db.backfillCanonicalAgencyIds({
      dryRun: false,
      caseIds: [25150],
      limit: 10,
    });

    assert.strictEqual(result.updated, 1);
    sinon.assert.calledOnceWithExactly(updateStub, 501, { agency_id: 1015 });
    sinon.assert.calledOnce(syncStub);
  });
});
