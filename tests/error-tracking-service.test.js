const assert = require('assert');
const sinon = require('sinon');

const db = require('../services/database');
const logger = require('../services/logger');
const errorTrackingService = require('../services/error-tracking-service');

describe('Error tracking service', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('persists normalized exception events and logs case activity', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [{ id: 91 }] });
    const logActivityStub = sinon.stub(db, 'logActivity').resolves({ id: 55 });
    sinon.stub(logger, 'error');
    sinon.stub(logger, 'warn');

    const error = new Error('Weekly report failed');
    error.code = 'E_WEEKLY';

    const row = await errorTrackingService.captureException(error, {
      sourceService: 'cron_service',
      operation: 'weekly_quality_report_cron',
      caseId: 42,
      retryable: true,
      retryAttempt: 3,
      metadata: {
        reportWindow: 7,
      },
    });

    assert.strictEqual(row.id, 91);
    assert.strictEqual(queryStub.calledOnce, true);
    const [, params] = queryStub.firstCall.args;
    assert.strictEqual(params[0], 'cron_service');
    assert.strictEqual(params[1], 'weekly_quality_report_cron');
    assert.strictEqual(params[2], 42);
    assert.strictEqual(params[7], 'E_WEEKLY');
    assert.strictEqual(params[10], true);
    assert.strictEqual(params[11], 3);
    assert.deepStrictEqual(params[12], { reportWindow: 7 });

    assert.strictEqual(logActivityStub.calledOnce, true);
    assert.strictEqual(logActivityStub.firstCall.args[0], 'tracked_error');
    assert.strictEqual(logActivityStub.firstCall.args[2].case_id, 42);
    assert.strictEqual(logActivityStub.firstCall.args[2].tracked_error_id, 91);
  });

  it('searches tracked errors with filters', async function () {
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [{ id: 1 }] });

    const rows = await errorTrackingService.searchErrorEvents({
      sourceService: 'eval_api',
      caseId: 10,
      operation: 'quality_report',
      errorCode: 'E_FAIL',
      sinceHours: 24,
      search: 'timeout',
      limit: 5,
    });

    assert.deepStrictEqual(rows, [{ id: 1 }]);
    const [sql, params] = queryStub.firstCall.args;
    assert.match(sql, /FROM error_events/);
    assert.match(sql, /source_service = \$1/);
    assert.match(sql, /case_id = \$2/);
    assert.match(sql, /operation = \$3/);
    assert.match(sql, /error_code = \$4/);
    assert.match(sql, /created_at >= NOW\(\) - \(\$5::int \* INTERVAL '1 hour'\)/);
    assert.match(sql, /error_message ILIKE \$6/);
    assert.strictEqual(params[0], 'eval_api');
    assert.strictEqual(params[1], 10);
    assert.strictEqual(params[2], 'quality_report');
    assert.strictEqual(params[3], 'E_FAIL');
    assert.strictEqual(params[4], 24);
    assert.strictEqual(params[5], '%timeout%');
    assert.strictEqual(params[6], 5);
  });
});
