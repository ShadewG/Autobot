const assert = require('assert');
const axios = require('axios');
const twilioVoiceService = require('../services/twilio-voice-service');

describe('Twilio voice service', function () {
  let originalEnv;
  let originalAxiosPost;

  beforeEach(function () {
    originalEnv = {
      TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
      TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,
      APP_BASE_URL: process.env.APP_BASE_URL,
    };
    originalAxiosPost = axios.post;
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'auth-token';
    process.env.TWILIO_PHONE_NUMBER = '+15551230000';
    process.env.APP_BASE_URL = 'https://app.example.test';
  });

  afterEach(function () {
    axios.post = originalAxiosPost;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('builds TwiML with status-check instructions and callbacks', function () {
    const twiml = twilioVoiceService.buildStatusCheckTwiml(
      { case_id: 77, agency_name: 'Example Police Department' },
      { id: 77, subject_name: 'Jordan Example' }
    );

    assert.match(twiml, /automated public records follow up/i);
    assert.match(twiml, /Example Police Department/);
    assert.match(twiml, /Jordan Example/);
    assert.match(twiml, /recordingStatusCallback="https:\/\/app\.example\.test\/api\/phone-calls\/twilio\/recording"/);
    assert.match(twiml, /transcribeCallback="https:\/\/app\.example\.test\/api\/phone-calls\/twilio\/transcription"/);
  });


  it('uses AI briefing guidance when building the spoken status-check script', function () {
    const script = twilioVoiceService.buildStatusCheckScript(
      {
        case_id: 77,
        agency_name: 'Example Police Department',
        ai_briefing: JSON.stringify({
          call_justification: 'We have not received a response after repeated follow ups.',
          talking_points: [
            'Confirm whether the request is still being processed',
            'Ask if any fee or clarification is needed'
          ],
        }),
      },
      { id: 77, subject_name: 'Jordan Example' }
    );

    assert.match(script, /not received a response after repeated follow ups/i);
    assert.match(script, /Confirm whether the request is still being processed/);
    assert.match(script, /Ask if any fee or clarification is needed/);
  });

  it('creates an outbound call through the Twilio REST API', async function () {
    let request = null;
    axios.post = async (url, body, options) => {
      request = { url, body, options };
      return { data: { sid: 'CA123', status: 'queued' } };
    };

    const result = await twilioVoiceService.startStatusCheckCall({
      task: { case_id: 77, agency_phone: '+15554443333', agency_name: 'Example Police Department' },
      caseData: { id: 77, subject_name: 'Jordan Example' },
    });

    assert.strictEqual(result.callSid, 'CA123');
    assert.strictEqual(result.status, 'queued');
    assert.match(request.url, /Accounts\/AC123\/Calls\.json$/);
    assert.match(request.body, /To=%2B15554443333/);
    assert.match(request.body, /From=%2B15551230000/);
    assert.match(request.body, /StatusCallback=https%3A%2F%2Fapp\.example\.test%2Fapi%2Fphone-calls%2Ftwilio%2Fstatus/);
    assert.strictEqual(request.options.auth.username, 'AC123');
    assert.strictEqual(request.options.auth.password, 'auth-token');
    assert.strictEqual(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  });
});
