const db = require("./database");

const ACTIVE_PROPOSAL_STATUSES = ["PENDING_APPROVAL", "BLOCKED", "DECISION_RECEIVED", "PENDING_PORTAL"];

function truncate(value, max = 200) {
  return String(value || "").trim().slice(0, max);
}

function isQuotaOrRateLimitError(rawError) {
  const value = String(rawError || "");
  return /(?:^|[^a-z])(429)(?:[^a-z]|$)/i.test(value)
    || /quota/i.test(value)
    || /rate limit/i.test(value)
    || /billing/i.test(value);
}

function buildFailureDraft({ caseData, message, error }) {
  const caseLabel = truncate(caseData?.case_name || `Case ${caseData?.id || ""}`, 160);
  const fromLine = message?.from_email ? `From: ${message.from_email}` : null;
  const subjectLine = message?.subject ? `Subject: ${message.subject}` : null;
  const failureSummary = isQuotaOrRateLimitError(error)
    ? "Autobot could not process the latest inbound email because the AI provider hit a quota or rate-limit error."
    : `Autobot could not process the latest inbound email automatically: ${truncate(error, 220)}`;

  return {
    draftSubject: `Manual review needed: ${caseLabel}`.slice(0, 200),
    draftBodyText: [
      `Manual review is needed for ${caseLabel}.`,
      "",
      failureSummary,
      "",
      "Latest inbound message:",
      fromLine,
      subjectLine,
      "",
      "Review the inbound message and decide the next response manually.",
    ].filter(Boolean).join("\n"),
    reasoning: [
      { step: "Inbound matched", detail: "The latest inbound email was matched to this case and thread." },
      { step: "Automated processing failed", detail: truncate(error, 300) || "The agent run failed before it could generate a proposal." },
      { step: "Manual review required", detail: "Create or adjust the next response manually from the latest inbound message." },
    ],
  };
}

async function recoverInboundRunFailureToProposal(
  { caseId, messageId = null, runId = null, error, sourceService = "trigger.dev" },
  deps = {}
) {
  const database = deps.db || db;

  const caseData = await database.getCaseById(caseId).catch(() => null);
  if (!caseData) {
    return { recovered: false, reason: "case_not_found" };
  }

  const activeProposalResult = await database.query(
    `SELECT id
       FROM proposals
      WHERE case_id = $1
        AND status = ANY($2)
      LIMIT 1`,
    [caseId, ACTIVE_PROPOSAL_STATUSES]
  );
  if ((activeProposalResult.rows || []).length > 0) {
    if (messageId) {
      await database.markMessageProcessed(messageId, runId, truncate(error, 500) || null);
    }
    return { recovered: false, reason: "active_proposal_exists" };
  }

  const message = messageId ? await database.getMessageById(messageId).catch(() => null) : null;
  const draft = buildFailureDraft({ caseData, message, error });

  const proposal = await database.upsertProposal({
    proposalKey: `${caseId}:inbound_failure:${messageId || "none"}:ESCALATE`,
    caseId,
    runId,
    triggerMessageId: messageId || null,
    actionType: "ESCALATE",
    draftSubject: draft.draftSubject,
    draftBodyText: draft.draftBodyText,
    draftBodyHtml: null,
    reasoning: draft.reasoning,
    confidence: 0,
    requiresHuman: true,
    canAutoExecute: false,
    status: "PENDING_APPROVAL",
    gateOptions: ["ADJUST", "DISMISS"],
  });

  if (messageId) {
    await database.markMessageProcessed(messageId, runId, truncate(error, 500) || null);
  }

  await database.logActivity(
    "inbound_run_failed_recovered",
    `Created manual review proposal after inbound processing failed for message #${messageId || "unknown"}`,
    {
      case_id: caseId,
      message_id: messageId || null,
      run_id: runId || null,
      proposal_id: proposal.id,
      actor_type: "system",
      source_service: sourceService,
    }
  );

  return { recovered: true, proposalId: proposal.id };
}

module.exports = {
  recoverInboundRunFailureToProposal,
  isQuotaOrRateLimitError,
};
