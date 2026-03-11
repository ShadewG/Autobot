const assert = require('assert');

const {
  isSupportedPortalUrl,
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
});
