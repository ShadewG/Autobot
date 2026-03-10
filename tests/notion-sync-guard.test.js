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

  it('tracks fetchCasesWithStatus failures with status context', async function () {
    sinon.stub(notionService, 'resolvePropertyName').rejects(Object.assign(new Error('rate limited'), { status: 429 }));
    const captureStub = sinon.stub(errorTrackingService, 'captureException').resolves(null);

    await assert.rejects(
      () => notionService.fetchCasesWithStatus('Ready To Send'),
      /rate limited/
    );

    assert.strictEqual(captureStub.calledOnce, true);
    assert.strictEqual(captureStub.firstCall.args[1].operation, 'fetch_cases_with_status');
    assert.strictEqual(captureStub.firstCall.args[1].metadata.status, 'Ready To Send');
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

  it('quarantines missing notion pages during status sync', async function () {
    sinon.stub(db, 'getCaseById').resolves({
      id: 70,
      notion_page_id: '12345678123412341234123456789012',
      case_name: 'Missing Page Case',
      status: 'responded',
      updated_at: new Date().toISOString(),
      import_warnings: [],
    });
    sinon.stub(db, 'getFollowUpScheduleByCaseId').resolves(null);
    sinon.stub(notionService, 'updatePage').rejects(Object.assign(new Error('Could not find page with ID: 123'), {
      status: 404,
      code: 'object_not_found',
    }));
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [] });
    const captureStub = sinon.stub(errorTrackingService, 'captureException').resolves(null);
    const activityStub = sinon.stub(db, 'logActivity').resolves({ id: 9 });

    await notionService._syncStatusToNotion(70);

    assert.strictEqual(queryStub.calledOnce, true);
    assert.match(queryStub.firstCall.args[0], /SET notion_page_id = \$3/i);
    assert.match(queryStub.firstCall.args[1][2], /^missing:70:12345678123412341234123456789012$/);
    assert.strictEqual(captureStub.calledOnce, true);
    assert.strictEqual(captureStub.firstCall.args[1].retryable, false);
    assert.strictEqual(captureStub.firstCall.args[1].metadata.quarantinedMissingPage, true);
    assert.strictEqual(activityStub.firstCall.args[0], 'notion_page_missing');
    assert.strictEqual(activityStub.secondCall.args[0], 'notion_sync_error');
  });

  it('skips invalid agency notion ids when reading submission memory', async function () {
    const commentStub = sinon.stub(notionService.notion.comments, 'list').resolves({ results: [], has_more: false, next_cursor: null });

    const memories = await notionService.getSubmissionMemory('qa-agency-123');

    assert.deepStrictEqual(memories, []);
    assert.strictEqual(commentStub.called, false);
  });

  it('tracks fetchPageById failures with page context', async function () {
    sinon.stub(notionService.notion.pages, 'retrieve').rejects(Object.assign(new Error('notion unavailable'), { status: 503 }));
    const captureStub = sinon.stub(errorTrackingService, 'captureException').resolves(null);

    await assert.rejects(
      () => notionService.fetchPageById('12345678-1234-1234-1234-123456789012'),
      /notion unavailable/
    );

    assert.strictEqual(captureStub.calledOnce, true);
    assert.strictEqual(captureStub.firstCall.args[1].operation, 'fetch_page_by_id');
    assert.strictEqual(captureStub.firstCall.args[1].metadata.pageId, '12345678-1234-1234-1234-123456789012');
  });

  it('tracks page-property lookup failures with page context', async function () {
    sinon.stub(notionService.notion.pages, 'retrieve').rejects(Object.assign(new Error('property fetch failed'), { status: 503 }));
    const captureStub = sinon.stub(errorTrackingService, 'captureException').resolves(null);

    await assert.rejects(
      () => notionService.getPagePropertyNames('12345678-1234-1234-1234-123456789012'),
      /property fetch failed/
    );

    assert.strictEqual(captureStub.calledOnce, true);
    assert.strictEqual(captureStub.firstCall.args[1].operation, 'get_page_property_names');
    assert.strictEqual(captureStub.firstCall.args[1].metadata.pageId, '12345678-1234-1234-1234-123456789012');
  });

  it('does not double-track object_not_found during page-property lookup', async function () {
    sinon.stub(notionService.notion.pages, 'retrieve').rejects(Object.assign(new Error('Could not find page with ID: 123'), {
      status: 404,
      code: 'object_not_found',
    }));
    const captureStub = sinon.stub(errorTrackingService, 'captureException').resolves(null);

    await assert.rejects(
      () => notionService.getPagePropertyNames('12345678-1234-1234-1234-123456789012'),
      /Could not find page/
    );

    assert.strictEqual(captureStub.called, false);
  });

  it('tracks database schema lookup failures with database context', async function () {
    notionService.databaseSchema = null;
    notionService.databaseSchemaFetchedAt = 0;
    sinon.stub(notionService.notion.databases, 'retrieve').rejects(Object.assign(new Error('schema unavailable'), { status: 503 }));
    const captureStub = sinon.stub(errorTrackingService, 'captureException').resolves(null);

    const result = await notionService.getDatabaseSchemaProperties();

    assert.strictEqual(result, null);
    assert.strictEqual(captureStub.calledOnce, true);
    assert.strictEqual(captureStub.firstCall.args[1].operation, 'get_database_schema_properties');
  });

  it('tracks full-page text fetch failures with block context', async function () {
    sinon.stub(notionService.notion.blocks.children, 'list').rejects(Object.assign(new Error('blocks unavailable'), { status: 503 }));
    const captureStub = sinon.stub(errorTrackingService, 'captureException').resolves(null);

    const result = await notionService.getFullPagePlainText('12345678-1234-1234-1234-123456789012');

    assert.strictEqual(result, '');
    assert.strictEqual(captureStub.calledOnce, true);
    assert.strictEqual(captureStub.firstCall.args[1].operation, 'get_full_page_plain_text');
    assert.strictEqual(captureStub.firstCall.args[1].metadata.blockId, '12345678-1234-1234-1234-123456789012');
  });

  it('tracks police-department enrichment failures with department context', async function () {
    sinon.stub(notionService.notion.pages, 'retrieve').rejects(Object.assign(new Error('pd unavailable'), { status: 503 }));
    const captureStub = sinon.stub(errorTrackingService, 'captureException').resolves(null);

    const result = await notionService.enrichWithPoliceDepartment(
      { police_dept_id: '12345678123412341234123456789012', case_name: 'QA PD Case' },
      { id: '87654321876543218765432187654321', properties: {} }
    );

    assert.strictEqual(result.agency_name, 'Police Department');
    assert.strictEqual(result.agency_email, null);
    assert.strictEqual(captureStub.calledOnce, true);
    assert.strictEqual(captureStub.firstCall.args[1].operation, 'enrich_with_police_department');
    assert.strictEqual(captureStub.firstCall.args[1].metadata.policeDeptId, '12345678123412341234123456789012');
  });

  it('tracks AI summary sync failures with case context', async function () {
    sinon.stub(db, 'getCaseById').resolves({
      id: 11,
      notion_page_id: '12345678123412341234123456789012',
      case_name: 'QA Summary Case',
    });
    sinon.stub(notionService, 'updatePage').rejects(Object.assign(new Error('summary sync failed'), { status: 503 }));
    const captureStub = sinon.stub(errorTrackingService, 'captureException').resolves(null);

    await notionService.addAISummaryToNotion(11, 'summary text');

    assert.strictEqual(captureStub.calledOnce, true);
    assert.strictEqual(captureStub.firstCall.args[1].operation, 'add_ai_summary');
    assert.strictEqual(captureStub.firstCall.args[1].caseId, 11);
  });

  it('tracks submission comment failures for both case and agency pages', async function () {
    sinon.stub(db, 'getCaseById').resolves({
      id: 12,
      notion_page_id: '12345678123412341234123456789012',
      case_name: 'QA Submission Case',
    });
    const commentStub = sinon.stub(notionService.notion.comments, 'create');
    commentStub.onFirstCall().rejects(Object.assign(new Error('case comment failed'), { status: 503 }));
    commentStub.onSecondCall().rejects(Object.assign(new Error('agency comment failed'), { status: 503 }));
    const captureStub = sinon.stub(errorTrackingService, 'captureException').resolves(null);

    await notionService.addSubmissionComment(12, {
      portal_url: 'https://example.gov/portal',
      provider: 'govqa',
      account_email: 'records@example.gov',
      status: 'completed',
      confirmation_number: 'ABC-123',
      agency_notion_page_id: '87654321876543218765432187654321',
    });

    assert.strictEqual(captureStub.callCount, 2);
    assert.strictEqual(captureStub.firstCall.args[1].operation, 'add_submission_comment_case');
    assert.strictEqual(captureStub.secondCall.args[1].operation, 'add_submission_comment_agency');
  });

  it('rejects invalid page ids before single-page import fetches from Notion', async function () {
    const retrieveStub = sinon.stub(notionService.notion.pages, 'retrieve').resolves({});

    await assert.rejects(
      () => notionService.processSinglePage('qa-import-123'),
      /Invalid Notion page ID/
    );

    assert.strictEqual(retrieveStub.called, false);
  });

  it('tracks single-page import failures with page context', async function () {
    sinon.stub(notionService.notion.pages, 'retrieve').rejects(Object.assign(new Error('page fetch failed'), { status: 503 }));
    const captureStub = sinon.stub(errorTrackingService, 'captureException').resolves(null);

    await assert.rejects(
      () => notionService.processSinglePage('12345678123412341234123456789012'),
      /page fetch failed/
    );

    assert.strictEqual(captureStub.calledOnce, true);
    assert.strictEqual(captureStub.firstCall.args[1].operation, 'process_single_page');
    assert.strictEqual(captureStub.firstCall.args[1].metadata.pageId, '12345678123412341234123456789012');
  });

  it('parks placeholder imports in human review when the page has no request content', function () {
    const caseData = {
      case_name: 'Untitled Case',
      requested_records: [],
      additional_details: '--- Notion Fields ---\nTitle: &nbsp;\nStatus: Research\nSummary: not available',
      status: 'ready_to_send',
    };

    const warnings = notionService.applyImportReadinessGuard(caseData, {
      pageContent: '# 📋 Case Summary\nSummary not available\n## 👥 Individuals Involved',
    });

    assert.strictEqual(caseData.status, 'needs_human_review');
    assert.strictEqual(warnings.some((warning) => warning.type === 'PLACEHOLDER_TITLE'), true);
    assert.strictEqual(warnings.some((warning) => warning.type === 'MISSING_REQUEST_CONTENT'), true);
  });

  it('blocks imports when both title and subject are placeholder text even if request content exists', function () {
    const caseData = {
      case_name: 'Untitled Case',
      subject_name: '&nbsp;',
      requested_records: [],
      additional_details: '',
      agency_email: 'records@example.gov',
      status: 'ready_to_send',
    };

    const warnings = notionService.applyImportReadinessGuard(caseData, {
      pageContent: 'Please request all body camera, dash camera, CAD logs, and incident reports for the arrest on March 1.',
    });

    assert.strictEqual(caseData.status, 'needs_human_review');
    assert.strictEqual(warnings.some((warning) => warning.type === 'PLACEHOLDER_TITLE'), true);
    assert.strictEqual(warnings.some((warning) => warning.type === 'MISSING_REQUEST_CONTENT'), false);
  });

  it('does not block imports when the title is weak but the subject and agency are concrete', function () {
    const caseData = {
      case_name: 'Untitled Case',
      subject_name: 'Ryan Campbell',
      agency_name: 'Denver Police Department, Colorado',
      requested_records: [],
      additional_details: '**Police Department:** Denver Police Department, Colorado',
      agency_email: 'records@example.gov',
      status: 'ready_to_send',
    };

    const warnings = notionService.applyImportReadinessGuard(caseData, {
      pageContent: 'Please request all body camera, dash camera, CAD logs, and incident reports for the arrest on March 1.',
    });

    assert.strictEqual(caseData.status, 'ready_to_send');
    assert.strictEqual(warnings.some((warning) => warning.type === 'PLACEHOLDER_TITLE'), true);
  });

  it('routes real requests with no delivery path into needs_contact_info', function () {
    const caseData = {
      case_name: 'Officer misconduct records request',
      requested_records: [],
      additional_details: '',
      agency_email: '',
      portal_url: '',
      status: 'ready_to_send',
    };

    const warnings = notionService.applyImportReadinessGuard(caseData, {
      pageContent: 'Please provide body camera, incident report, CAD logs, and dash camera for the March 1 arrest.',
    });

    assert.strictEqual(caseData.status, 'needs_contact_info');
    assert.strictEqual(warnings.some((warning) => warning.type === 'MISSING_DELIVERY_PATH'), true);
    assert.strictEqual(warnings.some((warning) => warning.type === 'MISSING_REQUEST_CONTENT'), false);
  });

  it('uses a placeholder email for needs_contact_info imports so the case can persist', function () {
    const caseData = {
      case_name: 'Officer misconduct records request',
      requested_records: ['Body camera footage'],
      agency_email: null,
      portal_url: null,
      status: 'needs_contact_info',
    };

    notionService.applyImportDeliveryFallback(caseData);

    assert.strictEqual(caseData.agency_email, 'pending-research@intake.autobot');
  });

  it('persists a primary case_agencies row from imported Notion identity data', async function () {
    const addCaseAgencyStub = sinon.stub(db, 'addCaseAgency').resolves({ id: 91, is_primary: true });
    const updateCaseStub = sinon.stub(db, 'updateCase').resolves({
      id: 123,
      agency_id: 1733,
      agency_name: "Tompkins County Sheriff's Office, New York",
      agency_email: 'sheriff@tompkins-co.org',
      portal_url: 'https://lfweb.tompkins-co.org/forms/foil',
      portal_provider: null,
    });

    const result = await notionService.persistImportedPrimaryAgency(
      {
        id: 123,
        agency_id: null,
        agency_name: 'Police Department',
        agency_email: null,
        portal_url: null,
        portal_provider: null,
      },
      {
        agency_id: 1733,
        agency_name: "Tompkins County Sheriff's Office, New York",
        agency_email: 'sheriff@tompkins-co.org',
        portal_url: 'https://lfweb.tompkins-co.org/forms/foil',
        police_dept_id: 'abcdefabcdefabcdefabcdefabcdefab',
      }
    );

    assert.strictEqual(updateCaseStub.calledOnce, true);
    assert.deepStrictEqual(updateCaseStub.firstCall.args, [123, {
      agency_name: "Tompkins County Sheriff's Office, New York",
      agency_id: 1733,
      agency_email: 'sheriff@tompkins-co.org',
      portal_url: 'https://lfweb.tompkins-co.org/forms/foil',
    }]);
    assert.strictEqual(addCaseAgencyStub.calledOnce, true);
    assert.deepStrictEqual(addCaseAgencyStub.firstCall.args, [123, {
      agency_id: 1733,
      agency_name: "Tompkins County Sheriff's Office, New York",
      agency_email: 'sheriff@tompkins-co.org',
      portal_url: 'https://lfweb.tompkins-co.org/forms/foil',
      portal_provider: null,
      is_primary: true,
      added_source: 'notion_relation',
      status: 'active',
      notes: 'Primary agency imported from Notion',
    }]);
    assert.deepStrictEqual(result, {
      id: 123,
      agency_id: 1733,
      agency_name: "Tompkins County Sheriff's Office, New York",
      agency_email: 'sheriff@tompkins-co.org',
      portal_url: 'https://lfweb.tompkins-co.org/forms/foil',
      portal_provider: null,
    });
  });

  it('skips imported agency persistence for generic names without a real channel', async function () {
    const addCaseAgencyStub = sinon.stub(db, 'addCaseAgency').resolves({ id: 92 });

    const result = await notionService.persistImportedPrimaryAgency(
      {
        id: 124,
        agency_name: 'Police Department',
        agency_email: null,
        portal_url: null,
        agency_id: null,
      },
      {}
    );

    assert.deepStrictEqual(result, {
      id: 124,
      agency_name: 'Police Department',
      agency_email: null,
      portal_url: null,
      agency_id: null,
    });
    assert.strictEqual(addCaseAgencyStub.called, false);
  });

  it('applies AI-resolved agency metadata during single-page import', function () {
    const caseData = {
      case_name: 'Original title',
      agency_name: null,
      state: null,
      incident_date: null,
      incident_location: '',
      subject_name: 'Original subject',
      requested_records: [],
      additional_details: '',
    };

    notionService.applySinglePageAIResult(caseData, {
      agency_name: "Jacksonville Sheriff's Office (JSO)",
      state: 'Florida',
      incident_date: 'February 2022',
      incident_location: 'Jacksonville, Florida',
      subject_name: 'Nathaniel Slade',
      records_requested: ['911 Call Recordings'],
    });

    assert.strictEqual(caseData.agency_name, "Jacksonville Sheriff's Office (JSO)");
    assert.strictEqual(caseData.state, 'Florida');
    assert.strictEqual(caseData.incident_date, '2022-02-01');
    assert.deepStrictEqual(caseData.requested_records, ['911 Call Recordings']);
  });

  it('upgrades generic agency labels with AI-normalized agency names', function () {
    const result = notionService.applyNormalizedCaseData(
      {
        case_name: 'Jason Chen, 24.',
        agency_name: 'Police Department',
        state: 'TN',
        requested_records: ['Body camera footage'],
      },
      {
        agency_name: 'Chattanooga Police Department',
        state: 'Tennessee',
      }
    );

    assert.strictEqual(result.agency_name, 'Chattanooga Police Department');
    assert.strictEqual(result.state, 'TN');
  });

  it('preserves a concrete narrative-derived agency when no police department relation exists', async function () {
    const result = await notionService.enrichWithPoliceDepartment(
      {
        agency_name: 'Chattanooga Police Department',
        agency_email: null,
        police_dept_id: null,
      },
      { properties: {} }
    );

    assert.strictEqual(result.agency_name, 'Chattanooga Police Department');
  });

  it('normalizes loose imported incident dates to a DB-safe date', function () {
    assert.strictEqual(notionService.normalizeImportedDateValue('February 2022'), '2022-02-01');
    assert.strictEqual(notionService.normalizeImportedDateValue('2022-02-14T15:04:05.000Z'), '2022-02-14');
    assert.strictEqual(notionService.normalizeImportedDateValue('not a real date'), null);
  });

  it('omits relation ids from free-text property exports', function () {
    const properties = {
      'Police Department': {
        id: 'abc',
        type: 'relation',
        relation: [
          { id: '20987c20-070a-8183-b16b-d52aba959eb7' },
          { id: '24587c20-070a-8046-b4d8-fdef0dd2713f' },
        ],
      },
      'Case Summary': {
        id: 'def',
        type: 'rich_text',
        rich_text: [{ plain_text: 'Body camera request' }],
      },
    };

    const allPropsText = notionService.formatAllPropertiesAsText(properties);
    const aiProps = notionService.preparePropertiesForAI(properties);

    assert.match(allPropsText, /Case Summary: Body camera request/);
    assert.doesNotMatch(allPropsText, /20987c20-070a-8183-b16b-d52aba959eb7/);
    assert.strictEqual(aiProps['Police Department'], null);
  });
});
