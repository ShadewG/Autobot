const db = require('./database');
const aiService = require('./ai-service');

const ACTIVE_PROPOSAL_STATUSES = ['PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL'];

function normalizeLines(reasoning = []) {
  if (!Array.isArray(reasoning)) return [];
  return reasoning
    .map((entry) => {
      if (!entry) return '';
      if (typeof entry === 'string') return entry.trim();
      if (typeof entry === 'object') return String(entry.detail || entry.summary || entry.step || '').trim();
      return String(entry).trim();
    })
    .filter(Boolean);
}

function buildResearchHandoffDraft(caseData, reasoning, fallbackCaseName) {
  const candidates = [
    caseData?.agency_name,
    caseData?.subject_name,
    caseData?.case_name,
    fallbackCaseName,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .filter((value) => {
      const normalized = value.toLowerCase();
      return normalized !== 'unknown agency'
        && normalized !== '—'
        && normalized !== '-'
        && normalized !== 'untitled case';
    });
  const label = candidates[0] || 'this case';

  const bullets = normalizeLines(reasoning).slice(0, 4).map((line) => `- ${line}`);
  if (bullets.length === 0) {
    bullets.push('- Research completed, but a verified delivery path was not found.');
  }

  return {
    subject: `Research handoff needed: ${label}`,
    body_text: [
      `Research handoff required for ${label}.`,
      '',
      'What the system found:',
      ...bullets,
      '',
      'Next step:',
      'Review the suggested redirect target, add a verified portal/email/contact if you have one, or retry research with better clues.',
    ].join('\n'),
    body_html: null,
    modelMetadata: null,
  };
}

function hasStatusUpdateNoise(proposal) {
  const body = String(proposal?.draft_body_text || '').toLowerCase();
  const warnings = JSON.stringify(proposal?.warnings || []).toLowerCase();
  return body.includes('security key')
    || body.includes('reference number available')
    || warnings.includes('security key')
    || warnings.includes('duplicate closing')
    || warnings.includes('personal phone number');
}

function hasFallbackRebuttal(proposal) {
  const subject = String(proposal?.draft_subject || '');
  const body = String(proposal?.draft_body_text || '');
  const riskFlags = JSON.stringify(proposal?.risk_flags || []);
  return subject === 'Review required: SEND REBUTTAL'
    || body.startsWith('System fallback draft generated')
    || riskFlags.includes('NO_DRAFT');
}

function hasGenericResearchHandoff(proposal) {
  const subject = String(proposal?.draft_subject || '');
  const body = String(proposal?.draft_body_text || '');
  return subject.startsWith('Action needed:')
    || /Research handoff needed:\s*[—-]\s*$/i.test(subject)
    || body.includes('(Draft generation failed — manual action required)')
    || /Research handoff required for\s+[—-]\./i.test(body)
    || !body.trim();
}

function getRecoveryReason(proposal) {
  switch (proposal?.action_type) {
    case 'SEND_STATUS_UPDATE':
      return hasStatusUpdateNoise(proposal) ? 'status_update_noise' : null;
    case 'SEND_REBUTTAL':
      return hasFallbackRebuttal(proposal) ? 'fallback_rebuttal' : null;
    case 'RESEARCH_AGENCY':
      return hasGenericResearchHandoff(proposal) ? 'generic_research_handoff' : null;
    default:
      return null;
  }
}

function sanitizeWarnings(actionType, warnings) {
  const values = Array.isArray(warnings) ? warnings : [];
  const filtered = values.filter((warning) => {
    const value = String(warning || '').toLowerCase();
    if (actionType === 'SEND_STATUS_UPDATE') {
      return !value.includes('security key')
        && !value.includes('duplicate closing')
        && !value.includes('personal phone number');
    }
    if (actionType === 'SEND_REBUTTAL') {
      return !value.includes('fallback draft generated');
    }
    if (actionType === 'RESEARCH_AGENCY') {
      return !value.includes('draft generation failed');
    }
    return true;
  });
  return filtered.length > 0 ? filtered : null;
}

function sanitizeRiskFlags(actionType, riskFlags) {
  const values = Array.isArray(riskFlags) ? riskFlags : [];
  const filtered = values.filter((flag) => {
    const value = String(flag || '').toUpperCase();
    if (actionType === 'SEND_REBUTTAL') {
      return value !== 'NO_DRAFT';
    }
    if (actionType === 'SEND_STATUS_UPDATE') {
      return value !== 'CONTAINS_PII';
    }
    return true;
  });
  return filtered.length > 0 ? filtered : null;
}

async function getLatestInboundForProposal(proposal) {
  if (proposal?.trigger_message_id) {
    return db.getMessageById(proposal.trigger_message_id);
  }
  const messages = await db.getMessagesByCaseId(proposal.case_id);
  return messages.find((m) => m.direction === 'inbound') || null;
}

async function regenerateProposalDraft(proposal) {
  const caseData = await db.getCaseById(proposal.case_id);
  if (!caseData) {
    throw new Error(`Case ${proposal.case_id} not found for proposal ${proposal.id}`);
  }

  switch (proposal.action_type) {
    case 'SEND_STATUS_UPDATE':
      return aiService.generateFollowUp(caseData, 0, {
        adjustmentInstruction: 'This is a brief status inquiry, not a follow-up. Keep it under 100 words. Ask for an update on when records will be available.',
        statusInquiry: true,
      });
    case 'SEND_REBUTTAL':
      const latestInbound = await getLatestInboundForProposal(proposal);
      const latestAnalysis = latestInbound
        ? await db.getResponseAnalysisByMessageId(latestInbound.id)
        : null;
      if (!latestInbound) {
        throw new Error(`Proposal ${proposal.id} has no inbound context for rebuttal regeneration`);
      }
      return aiService.generateDenialRebuttal(latestInbound, latestAnalysis, caseData, { forceDraft: true });
    case 'RESEARCH_AGENCY':
      return buildResearchHandoffDraft(caseData, proposal.reasoning, caseData.case_name || `case ${proposal.case_id}`);
    default:
      throw new Error(`Unsupported stale proposal action ${proposal.action_type}`);
  }
}

async function runStaleProposalRecoverySweep({ minAgeMinutes = 15, limit = 25 } = {}) {
  const result = await db.query(
    `SELECT p.*
       FROM proposals p
      WHERE p.status = ANY($1)
        AND p.updated_at < NOW() - ($2::text || ' minutes')::interval
        AND (
          (
            p.action_type = 'SEND_STATUS_UPDATE'
            AND (
              COALESCE(p.draft_body_text, '') ILIKE '%security key%'
              OR COALESCE(p.draft_body_text, '') ILIKE '%reference number available%'
              OR COALESCE(p.warnings::text, '') ILIKE '%security key%'
              OR COALESCE(p.warnings::text, '') ILIKE '%duplicate closing%'
              OR COALESCE(p.warnings::text, '') ILIKE '%personal phone number%'
            )
          )
          OR (
            p.action_type = 'SEND_REBUTTAL'
            AND (
              COALESCE(p.draft_subject, '') = 'Review required: SEND REBUTTAL'
              OR COALESCE(p.draft_body_text, '') ILIKE 'System fallback draft generated%'
              OR COALESCE(p.risk_flags::text, '') ILIKE '%NO_DRAFT%'
            )
          )
          OR (
            p.action_type = 'RESEARCH_AGENCY'
            AND (
              COALESCE(p.draft_subject, '') ILIKE 'Action needed:%'
              OR COALESCE(p.draft_subject, '') ~* '^Research handoff needed:\\s*[—-]\\s*$'
              OR COALESCE(p.draft_body_text, '') ILIKE '%Draft generation failed%'
              OR COALESCE(p.draft_body_text, '') ~* 'Research handoff required for\\s+[—-]\\.\\s*$'
              OR NULLIF(TRIM(COALESCE(p.draft_body_text, '')), '') IS NULL
            )
          )
        )
      ORDER BY p.updated_at ASC
      LIMIT $3`,
    [ACTIVE_PROPOSAL_STATUSES, String(minAgeMinutes), limit]
  );

  const summary = {
    scanned: result.rows.length,
    recovered: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  for (const proposal of result.rows) {
    const reason = getRecoveryReason(proposal);
    if (!reason) {
      summary.skipped += 1;
      continue;
    }

    try {
      const draft = await regenerateProposalDraft(proposal);
      const updates = {
        draftSubject: draft.subject || null,
        draftBodyText: draft.body_text || draft.bodyText || null,
        draftBodyHtml: draft.body_html || draft.bodyHtml || null,
        warnings: sanitizeWarnings(proposal.action_type, proposal.warnings),
        risk_flags: sanitizeRiskFlags(proposal.action_type, proposal.risk_flags),
        draftModelId: draft.modelMetadata?.modelId || null,
        draftPromptTokens: draft.modelMetadata?.promptTokens ?? null,
        draftCompletionTokens: draft.modelMetadata?.completionTokens ?? null,
        draftLatencyMs: draft.modelMetadata?.latencyMs ?? null,
        __versionSource: 'stale_recovery',
        __versionMetadata: { stale_recovery_reason: reason },
      };

      await db.updateProposal(proposal.id, updates);
      await db.logActivity(
        'stale_proposal_recovered',
        `Recovered stale ${proposal.action_type} draft automatically`,
        {
          case_id: proposal.case_id,
          proposal_id: proposal.id,
          action_type: proposal.action_type,
          recovery_reason: reason,
          actor_type: 'system',
          source_service: 'cron_service',
        }
      );

      summary.recovered += 1;
      summary.details.push({ proposalId: proposal.id, caseId: proposal.case_id, actionType: proposal.action_type, recovered: true, reason });
    } catch (error) {
      summary.failed += 1;
      summary.details.push({ proposalId: proposal.id, caseId: proposal.case_id, actionType: proposal.action_type, recovered: false, reason, error: error.message });
    }
  }

  return summary;
}

module.exports = {
  runStaleProposalRecoverySweep,
  getRecoveryReason,
  buildResearchHandoffDraft,
};
