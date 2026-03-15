const assert = require("assert");
const sinon = require("sinon");
const { tasks, runs } = require("@trigger.dev/sdk");

const db = require("../services/database");
const triggerDispatch = require("../services/trigger-dispatch-service");

describe("trigger dispatch service", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("hydrates human review process-inbound runs with the latest inbound message", async function () {
    sinon.stub(db, "query").callsFake(async (sql) => {
      const normalized = String(sql);
      if (normalized.includes("FROM messages")) {
        return { rows: [{ id: 724 }] };
      }
      if (normalized.includes("FROM agent_runs")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const triggerStub = sinon.stub(tasks, "trigger").resolves({ id: "tr_123" });
    sinon.stub(runs, "retrieve").resolves({ status: "QUEUED" });

    const result = await triggerDispatch.triggerTask(
      "process-inbound",
      {
        caseId: 25159,
        triggerType: "HUMAN_REVIEW_RESOLUTION",
        messageId: null,
      },
      {},
      {
        caseId: 25159,
        triggerType: "HUMAN_REVIEW_RESOLUTION",
      }
    );

    assert.strictEqual(result.handle.id, "tr_123");
    sinon.assert.calledOnce(triggerStub);
    const [taskId, payload, options] = triggerStub.firstCall.args;
    assert.strictEqual(taskId, "process-inbound");
    assert.strictEqual(payload.messageId, 724);
    assert.strictEqual(options.idempotencyKey, "process-inbound:25159:724:human_review_resolution");
  });
});
