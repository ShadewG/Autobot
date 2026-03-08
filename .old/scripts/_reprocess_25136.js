/**
 * Reprocess Case #25136 naturally — as if message #322 just arrived.
 * Tests the improved decide-next-action logic that detects unanswered clarifications.
 */
require("dotenv").config();
process.env.LANGGRAPH_DRY_RUN = 'false';

const db = require("../services/database");
const { classifyInboundNode } = require("../langgraph/nodes/classify-inbound");
const { updateConstraintsNode } = require("../langgraph/nodes/update-constraints");
const { decideNextActionNode } = require("../langgraph/nodes/decide-next-action");
const { draftResponseNode } = require("../langgraph/nodes/draft-response");

const CASE_ID = 25136;
const MESSAGE_ID = 322;  // "No Responsive Information" — the latest inbound

(async () => {
  console.log("=== Reprocessing Case #25136 naturally (msg #322) ===\n");

  // 0. Clean up old proposals
  const dismissed = await db.query(
    "UPDATE proposals SET status = 'DISMISSED', updated_at = NOW() WHERE case_id = $1 AND status = 'PENDING_APPROVAL' RETURNING id, action_type",
    [CASE_ID]
  );
  if (dismissed.rowCount > 0) {
    console.log("Dismissed old proposals:", dismissed.rows.map(p => `#${p.id} (${p.action_type})`));
  }

  // 1. CLASSIFY — run as if msg #322 just came in
  console.log("\n--- Step 1: classify_inbound ---");
  const classifyState = {
    caseId: CASE_ID,
    latestInboundMessageId: MESSAGE_ID,
    triggerType: 'INBOUND_MESSAGE'
  };
  const classifyResult = await classifyInboundNode(classifyState);
  console.log("Classification:", classifyResult.classification);
  console.log("Denial subtype:", classifyResult.denialSubtype);
  console.log("Requires response:", classifyResult.requiresResponse);
  console.log("Logs:", classifyResult.logs);

  // 2. UPDATE CONSTRAINTS
  console.log("\n--- Step 2: update_constraints ---");
  const constraintState = { caseId: CASE_ID, latestInboundMessageId: MESSAGE_ID };
  const constraintResult = await updateConstraintsNode(constraintState);
  console.log("Constraints:", constraintResult.constraints);

  // 3. DECIDE — this is what we fixed
  console.log("\n--- Step 3: decide_next_action ---");
  const decideState = {
    caseId: CASE_ID,
    classification: classifyResult.classification,
    denialSubtype: classifyResult.denialSubtype,
    extractedFeeAmount: classifyResult.extractedFeeAmount,
    sentiment: classifyResult.sentiment,
    constraints: constraintResult.constraints || [],
    triggerType: 'INBOUND_MESSAGE',
    autopilotMode: 'SUPERVISED',
    requiresResponse: classifyResult.requiresResponse,
    suggestedAction: classifyResult.suggestedAction,
    reasonNoResponse: classifyResult.reasonNoResponse,
    portalUrl: classifyResult.portalUrl
  };
  const decideResult = await decideNextActionNode(decideState);
  console.log("Action:", decideResult.proposalActionType);
  console.log("Reasoning:", decideResult.proposalReasoning);
  console.log("Logs:", decideResult.logs);

  // Check if it picked SEND_CLARIFICATION (the correct action)
  if (decideResult.proposalActionType !== 'SEND_CLARIFICATION') {
    console.log("\n⚠️  Expected SEND_CLARIFICATION but got:", decideResult.proposalActionType);
    console.log("The fix may need adjustment. Continuing anyway...\n");
  } else {
    console.log("\n✓ Correctly chose SEND_CLARIFICATION!\n");
  }

  // 4. DRAFT — generate the response
  console.log("--- Step 4: draft_response ---");
  const triggerMsgId = decideResult.latestInboundMessageId || MESSAGE_ID;
  const caseData = (await db.query("SELECT * FROM cases WHERE id = $1", [CASE_ID])).rows[0];
  const draftState = {
    caseId: CASE_ID,
    proposalActionType: decideResult.proposalActionType,
    constraints: constraintResult.constraints || caseData.constraints_jsonb || [],
    scopeItems: caseData.scope_items_jsonb || [],
    extractedFeeAmount: null,
    latestInboundMessageId: triggerMsgId,
    adjustmentInstruction: null,
    llmStubs: null
  };
  const draftResult = await draftResponseNode(draftState);

  console.log("\nSubject:", draftResult.draftSubject);
  console.log("\nBody:\n" + draftResult.draftBodyText);

  // 5. Save as proposal
  const proposal = await db.upsertProposal({
    proposalKey: db.generateProposalKey(CASE_ID, triggerMsgId, decideResult.proposalActionType, 0),
    caseId: CASE_ID,
    triggerMessageId: triggerMsgId,
    actionType: decideResult.proposalActionType,
    draftSubject: draftResult.draftSubject,
    draftBodyText: draftResult.draftBodyText,
    draftBodyHtml: draftResult.draftBodyHtml || null,
    reasoning: decideResult.proposalReasoning,
    confidence: decideResult.proposalConfidence || 0.90,
    requiresHuman: true,
    status: 'PENDING_APPROVAL'
  });
  console.log("\n✓ Proposal #" + proposal.id + " created (" + proposal.action_type + ")");

  process.exit(0);
})().catch(e => {
  console.error("Failed:", e);
  process.exit(1);
});
