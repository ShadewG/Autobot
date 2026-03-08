const db = require('./database');

const DRAFT_QUALITY_ACTION_TYPES = [
  'SEND_INITIAL_REQUEST',
  'SEND_FOLLOWUP',
  'SEND_REBUTTAL',
  'SEND_CLARIFICATION',
  'SEND_APPEAL',
  'SEND_FEE_WAIVER_REQUEST',
  'SEND_STATUS_UPDATE',
  'RESPOND_PARTIAL_APPROVAL',
  'NEGOTIATE_FEE',
  'ACCEPT_FEE',
  'DECLINE_FEE',
  'SEND_PDF_EMAIL',
];

function clampWindowDays(value, fallback = 30) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(Math.trunc(numeric), 365));
}

async function captureResolvedDraftQualityEvalCases({ windowDays = 30 } = {}) {
  const days = clampWindowDays(windowDays, 30);

  const eligible = await db.query(
    `WITH latest_sent_execution AS (
        SELECT DISTINCT ON (e.proposal_id)
          e.proposal_id,
          e.id AS execution_id,
          e.completed_at,
          e.status
        FROM executions e
        WHERE e.proposal_id IS NOT NULL
          AND e.status = 'SENT'
        ORDER BY e.proposal_id, e.completed_at DESC NULLS LAST, e.id DESC
      ),
      latest_draft_quality_run AS (
        SELECT DISTINCT ON (er.eval_case_id)
          er.eval_case_id,
          er.id AS run_id,
          er.ran_at
        FROM eval_runs er
        WHERE COALESCE(er.evaluation_type, 'decision_quality') = 'draft_quality'
        ORDER BY er.eval_case_id, er.ran_at DESC NULLS LAST, er.id DESC
      )
      SELECT
        p.id AS proposal_id,
        p.case_id,
        p.trigger_message_id,
        p.action_type,
        p.draft_subject,
        p.draft_body_text,
        p.human_decision,
        c.closed_at,
        c.outcome_type,
        c.outcome_summary,
        ec.id AS eval_case_id,
        ec.capture_source,
        ldqr.run_id AS draft_quality_run_id
      FROM proposals p
      JOIN cases c ON c.id = p.case_id
      JOIN latest_sent_execution lse ON lse.proposal_id = p.id
      LEFT JOIN eval_cases ec ON ec.proposal_id = p.id
      LEFT JOIN latest_draft_quality_run ldqr ON ldqr.eval_case_id = ec.id
      WHERE c.closed_at IS NOT NULL
        AND c.closed_at > NOW() - make_interval(days => $1)
        AND p.action_type = ANY($2::text[])
        AND NULLIF(BTRIM(COALESCE(p.draft_body_text, '')), '') IS NOT NULL
        AND ldqr.run_id IS NULL
      ORDER BY c.closed_at DESC, p.id DESC`,
    [days, DRAFT_QUALITY_ACTION_TYPES]
  );

  const captured = [];

  for (const row of eligible.rows) {
    let evalCaseId = row.eval_case_id || null;

    if (!evalCaseId) {
      const insertResult = await db.query(
        `INSERT INTO eval_cases (
            proposal_id,
            case_id,
            trigger_message_id,
            expected_action,
            source_action_type,
            capture_source,
            notes,
            is_active
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         ON CONFLICT (proposal_id) DO UPDATE
           SET expected_action = COALESCE(eval_cases.expected_action, EXCLUDED.expected_action),
               source_action_type = COALESCE(eval_cases.source_action_type, EXCLUDED.source_action_type),
               capture_source = COALESCE(eval_cases.capture_source, EXCLUDED.capture_source),
               notes = COALESCE(eval_cases.notes, EXCLUDED.notes),
               is_active = true
         RETURNING id`,
        [
          row.proposal_id,
          row.case_id,
          row.trigger_message_id || null,
          row.action_type,
          row.action_type,
          'resolved_draft_quality',
          'Auto-captured after case resolved for sent draft quality scoring',
        ]
      );
      evalCaseId = insertResult.rows[0]?.id || null;
    }

    if (!evalCaseId) continue;

    captured.push({
      eval_case_id: evalCaseId,
      proposal_id: row.proposal_id,
      case_id: row.case_id,
      action_type: row.action_type,
      closed_at: row.closed_at,
      outcome_type: row.outcome_type || null,
      outcome_summary: row.outcome_summary || null,
      reused_eval_case: Boolean(row.eval_case_id),
    });
  }

  return {
    window_days: days,
    eligible_count: eligible.rows.length,
    captured_count: captured.length,
    captured,
  };
}

module.exports = {
  DRAFT_QUALITY_ACTION_TYPES,
  captureResolvedDraftQualityEvalCases,
  clampWindowDays,
};
