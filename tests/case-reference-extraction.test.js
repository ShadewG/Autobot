const assert = require('assert');
const { extractReferencedCaseId } = require('../utils/case-reference-extraction');

describe('case reference extraction', function () {
  it('extracts explicit case id references', function () {
    assert.strictEqual(
      extractReferencedCaseId('Submission Confirmation', 'Case ID: 25156'),
      25156
    );
  });

  it('extracts case number phrasing', function () {
    assert.strictEqual(
      extractReferencedCaseId('The case number is 26636 and this is a confirmation.'),
      26636
    );
  });

  it('returns null when no supported case reference exists', function () {
    assert.strictEqual(
      extractReferencedCaseId('Reference number 24-12345', 'No autobot case id here'),
      null
    );
  });
});
