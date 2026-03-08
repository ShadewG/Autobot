const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');

describe('Inbound proposal preservation during case status changes', function () {
  let notionServicePath;
  let originalNotionService;

  beforeEach(function () {
    notionServicePath = require.resolve('../services/notion-service');
    originalNotionService = require.cache[notionServicePath];
    require.cache[notionServicePath] = {
      exports: {
        syncStatusToNotion: () => Promise.resolve(),
      },
    };

    sinon.stub(db, '_dispatchStatusAction').resolves();
  });

  afterEach(function () {
    sinon.restore();
    if (originalNotionService) {
      require.cache[notionServicePath] = originalNotionService;
    } else {
      delete require.cache[notionServicePath];
    }
  });

  it('preserves inbound-triggered proposals when updateCaseStatus moves a case to responded', async function () {
    const queryStub = sinon.stub(db, 'query');
    queryStub.onCall(0).resolves({
      rows: [{ id: 42, status: 'responded', agency_name: 'Test Agency', case_name: 'Test Case' }],
    });
    queryStub.onCall(1).resolves({ rows: [] });
    queryStub.onCall(2).resolves({ rows: [] });

    await db.updateCaseStatus(42, 'responded', {});

    const dismissCall = queryStub.getCall(1);
    assert.ok(dismissCall, 'expected proposal cleanup query');
    assert.match(dismissCall.args[0], /trigger_message_id IS NULL/);
    assert.strictEqual(dismissCall.args[1][3], true);
  });

  it('preserves inbound-triggered proposals when updateCase moves a case to awaiting_response', async function () {
    const queryStub = sinon.stub(db, 'query');
    queryStub.onCall(0).resolves({
      rows: [{ id: 52, status: 'awaiting_response', agency_name: 'Test Agency', case_name: 'Awaiting Case' }],
    });
    queryStub.onCall(1).resolves({ rows: [] });

    await db.updateCase(52, { status: 'awaiting_response' });

    const dismissCall = queryStub.getCall(1);
    assert.ok(dismissCall, 'expected proposal cleanup query');
    assert.match(dismissCall.args[0], /trigger_message_id IS NULL/);
    assert.strictEqual(dismissCall.args[1][3], true);
  });

  it('still dismisses all active proposals for terminal case states', async function () {
    const queryStub = sinon.stub(db, 'query');
    queryStub.onCall(0).resolves({
      rows: [{ id: 53, status: 'completed', agency_name: 'Test Agency', case_name: 'Completed Case' }],
    });
    queryStub.onCall(1).resolves({ rows: [] });
    queryStub.onCall(2).resolves({ rows: [] });

    await db.updateCaseStatus(53, 'completed', {});

    const dismissCall = queryStub.getCall(1);
    assert.ok(dismissCall, 'expected proposal cleanup query');
    assert.match(dismissCall.args[0], /trigger_message_id IS NULL/);
    assert.strictEqual(dismissCall.args[1][3], false);
  });
});
