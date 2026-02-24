/**
 * Test Script: Invoke Trigger.dev process-inbound task locally
 *
 * Usage:
 *   npx tsx scripts/test-trigger-inbound.ts [caseId] [messageId]
 *
 * This script tests the full inbound pipeline:
 * 1. Loads a real case from the database
 * 2. Runs through all steps (classify, decide, draft, safety, gate)
 * 3. Stops at the human gate (doesn't execute)
 * 4. Prints the proposal for review
 *
 * For a full end-to-end test with Trigger.dev:
 *   npx trigger dev
 *   Then trigger via the dashboard or API
 */

import "dotenv/config";

// Import steps directly (bypass Trigger.dev task wrapper for local testing)
import { loadContext } from "../trigger/steps/load-context";
import { classifyInbound } from "../trigger/steps/classify-inbound";
import { updateConstraints } from "../trigger/steps/update-constraints";
import { decideNextAction } from "../trigger/steps/decide-next-action";
import { draftResponse } from "../trigger/steps/draft-response";
import { safetyCheck } from "../trigger/steps/safety-check";

// @ts-ignore
const db = require("../services/database");

// @ts-ignore
const { DRAFT_REQUIRED_ACTIONS } = require("../constants/action-types");

async function main() {
  const caseId = parseInt(process.argv[2] || "49", 10);
  const messageId = process.argv[3] ? parseInt(process.argv[3], 10) : null;

  console.log(`\n=== Testing Trigger.dev Inbound Pipeline ===`);
  console.log(`Case: ${caseId}, Message: ${messageId || "latest"}\n`);

  try {
    // Step 1: Load context
    console.log("Step 1: Loading context...");
    const context = await loadContext(caseId, messageId);
    console.log(`  Case: ${context.caseData.case_name}`);
    console.log(`  Agency: ${context.caseData.agency_name}`);
    console.log(`  Messages: ${context.messages.length}`);
    console.log(`  Constraints: ${context.constraints.join(", ") || "none"}`);
    console.log(`  Autopilot: ${context.autopilotMode}`);

    // Resolve messageId if not provided
    const resolvedMessageId = messageId ||
      context.messages.find((m: any) => m.direction === "inbound")?.id;

    if (!resolvedMessageId) {
      console.log("\nNo inbound messages found. Testing as followup trigger...");

      const decision = await decideNextAction(
        caseId, "NO_RESPONSE", context.constraints, null, "neutral",
        context.autopilotMode, "SCHEDULED_FOLLOWUP", false, null, null, null, null
      );
      console.log(`\nDecision: ${decision.actionType}`);
      console.log(`Reasoning: ${decision.reasoning.join("; ")}`);
      console.log(`Auto-execute: ${decision.canAutoExecute}`);
      console.log(`Requires human: ${decision.requiresHuman}`);
      return;
    }

    // Step 2: Classify
    console.log(`\nStep 2: Classifying message #${resolvedMessageId}...`);
    const classification = await classifyInbound(context, resolvedMessageId, "INBOUND_MESSAGE");
    console.log(`  Classification: ${classification.classification}`);
    console.log(`  Confidence: ${classification.confidence}`);
    console.log(`  Sentiment: ${classification.sentiment}`);
    console.log(`  Requires response: ${classification.requiresResponse}`);
    console.log(`  Fee amount: ${classification.extractedFeeAmount ?? "none"}`);
    console.log(`  Portal URL: ${classification.portalUrl || "none"}`);
    console.log(`  Suggested action: ${classification.suggestedAction || "none"}`);
    if (classification.denialSubtype) console.log(`  Denial subtype: ${classification.denialSubtype}`);

    // Step 3: Update constraints
    console.log("\nStep 3: Updating constraints...");
    const { constraints, scopeItems } = await updateConstraints(
      caseId, classification.classification, classification.extractedFeeAmount,
      resolvedMessageId, context.constraints, context.scopeItems
    );
    console.log(`  Constraints: ${constraints.join(", ") || "none"}`);
    console.log(`  Scope items: ${scopeItems.length}`);

    // Step 4: Decide
    console.log("\nStep 4: Deciding next action...");
    const decision = await decideNextAction(
      caseId, classification.classification, constraints,
      classification.extractedFeeAmount, classification.sentiment,
      context.autopilotMode, "INBOUND_MESSAGE",
      classification.requiresResponse, classification.portalUrl,
      classification.suggestedAction, classification.reasonNoResponse,
      classification.denialSubtype
    );
    console.log(`  Action: ${decision.actionType}`);
    console.log(`  Auto-execute: ${decision.canAutoExecute}`);
    console.log(`  Requires human: ${decision.requiresHuman}`);
    console.log(`  Reasoning:`);
    decision.reasoning.forEach((r: string) => console.log(`    - ${r}`));

    if (decision.isComplete || decision.actionType === "NONE") {
      console.log("\n=== Pipeline complete: no action needed ===");
      return;
    }

    // Step 5: Draft (if needed)
    const needsDraft = DRAFT_REQUIRED_ACTIONS.includes(decision.actionType) ||
      ["RESEARCH_AGENCY", "REFORMULATE_REQUEST"].includes(decision.actionType);

    if (needsDraft) {
      console.log(`\nStep 5: Drafting ${decision.actionType}...`);
      const draft = await draftResponse(
        caseId, decision.actionType, constraints, scopeItems,
        classification.extractedFeeAmount, decision.adjustmentInstruction,
        resolvedMessageId
      );
      console.log(`  Subject: ${draft.subject || "(none)"}`);
      console.log(`  Body preview: ${(draft.bodyText || "").substring(0, 200)}...`);
      console.log(`  Lessons applied: ${draft.lessonsApplied.length}`);

      // Step 6: Safety check
      console.log("\nStep 6: Safety check...");
      const safety = await safetyCheck(
        draft.bodyText, draft.subject, decision.actionType,
        constraints, scopeItems
      );
      console.log(`  Risk flags: ${safety.riskFlags.join(", ") || "none"}`);
      console.log(`  Warnings: ${safety.warnings.join(", ") || "none"}`);
      console.log(`  Can auto-execute: ${safety.canAutoExecute}`);
    }

    console.log("\n=== Pipeline complete ===");
    console.log("Next: proposal would be created and gated for human approval");
    console.log("Use Trigger.dev dashboard to approve/dismiss");
  } catch (error: any) {
    console.error(`\nERROR: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    try { await db.close(); } catch (e: any) { /* ignore */ }
  }
}

main();
