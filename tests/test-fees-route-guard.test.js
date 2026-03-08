const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

const feesRouter = require('../routes/test/fees');

describe('Legacy test fee routes', function () {
  it('rejects legacy fee approve writes', async function () {
    const app = express();
    app.use(express.json());
    app.use('/api/test', feesRouter);

    const response = await supertest(app)
      .post('/api/test/fee-responses/123/approve')
      .send({ approved_by: 'tester' });

    assert.strictEqual(response.status, 410);
    assert.match(response.body.error, /retired/i);
  });

  it('rejects legacy fee regenerate writes', async function () {
    const app = express();
    app.use(express.json());
    app.use('/api/test', feesRouter);

    const response = await supertest(app)
      .post('/api/test/fee-responses/123/regenerate')
      .send({ instructions: 'please revise' });

    assert.strictEqual(response.status, 410);
    assert.match(response.body.error, /retired/i);
  });
});
