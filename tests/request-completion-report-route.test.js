const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

const caseManagementRouter = require('../routes/requests/case-management');
const { db } = require('../routes/requests/_helpers');
const recordsDeliveryService = require('../services/records-delivery-service');

describe('request completion report route', function () {
  let originalGetCaseById;
  let originalBuildCaseCompletionReport;

  beforeEach(function () {
    originalGetCaseById = db.getCaseById;
    originalBuildCaseCompletionReport = recordsDeliveryService.buildCaseCompletionReport;
  });

  afterEach(function () {
    db.getCaseById = originalGetCaseById;
    recordsDeliveryService.buildCaseCompletionReport = originalBuildCaseCompletionReport;
  });

  it('returns a completion report for the case', async function () {
    db.getCaseById = async (caseId) => ({ id: caseId, case_name: 'Completion Report Case' });
    recordsDeliveryService.buildCaseCompletionReport = async (caseId) => ({
      case_id: caseId,
      requested: [
        { requested_item: 'Incident report', received: true, received_count: 1, received_records: [] },
      ],
      unmatched: [],
      complete: true,
      outstanding: [],
      received_count: 1,
    });

    const app = express();
    app.use('/api/requests', caseManagementRouter);

    const response = await supertest(app).get('/api/requests/42/completion-report');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.case_id, 42);
    assert.strictEqual(response.body.report.complete, true);
  });
});
