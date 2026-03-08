const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const promptPatternDatasetService = require('../services/prompt-pattern-dataset-service');

describe('Prompt pattern dataset service', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('classifies real-message patterns deterministically', function () {
    assert.strictEqual(
      promptPatternDatasetService.classifyPromptPattern({
        portal_notification: true,
        subject: 'Password reset',
        body_text: 'Reset your password to continue using the portal.',
      }),
      'portal_access_issue'
    );

    assert.strictEqual(
      promptPatternDatasetService.classifyPromptPattern({
        subject: 'Fee estimate',
        body_text: 'Payment required before records are released. The fee estimate is $42.50.',
        intent: 'fee_request',
      }),
      'fee_letter'
    );

    assert.strictEqual(
      promptPatternDatasetService.classifyPromptPattern({
        subject: 'Wrong agency',
        body_text: 'We do not maintain these records. Please direct your request to the sheriff records unit.',
      }),
      'wrong_agency_referral'
    );
  });

  it('builds grouped prompt datasets from inbound messages', async function () {
    sinon.stub(db, 'query').resolves({
      rows: [
        {
          id: 1,
          case_id: 11,
          subject: 'Portal submission confirmation',
          from_email: 'noreply@portal.gov',
          body_text: 'Your request has been submitted successfully. Reference number 123.',
          body_html: null,
          portal_notification: true,
          portal_notification_type: 'submission_confirmation',
          portal_notification_provider: 'govqa',
          received_at: '2026-03-08T00:00:00.000Z',
          agency_name: 'Agency One',
          state: 'TX',
          intent: 'acknowledgment',
          denial_subtype: null,
          requires_action: false,
          suggested_action: 'wait',
          full_analysis_json: { intent: 'acknowledgment' },
          attachments: [],
        },
        {
          id: 2,
          case_id: 22,
          subject: 'Fee estimate letter',
          from_email: 'records@agency.gov',
          body_text: 'Attached is the fee estimate. Payment required before release.',
          body_html: null,
          portal_notification: false,
          portal_notification_type: null,
          portal_notification_provider: null,
          received_at: '2026-03-08T00:00:00.000Z',
          agency_name: 'Agency Two',
          state: 'FL',
          intent: 'fee_request',
          denial_subtype: null,
          requires_action: true,
          suggested_action: 'negotiate',
          full_analysis_json: { intent: 'fee_request' },
          attachments: [{ filename: 'fee.pdf', content_type: 'application/pdf', extracted_text: 'Fee estimate enclosed.' }],
        },
      ],
    });

    const dataset = await promptPatternDatasetService.buildPromptPatternDataset({ perPattern: 5 });

    assert.strictEqual(dataset.source.scanned_messages, 2);
    assert.strictEqual(dataset.counts.portal_confirmation, 1);
    assert.strictEqual(dataset.counts.fee_letter, 1);
    assert.strictEqual(dataset.patterns.portal_confirmation[0].message_id, 1);
    assert.strictEqual(dataset.patterns.fee_letter[0].attachment_summary[0].filename, 'fee.pdf');
  });
});
