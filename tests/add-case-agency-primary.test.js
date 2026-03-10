const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');

describe('addCaseAgency primary handling', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('seeds the existing case-row agency as primary before adding a different first agency', async function () {
    const queryStub = sinon.stub(db, 'query');
    sinon.stub(db, 'getCaseById').resolves({
      id: 77,
      agency_id: null,
      agency_name: 'Original Case Agency',
      agency_email: 'primary@example.com',
      portal_url: null,
      portal_provider: null,
    });
    sinon.stub(db, 'syncPrimaryAgencyToCase').resolves();

    queryStub.onCall(0).resolves({ rows: [] });
    queryStub.onCall(1).resolves({ rows: [] });
    queryStub.onCall(2).resolves({
      rows: [{
        id: 201,
        case_id: 77,
        agency_name: 'Added Agency',
        agency_email: 'added@example.com',
        is_primary: false,
      }],
    });

    const added = await db.addCaseAgency(77, {
      agency_name: 'Added Agency',
      agency_email: 'added@example.com',
      added_source: 'manual',
    });

    assert.strictEqual(added.id, 201);
    assert.strictEqual(added.is_primary, false);
    const seedCall = queryStub.getCall(1);
    assert.ok(seedCall, 'expected case-row backfill insert');
    assert.match(seedCall.args[0], /case_row_backfill/);
    assert.strictEqual(seedCall.args[1][2], 'Original Case Agency');
    assert.strictEqual(seedCall.args[1][3], 'primary@example.com');
  });

  it('switches primary agency when explicitly requested on insert', async function () {
    const queryStub = sinon.stub(db, 'query');
    sinon.stub(db, 'getCaseById').resolves({
      id: 88,
      agency_id: null,
      agency_name: null,
      agency_email: null,
      portal_url: null,
      portal_provider: null,
    });
    sinon.stub(db, 'switchPrimaryAgency').resolves({
      id: 301,
      case_id: 88,
      agency_name: 'Promoted Agency',
      is_primary: true,
    });
    sinon.stub(db, 'syncPrimaryAgencyToCase').resolves();

    queryStub.onCall(0).resolves({ rows: [] });
    queryStub.onCall(1).resolves({
      rows: [{
        id: 301,
        case_id: 88,
        agency_name: 'Promoted Agency',
        agency_email: 'promoted@example.com',
        is_primary: true,
      }],
    });

    const added = await db.addCaseAgency(88, {
      agency_name: 'Promoted Agency',
      agency_email: 'promoted@example.com',
      is_primary: true,
    });

    assert.strictEqual(added.id, 301);
    sinon.assert.calledOnceWithExactly(db.switchPrimaryAgency, 88, 301);
  });

  it('merges duplicate rows when portal differs only by scheme', async function () {
    const queryStub = sinon.stub(db, 'query');
    sinon.stub(db, 'updateCaseAgency').callsFake(async (id, updates) => ({
      id,
      case_id: 91,
      agency_id: 123,
      agency_name: 'South St. Paul Police Department, Minnesota',
      agency_email: 'SSPPDClerical@southstpaul.org',
      portal_url: 'https://www.southstpaulmn.gov/FormCenter/Police-8/Request-for-Police-Data-67',
      portal_provider: 'civicplus',
      is_primary: true,
      ...updates,
    }));
    sinon.stub(db, 'syncPrimaryAgencyToCase').resolves();

    queryStub.onCall(0).resolves({
      rows: [{
        id: 51,
        case_id: 91,
        agency_id: 123,
        agency_name: 'South St. Paul Police Department, Minnesota',
        agency_email: 'clerical@sspmn.org',
        portal_url: 'http://www.southstpaulmn.gov/FormCenter/Police-8/Request-for-Police-Data-67',
        portal_provider: null,
        is_primary: true,
        is_active: true,
        notes: null,
      }],
    });

    const merged = await db.addCaseAgency(91, {
      agency_name: 'South St. Paul Police Department, Minnesota',
      agency_email: 'SSPPDClerical@southstpaul.org',
      portal_url: 'https://www.southstpaulmn.gov/FormCenter/Police-8/Request-for-Police-Data-67',
      portal_provider: 'civicplus',
      agency_id: 123,
    });

    assert.strictEqual(merged.id, 51);
    assert.strictEqual(merged.portal_provider, 'civicplus');
    assert.strictEqual(merged.agency_email, 'SSPPDClerical@southstpaul.org');
    sinon.assert.calledOnce(db.updateCaseAgency);
    sinon.assert.calledOnce(db.syncPrimaryAgencyToCase);
  });
});
