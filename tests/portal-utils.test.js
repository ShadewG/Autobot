const assert = require('assert');

const {
  isSupportedPortalUrl,
  buildPortalFingerprint,
  evaluatePortalAutomationDecision,
} = require('../utils/portal-utils');

describe('portal utils', function () {
  it('rejects documentation/help URLs for automated portal submission', function () {
    assert.strictEqual(
      isSupportedPortalUrl('https://www.civicplus.help/nextrequest/docs/requesters', 'nextrequest', null),
      false
    );
  });

  it('rejects contact-directory style URLs even when they are https', function () {
    assert.strictEqual(
      isSupportedPortalUrl('https://agency.example.gov/contact/public-records', null, null),
      false
    );
  });

  it('rejects providers explicitly marked as non-automatable', function () {
    assert.strictEqual(
      isSupportedPortalUrl('https://agency.example.gov/public-records', 'paper form required', null),
      false
    );
  });

  it('accepts real request portal URLs', function () {
    assert.strictEqual(
      isSupportedPortalUrl('https://southstpaulmn.gov/FormCenter/Police-8/Request-for-Police-Data-67', 'civicplus', null),
      true
    );
  });

  it('builds the same fingerprint for equivalent provider portal URLs on the same host/path', function () {
    const first = buildPortalFingerprint('https://agency.govqa.us/WEBAPP/_rs/RequestLogin.aspx?rqst=4', 'govqa');
    const second = buildPortalFingerprint('agency.govqa.us/WEBAPP/_rs/RequestLogin.aspx?rqst=5', 'govqa');

    assert.ok(first);
    assert.ok(second);
    assert.strictEqual(first.host, 'agency.govqa.us');
    assert.strictEqual(first.pathClass, 'portal_entry');
    assert.strictEqual(first.fingerprint, second.fingerprint);
  });

  it('requires operator confirmation for unknown candidate portals', function () {
    const decision = evaluatePortalAutomationDecision({
      portalUrl: 'https://records.example.gov/openrecords/form',
      provider: null,
      lastPortalStatus: null,
      policyStatus: null,
    });

    assert.strictEqual(decision.decision, 'review');
    assert.strictEqual(decision.status, 'needs_confirmation');
    assert.strictEqual(decision.reason, 'operator_confirmation_required');
  });

  it('allows known provider portals without prior manual confirmation', function () {
    const decision = evaluatePortalAutomationDecision({
      portalUrl: 'https://agency.nextrequest.com/',
      provider: 'nextrequest',
      lastPortalStatus: null,
      policyStatus: null,
    });

    assert.strictEqual(decision.decision, 'allow');
    assert.strictEqual(decision.status, 'auto_supported');
    assert.strictEqual(decision.reason, 'known_provider_portal');
  });
});
