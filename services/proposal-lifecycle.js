const db = require('./database');

const FIELD_MAP = {
  executedAt: 'executed_at',
  emailJobId: 'email_job_id',
  executionKey: 'execution_key',
  humanDecision: 'human_decision',
  humanDecidedAt: 'human_decided_at',
  humanDecidedBy: 'human_decided_by',
  adjustmentCount: 'adjustment_count',
  runId: 'run_id',
  waitpointToken: 'waitpoint_token',
  draftBodyText: 'draft_body_text',
  draftBodyHtml: 'draft_body_html',
  draftSubject: 'draft_subject',
};

const ACTIVE_REVIEW_PROPOSAL_STATUSES = ['PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL'];

function buildHumanDecision(action, extras = {}) {
  const {
    decidedAt = new Date().toISOString(),
    decidedBy = 'human',
    ...rest
  } = extras || {};

  return Object.fromEntries(
    Object.entries({ action, decidedAt, decidedBy, ...rest }).filter(([, value]) => value !== undefined)
  );
}

function buildDecisionAuditUpdates(humanDecision) {
  if (!humanDecision) {
    return {
      humanDecision: null,
      humanDecidedAt: null,
      humanDecidedBy: null,
    };
  }

  const decidedAt = humanDecision.decidedAt ? new Date(humanDecision.decidedAt) : new Date();
  return {
    humanDecision,
    humanDecidedAt: Number.isNaN(decidedAt.getTime()) ? new Date() : decidedAt,
    humanDecidedBy: humanDecision.decidedBy || null,
  };
}

function normalizeDbUpdates(updates) {
  return Object.entries(updates || {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [FIELD_MAP[key] || key, value]);
}

async function conditionalUpdateProposal(proposalId, updates, allowedStatuses) {
  const entries = normalizeDbUpdates(updates);
  if (entries.length === 0) {
    return db.getProposalById(proposalId);
  }

  const values = [proposalId];
  const setClauses = [];
  let paramIndex = 2;

  for (const [dbKey, value] of entries) {
    if (dbKey === 'human_decision') {
      setClauses.push(`${dbKey} = $${paramIndex}::jsonb`);
      values.push(value == null ? null : JSON.stringify(value));
    } else {
      setClauses.push(`${dbKey} = $${paramIndex}`);
      values.push(value);
    }
    paramIndex += 1;
  }

  setClauses.push('updated_at = NOW()');
  values.push(allowedStatuses);

  const result = await db.query(
    `UPDATE proposals
     SET ${setClauses.join(', ')}
     WHERE id = $1
       AND status = ANY($${paramIndex}::text[])
     RETURNING *`,
    values
  );

  return result.rows[0] || null;
}

async function applyHumanReviewDecision(proposalId, {
  status,
  humanDecision,
  adjustmentCount,
  extraUpdates = {},
  allowedCurrentStatuses = null,
} = {}) {
  const updates = {
    status,
    ...buildDecisionAuditUpdates(humanDecision),
    ...(adjustmentCount !== undefined ? { adjustmentCount } : {}),
    ...extraUpdates,
  };

  if (allowedCurrentStatuses?.length) {
    return conditionalUpdateProposal(proposalId, updates, allowedCurrentStatuses);
  }

  return db.updateProposal(proposalId, updates);
}

async function clearHumanReviewDecision(proposalId, {
  status = 'PENDING_APPROVAL',
  extraUpdates = {},
  allowedCurrentStatuses = null,
} = {}) {
  const updates = {
    status,
    humanDecision: null,
    humanDecidedAt: null,
    humanDecidedBy: null,
    ...extraUpdates,
  };

  if (allowedCurrentStatuses?.length) {
    return conditionalUpdateProposal(proposalId, updates, allowedCurrentStatuses);
  }

  return db.updateProposal(proposalId, updates);
}

async function markProposalExecuted(proposalId, {
  humanDecision,
  emailJobId,
  executionKey,
  executedAt = new Date(),
  extraUpdates = {},
  allowedCurrentStatuses = null,
} = {}) {
  const updates = {
    executedAt,
    ...(emailJobId !== undefined ? { emailJobId } : {}),
    ...(executionKey !== undefined ? { executionKey } : {}),
    ...extraUpdates,
  };

  return applyHumanReviewDecision(proposalId, {
    status: 'EXECUTED',
    humanDecision,
    extraUpdates: updates,
    allowedCurrentStatuses,
  });
}

async function markProposalDecisionReceived(proposalId, {
  humanDecision,
  extraUpdates = {},
  allowedCurrentStatuses = null,
} = {}) {
  return applyHumanReviewDecision(proposalId, {
    status: 'DECISION_RECEIVED',
    humanDecision,
    extraUpdates,
    allowedCurrentStatuses,
  });
}

async function markProposalPendingPortal(proposalId, {
  humanDecision,
  runId,
  extraUpdates = {},
  allowedCurrentStatuses = null,
} = {}) {
  return applyHumanReviewDecision(proposalId, {
    status: 'PENDING_PORTAL',
    humanDecision,
    extraUpdates: {
      ...(runId !== undefined ? { runId } : {}),
      ...extraUpdates,
    },
    allowedCurrentStatuses,
  });
}

async function dismissActiveCaseProposals(caseId, {
  humanDecision,
  statuses = ACTIVE_REVIEW_PROPOSAL_STATUSES,
} = {}) {
  const auditUpdates = buildDecisionAuditUpdates(humanDecision);
  const result = await db.query(
    `UPDATE proposals
     SET status = 'DISMISSED',
         human_decision = $1::jsonb,
         human_decided_at = $2,
         human_decided_by = $3,
         updated_at = NOW()
     WHERE case_id = $4
       AND status = ANY($5::text[])
     RETURNING *`,
    [
      auditUpdates.humanDecision == null ? null : JSON.stringify(auditUpdates.humanDecision),
      auditUpdates.humanDecidedAt,
      auditUpdates.humanDecidedBy,
      caseId,
      statuses,
    ]
  );

  return result.rows;
}

module.exports = {
  ACTIVE_REVIEW_PROPOSAL_STATUSES,
  applyHumanReviewDecision,
  buildDecisionAuditUpdates,
  buildHumanDecision,
  clearHumanReviewDecision,
  conditionalUpdateProposal,
  dismissActiveCaseProposals,
  markProposalDecisionReceived,
  markProposalExecuted,
  markProposalPendingPortal,
};
