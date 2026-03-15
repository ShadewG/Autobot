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

  it('falls back to a real requester name instead of generic Requester', async function () {
    const originalRequesterName = process.env.REQUESTER_NAME;
    const originalSendgridFromName = process.env.SENDGRID_FROM_NAME;
    delete process.env.REQUESTER_NAME;
    process.env.SENDGRID_FROM_NAME = 'Samuel Hylton';
    sinon.stub(db, 'getUserById').resolves(null);

    try {
      const signature = await aiService.getUserSignatureForCase({
        user_id: 999999,
        requester_name: null,
      });
      assert.strictEqual(signature.name, 'Samuel Hylton');
    } finally {
      if (originalRequesterName === undefined) delete process.env.REQUESTER_NAME;
      else process.env.REQUESTER_NAME = originalRequesterName;
      if (originalSendgridFromName === undefined) delete process.env.SENDGRID_FROM_NAME;
      else process.env.SENDGRID_FROM_NAME = originalSendgridFromName;
    }
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

  it('replaces weak generic no-records rebuttals with a deterministic substantive template', async function () {
    sinon.stub(aiService, 'researchStateLaws').resolves('');
    sinon.stub(aiService, 'callAI').resolves({
      text: [
        'Hello Officer Alley,',
        '',
        'Thank you for your March 6, 2026 response to TPIA request W028334-021626 regarding the June 2, 2019 homicide at the Village of Telluride apartments.',
        '',
        'Samuel Hylton',
      ].join('\n'),
      modelMetadata: { modelId: 'test-model' },
    });
    sinon.stub(aiService, 'getUserSignatureForCase').resolves({
      name: 'Samuel Hylton',
      title: '',
      phone: '209-800-7702',
    });
    sinon.stub(db, 'getStateDeadline').resolves({ state_name: 'Texas' });

    const draft = await aiService.generateDenialRebuttal(
      {
        subject: 'Public Information Request :: W028334-021626',
        normalized_body_text: [
          'The City has no response because this is not a valid public information request for body worn camera footage.',
          'Please refer to Code of Criminal Procedure Art. 2B.0112.',
          'The 911 call is no longer available as it has passed the retention period.',
          'The interior surveillance video was turned over to the DA\'s office.',
          'The City has reviewed its files and has determined there are no responsive documents.',
        ].join(' '),
      },
      { denial_subtype: 'no_records' },
      {
        state: 'TX',
        agency_name: 'San Marcos Police Department, Texas',
        subject_name: 'Jon Jervis, Lapear Willrich',
        incident_date: '2019-06-02T04:00:00.000Z',
        incident_location: 'Village of Telluride apartment, San Marcos, Texas',
        requested_records: ['body camera footage', '911 audio', 'surveillance video'],
      },
      { forceDraft: true }
    );

    assert.match(draft.body_text, /treat this message as providing the identifying information/i);
    assert.match(draft.body_text, /For clarity, this request still covers:/i);
    assert.match(draft.body_text, /body camera footage/i);
    assert.match(draft.body_text, /district attorney/i);
    assert.match(draft.body_text, /retention authority/i);
    assert.match(draft.body_text, /record systems or files that were searched/i);
    assert.match(draft.body_text, /specific legal basis/i);
    assert.doesNotMatch(draft.body_text, /209-800-7702/);
  });

  it('sanitizes status-update drafts so they do not echo security keys or requester phone numbers', async function () {
    sinon.stub(aiService, 'callAI').resolves({
      text: [
        'Hello Records Custodian,',
        '',
        'I am writing to confirm receipt of my request.',
        'Your request reference number is PRR-2025-1168 and your security key is DCC5EBE0.',
        'Please have both reference numbers available when communicating with our staff regarding your request.',
        '',
        'Thank you,',
        'Thank you,',
      ].join('\n'),
      modelMetadata: { modelId: 'test-model' },
    });
    sinon.stub(aiService, 'getUserSignatureForCase').resolves({
      name: 'Samuel Hylton',
      title: '',
      phone: '209-800-7702',
    });
    sinon.stub(db, 'getStateDeadline').resolves({ state_name: 'Florida', response_days: 10 });

    const draft = await aiService.generateFollowUp(
      {
        case_name: 'Herschol Howell',
        subject_name: 'Herschol Howell',
        agency_name: "Santa Rosa County Sheriff's Office",
        send_date: '2026-02-17',
        state: 'FL',
      },
      0,
      { statusInquiry: true }
    );

    assert.doesNotMatch(draft.body_text, /security key/i);
    assert.doesNotMatch(draft.body_text, /209-800-7702/);
    assert.doesNotMatch(draft.body_text, /Please have both reference numbers available/i);
    assert.match(draft.body_text, /Hello Records Custodian,/);
    assert.strictEqual((draft.body_text.match(/Thank you,/g) || []).length, 1);
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
