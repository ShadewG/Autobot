const assert = require('assert');

const {
  classifyPortalStatus,
  applyPortalStatusOutcome,
  checkCasePortalStatus,
  monitorSubmittedPortalCases,
} = require('../services/portal-status-monitor-service');

describe('portal status monitor service', function () {
  it('classifies records-ready portal status text', function () {
    const classification = classifyPortalStatus({
      statusText: 'Your records are ready for download in the portal',
      extracted_data: { status_detail: 'Documents available for release' },
    });

    assert.strictEqual(classification.category, 'records_ready');
    assert.match(classification.summary, /records are ready for download/i);
  });

  it('classifies denied and more-info-needed portal status text', function () {
    const denied = classifyPortalStatus({
      statusText: 'Request denied pending legal review',
    });
    const moreInfo = classifyPortalStatus({
      statusText: 'Action required: additional information needed before processing',
    });

    assert.strictEqual(denied.category, 'denied');
    assert.strictEqual(moreInfo.category, 'more_info_needed');
  });

  it('marks the case completed when the portal says records are ready', async function () {
    const calls = [];
    const fakeDb = {
      updateCasePortalStatus: async (caseId, payload) => {
        calls.push(['updateCasePortalStatus', caseId, payload]);
        return { id: caseId, ...payload };
      },
      logActivity: async (type, description, metadata) => {
        calls.push(['logActivity', type, description, metadata]);
      },
      dismissPendingProposals: async (caseId, reason, actions) => {
        calls.push(['dismissPendingProposals', caseId, reason, actions]);
      },
      updateCase: async (caseId, payload) => {
        calls.push(['updateCase', caseId, payload]);
      },
      upsertProposal: async () => {
        throw new Error('should not create alert proposal for records_ready');
      },
    };

    const classification = await applyPortalStatusOutcome(
      { id: 91, case_name: 'Portal Ready Case' },
      {
        statusText: 'Records are ready for download',
        taskId: 'sky-1',
        recording_url: 'https://skyvern.example/runs/1',
        extracted_data: { status_detail: 'Download available now' },
      },
      { db: fakeDb }
    );

    assert.strictEqual(classification.category, 'records_ready');
    assert.ok(calls.some((entry) => entry[0] === 'dismissPendingProposals'));
    assert.ok(
      calls.some((entry) => entry[0] === 'updateCase' && entry[2].status === 'completed' && entry[2].outcome_type === 'records_ready')
    );
  });

  it('escalates to human review when the portal says more info is needed', async function () {
    const calls = [];
    const fakeDb = {
      updateCasePortalStatus: async (caseId, payload) => {
        calls.push(['updateCasePortalStatus', caseId, payload]);
        return { id: caseId, ...payload };
      },
      logActivity: async (type, description, metadata) => {
        calls.push(['logActivity', type, description, metadata]);
      },
      dismissPendingProposals: async () => {
        throw new Error('should not dismiss proposals for more_info_needed');
      },
      updateCase: async (caseId, payload) => {
        calls.push(['updateCase', caseId, payload]);
      },
      upsertProposal: async (payload) => {
        calls.push(['upsertProposal', payload]);
        return { id: 501, ...payload };
      },
    };

    const classification = await applyPortalStatusOutcome(
      { id: 92, case_name: 'Portal Question Case' },
      {
        statusText: 'Action required: additional information needed before processing',
        taskId: 'sky-2',
        extracted_data: { status_detail: 'Please provide more information' },
      },
      { db: fakeDb }
    );

    assert.strictEqual(classification.category, 'more_info_needed');
    assert.ok(
      calls.some((entry) => entry[0] === 'upsertProposal' && entry[1].actionType === 'ESCALATE')
    );
    assert.ok(
      calls.some((entry) => entry[0] === 'updateCase' && entry[2].status === 'needs_human_review')
    );
  });

  it('monitors submitted portal cases and summarizes the outcomes', async function () {
    const activity = [];
    const fakeDb = {
      query: async (sql) => {
        assert.match(sql, /FROM cases c/);
        assert.match(sql, /c.status IN \('awaiting_response', 'portal_in_progress'\)/);
        assert.match(sql, /portal_status_check_failed/);
        assert.match(sql, /portal_status_monitor_paused/);
        return {
          rows: [
            { id: 201, case_name: 'Ready Case', portal_url: 'https://portal.example/1', status: 'awaiting_response' },
            { id: 202, case_name: 'Denied Case', portal_url: 'https://portal.example/2', status: 'portal_in_progress' },
          ],
        };
      },
      updateCasePortalStatus: async (caseId, payload) => activity.push(['updateCasePortalStatus', caseId, payload]),
      logActivity: async (type, description, metadata) => activity.push(['logActivity', type, description, metadata]),
      dismissPendingProposals: async (caseId, reason, actions) => activity.push(['dismissPendingProposals', caseId, reason, actions]),
      updateCase: async (caseId, payload) => activity.push(['updateCase', caseId, payload]),
      upsertProposal: async (payload) => activity.push(['upsertProposal', payload]),
    };
    const fakeSkyvern = {
      checkPortalStatus: async (caseData) => {
        if (caseData.id === 201) {
          return { success: true, statusText: 'Records are ready for download', extracted_data: {} };
        }
        return { success: true, statusText: 'Request denied pending legal review', extracted_data: {} };
      },
    };

    const result = await monitorSubmittedPortalCases({ db: fakeDb, skyvern: fakeSkyvern, limit: 5 });

    assert.deepStrictEqual(result, {
      checked: 2,
      recordsReady: 1,
      alerts: 1,
      failures: 0,
      candidateCount: 2,
    });
    assert.ok(activity.some((entry) => entry[0] === 'upsertProposal'));
  });

  it('pauses monitoring and locks the account on auth-related status check failures', async function () {
    const calls = [];
    const fakeDb = {
      acquireAdvisoryLock: async () => async () => {},
      getPortalAccountByUrl: async () => ({ id: 44, account_status: 'active' }),
      updatePortalAccountStatus: async (id, status) => {
        calls.push(['updatePortalAccountStatus', id, status]);
      },
      updateCasePortalStatus: async (caseId, payload) => {
        calls.push(['updateCasePortalStatus', caseId, payload]);
      },
      logActivity: async (type, description, metadata) => {
        calls.push(['logActivity', type, description, metadata]);
      },
    };
    const fakeSkyvern = {
      checkPortalStatus: async () => ({
        success: false,
        error: 'No TOTP verification code found. Going to terminate.',
        taskId: 'tsk_123',
      }),
    };

    const outcome = await checkCasePortalStatus(
      {
        id: 301,
        case_name: 'Portal Status Auth Failure',
        portal_url: 'https://example.nextrequest.com/requests/new',
        user_id: 7,
      },
      { db: fakeDb, skyvern: fakeSkyvern }
    );

    assert.strictEqual(outcome.success, false);
    assert.strictEqual(outcome.paused, true);
    assert.strictEqual(outcome.reason, 'totp_missing');
    assert.ok(
      calls.some((entry) => entry[0] === 'updatePortalAccountStatus' && entry[1] === 44 && entry[2] === 'locked')
    );
    assert.ok(
      calls.some((entry) => entry[0] === 'logActivity' && entry[1] === 'portal_status_monitor_paused')
    );
    assert.ok(
      calls.some(
        (entry) =>
          entry[0] === 'updateCasePortalStatus' &&
          String(entry[2].last_portal_status || '').startsWith('Status monitoring paused:')
      )
    );
  });

  it('skips disabled task-mode status checks without counting them as failures', async function () {
    const fakeDb = {
      query: async () => ({
        rows: [
          { id: 401, case_name: 'Skipped Portal Case', portal_url: 'https://portal.example/skip', status: 'awaiting_response' },
        ],
      }),
    };
    const fakeSkyvern = {
      checkPortalStatus: async () => ({
        success: false,
        skipped: true,
        reason: 'task_mode_status_checks_disabled',
      }),
    };

    const result = await monitorSubmittedPortalCases({ db: fakeDb, skyvern: fakeSkyvern, limit: 5 });

    assert.deepStrictEqual(result, {
      checked: 0,
      recordsReady: 0,
      alerts: 0,
      failures: 0,
      candidateCount: 1,
    });
  });
});
