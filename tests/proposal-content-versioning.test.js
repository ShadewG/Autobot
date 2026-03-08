const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');

describe('Proposal content versioning', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('creates an initial content version when a proposal is created', async function () {
    sinon.stub(db, 'getCaseById').resolves(null);
    const queryStub = sinon.stub(db, 'query');
    queryStub.onCall(0).resolves({ rows: [] });
    queryStub.onCall(1).resolves({
      rows: [{
        id: 77,
        case_id: 123,
        status: 'PENDING_APPROVAL',
        action_type: 'SEND_CLARIFICATION',
        draft_subject: 'Original subject',
        draft_body_text: 'Original body',
        draft_body_html: null,
      }],
    });
    queryStub.onCall(2).resolves({ rows: [] });
    queryStub.onCall(3).resolves({ rows: [{ id: 1, version_number: 1 }] });

    await db.upsertProposal({
      proposalKey: '123:msg-1:SEND_CLARIFICATION:0',
      caseId: 123,
      triggerMessageId: 456,
      actionType: 'SEND_CLARIFICATION',
      draftSubject: 'Original subject',
      draftBodyText: 'Original body',
      status: 'PENDING_APPROVAL',
    });

    const versionCall = queryStub.getCall(3);
    assert.ok(versionCall, 'expected proposal content version insert');
    assert.match(versionCall.args[0], /INSERT INTO proposal_content_versions/);
    assert.strictEqual(versionCall.args[1][0], 77);
    assert.strictEqual(versionCall.args[1][1], 'created');
    assert.strictEqual(versionCall.args[1][3], 'Original subject');
    assert.strictEqual(versionCall.args[1][4], 'Original body');
  });

  it('appends a new content version when draft content changes', async function () {
    sinon.stub(db, 'getProposalById').resolves({
      id: 9,
      case_id: 123,
      status: 'PENDING_APPROVAL',
      draft_subject: 'Old subject',
      draft_body_text: 'Old body',
      draft_body_html: null,
    });
    sinon.stub(db, 'getCaseById').resolves({ status: 'needs_human_review' });
    const queryStub = sinon.stub(db, 'query');
    queryStub.onCall(0).resolves({
      rows: [{
        id: 9,
        case_id: 123,
        status: 'PENDING_APPROVAL',
        action_type: 'SEND_CLARIFICATION',
        draft_subject: 'New subject',
        draft_body_text: 'New body',
        draft_body_html: null,
        updated_at: new Date().toISOString(),
      }],
    });
    queryStub.onCall(1).resolves({ rows: [] });
    queryStub.onCall(2).resolves({ rows: [{ id: 1, version_number: 1 }] });
    queryStub.onCall(3).resolves({ rows: [{ id: 2, version_number: 2 }] });

    const updated = await db.updateProposal(9, {
      draft_subject: 'New subject',
      draft_body_text: 'New body',
      __versionSource: 'approval_edit',
      __versionActor: 'user-7',
      __versionMetadata: { reason: 'human adjusted tone' },
    });

    assert.strictEqual(updated.draft_subject, 'New subject');
    const seedCall = queryStub.getCall(2);
    const appendCall = queryStub.getCall(3);
    assert.match(seedCall.args[0], /INSERT INTO proposal_content_versions/);
    assert.strictEqual(seedCall.args[1][1], 'created');
    assert.match(appendCall.args[0], /INSERT INTO proposal_content_versions/);
    assert.strictEqual(appendCall.args[1][1], 'approval_edit');
    assert.strictEqual(appendCall.args[1][2], 'user-7');
    assert.deepStrictEqual(appendCall.args[1][6], {
      changed_fields: ['draft_subject', 'draft_body_text'],
      reason: 'human adjusted tone',
    });
  });
});
