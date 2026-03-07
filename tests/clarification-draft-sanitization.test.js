const assert = require('assert');
const sinon = require('sinon');

const aiService = require('../services/ai-service');

describe('Clarification draft sanitization', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('fills stored mailing address and strips unsupported form-send claims', function () {
    const userSignature = {
      name: 'Samuel Hylton',
      phone: '209-800-7702',
      address: '3021 21st Ave W\nApt 202\nSeattle, WA\n98199',
    };

    const draft = [
      'Andrew,',
      '',
      'Thanks for the update. If you can provide a secure electronic delivery link (preferred), please send it.',
      '',
      'Mailing address (for CD): [INSERT REQUESTER MAILING ADDRESS]',
      '',
      'For your records, I’ve completed your APRA/FOIA request form and will send it to 911audio@portercountyin.gov with the mailing address included.',
      '',
      'Thank you,',
      '',
      'Samuel Hylton',
      '209-800-7702',
    ].join('\n');

    const normalized = aiService.normalizeGeneratedDraftSignature(draft, userSignature, {
      includeEmail: false,
      includeAddress: false,
    });
    const sanitized = aiService.sanitizeClarificationDraft(normalized, userSignature);

    assert(sanitized.includes('Mailing address (for CD): 3021 21st Ave W, Apt 202, Seattle, WA 98199'));
    assert(!sanitized.includes('[INSERT REQUESTER MAILING ADDRESS]'));
    assert(!/completed your APRA\/FOIA request form/i.test(sanitized));
    assert(!/will send it to 911audio@portercountyin\.gov/i.test(sanitized));
  });

  it('removes unresolved mailing-address placeholder lines when no address is on file', function () {
    const userSignature = {
      name: 'Samuel Hylton',
      phone: '209-800-7702',
      address: '',
    };

    const draft = [
      'Andrew,',
      '',
      'Mailing address (for CD): [INSERT REQUESTER MAILING ADDRESS]',
      '',
      'If needed, I can provide a mailing address separately.',
      '',
      'Thank you,',
      '',
      'Samuel Hylton',
      '209-800-7702',
    ].join('\n');

    const sanitized = aiService.sanitizeClarificationDraft(draft, userSignature);

    assert(!sanitized.includes('[INSERT REQUESTER MAILING ADDRESS]'));
    assert(!/^Mailing address \(for CD\):/m.test(sanitized));
    assert(sanitized.includes('If needed, I can provide a mailing address separately.'));
  });

  it('treats CLARIFICATION_REQUEST as a reply-worthy clarification intent', async function () {
    sinon.stub(aiService, 'callAI').resolves('Please confirm the incident date and location so I can narrow the request.');
    sinon.stub(aiService, 'getUserSignatureForCase').resolves({
      name: 'Samuel Hylton',
      phone: '209-800-7702',
      address: '',
    });

    const draft = await aiService.generateAutoReply(
      { body_text: 'Please clarify the incident date and location.' },
      {
        intent: 'CLARIFICATION_REQUEST',
        suggested_action: 'Provide the missing incident date and location',
        confidence_score: 0.92,
      },
      {
        case_name: 'QA Workflow - Clarification Path',
        subject_name: 'Jordan Example',
        agency_name: 'Synthetic QA Records Unit',
      }
    );

    assert.strictEqual(draft.should_auto_reply, true);
    assert.match(draft.body_text, /incident date and location/i);
  });
});
