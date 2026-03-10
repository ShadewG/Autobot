const assert = require("assert");
const express = require("express");
const supertest = require("supertest");

const requestRouter = require("../routes/requests/query");
const db = require("../services/database");

describe("workspace import warning suppression", function () {
  const originalDbMethods = {};

  beforeEach(function () {
    originalDbMethods.getCaseById = db.getCaseById;
    originalDbMethods.getCaseAgencies = db.getCaseAgencies;
    originalDbMethods.getThreadsByCaseId = db.getThreadsByCaseId;
    originalDbMethods.getMessagesByThreadId = db.getMessagesByThreadId;
    originalDbMethods.getAttachmentsByCaseId = db.getAttachmentsByCaseId;
    originalDbMethods.getUserById = db.getUserById;
    originalDbMethods.query = db.query;
  });

  afterEach(function () {
    db.getCaseById = originalDbMethods.getCaseById;
    db.getCaseAgencies = originalDbMethods.getCaseAgencies;
    db.getThreadsByCaseId = originalDbMethods.getThreadsByCaseId;
    db.getMessagesByThreadId = originalDbMethods.getMessagesByThreadId;
    db.getAttachmentsByCaseId = originalDbMethods.getAttachmentsByCaseId;
    db.getUserById = originalDbMethods.getUserById;
    db.query = originalDbMethods.query;
  });

  it("hides stale AGENCY_NOT_IN_DIRECTORY warnings once a canonical agency id is present", async function () {
    db.getCaseById = async () => ({
      id: 25150,
      subject_name: "Casey Johnson",
      case_name: "Casey Johnson bodycam request",
      agency_id: 1015,
      agency_name: "South St. Paul Police Department, Minnesota",
      agency_email: "ssppdclerical@southstpaul.org",
      portal_url: "https://www.southstpaulmn.gov/FormCenter/Police-8/Request-for-Police-Data-67",
      portal_provider: "civicplus",
      state: "MN",
      status: "needs_human_review",
      requires_human: true,
      pause_reason: "SENSITIVE",
      substatus: "Proposal pending review",
      requested_records: ["Body camera footage"],
      autopilot_mode: "SUPERVISED",
      created_at: "2026-03-10T00:00:00.000Z",
      updated_at: "2026-03-10T00:00:00.000Z",
      next_due_at: null,
      last_response_date: null,
      import_warnings: [
        {
          type: "AGENCY_NOT_IN_DIRECTORY",
          message: 'Agency "South St. Paul Police Department, Minnesota" not found in directory',
        },
      ],
      contact_research_notes: null,
      additional_details: null,
      user_id: null,
    });
    db.getCaseAgencies = async () => ([{
      id: 56,
      case_id: 25150,
      agency_id: 1015,
      agency_name: "South St. Paul Police Department, Minnesota",
      agency_email: "ssppdclerical@southstpaul.org",
      portal_url: "https://www.southstpaulmn.gov/FormCenter/Police-8/Request-for-Police-Data-67",
      portal_provider: "civicplus",
      is_primary: true,
      is_active: true,
      added_source: "research",
      status: "active",
      created_at: "2026-03-10T00:00:00.000Z",
      updated_at: "2026-03-10T00:00:00.000Z",
    }]);
    db.getThreadsByCaseId = async () => [];
    db.getMessagesByThreadId = async () => [];
    db.getAttachmentsByCaseId = async () => [];
    db.getUserById = async () => null;
    db.query = async (sql) => {
      if (String(sql).includes("FROM portal_tasks")) return { rows: [] };
      if (String(sql).includes("FROM activity_log")) return { rows: [] };
      if (String(sql).includes("FROM auto_reply_queue")) return { rows: [] };
      if (String(sql).includes("FROM proposals")) return { rows: [] };
      if (String(sql).includes("FROM agent_decisions")) return { rows: [] };
      if (String(sql).includes("FROM agent_runs")) return { rows: [] };
      if (String(sql).includes("FROM agencies a") && String(sql).includes("score DESC")) return { rows: [] };
      if (String(sql).includes("FROM agencies") && String(sql).includes("WHERE id = $1")) {
        return { rows: [{ id: 1015, name: "South St. Paul Police Department, Minnesota" }] };
      }
      if (String(sql).includes("FROM agencies") && String(sql).includes("WHERE name = $1")) return { rows: [] };
      if (String(sql).includes("FROM agencies") && String(sql).includes("WHERE portal_url = $1")) return { rows: [] };
      if (String(sql).includes("FROM agencies") && String(sql).includes("WHERE LOWER(email_main) = LOWER($1)")) return { rows: [] };
      throw new Error(`Unexpected query in warning suppression test: ${sql}`);
    };

    const app = express();
    app.use("/api/requests", requestRouter);

    const response = await supertest(app).get("/api/requests/25150/workspace");

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.request.agency_name, "South St. Paul Police Department, Minnesota");
    assert.strictEqual(response.body.request.import_warnings, null);
    assert.strictEqual(response.body.agency_summary.id, "1015");
  });
});
