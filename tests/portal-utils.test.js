const assert = require('assert');

const {
  isSupportedPortalUrl,
  buildPortalFingerprint,
  evaluatePortalAutomationDecision,
  derivePortalPolicyFromBrowserValidation,
  classifyRequestChannelUrl,
  normalizeRequestChannelFields,
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

  it('rejects generic JustFOIA root URLs until a tenant-specific portal is known', function () {
    assert.strictEqual(
      isSupportedPortalUrl('https://request.justfoia.com/', 'justfoia', null),
      false
    );
  });

  it('rejects GovQA upload and asset URLs as non-portals', function () {
    assert.strictEqual(
      isSupportedPortalUrl('https://uploads.govqa.us/LUBBOCKTX/lubbock.png', 'govqa', null),
      false
    );
  });

  it('classifies generic nextrequest.com roots as confirmation-required, not auto-supported', function () {
    const decision = evaluatePortalAutomationDecision({
      portalUrl: 'https://nextrequest.com/',
      provider: 'nextrequest',
      lastPortalStatus: null,
      policyStatus: null,
    });

    assert.strictEqual(decision.decision, 'review');
    assert.strictEqual(decision.status, 'needs_confirmation');
    assert.strictEqual(decision.pathClass, 'unknown_root');
  });

  it('detects Smartsheet form URLs as real portal candidates', function () {
    assert.strictEqual(
      isSupportedPortalUrl('https://app.smartsheet.com/b/form/2fa13221a958491892a9cd319e7ba195', null, null),
      true
    );
    const decision = evaluatePortalAutomationDecision({
      portalUrl: 'https://app.smartsheet.com/b/form/2fa13221a958491892a9cd319e7ba195',
      provider: null,
      lastPortalStatus: null,
      policyStatus: null,
    });
    assert.strictEqual(decision.decision, 'review');
    assert.strictEqual(decision.pathClass, 'portal_entry');
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

  it('moves downloadable request forms into the pdf form channel', function () {
    const classified = classifyRequestChannelUrl('https://www.allencounty.org/word_doc/openrec.doc', null, null);
    assert.strictEqual(classified.kind, 'pdf_form');

    const normalized = normalizeRequestChannelFields({
      portal_url: 'https://www.allencounty.org/word_doc/openrec.doc',
      portal_provider: null,
      manual_request_url: null,
      pdf_form_url: null,
    });
    assert.strictEqual(normalized.portal_url, null);
    assert.strictEqual(normalized.pdf_form_url, 'https://www.allencounty.org/word_doc/openrec.doc');
  });

  it('moves contact or records-info pages into the manual request channel', function () {
    const classified = classifyRequestChannelUrl('https://www.co.warren.ms.us/contact-us/', null, null);
    assert.strictEqual(classified.kind, 'manual_request');

    const normalized = normalizeRequestChannelFields({
      portal_url: 'https://www.co.warren.ms.us/contact-us/',
      portal_provider: null,
      manual_request_url: null,
      pdf_form_url: null,
    });
    assert.strictEqual(normalized.portal_url, null);
    assert.strictEqual(normalized.manual_request_url, 'https://www.co.warren.ms.us/contact-us/');
  });

  it('moves provider-labeled no-online-submission pages into the manual request channel', function () {
    const url = 'https://www.perry-ga.gov/police-department/records-reports';
    const provider = 'pdf form download (no online submission portal)';
    const classified = classifyRequestChannelUrl(url, provider, null);
    assert.strictEqual(classified.kind, 'manual_request');

    const normalized = normalizeRequestChannelFields({
      portal_url: url,
      portal_provider: provider,
      manual_request_url: null,
      pdf_form_url: null,
    });
    assert.strictEqual(normalized.portal_url, null);
    assert.strictEqual(normalized.portal_provider, null);
    assert.strictEqual(normalized.manual_request_url, url);
  });

  it('drops junk tracking and generic root URLs instead of keeping them in request channels', function () {
    const sendgrid = normalizeRequestChannelFields({
      portal_url: 'https://u8387778.ct.sendgrid.net/ls/click?upn=test',
      portal_provider: null,
      manual_request_url: null,
      pdf_form_url: null,
    });
    assert.deepStrictEqual(sendgrid, {
      portal_url: null,
      portal_provider: null,
      manual_request_url: null,
      pdf_form_url: null,
    });

    const justfoia = classifyRequestChannelUrl('https://request.justfoia.com/', 'justfoia', null);
    assert.strictEqual(justfoia.kind, 'discard');
  });

  it('trusts a needs_confirmation portal after browser validation reaches a request form', function () {
    const derived = derivePortalPolicyFromBrowserValidation({
      portalUrl: 'https://records.example.gov/openrecords/start',
      provider: null,
      validation: {
        status: 'dry_run_form_detected',
        pageKind: 'request_form',
        final_url: 'https://records.example.gov/openrecords/start',
      },
    });

    assert.strictEqual(derived.policyStatus, 'trusted');
    assert.strictEqual(derived.decisionReason, 'dry_run_form_detected');
  });

  it('blocks a portal fingerprint when browser validation lands on a contact page', function () {
    const derived = derivePortalPolicyFromBrowserValidation({
      portalUrl: 'https://records.example.gov/openrecords/start',
      provider: null,
      validation: {
        status: 'landing_page_detected',
        pageKind: 'landing_page',
        final_url: 'https://records.example.gov/contact-us',
      },
    });

    assert.strictEqual(derived.policyStatus, 'blocked');
    assert.strictEqual(derived.decisionReason, 'contact');
  });
});
