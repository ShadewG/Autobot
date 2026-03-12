const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const aiService = require('../services/ai-service');
const denialResponsePrompts = require('../prompts/denial-response-prompts');

describe('AI service request strategy path', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('builds FOIA system prompts with the default deterministic strategy', function () {
    const prompt = aiService.buildFOIASystemPrompt('Texas');
    assert.match(prompt, /STRATEGIC APPROACH FOR THIS REQUEST:/);
    assert.match(prompt, /Use a collaborative, cooperative tone/);
    assert.match(prompt, /Emphasize documentary production and educational purposes/);
  });

  it('anchors the initial request prompt to the target agency and strips Notion metadata dumps', function () {
    const prompt = aiService.buildFOIAUserPrompt({
      state: 'TN',
      agency_name: 'Chattanooga Police Department, Tennessee',
      subject_name: 'Jasmine Pace',
      incident_date: '2025-01-20',
      incident_location: 'Nolensville, Tennessee',
      requested_records: ['Body camera footage', '911 audio'],
      additional_details: [
        'Jason Chen was convicted of murdering Jasmine Pace in Chattanooga.',
        '',
        '--- Notion Fields ---',
        'City : Nolensville',
        'Police Departments Involved: Chattanooga Police Department',
      ].join('\n'),
    });

    assert.match(prompt, /authoritative target agency for this request is: Chattanooga Police Department, Tennessee/i);
    assert.doesNotMatch(prompt, /--- Notion Fields ---/);
    assert.doesNotMatch(prompt, /at Nolensville, Tennessee/);
    assert.match(prompt, /Jason Chen was convicted of murdering Jasmine Pace in Chattanooga\./);
  });

  it('does not globally encourage narrowing for privacy-exemption rebuttals', function () {
    const systemPrompt = denialResponsePrompts.denialRebuttalSystemPrompt;
    assert.match(systemPrompt, /Only offer narrowing or phased production when the denial is actually about overbreadth or burden/i);
    assert.match(systemPrompt, /For privacy \/ surveillance \/ personnel \/ victim-protection denials: do NOT offer to narrow the request/i);
    assert.doesNotMatch(systemPrompt, /- "Happy to narrow\.\.\." not "The law requires\.\.\."/i);
  });

  it('replaces weak privacy-exemption rebuttals with a deterministic segregability template', async function () {
    sinon.stub(aiService, 'researchStateLaws').resolves('');
    sinon.stub(aiService, 'callAI').resolves({
      text: 'Records Custodian,\n\nI understand the concern about surveillance techniques.\n\nSamuel Hylton\n209-800-7702',
      modelMetadata: { modelId: 'test-model' },
    });
    sinon.stub(aiService, 'getUserSignatureForCase').resolves({
      name: 'Samuel Hylton',
      title: '',
      phone: '209-800-7702',
    });
    sinon.stub(db, 'getStateDeadline').resolves({ state_name: 'Florida' });

    const draft = await aiService.generateDenialRebuttal(
      {
        subject: '[Records Center] Public Records Request :: R039189-030926',
        normalized_body_text: 'Reference #: R039189-030926\nAny information revealing surveillance techniques or procedures or personnel is exempt from s. 119.07(1) and s. 24(a).',
      },
      { denial_subtype: 'privacy_exemption' },
      {
        state: 'FL',
        agency_name: "St. Johns County Sheriff's Office, Florida",
        requested_records: ['Surveillance video'],
      }
    );

    assert.match(draft.body_text, /segregable non-exempt portions/i);
    assert.match(draft.body_text, /comprehensive redactions/i);
    assert.doesNotMatch(draft.body_text, /happy to narrow|proceed in phases/i);
  });


  it('still generates a rebuttal draft when the action is already SEND_REBUTTAL on a portal-hosted denial', async function () {
    sinon.stub(aiService, 'researchStateLaws').resolves('');
    sinon.stub(aiService, 'callAI').resolves({
      text: 'Records Custodian,\n\nPlease clarify the legal basis for the no-records determination.\n\nSamuel Hylton',
      modelMetadata: { modelId: 'test-model' },
    });
    sinon.stub(aiService, 'getUserSignatureForCase').resolves({
      name: 'Samuel Hylton',
      title: '',
      phone: '209-800-7702',
    });
    sinon.stub(db, 'getStateDeadline').resolves({ state_name: 'South Carolina' });

    const draft = await aiService.generateDenialRebuttal(
      {
        subject: 'Your City of Hardeeville, SC public records request #26-111 has been closed.',
        normalized_body_text: 'The record you asked for does not exist. Please contact us so that we can assist you in making a focused and effective request.',
      },
      { denial_subtype: 'no_records', portal_url: 'https://hardeevillesc.nextrequest.com/' },
      {
        state: 'SC',
        agency_name: 'Hardeeville Police Department, South Carolina',
        requested_records: ['incident reports'],
      },
      { forceDraft: true }
    );

    assert.ok(draft);
    assert.match(draft.body_text, /legal basis|no-records determination/i);
    assert.notStrictEqual(draft.should_auto_reply, false);
  });

  it('does not write adaptive learning outcomes anymore', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [] });

    await aiService.recordOutcomeForLearning(
      { id: 1401, outcome_recorded: false, send_date: '2026-03-01' },
      { intent: 'records_ready', extracted_fee_amount: 0, key_points: [] },
      { received_at: '2026-03-03T00:00:00.000Z' }
    );

    sinon.assert.notCalled(queryStub);
  });
});
