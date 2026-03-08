const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const decisionMemory = require('../services/decision-memory-service');

describe('Decision memory stale lesson decay', function () {
  afterEach(function () {
    sinon.restore();
    decisionMemory._lastDecaySweepAt = 0;
  });

  it('deactivates stale unused auto lessons', async function () {
    const queryStub = sinon.stub(db, 'query');
    queryStub.onFirstCall().resolves({ rows: [{ id: 11 }, { id: 12 }] });

    const count = await decisionMemory.deactivateStaleLessons({ maxAgeDays: 90 });

    assert.strictEqual(count, 2);
    sinon.assert.calledWithMatch(queryStub.firstCall, sinon.match(/UPDATE ai_decision_lessons/), [90]);
  });

  it('runs stale lesson cleanup at most once per interval during lesson lookup', async function () {
    const queryStub = sinon.stub(db, 'query');
    queryStub.onFirstCall().resolves({ rows: [] }); // decay sweep
    queryStub.onSecondCall().resolves({
      rows: [
        {
          id: 21,
          category: 'general',
          trigger_pattern: 'synthetic police department',
          lesson: 'Use the successful prior pattern.',
          priority: 5,
          source: 'auto',
        },
      ],
    });
    queryStub.onThirdCall().resolves({ rows: [] }); // times_applied increment
    queryStub.onCall(3).resolves({
      rows: [
        {
          id: 21,
          category: 'general',
          trigger_pattern: 'synthetic police department',
          lesson: 'Use the successful prior pattern.',
          priority: 5,
          source: 'auto',
        },
      ],
    });
    queryStub.onCall(4).resolves({ rows: [] });

    const caseData = {
      agency_name: 'Synthetic Police Department',
      status: 'awaiting_response',
    };

    const first = await decisionMemory.getRelevantLessons(caseData, { messages: [], priorProposals: [] });
    const second = await decisionMemory.getRelevantLessons(caseData, { messages: [], priorProposals: [] });

    assert.strictEqual(first.length, 1);
    assert.strictEqual(second.length, 1);
    const cleanupCalls = queryStub.getCalls().filter(
      (call) =>
        String(call.args[0]).includes('UPDATE ai_decision_lessons') &&
        String(call.args[0]).includes('SET active = false')
    );
    assert.strictEqual(cleanupCalls.length, 1);
  });
});
