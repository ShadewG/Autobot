/**
 * Regenerate proposals for Case #60 and #1658 through the proper pipeline.
 */
require("dotenv").config();
process.env.LANGGRAPH_DRY_RUN = 'false';

const db = require("../services/database");
const { classifyInboundNode } = require("../langgraph/nodes/classify-inbound");
const { updateConstraintsNode } = require("../langgraph/nodes/update-constraints");
const { decideNextActionNode } = require("../langgraph/nodes/decide-next-action");
const { draftResponseNode } = require("../langgraph/nodes/draft-response");

async function regenerateProposal(caseId) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing Case #${caseId}`);
  console.log('='.repeat(60));

  const caseData = (await db.query("SELECT * FROM cases WHERE id = $1", [caseId])).rows[0];
  console.log("Case:", caseData.case_name);
  console.log("Agency:", caseData.agency_name);

  // Find the latest inbound message (if any)
  // Note: getMessagesByCaseId returns DESC order (newest first)
  const msgs = await db.getMessagesByCaseId(caseId);
  const latestInbound = msgs.find(m => m.direction === 'inbound') || null;
  const latestInboundId = latestInbound ? latestInbound.id : null;

  // Determine trigger type based on whether there's an inbound message
  const triggerType = latestInboundId ? 'INBOUND_MESSAGE' : 'SCHEDULED_FOLLOWUP';
  console.log("Latest inbound msg:", latestInboundId || 'NONE');
  console.log("Trigger type:", triggerType);

  // 1. CLASSIFY
  console.log("\n--- Step 1: classify_inbound ---");
  let classifyResult;
  if (latestInboundId) {
    const classifyState = { caseId, latestInboundMessageId: latestInboundId, triggerType };
    classifyResult = await classifyInboundNode(classifyState);
  } else {
    classifyResult = {
      classification: 'NO_RESPONSE',
      classificationConfidence: 1.0,
      requiresResponse: false,
      suggestedAction: null,
      reasonNoResponse: 'No agency response received',
      logs: ['No inbound messages — treating as no-response followup']
    };
  }
  console.log("Classification:", classifyResult.classification);
  console.log("Requires response:", classifyResult.requiresResponse);
  console.log("Logs:", classifyResult.logs);

  // 2. UPDATE CONSTRAINTS
  console.log("\n--- Step 2: update_constraints ---");
  const constraintState = { caseId, latestInboundMessageId: latestInboundId };
  const constraintResult = await updateConstraintsNode(constraintState);
  console.log("Constraints:", constraintResult.constraints);

  // 3. DECIDE
  console.log("\n--- Step 3: decide_next_action ---");
  const decideState = {
    caseId,
    classification: classifyResult.classification,
    denialSubtype: classifyResult.denialSubtype,
    extractedFeeAmount: classifyResult.extractedFeeAmount,
    sentiment: classifyResult.sentiment,
    constraints: constraintResult.constraints || [],
    triggerType,
    autopilotMode: 'SUPERVISED',
    requiresResponse: classifyResult.requiresResponse,
    suggestedAction: classifyResult.suggestedAction,
    reasonNoResponse: classifyResult.reasonNoResponse,
    portalUrl: classifyResult.portalUrl,
    unansweredAgencyQuestion: classifyResult.unansweredAgencyQuestion
  };
  const decideResult = await decideNextActionNode(decideState);
  console.log("Action:", decideResult.proposalActionType);
  console.log("Reasoning:", decideResult.proposalReasoning);
  console.log("Logs:", decideResult.logs);

  if (decideResult.proposalActionType === 'NONE' || !decideResult.proposalActionType) {
    console.log("\n⚠️  No action proposed — pipeline returned NONE");
    return;
  }

  // 4. DRAFT
  console.log("\n--- Step 4: draft_response ---");
  const triggerMsgId = decideResult.latestInboundMessageId || latestInboundId;
  const draftState = {
    caseId,
    proposalActionType: decideResult.proposalActionType,
    constraints: constraintResult.constraints || caseData.constraints_jsonb || [],
    scopeItems: caseData.scope_items_jsonb || [],
    extractedFeeAmount: classifyResult.extractedFeeAmount || null,
    latestInboundMessageId: triggerMsgId,
    adjustmentInstruction: null,
    llmStubs: null
  };
  const draftResult = await draftResponseNode(draftState);

  console.log("\nDraft subject:", draftResult.draftSubject);
  console.log("\nDraft body:\n" + draftResult.draftBodyText);

  // 5. Save as proposal
  const proposal = await db.upsertProposal({
    proposalKey: db.generateProposalKey(caseId, triggerMsgId || 0, decideResult.proposalActionType, 0),
    caseId,
    triggerMessageId: triggerMsgId,
    actionType: decideResult.proposalActionType,
    draftSubject: draftResult.draftSubject,
    draftBodyText: draftResult.draftBodyText,
    draftBodyHtml: draftResult.draftBodyHtml || null,
    reasoning: decideResult.proposalReasoning,
    confidence: decideResult.proposalConfidence || 0.85,
    requiresHuman: true,
    status: 'PENDING_APPROVAL'
  });
  console.log("\n✓ Proposal #" + proposal.id + " created (" + proposal.action_type + ")");
}

(async () => {
  await regenerateProposal(1658);
  await regenerateProposal(60);
  process.exit(0);
})().catch(e => {
  console.error("Failed:", e);
  process.exit(1);
});
