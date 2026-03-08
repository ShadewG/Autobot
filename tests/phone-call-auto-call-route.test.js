const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

const phoneCallRoutes = require('../routes/phone-calls');
const db = require('../services/database');
const twilioVoiceService = require('../services/twilio-voice-service');
const aiService = require('../services/ai-service');

describe('Phone call auto-call routes', function () {
  let originals;

  beforeEach(function () {
    originals = {
      getPhoneCallById: db.getPhoneCallById,
      getCaseById: db.getCaseById,
      getThreadByCaseId: db.getThreadByCaseId,
      createMessage: db.createMessage,
      query: db.query,
      logActivity: db.logActivity,
      isConfigured: twilioVoiceService.isConfigured,
      startStatusCheckCall: twilioVoiceService.startStatusCheckCall,
      summarizePhoneCallForConversation: aiService.summarizePhoneCallForConversation,
    };

    db.logActivity = async () => ({ id: 1 });
  });

  afterEach(function () {
    Object.assign(db, {
      getPhoneCallById: originals.getPhoneCallById,
      getCaseById: originals.getCaseById,
      getThreadByCaseId: originals.getThreadByCaseId,
      createMessage: originals.createMessage,
      query: originals.query,
      logActivity: originals.logActivity,
    });
    twilioVoiceService.isConfigured = originals.isConfigured;
    twilioVoiceService.startStatusCheckCall = originals.startStatusCheckCall;
    aiService.summarizePhoneCallForConversation = originals.summarizePhoneCallForConversation;
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/api/phone-calls', phoneCallRoutes);
    return app;
  }

  it('starts an automated status-check call and persists the Twilio SID', async function () {
    db.getPhoneCallById = async () => ({ id: 7, case_id: 88, status: 'pending', agency_phone: '+15554443333', agency_name: 'Example PD' });
    db.getCaseById = async () => ({ id: 88, subject_name: 'Jordan Example' });
    db.query = async (sql, params) => {
      assert.match(sql, /UPDATE phone_call_queue/);
      assert.deepStrictEqual(params, [7, 'CA555', 'queued']);
      return { rows: [{ id: 7, twilio_call_sid: 'CA555', twilio_call_status: 'queued' }] };
    };
    twilioVoiceService.isConfigured = () => true;
    twilioVoiceService.startStatusCheckCall = async () => ({ callSid: 'CA555', status: 'queued', to: '+15554443333' });

    const response = await supertest(createApp())
      .post('/api/phone-calls/7/start-auto-call')
      .send({ initiatedBy: 'sam' });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.task.twilio_call_sid, 'CA555');
    assert.strictEqual(response.body.call.status, 'queued');
  });

  it('stores the transcript and appends a case conversation entry', async function () {
    let queryCall = 0;
    db.query = async (sql, params) => {
      queryCall += 1;
      if (queryCall === 1) {
        assert.match(sql, /UPDATE phone_call_queue/);
        assert.deepStrictEqual(params, ['CA777', 'The request is still under review.', 'completed']);
        return {
          rows: [{
            id: 7,
            case_id: 88,
            agency_name: 'Example PD',
            agency_phone: '+15554443333',
            twilio_recording_url: 'https://recordings.example.test/call.mp3',
          }],
        };
      }
      assert.match(sql, /UPDATE phone_call_queue/);
      assert.deepStrictEqual(params, [7, 'Concise summary']);
      return { rows: [] };
    };
    db.getCaseById = async () => ({ id: 88, case_name: 'Case 88', agency_name: 'Example PD' });
    db.getThreadByCaseId = async () => ({ id: 99 });
    db.createMessage = async (payload) => ({ id: 123, ...payload });
    aiService.summarizePhoneCallForConversation = async () => ({
      summary: 'Concise summary',
      recommended_follow_up: 'Wait for the promised update tomorrow.',
    });

    const response = await supertest(createApp())
      .post('/api/phone-calls/twilio/transcription')
      .type('form')
      .send({
        CallSid: 'CA777',
        TranscriptionText: 'The request is still under review.',
        TranscriptionStatus: 'completed',
      });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.text, 'ok');
  });
});
