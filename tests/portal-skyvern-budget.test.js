const assert = require('assert');
const sinon = require('sinon');
const axios = require('axios');
const portalSkyvern = require('../services/portal-agent-service-skyvern');
const database = require('../services/database');

describe('portal-agent-service-skyvern budgets', function () {
  const originalEnv = {
    REQUESTER_NAME: process.env.REQUESTER_NAME,
    REQUESTER_EMAIL: process.env.REQUESTER_EMAIL,
  };
  const originalTimeout = portalSkyvern.workflowSoftTimeoutMs;

  afterEach(function () {
    if (originalEnv.REQUESTER_NAME === undefined) delete process.env.REQUESTER_NAME;
    else process.env.REQUESTER_NAME = originalEnv.REQUESTER_NAME;

    if (originalEnv.REQUESTER_EMAIL === undefined) delete process.env.REQUESTER_EMAIL;
    else process.env.REQUESTER_EMAIL = originalEnv.REQUESTER_EMAIL;

    portalSkyvern.workflowSoftTimeoutMs = originalTimeout;
  });

  it('defaults requester identity to Samuel Hylton when no env override is set', function () {
    delete process.env.REQUESTER_NAME;
    delete process.env.REQUESTER_EMAIL;

    const personalInfo = portalSkyvern._buildWorkflowPersonalInfo({}, null);
    const payload = portalSkyvern.buildNavigationPayloadWithoutAccount({});

    assert.strictEqual(personalInfo.name, 'Samuel Hylton');
    assert.strictEqual(payload.requester_name, 'Samuel Hylton');
    assert.strictEqual(payload.first_name, 'Samuel');
    assert.strictEqual(payload.last_name, 'Hylton');
  });

  it('caps GovQA workflow attempts slightly above the longest clean successful run', function () {
    portalSkyvern.workflowSoftTimeoutMs = 1200000;

    const initialBudget = portalSkyvern._getWorkflowBudget({
      portalProvider: 'GovQA',
      portalUrl: 'https://records.govqa.us/WEBAPP/_rs/RequestLogin.aspx',
    });
    const retryBudget = portalSkyvern._getWorkflowBudget({
      portalProvider: 'GovQA',
      portalUrl: 'https://records.govqa.us/WEBAPP/_rs/RequestLogin.aspx',
      retryContext: { previousError: 'timeout' },
    });

    assert.strictEqual(initialBudget.provider, 'govqa');
    assert.strictEqual(initialBudget.softTimeoutMs, 960000);
    assert.strictEqual(initialBudget.maxSteps, 10);
    assert.strictEqual(retryBudget.softTimeoutMs, 780000);
    assert.strictEqual(retryBudget.maxSteps, 8);
  });

  it('sets NextRequest just above the longest clean successful run', function () {
    portalSkyvern.workflowSoftTimeoutMs = 1200000;

    const nextRequestBudget = portalSkyvern._getWorkflowBudget({
      portalProvider: 'NextRequest',
      portalUrl: 'https://city.nextrequest.com/'
    });
    const dryRunBudget = portalSkyvern._getWorkflowBudget({
      portalProvider: 'NextRequest',
      portalUrl: 'https://city.nextrequest.com/',
      dryRun: true
    });

    assert.strictEqual(nextRequestBudget.provider, 'nextrequest');
    assert.strictEqual(nextRequestBudget.softTimeoutMs, 540000);
    assert.strictEqual(nextRequestBudget.maxSteps, 8);
    assert.strictEqual(dryRunBudget.softTimeoutMs, 420000);
    assert.strictEqual(dryRunBudget.maxSteps, 6);
  });

  it('gives formcenter-style portals the same ceiling as the longest successful custom form runs', function () {
    portalSkyvern.workflowSoftTimeoutMs = 1200000;

    const budget = portalSkyvern._getWorkflowBudget({
      portalProvider: 'Form Center (custom city form)',
      portalUrl: 'https://roanokeva.gov/FormCenter/Police-26/FOIA-Request-Form-Police-Department-Only-154'
    });

    assert.strictEqual(budget.provider, 'formcenter');
    assert.strictEqual(budget.softTimeoutMs, 960000);
    assert.strictEqual(budget.maxSteps, 12);
  });

  it('extracts normalized workflow telemetry from status payloads', function () {
    const snapshot = portalSkyvern._extractWorkflowProgressSnapshot({
      status: 'running',
      screenshot_urls: ['https://one.png', 'https://two.png'],
      current_url: 'https://portal.example.com/form',
      latest_step: { label: 'Fill request form', step_index: 4 },
    }, 'running');

    assert.strictEqual(snapshot.actionCount, 4);
    assert.strictEqual(snapshot.currentUrl, 'https://portal.example.com/form');
    assert.strictEqual(snapshot.currentStep, 'Fill request form');
    assert.strictEqual(snapshot.screenshotCount, 2);
    assert.strictEqual(snapshot.latestScreenshotUrl, 'https://two.png');
    assert.strictEqual(snapshot.hasSignals, true);
  });

  it('treats a terminated workflow with a completed inner task as a successful submission', function () {
    const innerTask = portalSkyvern._extractSuccessfulInnerTaskResult({
      status: 'terminated',
      block_1_output: {
        task_id: 'tsk_123',
        task_status: 'completed',
        errors: [],
        outputs: { confirmation_number: 'ABC-123' },
      },
    });

    assert.ok(innerTask);
    assert.strictEqual(innerTask.taskId, 'tsk_123');
    assert.strictEqual(innerTask.taskStatus, 'completed');
    assert.deepStrictEqual(innerTask.output, { confirmation_number: 'ABC-123' });
  });

  it('cuts off workflow runs that show no progress for too long', async function () {
    process.env.SKYVERN_WORKFLOW_LOOP_MIN_ELAPSED_MS = '5';
    process.env.SKYVERN_WORKFLOW_LOOP_MAX_STAGNANT_POLLS = '3';

    const getStub = sinon.stub(axios, 'get').resolves({
      data: {
        status: 'running',
        current_url: 'https://portal.example.com/form',
        action_count: 2,
      },
    });
    const cancelStub = sinon.stub(portalSkyvern, 'cancelWorkflowRun').resolves(true);
    const logStub = sinon.stub(database, 'logActivity').resolves();
    const queryStub = sinon.stub(database, 'query').resolves({ rows: [] });

    try {
      const result = await portalSkyvern._pollWorkflowRun('wr_test_loop', 12345, {
        provider: 'nextrequest',
        pollIntervalMs: 1,
        softTimeoutMs: 50,
        maxSteps: 8,
      });

      assert.strictEqual(result.status, 'loop_detected');
      assert.strictEqual(result.loop_detected, true);
      assert.strictEqual(result.autobot_portal_telemetry.action_count, 2);
      sinon.assert.calledOnce(cancelStub);
      sinon.assert.calledWith(
        logStub,
        'portal_loop_detected',
        sinon.match.string,
        sinon.match({
          case_id: 12345,
          current_url: 'https://portal.example.com/form',
          action_count: 2,
        })
      );
      assert.ok(getStub.callCount >= 3);
    } finally {
      delete process.env.SKYVERN_WORKFLOW_LOOP_MIN_ELAPSED_MS;
      delete process.env.SKYVERN_WORKFLOW_LOOP_MAX_STAGNANT_POLLS;
      getStub.restore();
      cancelStub.restore();
      logStub.restore();
      queryStub.restore();
    }
  });
});
