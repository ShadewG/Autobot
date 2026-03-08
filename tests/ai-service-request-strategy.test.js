const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const aiService = require('../services/ai-service');

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
