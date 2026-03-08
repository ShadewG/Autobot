const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const notionService = require('../services/notion-service');
const errorTrackingService = require('../services/error-tracking-service');

describe('Notion sync guards', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('rejects invalid page ids before making a Notion API call', async function () {
    const propertyStub = sinon.stub(notionService, 'getPagePropertyNames').resolves(['Live Status']);

    await assert.rejects(
      () => notionService.updatePage('qa-version-123', { live_status: 'Ready to Send' }),
      /Invalid Notion page ID/
    );

    assert.strictEqual(propertyStub.called, false);
  });

  it('skips synthetic case ids during status sync', async function () {
    sinon.stub(db, 'getCaseById').resolves({
      id: 1,
      notion_page_id: 'qa-version-123',
      status: 'awaiting_response',
    });
    const updatePageStub = sinon.stub(notionService, 'updatePage').resolves(null);

    await notionService._syncStatusToNotion(1);

    assert.strictEqual(updatePageStub.called, false);
  });

  it('captures status sync failures with case context', async function () {
    sinon.stub(db, 'getCaseById').resolves({
      id: 7,
      notion_page_id: '12345678123412341234123456789012',
      case_name: 'QA Case',
      status: 'awaiting_response',
      updated_at: new Date().toISOString(),
    });
    sinon.stub(db, 'getFollowUpScheduleByCaseId').resolves(null);
    sinon.stub(notionService, 'updatePage').rejects(Object.assign(new Error('Notion is down'), { status: 503 }));
    const captureStub = sinon.stub(errorTrackingService, 'captureException').resolves(null);
    const activityStub = sinon.stub(db, 'logActivity').resolves({ id: 3 });

    await notionService._syncStatusToNotion(7);

    assert.strictEqual(captureStub.calledOnce, true);
    assert.strictEqual(captureStub.firstCall.args[1].caseId, 7);
    assert.strictEqual(captureStub.firstCall.args[1].metadata.notionPageId, '12345678123412341234123456789012');
    assert.strictEqual(captureStub.firstCall.args[1].metadata.caseStatus, 'awaiting_response');
    assert.strictEqual(activityStub.calledOnce, true);
    assert.strictEqual(activityStub.firstCall.args[0], 'notion_sync_error');
  });

  it('skips invalid agency notion ids when reading submission memory', async function () {
    const commentStub = sinon.stub(notionService.notion.comments, 'list').resolves({ results: [], has_more: false, next_cursor: null });

    const memories = await notionService.getSubmissionMemory('qa-agency-123');

    assert.deepStrictEqual(memories, []);
    assert.strictEqual(commentStub.called, false);
  });

  it('rejects invalid page ids before single-page import fetches from Notion', async function () {
    const retrieveStub = sinon.stub(notionService.notion.pages, 'retrieve').resolves({});

    await assert.rejects(
      () => notionService.processSinglePage('qa-import-123'),
      /Invalid Notion page ID/
    );

    assert.strictEqual(retrieveStub.called, false);
  });
});
