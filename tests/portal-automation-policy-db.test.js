const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');

describe('portal automation policy backfill', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('promotes historical successful submissions to a trusted portal policy on first lookup', async function () {
    const queryStub = sinon.stub(db, 'query');
    queryStub.onCall(0).resolves({ rows: [], rowCount: 0 });
    queryStub.onCall(1).resolves({
      rows: [{
        submission_id: 91,
        case_id: 7003,
        started_at: new Date('2026-03-01T00:00:00Z').toISOString(),
        portal_url: 'https://agency.nextrequest.com/',
        portal_provider: 'nextrequest',
      }],
      rowCount: 1,
    });
    const upsertStub = sinon.stub(db, 'upsertPortalAutomationPolicy').resolves({
      id: 9,
      portal_fingerprint: 'nextrequest|agency.nextrequest.com|portal_entry|/',
      policy_status: 'trusted',
      decision_source: 'historical_success',
      decision_reason: 'historical_completed_submission',
      success_count: 1,
      failure_count: 0,
    });

    const policy = await db.getPortalAutomationPolicy('https://agency.nextrequest.com/', 'nextrequest');

    assert.ok(policy);
    assert.strictEqual(policy.policy_status, 'trusted');
    sinon.assert.calledOnce(upsertStub);
    sinon.assert.calledWithMatch(upsertStub, sinon.match({
      portalUrl: 'https://agency.nextrequest.com/',
      provider: 'nextrequest',
      policyStatus: 'trusted',
      decisionSource: 'historical_success',
      successDelta: 1,
    }));
  });
});
