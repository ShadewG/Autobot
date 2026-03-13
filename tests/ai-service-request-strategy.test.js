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

  it('replaces meta clarification output with a deterministic not-reasonably-described reply', async function () {
    sinon.stub(aiService, 'callAI').resolves({
      text: 'Is a response needed? Yes.\nHello Mr. Records,\nPlease clarify.',
      modelMetadata: { modelId: 'test-model' },
    });
    sinon.stub(aiService, 'getUserSignatureForCase').resolves({
      name: 'Samuel Hylton',
      title: '',
      phone: '209-800-7702',
      address: {
        street: '123 Main St',
        city: 'Seattle',
        state: 'WA',
        zip: '98101',
      },
    });

    const draft = await aiService.generateClarificationResponse(
      {
        subject: 'Your request has been closed',
        normalized_body_text: 'Your request is not sufficiently clear. Please reasonably describe an identifiable record or contact us to make a focused and effective request.',
      },
      { intent: 'more_info_needed' },
      {
        agency_name: 'San Francisco Police Department',
        subject_name: 'Jordan Example',
        incident_date: '2024-01-05',
        incident_location: 'San Francisco, CA',
        requested_records: ['Body camera footage', '911 audio', 'City : should be ignored'],
        constraints_jsonb: ['REQUEST_NOT_REASONABLY_DESCRIBED'],
      }
    );

    assert.doesNotMatch(draft.body_text, /Is a response needed\?/i);
    assert.match(draft.body_text, /Helpful identifying details:/i);
    assert.match(draft.body_text, /If this request can be reopened with the clarification above, please do so\./i);
    assert.match(draft.body_text, /Jordan Example/);
    assert.doesNotMatch(draft.body_text, /City : should be ignored/);
  });

  it('replaces weak certification-barrier rebuttals with a deterministic certification template', async function () {
    sinon.stub(aiService, 'researchStateLaws').resolves('');
    sinon.stub(aiService, 'callAI').resolves({
      text: 'Records Custodian,\n\nCan you help?\n\nSamuel Hylton',
      modelMetadata: { modelId: 'test-model' },
    });
    sinon.stub(aiService, 'getUserSignatureForCase').resolves({
      name: 'Samuel Hylton',
      title: '',
      phone: '209-800-7702',
    });
    sinon.stub(db, 'getStateDeadline').resolves({ state_name: 'Wisconsin' });

    const draft = await aiService.generateDenialRebuttal(
      {
        subject: 'Request closed',
        normalized_body_text: 'Before we can release the audio or video, we need a certification under Wis. Stat. § 19.35(3)(h)3.a. We also need a correlation to the videos and may assess fees.',
      },
      { denial_subtype: 'denial_strong' },
      {
        state: 'WI',
        agency_name: 'Winnebago County Sheriff\'s Office, Wisconsin',
        requested_records: ['body camera video', 'dispatch audio'],
      },
      { forceDraft: true }
    );

    assert.match(draft.body_text, /exact certification form or language/i);
    assert.match(draft.body_text, /itemized written estimate/i);
    assert.match(draft.body_text, /process and release those records now/i);
  });

  it('replaces weak no-contact closure rebuttals with a deterministic reopen request', async function () {
    sinon.stub(aiService, 'researchStateLaws').resolves('');
    sinon.stub(aiService, 'callAI').resolves({
      text: 'Records Custodian,\n\nPlease help.\n\nSamuel Hylton',
      modelMetadata: { modelId: 'test-model' },
    });
    sinon.stub(aiService, 'getUserSignatureForCase').resolves({
      name: 'Samuel Hylton',
      title: '',
      phone: '209-800-7702',
    });
    sinon.stub(db, 'getStateDeadline').resolves({ state_name: 'Illinois' });

    const draft = await aiService.generateDenialRebuttal(
      {
        subject: 'Request closed',
        normalized_body_text: 'We were unable to contact you to make a focused and effective request. The request has been closed because it was not sufficiently clear.',
      },
      { denial_subtype: 'not_reasonably_described' },
      {
        state: 'IL',
        agency_name: 'Rockford Police Department, Illinois',
        subject_name: 'Jordan Example',
        incident_date: '2024-01-05',
        incident_location: 'Rockford, Illinois',
        requested_records: ['body camera footage'],
      },
      { forceDraft: true }
    );

    assert.match(draft.body_text, /reopened and processed/i);
    assert.match(draft.body_text, /This request seeks/i);
    assert.match(draft.body_text, /Subject\/person: Jordan Example/i);
    assert.match(draft.body_text, /case number or another specific identifier/i);
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
