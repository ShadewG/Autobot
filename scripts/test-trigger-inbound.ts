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

import { config } from "dotenv";
config({ path: ".env" });
if (!process.env.DATABASE_URL) {
  config({ path: ".env.test", override: false });
}

// Import steps directly (bypass Trigger.dev task wrapper for local testing)
import { loadContext } from "../trigger/steps/load-context";
import { classifyInbound } from "../trigger/steps/classify-inbound";
import { updateConstraints } from "../trigger/steps/update-constraints";
import { decideNextAction } from "../trigger/steps/decide-next-action";
import { draftResponse } from "../trigger/steps/draft-response";
import { safetyCheck } from "../trigger/steps/safety-check";
import { createProposalAndGate } from "../trigger/steps/gate-or-execute";

// @ts-ignore
const db = require("../services/database");
// @ts-ignore
const pdfFormService = require("../services/pdf-form-service");

// @ts-ignore
const { DRAFT_REQUIRED_ACTIONS } = require("../constants/action-types");

function parseArgs(argv: string[]) {
  const args = [...argv];
  let caseId = 49;
  let messageId: number | null = null;
  let materialize = false;
  let forcePdfFailure = false;
  let cleanupFilled = false;

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--materialize") {
      materialize = true;
      continue;
    }
    if (arg === "--force-pdf-failure") {
      forcePdfFailure = true;
      continue;
    }
    if (arg === "--cleanup-filled") {
      cleanupFilled = true;
      continue;
    }
    if (/^\d+$/.test(arg) && caseId === 49) {
      caseId = parseInt(arg, 10);
      continue;
    }
    if (/^\d+$/.test(arg) && messageId === null) {
      messageId = parseInt(arg, 10);
      continue;
    }
  }

  return { caseId, messageId, materialize, forcePdfFailure, cleanupFilled };
}

async function clearPendingReviewState(caseId: number) {
  await db.query(
    `UPDATE proposals
        SET status = 'DISMISSED',
            waitpoint_token = NULL,
            updated_at = NOW()
      WHERE case_id = $1
        AND status IN ('PENDING_APPROVAL', 'DECISION_RECEIVED', 'CHAIN_PENDING')`,
    [caseId]
  );
  await db.query(
    `UPDATE agent_runs
        SET status = 'cancelled',
            ended_at = NOW(),
            error = COALESCE(error, 'replaced by local inbound materialization')
      WHERE case_id = $1
        AND status IN ('created', 'queued', 'processing', 'running', 'paused', 'waiting', 'gated')`,
    [caseId]
  );
}

async function cleanupGeneratedFilledAttachments(caseId: number) {
  await db.query(
    `DELETE FROM attachments
      WHERE case_id = $1
        AND message_id IS NULL
        AND filename LIKE 'filled_%'`,
    [caseId]
  );
}

