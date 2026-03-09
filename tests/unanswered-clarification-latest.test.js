require("tsx/cjs");

const { describe, it, beforeEach, afterEach } = require("mocha");
const { expect } = require("chai");

const db = require("../services/database");

describe("Latest unanswered clarification detection", function () {
  let originalGetMessagesByCaseId;
  let originalQuery;

  beforeEach(function () {
    originalGetMessagesByCaseId = db.getMessagesByCaseId;
    originalQuery = db.query;
  });

  afterEach(function () {
    db.getMessagesByCaseId = originalGetMessagesByCaseId;
    db.query = originalQuery;
  });

  it("ignores an older unanswered clarification when a newer acknowledgment supersedes it", async function () {
    const { checkUnansweredClarification } = require("../trigger/steps/decide-next-action.ts");

    db.getMessagesByCaseId = async () => ([
      { id: 100, direction: "inbound" },
      { id: 101, direction: "outbound" },
      { id: 102, direction: "inbound" },
    ]);
    db.query = async (sql) => {
      if (String(sql).includes("FROM response_analysis")) {
        return {
          rows: [
            { message_id: 102, intent: "acknowledgment", created_at: "2026-03-09T12:36:29.874Z" },
            { message_id: 100, intent: "question", created_at: "2026-03-09T12:36:07.723Z" },
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    };

    const result = await checkUnansweredClarification(25157);
    expect(result).to.equal(null);
  });

  it("returns the latest clarification message id when the newest inbound still needs a reply", async function () {
    const { checkUnansweredClarification } = require("../trigger/steps/decide-next-action.ts");

    db.getMessagesByCaseId = async () => ([
      { id: 200, direction: "inbound" },
      { id: 201, direction: "outbound" },
      { id: 202, direction: "inbound" },
    ]);
    db.query = async (sql) => {
      if (String(sql).includes("FROM response_analysis")) {
        return {
          rows: [
            { message_id: 202, intent: "question", created_at: "2026-03-09T12:40:00.000Z" },
            { message_id: 200, intent: "acknowledgment", created_at: "2026-03-09T12:35:00.000Z" },
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    };

    const result = await checkUnansweredClarification(25158);
    expect(result).to.equal(202);
  });
});
