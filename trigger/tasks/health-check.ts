import { task } from "@trigger.dev/sdk";
import db, { logger } from "../lib/db";

// Same imports as process-inbound to test if they hang
import { loadContext } from "../steps/load-context";
import { classifyInbound } from "../steps/classify-inbound";
import { updateConstraints } from "../steps/update-constraints";
import { decideNextAction } from "../steps/decide-next-action";
import { draftResponse } from "../steps/draft-response";
import { safetyCheck } from "../steps/safety-check";
import { createProposalAndGate } from "../steps/gate-or-execute";
import { executeAction } from "../steps/execute-action";
import { commitState } from "../steps/commit-state";
import { researchContext, determineResearchLevel, emptyResearchContext } from "../steps/research-context";

export const healthCheck = task({
  id: "health-check",
  maxDuration: 60,
  run: async (payload: { test: string; caseId?: number }) => {
    const results: Record<string, any> = {};

    // Test DB connectivity
    try {
      const r = await db.query("SELECT 1 as ping");
      results.dbPing = "ok";
    } catch (e: any) { results.dbPing = e.message; }

    // Test createAgentRun (the exact call that may be hanging)
    if (payload.caseId) {
      try {
        await db.query(
          `UPDATE agent_runs SET status = 'failed', error = 'superseded by health-check'
           WHERE case_id = $1 AND status IN ('created', 'queued', 'running')`,
          [payload.caseId]
        );
        results.clearStale = "ok";

        const agentRun = await db.createAgentRun(payload.caseId, "HEALTH_CHECK", {
          source: "health-check",
        });
        results.createAgentRun = `ok (id: ${agentRun.id})`;

        // Clean up the test run
        await db.query("UPDATE agent_runs SET status = 'failed' WHERE id = $1", [agentRun.id]);
        results.cleanup = "ok";
      } catch (e: any) { results.createAgentRun = e.message; }
    }

    // Test loadContext
    if (payload.caseId) {
      try {
        const { loadContext } = await import("../steps/load-context");
        const ctx = await loadContext(payload.caseId, null);
        results.loadContext = `ok (agency: ${ctx.caseData?.agency_name})`;
      } catch (e: any) { results.loadContext = e.message; }
    }

    return results;
  },
});
