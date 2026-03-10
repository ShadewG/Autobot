const assert = require("assert");
const express = require("express");
const supertest = require("supertest");
const sinon = require("sinon");
const { wait: triggerWait } = require("@trigger.dev/sdk");

const runEngineRouter = require("../routes/run-engine");
const db = require("../services/database");
const triggerDispatch = require("../services/trigger-dispatch-service");
const proposalLifecycle = require("../services/proposal-lifecycle");

describe("run-initial explicit contact restart", function () {
  let app;
  let originalNodeEnv;

  beforeEach(function () {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    app = express();
    app.use(express.json());
    app.use("/", runEngineRouter);

    sinon.stub(db, "getCaseById").resolves({
      id: 25150,
      portal_url: "https://www.southstpaulmn.gov/FormCenter/Police-8/Request-for-Police-Data-67",
      agency_email: "ssppdclerical@southstpaul.org",
    });
    sinon.stub(db, "getActiveRunForCase").resolves({
      id: 2765,
      status: "waiting",
      trigger_type: "human_review_resolution",
      started_at: "2026-03-10T10:00:00.000Z",
      metadata: {
        current_node: "wait_human_decision",
      },
    });
    sinon.stub(db, "createAgentRunFull").resolves({
      id: 3001,
      status: "queued",
      langgraph_thread_id: "initial:25150:test",
      metadata: {},
    });
    sinon.stub(db, "query").callsFake(async (sql) => {
      const normalized = String(sql);
      if (normalized.includes("SELECT id, waitpoint_token FROM proposals")) {
        return { rows: [{ id: 1981, waitpoint_token: "waitpoint_1981" }] };
      }
      if (normalized.includes("UPDATE agent_runs") && normalized.includes("SET status = 'failed'")) {
        return { rows: [{ id: 2765 }] };
      }
      if (normalized.includes("UPDATE agent_runs SET metadata = COALESCE")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    sinon.stub(triggerDispatch, "triggerTask").resolves({
      handle: { id: "run_trigger_3001" },
    });
    sinon.stub(proposalLifecycle, "dismissActiveCaseProposals").resolves();
    sinon.stub(triggerWait, "completeToken").resolves();
  });

  afterEach(function () {
    process.env.NODE_ENV = originalNodeEnv;
    sinon.restore();
  });

  it("supersedes the stale waiting review run and forwards the selected route", async function () {
    const response = await supertest(app)
      .post("/cases/25150/run-initial")
      .send({
        autopilotMode: "SUPERVISED",
        route_mode: "portal",
        force_restart: true,
      });

    assert.strictEqual(response.status, 202);
    assert.strictEqual(response.body.success, true);
    sinon.assert.calledOnce(triggerDispatch.triggerTask);
    sinon.assert.calledOnce(proposalLifecycle.dismissActiveCaseProposals);
    sinon.assert.calledOnce(triggerWait.completeToken);

    const payload = triggerDispatch.triggerTask.firstCall.args[1];
    assert.strictEqual(payload.caseId, 25150);
    assert.strictEqual(payload.routeMode, "portal");

    const failQuery = db.query.getCalls().find((call) => {
      const sql = String(call.args[0]);
      return sql.includes("UPDATE agent_runs") && sql.includes("SET status = 'failed'");
    });
    assert.ok(failQuery, "expected stale waiting run to be superseded");
  });

  it("rejects portal routing when the selected case channel does not have a portal", async function () {
    db.getCaseById.restore();
    sinon.stub(db, "getCaseById").resolves({
      id: 25150,
      portal_url: null,
      agency_email: "ssppdclerical@southstpaul.org",
    });

    const response = await supertest(app)
      .post("/cases/25150/run-initial")
      .send({
        autopilotMode: "SUPERVISED",
        route_mode: "portal",
        force_restart: true,
      });

    assert.strictEqual(response.status, 400);
    assert.match(response.body.error, /does not have a portal url/i);
    sinon.assert.notCalled(triggerDispatch.triggerTask);
  });
});
