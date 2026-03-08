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
    queryStub.onCall(1).resolves({ rows: [{ cnt: '0' }] });
    queryStub.onCall(2).resolves({ rows: [] });
    queryStub.onCall(3).resolves({
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
    const seedCall = queryStub.getCall(2);
    assert.ok(seedCall, 'expected case-row backfill insert');
    assert.match(seedCall.args[0], /case_row_backfill/);
    assert.strictEqual(seedCall.args[1][2], 'Original Case Agency');
    assert.strictEqual(seedCall.args[1][3], 'primary@example.com');
  });

  it('switches primary agency when explicitly requested on insert', async function () {
    const queryStub = sinon.stub(db, 'query');
    sinon.stub(db, 'switchPrimaryAgency').resolves({
      id: 301,
      case_id: 88,
      agency_name: 'Promoted Agency',
      is_primary: true,
    });
    sinon.stub(db, 'syncPrimaryAgencyToCase').resolves();

    queryStub.onCall(0).resolves({ rows: [] });
    queryStub.onCall(1).resolves({ rows: [{ cnt: '1' }] });
    queryStub.onCall(2).resolves({
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
});
