const assert = require('assert');
const express = require('express');
const sinon = require('sinon');
const supertest = require('supertest');

const db = require('../services/database');
const sdk = require('@trigger.dev/sdk');

describe('Simulation and eval attachment plumbing', function () {
  afterEach(function () {
    sinon.restore();
    delete require.cache[require.resolve('../routes/simulate')];
    delete require.cache[require.resolve('../routes/eval')];
  });

  it('passes extracted attachments from the case into simulate-decision', async function () {
    sinon.stub(db, 'getCaseById').resolves({ id: 55 });
    sinon.stub(db, 'getAttachmentsByCaseId').resolves([
      {
        id: 8,
        message_id: 9,
        filename: 'fee-letter.pdf',
        content_type: 'application/pdf',
        extracted_text: 'Estimated duplication fees are $42.50.',
      },
    ]);
    const triggerStub = sinon.stub(sdk.tasks, 'trigger').resolves({ id: 'run_123' });

    const router = require('../routes/simulate');
    const app = express();
    app.use('/api/simulate', router);

    const response = await supertest(app)
      .post('/api/simulate')
      .send({
        messageBody: 'Please see attached fee estimate.',
        fromEmail: 'agency@example.gov',
        subject: 'Fee estimate',
        caseId: 55,
        hasAttachments: true,
      });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(triggerStub.calledOnce, true);
    assert.strictEqual(triggerStub.firstCall.args[0], 'simulate-decision');
    assert.deepStrictEqual(triggerStub.firstCall.args[1].attachments, [
      {
        id: 8,
        message_id: 9,
        filename: 'fee-letter.pdf',
        content_type: 'application/pdf',
        extracted_text: 'Estimated duplication fees are $42.50.',
      },
    ]);
  });

  it('stores simulation attachments on eval cases', async function () {
    sinon.stub(db, 'getCaseById').resolves({ id: 66 });
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [{ id: 1 }] });

    const router = require('../routes/eval');
    const app = express();
    app.use(express.json());
    app.use('/api/eval', router);

    const attachments = [
      { filename: 'denial-letter.pdf', extracted_text: 'Your request is denied.' },
    ];

    const response = await supertest(app)
      .post('/api/eval/cases/from-simulation')
      .send({
        expectedAction: 'SEND_APPEAL',
        predictedAction: 'SEND_APPEAL',
        messageBody: 'Please see attached denial letter.',
        fromEmail: 'agency@example.gov',
        subject: 'Denial letter',
        caseId: 66,
        reasoning: ['Formal exemption denial'],
        attachments,
      });

    assert.strictEqual(response.status, 200);
    assert.match(queryStub.firstCall.args[0], /simulated_attachments_jsonb/);
    assert.strictEqual(queryStub.firstCall.args[1][9], JSON.stringify(attachments));
  });
});