async function main() {
  const { caseId, messageId, materialize, forcePdfFailure, cleanupFilled } = parseArgs(process.argv.slice(2));

  const originalPrepareInboundPdfFormReply = pdfFormService.prepareInboundPdfFormReply;
  if (forcePdfFailure) {
    pdfFormService.prepareInboundPdfFormReply = async () => ({
      success: false,
      manualRequired: true,
      error: "Forced local PDF preparation failure for UI verification",
      sourceAttachmentId: null,
      sourceFilename: "New FOIA Request Form.pdf",
    });
  }

  console.log(`\n=== Testing Trigger.dev Inbound Pipeline ===`);
  console.log(`Case: ${caseId}, Message: ${messageId || "latest"}\n`);
  if (materialize) {
    console.log(`Materialize mode: ON`);
  }
  if (forcePdfFailure) {
    console.log(`PDF preparation failure forced: YES`);
  }

  try {
    if (cleanupFilled) {
      await cleanupGeneratedFilledAttachments(caseId);
      console.log(`Cleaned generated filled PDFs for case ${caseId}`);
    }

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

      if (draft.attachment_id) {
        console.log(`  Attachment ID: ${draft.attachment_id}`);
      }
      if (draft.attachment_filename) {
        console.log(`  Attachment filename: ${draft.attachment_filename}`);
      }

      if (materialize) {
        console.log("\nStep 7: Materializing proposal into local DB...");
        await clearPendingReviewState(caseId);
        const agentRun = await db.createAgentRun(caseId, "INBOUND_MESSAGE", {
          messageId: resolvedMessageId,
          source: "local_materialized_inbound_test",
          forcePdfFailure,
        });
        await db.updateAgentRun(agentRun.id, {
          status: "running",
          started_at: new Date(),
          metadata: {
            messageId: resolvedMessageId,
            source: "local_materialized_inbound_test",
            forcePdfFailure,
          },
        });

        const gate = await createProposalAndGate(
          caseId,
          agentRun.id,
          decision.actionType,
          resolvedMessageId,
          draft,
          safety,
          decision.canAutoExecute,
          decision.requiresHuman,
          decision.pauseReason,
          decision.reasoning,
          classification.confidence,
          0,
          null,
          draft.lessonsApplied || null
        );

        await db.updateAgentRun(agentRun.id, {
          status: gate.shouldWait ? "waiting" : "completed",
          proposal_id: gate.proposalId,
          ended_at: gate.shouldWait ? null : new Date(),
          metadata: {
            messageId: resolvedMessageId,
            source: "local_materialized_inbound_test",
            forcePdfFailure,
            materializedProposalId: gate.proposalId,
          },
        });

        const proposal = await db.getProposalById(gate.proposalId);
        console.log(`  Materialized proposal ID: ${gate.proposalId}`);
        console.log(`  Proposal action: ${proposal?.action_type}`);
        console.log(`  Proposal status: ${proposal?.status}`);
        console.log(`  Wait token: ${proposal?.waitpoint_token || "none"}`);
      }
    }
    else if (materialize) {
      console.log("\nStep 5: No draft required, materializing decision-only proposal...");
      await clearPendingReviewState(caseId);
      const agentRun = await db.createAgentRun(caseId, "INBOUND_MESSAGE", {
        messageId: resolvedMessageId,
        source: "local_materialized_inbound_test",
        forcePdfFailure,
      });
      await db.updateAgentRun(agentRun.id, {
        status: "running",
        started_at: new Date(),
        metadata: {
          messageId: resolvedMessageId,
          source: "local_materialized_inbound_test",
          forcePdfFailure,
        },
      });

      const emptyDraft = { subject: null, bodyText: null, bodyHtml: null, lessonsApplied: [] as any[] };
      const safety = await safetyCheck(
        emptyDraft.bodyText,
        emptyDraft.subject,
        decision.actionType,
        constraints,
        scopeItems
      );

      const gate = await createProposalAndGate(
        caseId,
        agentRun.id,
        decision.actionType,
        resolvedMessageId,
        emptyDraft,
        safety,
        decision.canAutoExecute,
        decision.requiresHuman,
        decision.pauseReason,
        decision.reasoning,
        classification.confidence,
        0,
        null,
        emptyDraft.lessonsApplied
      );

      await db.updateAgentRun(agentRun.id, {
        status: gate.shouldWait ? "waiting" : "completed",
        proposal_id: gate.proposalId,
        ended_at: gate.shouldWait ? null : new Date(),
        metadata: {
          messageId: resolvedMessageId,
          source: "local_materialized_inbound_test",
          forcePdfFailure,
          materializedProposalId: gate.proposalId,
        },
      });

      const proposal = await db.getProposalById(gate.proposalId);
      console.log(`  Materialized proposal ID: ${gate.proposalId}`);
      console.log(`  Proposal action: ${proposal?.action_type}`);
      console.log(`  Proposal status: ${proposal?.status}`);
      console.log(`  Wait token: ${proposal?.waitpoint_token || "none"}`);
    }

    console.log("\n=== Pipeline complete ===");
    if (!materialize) {
      console.log("Next: proposal would be created and gated for human approval");
      console.log("Use --materialize to write the proposal into the local DB");
    }
  } catch (error: any) {
    console.error(`\nERROR: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    pdfFormService.prepareInboundPdfFormReply = originalPrepareInboundPdfFormReply;
    try { await db.close(); } catch (e: any) { /* ignore */ }
  }
}

main();
