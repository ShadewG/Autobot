const assert = require('assert');

const {
  collectExpectedAgencyEmails,
  shouldEscalateManualPasteMismatch,
} = require('../trigger/lib/manual-paste-guard.ts');

describe('manual pasted inbound guard', function () {
  it('flags manual pasted inbound email when sender domain does not match the case thread', function () {
    const result = shouldEscalateManualPasteMismatch(
      {
        direction: 'inbound',
        from_email: 'records@atlanta.gov',
        metadata: { source: 'manual_paste', manual_paste: true },
      },
      { agency_email: 'kayla.neesmith@perry-ga.gov' },
      { agency_email: null, alternate_agency_email: null }
    );

    assert.strictEqual(result.mismatch, true);
    assert.deepStrictEqual(result.expectedEmails, ['kayla.neesmith@perry-ga.gov']);
    assert.strictEqual(result.senderDomain, 'atlanta.gov');
    assert.deepStrictEqual(result.expectedDomains, ['perry-ga.gov']);
  });

  it('does not flag a matching sender or non-manual-paste message', function () {
    const matching = shouldEscalateManualPasteMismatch(
      {
        direction: 'inbound',
        from_email: 'records@perry-ga.gov',
        metadata: { source: 'manual_paste', manual_paste: true },
      },
      { agency_email: 'kayla.neesmith@perry-ga.gov' },
      { agency_email: null, alternate_agency_email: null }
    );
    assert.strictEqual(matching.mismatch, false);

    const webhook = shouldEscalateManualPasteMismatch(
      {
        direction: 'inbound',
        from_email: 'records@atlanta.gov',
        metadata: { source: 'sendgrid' },
      },
      { agency_email: 'kayla.neesmith@perry-ga.gov' },
      { agency_email: null, alternate_agency_email: null }
    );
    assert.strictEqual(webhook.mismatch, false);
    assert.deepStrictEqual(
      collectExpectedAgencyEmails(
        { agency_email: 'records@perry-ga.gov', alternate_agency_email: 'records@perry-ga.gov' },
        { agency_email: 'kayla.neesmith@perry-ga.gov' }
      ),
      ['kayla.neesmith@perry-ga.gov', 'records@perry-ga.gov']
    );
  });

  it('handles top-level manual_paste source and uppercase inbound direction', function () {
    const result = shouldEscalateManualPasteMismatch(
      {
        direction: 'INBOUND',
        from_email: 'records@atlanta.gov',
        source: 'manual_paste',
      },
      { agency_email: 'kayla.neesmith@perry-ga.gov' },
      { agency_email: null, alternate_agency_email: null }
    );

    assert.strictEqual(result.mismatch, true);
    assert.strictEqual(result.senderEmail, 'records@atlanta.gov');
  });
});
