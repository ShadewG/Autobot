const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const {
  buildApprovalDraftUpdates,
  buildOriginalDraftInsertFields,
} = require('../services/proposal-draft-history');

describe('Proposal draft history', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('captures the current draft into original fields before approval-time overwrite', function () {
    const updates = buildApprovalDraftUpdates({
      draft_subject: 'Original subject',
      draft_body_text: 'Original body',
      original_draft_subject: null,
      original_draft_body_text: null,
      human_edited: false,
    }, {
      draft_subject: 'Edited subject',
      draft_body_text: 'Edited body',
    });

    assert.deepStrictEqual(updates, {
      original_draft_subject: 'Original subject',
      original_draft_body_text: 'Original body',
      draft_subject: 'Edited subject',
      draft_body_text: 'Edited body',
      draft_body_html: null,
      human_edited: true,
    });
  });

  it('does not write anything when the approval draft edit does not change content', function () {
    const updates = buildApprovalDraftUpdates({
      draft_subject: 'Original subject',
      draft_body_text: 'Original body',
      original_draft_subject: 'Original subject',
      original_draft_body_text: 'Original body',
      human_edited: false,
    }, {
      draft_subject: 'Original subject',
      draft_body_text: 'Original body',
    });

    assert.deepStrictEqual(updates, {});
  });

  it('seeds original draft fields on proposal creation', async function () {
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

    const insertCall = queryStub.getCall(1);
    assert.ok(insertCall, 'expected insert query call');
    assert.match(insertCall.args[0], /original_draft_subject/);
    assert.match(insertCall.args[0], /original_draft_body_text/);
    assert.match(insertCall.args[0], /human_edited/);
    assert.strictEqual(insertCall.args[1][8], 'Original subject');
    assert.strictEqual(insertCall.args[1][9], 'Original body');
    assert.strictEqual(insertCall.args[1][10], false);
  });

  it('preserves explicit false requiresHuman/canAutoExecute values on proposal creation', async function () {
    sinon.stub(db, 'getCaseById').resolves(null);
    const queryStub = sinon.stub(db, 'query');
    queryStub.onCall(0).resolves({ rows: [] });
    queryStub.onCall(1).resolves({
      rows: [{
        id: 88,
        case_id: 456,
        status: 'DRAFT',
        action_type: 'SEND_INITIAL_REQUEST',
        draft_subject: 'Initial subject',
        draft_body_text: 'Initial body',
        draft_body_html: null,
        can_auto_execute: true,
        requires_human: false,
      }],
    });
    queryStub.onCall(2).resolves({ rows: [] });
    queryStub.onCall(3).resolves({ rows: [{ id: 2, version_number: 1 }] });

    await db.upsertProposal({
      proposalKey: '456:initial:SEND_INITIAL_REQUEST:0',
      caseId: 456,
      actionType: 'SEND_INITIAL_REQUEST',
      draftSubject: 'Initial subject',
      draftBodyText: 'Initial body',
      canAutoExecute: true,
      requiresHuman: false,
      status: 'DRAFT',
    });

    const insertCall = queryStub.getCalls().find((call) => /INSERT INTO proposals/.test(call.args[0]));
    assert.strictEqual(insertCall.args[1][23], true);
    assert.strictEqual(insertCall.args[1][24], false);
    assert.strictEqual(insertCall.args[1][25], 'DRAFT');
  });

  it('builds insert defaults for original draft fields', function () {
    const fields = buildOriginalDraftInsertFields({
      draftSubject: 'Original subject',
      draftBodyText: 'Original body',
    });

    assert.deepStrictEqual(fields, {
      originalDraftSubject: 'Original subject',
      originalDraftBodyText: 'Original body',
      humanEdited: false,
    });
  });
});
