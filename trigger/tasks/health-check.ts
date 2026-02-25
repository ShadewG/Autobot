import { task } from "@trigger.dev/sdk/v3";

export const healthCheck = task({
  id: "health-check",
  maxDuration: 60,
  run: async (payload: { test: string }) => {
    const results: Record<string, string> = {};

    // Test each import
    try {
      const { loadContext } = await import("../steps/load-context");
      results.loadContext = "ok";
    } catch (e: any) { results.loadContext = e.message; }

    try {
      const { classifyInbound } = await import("../steps/classify-inbound");
      results.classifyInbound = "ok";
    } catch (e: any) { results.classifyInbound = e.message; }

    try {
      const { updateConstraints } = await import("../steps/update-constraints");
      results.updateConstraints = "ok";
    } catch (e: any) { results.updateConstraints = e.message; }

    try {
      const { decideNextAction } = await import("../steps/decide-next-action");
      results.decideNextAction = "ok";
    } catch (e: any) { results.decideNextAction = e.message; }

    try {
      const { draftResponse } = await import("../steps/draft-response");
      results.draftResponse = "ok";
    } catch (e: any) { results.draftResponse = e.message; }

    try {
      const { safetyCheck } = await import("../steps/safety-check");
      results.safetyCheck = "ok";
    } catch (e: any) { results.safetyCheck = e.message; }

    try {
      const { createProposalAndGate } = await import("../steps/gate-or-execute");
      results.gateOrExecute = "ok";
    } catch (e: any) { results.gateOrExecute = e.message; }

    try {
      const { executeAction } = await import("../steps/execute-action");
      results.executeAction = "ok";
    } catch (e: any) { results.executeAction = e.message; }

    try {
      const { commitState } = await import("../steps/commit-state");
      results.commitState = "ok";
    } catch (e: any) { results.commitState = e.message; }

    try {
      const rc = await import("../steps/research-context");
      results.researchContext = "ok";
    } catch (e: any) { results.researchContext = e.message; }

    try {
      const db = await import("../lib/db");
      results.db = "ok";
    } catch (e: any) { results.db = e.message; }

    try {
      const ai = await import("../lib/ai");
      results.ai = "ok";
    } catch (e: any) { results.ai = e.message; }

    return results;
  },
});
