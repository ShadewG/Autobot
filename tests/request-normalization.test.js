const assert = require('assert');

const {
  extractMetadataAgencyHint,
  detectCaseMetadataAgencyMismatch,
} = require('../utils/request-normalization');

describe('request normalization helpers', function () {
  it('extracts an explicit police department from additional details', function () {
    const hint = extractMetadataAgencyHint(`
**Case Summary:** Example
**Police Department:** Gwinnett County Police Department, Georgia
`);

    assert.deepStrictEqual(hint, {
      name: 'Gwinnett County Police Department, Georgia',
      state: 'GA',
      source: 'additional_details',
    });
  });

  it('detects a wrong-agency mismatch when metadata names a different jurisdiction', function () {
    const mismatch = detectCaseMetadataAgencyMismatch({
      currentAgencyName: 'Lubbock Police Department, Texas',
      additionalDetails: `
**Case Summary:** Example
**Police Department:** Gwinnett County Police Department, Georgia
`,
    });

    assert.deepStrictEqual(mismatch, {
      expectedAgencyName: 'Gwinnett County Police Department, Georgia',
      expectedState: 'GA',
      currentAgencyName: 'Lubbock Police Department, Texas',
      source: 'additional_details',
    });
  });

  it('does not flag a mismatch when metadata names the same agency', function () {
    const mismatch = detectCaseMetadataAgencyMismatch({
      currentAgencyName: 'Lubbock Police Department, Texas',
      additionalDetails: `
**Case Summary:** Example
**Police Department:** Lubbock Police Department, Texas
`,
    });

    assert.strictEqual(mismatch, null);
  });
});
