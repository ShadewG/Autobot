const assert = require('assert');
const {
  buildPdfReplyRequirementsFromText,
  _buildDeterministicPdfReplyDraft,
  _applyPdfDraftAdjustment,
  _insertSentenceAfterFirstParagraph,
  isLikelyRequestFormAttachment,
} = require('../services/pdf-form-service');
const {
  DRAFT_REQUIRED_ACTIONS,
  SEND_PDF_EMAIL,
} = require('../constants/action-types');

describe('pdf form service helpers', function () {
  it('detects public records request-form attachments', function () {
    const attachment = {
      filename: 'New FOIA Request Form.pdf',
      content_type: 'application/pdf',
      extracted_text: 'PORTER COUNTY ACCESS TO PUBLIC RECORDS ACT REQUEST FORM',
    };

    assert.strictEqual(isLikelyRequestFormAttachment(attachment), true);
  });

  it('ignores generated filled pdf attachments', function () {
    const attachment = {
      filename: 'filled_1741276764094.pdf',
      content_type: 'application/pdf',
      extracted_text: 'PORTER COUNTY ACCESS TO PUBLIC RECORDS ACT REQUEST FORM',
    };

    assert.strictEqual(isLikelyRequestFormAttachment(attachment), false);
  });

  it('treats SEND_PDF_EMAIL as a draft-required action', function () {
    assert.strictEqual(DRAFT_REQUIRED_ACTIONS.includes(SEND_PDF_EMAIL), true);
  });

  it('detects request-form clarification workflows from agency text', function () {
    const requirements = buildPdfReplyRequirementsFromText(`
      We have not received a response to my previous email.
      The requested records are compiled, but are too large to send via email.
      We cannot complete this request until we hear back on the method to send the records.
      We also request the completion of the APRA request form for our records.
      Please include a physical mailing address in case we need to mail a CD.
    `);

    assert.strictEqual(requirements.requestFormRequired, true);
    assert.strictEqual(requirements.mailingAddressRequired, true);
    assert.strictEqual(requirements.tooLargeForEmail, true);
  });

  it('builds a deterministic PDF reply draft with mailing-address and CD fallback details', function () {
    const draft = _buildDeterministicPdfReplyDraft(
      {
        agency_name: 'Porter County Central Communications (9-1-1) Center',
        subject_name: 'Conner (Lee) Kobold',
      },
      {
        name: 'Samuel Hylton',
        organization: 'Dr Insanity Media',
        email: 'requests@foib-request.com',
        phone: '209-800-7702',
        address: '3021 21st Ave W',
        addressLine2: 'Apt 202',
        city: 'Seattle',
        state: 'WA',
        zip: '98199',
      },
      {
        requestFormRequired: true,
        mailingAddressRequired: true,
        tooLargeForEmail: true,
      }
    );

    assert.match(draft.subject, /Completed Public Records Request Form/i);
    assert.match(draft.bodyText, /Attached please find my completed public records request form/i);
    assert.match(draft.bodyText, /Mailing address for CD delivery if needed:/i);
    assert.match(draft.bodyText, /3021 21st Ave W/i);
    assert.match(draft.bodyText, /Apt 202/i);
    assert.match(draft.bodyText, /Seattle, WA 98199/i);
    assert.match(draft.bodyText, /too large to email, you may mail a CD/i);
    assert.doesNotMatch(draft.bodyText, /preferred email address or portal/i);
  });

  it('does not emit a broken one-line mailing address when only a state is available', function () {
    const draft = _buildDeterministicPdfReplyDraft(
      {
        agency_name: 'Synthetic QA Records Unit',
        subject_name: 'Jordan Example',
      },
      {
        name: 'Requester',
        email: 'requests@example.com',
        phone: '206-555-0100',
        state: 'WA',
      },
      {
        mailingAddressRequired: true,
        tooLargeForEmail: true,
      }
    );

    assert.doesNotMatch(draft.bodyText, /Mailing address for CD delivery if needed:\nWA/i);
  });

  it('inserts an exact requested sentence after the first paragraph for adjusted PDF drafts', async function () {
    const baseDraft = _buildDeterministicPdfReplyDraft(
      {
        agency_name: 'Synthetic QA Records Unit',
        subject_name: 'Jordan Example',
        state: 'WA',
      },
      {
        name: 'Samuel Hylton',
        email: 'requests@example.com',
        phone: '206-555-0100',
        address: '3021 21st Ave W',
        addressLine2: 'Apt 202',
        city: 'Seattle',
        state: 'WA',
        zip: '98199',
      },
      {
        requestFormRequired: true,
        mailingAddressRequired: true,
        tooLargeForEmail: true,
      }
    );

    const exactSentence = 'The completed request form is attached as a PDF for your records.';
    const adjusted = await _applyPdfDraftAdjustment(
      baseDraft,
      {
        agency_name: 'Synthetic QA Records Unit',
        subject_name: 'Jordan Example',
        state: 'WA',
      },
      {
        name: 'Samuel Hylton',
        email: 'requests@example.com',
        phone: '206-555-0100',
      },
      null,
      `Keep this as a PDF email. Add exactly this sentence after the first paragraph: ${exactSentence}`,
      {
        requestFormRequired: true,
        mailingAddressRequired: true,
        tooLargeForEmail: true,
      }
    );

    const paragraphs = adjusted.bodyText.split(/\n\s*\n/);
    assert.strictEqual(paragraphs[1], exactSentence);
    assert.match(adjusted.bodyText, /Mailing address for CD delivery if needed:/i);
    assert.match(adjusted.bodyText, /too large to email, you may mail a CD/i);
  });

  it('does not duplicate an exact inserted sentence if the adjustment is retried', function () {
    const body = [
      'To Synthetic QA Records Unit,',
      '',
      'Attached please find my completed public records request form regarding Jordan Example.',
      '',
      'Mailing address for CD delivery if needed:',
      '3021 21st Ave W',
    ].join('\n');
    const sentence = 'The completed request form is attached as a PDF for your records.';
    const once = _insertSentenceAfterFirstParagraph(body, sentence);
    const twice = _insertSentenceAfterFirstParagraph(once, sentence);
    assert.strictEqual(once, twice);
  });
});
