const axios = require('axios');

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseBriefing(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getConfig() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_PHONE_NUMBER || '',
    appBaseUrl: process.env.APP_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`,
  };
}

function isConfigured() {
  const config = getConfig();
  return Boolean(config.accountSid && config.authToken && config.fromNumber && config.appBaseUrl);
}

function buildStatusCheckScript(task = {}, caseData = {}) {
  const agencyName = task.agency_name || caseData.agency_name || 'the records office';
  const subjectName = caseData.subject_name || caseData.case_name || 'this request';
  const caseRef = caseData.id || task.case_id || 'this case';
  const briefing = parseBriefing(task.ai_briefing);
  const talkingPoints = Array.isArray(briefing?.talking_points) ? briefing.talking_points.slice(0, 2) : [];

  return [
    `Hello. This is an automated public records follow up for case ${caseRef}.`,
    `We are calling ${agencyName} regarding ${subjectName}.`,
    briefing?.call_justification ? `Context: ${briefing.call_justification}` : null,
    talkingPoints.length > 0 ? `Please address the following in your update: ${talkingPoints.join(' ')}.` : null,
    'Please leave a brief status update after the tone, including whether the request is being processed, denied, needs clarification, or requires payment.',
  ].filter(Boolean).join(' ');
}

function buildStatusCheckTwiml(task = {}, caseData = {}) {
  const { appBaseUrl } = getConfig();
  const recordingCallback = `${appBaseUrl}/api/phone-calls/twilio/recording`;
  const transcriptionCallback = `${appBaseUrl}/api/phone-calls/twilio/transcription`;
  const script = buildStatusCheckScript(task, caseData);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${xmlEscape(script)}</Say>
  <Pause length="1" />
  <Record maxLength="120" playBeep="true" trim="trim-silence" transcribe="true" recordingStatusCallback="${xmlEscape(recordingCallback)}" transcribeCallback="${xmlEscape(transcriptionCallback)}" />
  <Say voice="alice">Thank you. Goodbye.</Say>
  <Hangup />
</Response>`;
}

async function startStatusCheckCall({ task, caseData }) {
  const config = getConfig();
  if (!isConfigured()) {
    const error = new Error('Twilio voice is not configured');
    error.status = 503;
    error.code = 'TWILIO_NOT_CONFIGURED';
    throw error;
  }
  if (!task?.agency_phone) {
    const error = new Error('Phone call task does not have an agency phone number');
    error.status = 400;
    error.code = 'TWILIO_PHONE_REQUIRED';
    throw error;
  }

  const twiml = buildStatusCheckTwiml(task, caseData);
  const statusCallback = `${config.appBaseUrl}/api/phone-calls/twilio/status`;
  const payload = new URLSearchParams({
    To: task.agency_phone,
    From: config.fromNumber,
    Twiml: twiml,
    StatusCallback: statusCallback,
    StatusCallbackEvent: 'initiated ringing answered completed',
    StatusCallbackMethod: 'POST',
  });

  const response = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`,
    payload.toString(),
    {
      auth: {
        username: config.accountSid,
        password: config.authToken,
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 15000,
    }
  );

  return {
    callSid: response.data?.sid,
    status: response.data?.status || 'queued',
    twiml,
    to: task.agency_phone,
    from: config.fromNumber,
  };
}

module.exports = {
  getConfig,
  isConfigured,
  buildStatusCheckScript,
  buildStatusCheckTwiml,
  startStatusCheckCall,
};
