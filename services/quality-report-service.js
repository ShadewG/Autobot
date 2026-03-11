const db = require('./database');
const { inferAgencyType } = require('./successful-examples-service');
const { buildRealCaseWhereClause } = require('../utils/analytics-test-filter');

const DEDUPED_EVAL_CASES_CTE = `
    WITH ranked_eval_cases AS (
        SELECT
            ec.*,
            ROW_NUMBER() OVER (
                PARTITION BY CASE
                    WHEN COALESCE(ec.notes, '') LIKE 'Auto-captured from monitor decision:%'
                    THEN CONCAT(
                        'auto-monitor:',
                        COALESCE(
                            NULLIF(
                                lower(trim(regexp_replace(COALESCE(ec.simulated_subject, c.case_name, ''), '<[^>]+>', '', 'g'))),
                                ''
                            ),
                            COALESCE(ec.case_id::text, 'none')
                        ),
                        ':',
                        COALESCE(ec.expected_action, 'none')
                    )
                    WHEN ec.proposal_id IS NOT NULL
                    THEN CONCAT('proposal:', ec.proposal_id::text)
                    ELSE CONCAT('eval-case:', ec.id::text)
                END
                ORDER BY ec.created_at DESC, ec.id DESC
            ) AS logical_rank
        FROM eval_cases ec
        LEFT JOIN cases c ON c.id = ec.case_id
        WHERE ec.is_active = true
    ),
    deduped_eval_cases AS (
        SELECT * FROM ranked_eval_cases WHERE logical_rank = 1
    )
`;

function clampWindowDays(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(Math.trunc(numeric), 365));
}

function rate(count, total) {
  return total > 0 ? Number((count / total).toFixed(4)) : null;
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number((total / values.length).toFixed(2));
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  return Number(value.toFixed(2));
}

function summarizeFreeText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

const REAL_CASES_WHERE = buildRealCaseWhereClause('c');
const NON_SUBSTANTIVE_PORTAL_MESSAGE_SQL = `
  NOT (
    LOWER(COALESCE(m.from_email, '')) ~ '(nextrequest\\.com|govqa\\.us|custhelp\\.com|mycusthelp\\.com|mycusthelp\\.net|usnx\\.com)'
    AND (
      LOWER(COALESCE(m.subject, '')) LIKE '%password assistance%'
      OR LOWER(COALESCE(m.subject, '')) LIKE '%welcome to the records center%'
      OR LOWER(COALESCE(m.subject, '')) LIKE '%portal account%'
      OR LOWER(COALESCE(m.subject, '')) LIKE '%unlock your%'
      OR LOWER(COALESCE(m.subject, '')) LIKE '%unrecognized email%'
      OR LOWER(COALESCE(m.subject, '')) LIKE '%has been submitted%'
      OR LOWER(COALESCE(m.subject, '')) LIKE '%submission confirmation%'
    )
  )
`;
const CLEANUP_PROCESSING_ERROR_SQL = `
  COALESCE(m.last_error, '') NOT ILIKE '%marked processed during cleanup%'
`;
const REQUEST_NUMBER_PORTAL_SQL = `
  (
    COALESCE(c.last_portal_engine, '') IN ('govqa', 'nextrequest', 'justfoia', 'mycusthelp', 'custhelp', 'publicrecordscenter')
    OR LOWER(COALESCE(c.portal_url, '')) ~ '(govqa|nextrequest|justfoia|mycusthelp|custhelp|publicrecordscenter|requestlogin\\.aspx|webapp/_rs)'
  )
`;
const BLOCKED_IMPORT_CASE_SQL = `
  (
    c.status = 'needs_contact_info'
    OR COALESCE(jsonb_array_length(c.import_warnings), 0) > 0
  )
`;

function inferActualClassificationFromExpectedAction(expectedAction) {
  switch (String(expectedAction || '').toUpperCase()) {
    case 'SEND_INITIAL_REQUEST':
    case 'SUBMIT_PORTAL':
      return 'initial_request';
    case 'SEND_CLARIFICATION':
    case 'SEND_PDF_EMAIL':
      return 'clarification';
    case 'SEND_FOLLOWUP':
    case 'SEND_STATUS_UPDATE':
      return 'follow_up';
    case 'SEND_REBUTTAL':
    case 'SEND_APPEAL':
      return 'denial';
    case 'NEGOTIATE_FEE':
    case 'ACCEPT_FEE':
    case 'DECLINE_FEE':
    case 'SEND_FEE_WAIVER_REQUEST':
      return 'fee_notice';
    case 'RESPOND_PARTIAL_APPROVAL':
      return 'partial_approval';
    case 'RESEARCH_AGENCY':
      return 'wrong_agency';
    case 'REFORMULATE_REQUEST':
      return 'reformulated_request';
    case 'ESCALATE':
      return 'human_review';
    case 'CLOSE_CASE':
      return 'closure';
    case 'NONE':
    case 'DISMISSED':
      return 'none';
    default:
      return 'other';
  }
}

/**
 * Map raw classifier intent values (from response_analysis.intent) to the same
 * canonical label space used by inferActualClassificationFromExpectedAction().
 *
 * This ensures both sides of the confusion matrix use the same vocabulary.
 */
function normalizeIntentToCanonicalClass(intent) {
  switch (String(intent || '').toLowerCase()) {
    case 'fee_request':
      return 'fee_notice';
    case 'question':
    case 'more_info_needed':
      return 'clarification';
    case 'denial':
      return 'denial';
    case 'partial_denial':
    case 'partial_approval':
    case 'partial_release':
    case 'partial_delivery':
      return 'partial_approval';
    case 'portal_redirect':
      return 'initial_request'; // portal redirect typically means "resubmit via portal"
    case 'acknowledgment':
      return 'acknowledgment';
    case 'records_ready':
    case 'delivery':
      return 'records_delivered';
    case 'wrong_agency':
      return 'wrong_agency';
    case 'hostile':
      return 'hostile';
    case 'none':
      return 'none';
    case 'other':
      return 'other';
    default:
      return 'unknown';
  }
}

async function buildWeeklyQualityReport({ windowDays = 7 } = {}) {
  const days = clampWindowDays(windowDays, 7);

  const [overviewResult, feedbackResult, adjustmentsResult, failuresResult, resolutionResult] = await Promise.all([
    db.query(
      `WITH processed_case_ids AS (
          SELECT DISTINCT case_id
          FROM proposals
          WHERE case_id IS NOT NULL
            AND human_decided_at > NOW() - make_interval(days => $1)
          UNION
          SELECT DISTINCT case_id
          FROM executions
          WHERE case_id IS NOT NULL
            AND completed_at > NOW() - make_interval(days => $1)
          UNION
          SELECT id AS case_id
          FROM cases
          WHERE closed_at > NOW() - make_interval(days => $1)
       )
       SELECT
         (SELECT COUNT(*)::int FROM processed_case_ids) AS cases_processed,
         (SELECT COUNT(*)::int FROM cases WHERE closed_at > NOW() - make_interval(days => $1)) AS cases_resolved`,
      [days]
    ),
    db.query(
      `WITH reviewed_proposals AS (
          SELECT UPPER(COALESCE(NULLIF(p.human_decision->>'action', ''), '')) AS human_action
          FROM proposals p
          WHERE p.human_decided_at > NOW() - make_interval(days => $1)
       )
       SELECT
         COUNT(*) FILTER (WHERE reviewed_proposals.human_action IN ('APPROVE', 'ADJUST', 'DISMISS'))::int AS total_reviews,
         COUNT(*) FILTER (WHERE reviewed_proposals.human_action = 'APPROVE')::int AS approve_count,
         COUNT(*) FILTER (WHERE reviewed_proposals.human_action = 'ADJUST')::int AS adjust_count,
         COUNT(*) FILTER (WHERE reviewed_proposals.human_action = 'DISMISS')::int AS dismiss_count
       FROM reviewed_proposals`,
      [days]
    ),
    db.query(
      `SELECT
          COALESCE(
            NULLIF(TRIM(feedback_reason), ''),
            NULLIF(TRIM(feedback_instruction), ''),
            'Unspecified adjustment'
          ) AS adjustment,
          COUNT(*)::int AS count
       FROM eval_cases
       WHERE is_active = true
         AND feedback_action = 'ADJUST'
         AND created_at > NOW() - make_interval(days => $1)
       GROUP BY 1
       ORDER BY count DESC, adjustment ASC
       LIMIT 5`,
      [days]
    ),
    db.query(
      `SELECT failure_category, COUNT(*)::int AS count
       FROM eval_runs
       WHERE failure_category IS NOT NULL
         AND COALESCE(evaluation_type, 'decision_quality') = 'decision_quality'
         AND ran_at > NOW() - make_interval(days => $1)
       GROUP BY failure_category
       ORDER BY count DESC, failure_category ASC
       LIMIT 5`,
      [days]
    ),
    db.query(
      `SELECT id, agency_name, created_at, closed_at
       FROM cases
       WHERE closed_at IS NOT NULL
         AND created_at IS NOT NULL
         AND closed_at > NOW() - make_interval(days => $1)`,
      [days]
    ),
  ]);

  const overview = overviewResult.rows[0] || {};
  const feedback = feedbackResult.rows[0] || {};
  const totalReviews = Number(feedback.total_reviews) || 0;
  const approveCount = Number(feedback.approve_count) || 0;
  const adjustCount = Number(feedback.adjust_count) || 0;
  const dismissCount = Number(feedback.dismiss_count) || 0;

  const groupedResolution = new Map();
  for (const row of resolutionResult.rows) {
    const createdAt = row.created_at ? new Date(row.created_at) : null;
    const closedAt = row.closed_at ? new Date(row.closed_at) : null;
    if (!createdAt || !closedAt || Number.isNaN(createdAt.getTime()) || Number.isNaN(closedAt.getTime())) continue;
    const durationDays = (closedAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (!Number.isFinite(durationDays) || durationDays < 0) continue;

    const agencyType = inferAgencyType(row.agency_name);
    const bucket = groupedResolution.get(agencyType) || [];
    bucket.push(durationDays);
    groupedResolution.set(agencyType, bucket);
  }

  const timeToResolutionByAgencyType = Array.from(groupedResolution.entries())
    .map(([agencyType, values]) => ({
      agency_type: agencyType,
      cases_resolved: values.length,
      avg_resolution_days: average(values),
      median_resolution_days: median(values),
    }))
    .sort((a, b) => b.cases_resolved - a.cases_resolved || a.agency_type.localeCompare(b.agency_type));

  return {
    generated_at: new Date().toISOString(),
    window_days: days,
    overview: {
      cases_processed: Number(overview.cases_processed) || 0,
      cases_resolved: Number(overview.cases_resolved) || 0,
      total_reviews: totalReviews,
      approve_count: approveCount,
      adjust_count: adjustCount,
      dismiss_count: dismissCount,
      approval_rate: rate(approveCount, totalReviews),
      adjust_rate: rate(adjustCount, totalReviews),
      dismiss_rate: rate(dismissCount, totalReviews),
      avg_resolution_days: average(
        timeToResolutionByAgencyType.flatMap((row) => Array(row.cases_resolved).fill(row.avg_resolution_days).filter((v) => v != null))
      ),
    },
    common_adjustments: adjustmentsResult.rows.map((row) => ({
      adjustment: summarizeFreeText(row.adjustment),
      count: Number(row.count) || 0,
    })),
    common_failures: failuresResult.rows.map((row) => ({
      failure_category: row.failure_category,
      count: Number(row.count) || 0,
    })),
    time_to_resolution_by_agency_type: timeToResolutionByAgencyType,
  };
}

async function buildClassificationConfusionMatrix({ windowDays = 30 } = {}) {
  const days = clampWindowDays(windowDays, 30);

  // Pull all available prediction sources:
  // 1. ra.intent — from response_analysis (classifier output for real cases)
  // 2. ec.simulated_predicted_action — for simulation-sourced eval cases
  // 3. ec.source_action_type — the AI-proposed action when captured from feedback
  // 4. p.action_type — the proposal's action type (fallback for proposal-linked cases)
  const result = await db.query(
    `${DEDUPED_EVAL_CASES_CTE}
     SELECT
       LOWER(ra.intent) AS raw_intent,
       ec.expected_action,
       ec.simulated_predicted_action,
       ec.source_action_type,
       p.action_type AS proposal_action_type
     FROM deduped_eval_cases ec
     LEFT JOIN response_analysis ra ON ra.message_id = ec.trigger_message_id
     LEFT JOIN proposals p ON p.id = ec.proposal_id
     WHERE ec.expected_action IS NOT NULL
       AND ec.created_at > NOW() - make_interval(days => $1)`,
    [days]
  );

  const cells = new Map();
  const actualTotals = new Map();
  const predictedTotals = new Map();

  for (const row of result.rows) {
    const actual = inferActualClassificationFromExpectedAction(row.expected_action);

    // Determine the predicted classification from the best available source.
    // Priority: raw classifier intent > simulated action > source action > proposal action
    let predicted;
    if (row.raw_intent) {
      // Normalize the raw intent to the same canonical label space as the actual side
      predicted = normalizeIntentToCanonicalClass(row.raw_intent);
    } else if (row.simulated_predicted_action) {
      // Simulation cases store the AI's predicted action type directly
      predicted = inferActualClassificationFromExpectedAction(row.simulated_predicted_action);
    } else if (row.source_action_type) {
      // Feedback-captured cases store the original AI action type
      predicted = inferActualClassificationFromExpectedAction(row.source_action_type);
    } else if (row.proposal_action_type) {
      // Fall back to the linked proposal's action type
      predicted = inferActualClassificationFromExpectedAction(row.proposal_action_type);
    } else {
      predicted = 'unknown';
    }

    const key = `${actual}::${predicted}`;
    cells.set(key, (cells.get(key) || 0) + 1);
    actualTotals.set(actual, (actualTotals.get(actual) || 0) + 1);
    predictedTotals.set(predicted, (predictedTotals.get(predicted) || 0) + 1);
  }

  const matrix = Array.from(cells.entries())
    .map(([key, count]) => {
      const [actual_classification, predicted_classification] = key.split('::');
      return {
        actual_classification,
        predicted_classification,
        count,
      };
    })
    .sort((a, b) => b.count - a.count || a.actual_classification.localeCompare(b.actual_classification) || a.predicted_classification.localeCompare(b.predicted_classification));

  const topConfusions = matrix
    .filter((row) => row.actual_classification !== row.predicted_classification)
    .slice(0, 10);

  return {
    generated_at: new Date().toISOString(),
    window_days: days,
    actual_source: 'expected_action_inference',
    predicted_source: 'intent_or_action_type_inference',
    totals: {
      samples: result.rows.length,
      distinct_actual_classifications: actualTotals.size,
      distinct_predicted_classifications: predictedTotals.size,
    },
    matrix,
    top_confusions: topConfusions,
  };
}

async function buildReconciliationReport() {
  const [
    droppedActions,
    branchErrors,
    orphanedInbound,
    staleProposals,
    unanalyzedInbound,
    portalMissingRequestNumber,
    runsWithoutTraces,
    attachmentGaps,
    deadEndCases,
    blockedImportCases,
    inboundLinkageGaps,
    emptyNormalizedInbound,
    proposalMessageMismatches,
  ] = await Promise.all([
    db.query(`
      WITH latest_analysis AS (
        SELECT DISTINCT ON (case_id) case_id, requires_action, suggested_action, created_at
        FROM response_analysis
        WHERE case_id IS NOT NULL
        ORDER BY case_id, created_at DESC
      )
      SELECT la.case_id, la.suggested_action, la.created_at as analysis_at, c.status, c.agency_name
      FROM latest_analysis la
      JOIN cases c ON c.id = la.case_id
      WHERE la.requires_action = true
        AND ${REAL_CASES_WHERE}
        AND c.status NOT IN ('completed', 'closed', 'withdrawn', 'cancelled', 'records_received', 'case_completed')
        AND NOT EXISTS (
          SELECT 1
          FROM proposals p
          WHERE p.case_id = la.case_id
            AND p.created_at >= la.created_at
            AND p.status IN ('PENDING_APPROVAL', 'BLOCKED', 'EXECUTED', 'DECISION_RECEIVED')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM agent_runs ar
          WHERE ar.case_id = la.case_id
            AND ar.started_at >= la.created_at
            AND ar.status IN ('created', 'queued', 'processing', 'running', 'waiting', 'completed')
        )
      ORDER BY la.created_at DESC
      LIMIT 20
    `),
    db.query(`
      SELECT m.id as message_id, m.case_id, m.from_email, m.subject, m.last_error, m.created_at
      FROM messages m
      LEFT JOIN cases c ON c.id = m.case_id
      WHERE m.last_error IS NOT NULL AND m.last_error != ''
        AND ${CLEANUP_PROCESSING_ERROR_SQL}
        AND (c.id IS NULL OR ${REAL_CASES_WHERE})
        AND (c.status IS NULL OR c.status NOT IN ('completed', 'closed', 'withdrawn', 'cancelled'))
      ORDER BY m.created_at DESC
      LIMIT 20
    `),
    db.query(`
      SELECT COUNT(*) as count
      FROM messages m
      LEFT JOIN cases c ON c.id = m.case_id
      WHERE direction = 'inbound' AND m.case_id IS NULL
        AND processed_at IS NULL
        AND (metadata->>'source' IS NULL)
        AND ${NON_SUBSTANTIVE_PORTAL_MESSAGE_SQL}
    `),
    db.query(`
      SELECT COUNT(*) as count
      FROM proposals p
      JOIN cases c ON c.id = p.case_id
      WHERE p.status = 'PENDING_APPROVAL'
        AND ${REAL_CASES_WHERE}
        AND p.created_at < NOW() - INTERVAL '48 hours'
    `),
    db.query(`
      SELECT m.id as message_id, m.case_id, m.from_email, m.subject, m.created_at
      FROM messages m
      LEFT JOIN response_analysis ra ON ra.message_id = m.id
      JOIN cases c ON c.id = m.case_id
      WHERE m.direction = 'inbound'
        AND m.case_id IS NOT NULL
        AND m.processed_at IS NULL
        AND ra.id IS NULL
        AND ${REAL_CASES_WHERE}
        AND c.status NOT IN ('completed', 'closed', 'withdrawn', 'cancelled', 'records_received', 'case_completed')
        AND NOT EXISTS (
          SELECT 1
          FROM response_analysis ra2
          WHERE ra2.case_id = m.case_id
            AND ra2.created_at > COALESCE(m.received_at, m.created_at)
        )
        AND ${NON_SUBSTANTIVE_PORTAL_MESSAGE_SQL}
      ORDER BY m.created_at DESC
      LIMIT 20
    `),
    db.query(`
      SELECT c.id as case_id, c.case_name, c.agency_name, c.status, c.portal_url,
             c.last_portal_engine, c.last_portal_status
      FROM cases c
      WHERE c.portal_url IS NOT NULL
        AND c.portal_url != ''
        AND ${REAL_CASES_WHERE}
        AND ${REQUEST_NUMBER_PORTAL_SQL}
        AND (c.portal_request_number IS NULL OR c.portal_request_number = '')
        AND c.status IN ('sent', 'awaiting_response', 'portal_in_progress')
        AND COALESCE(c.last_portal_status, '') NOT ILIKE '%fallback email sent%'
        AND (
          EXISTS (
            SELECT 1
            FROM portal_tasks pt
            WHERE pt.case_id = c.id
              AND pt.status = 'COMPLETED'
              AND NULLIF(BTRIM(COALESCE(pt.confirmation_number, '')), '') IS NOT NULL
          )
          OR EXISTS (
            SELECT 1
            FROM portal_submissions ps
            WHERE ps.case_id = c.id
              AND ps.status = 'completed'
              AND COALESCE(ps.extracted_data::text, '') ~* '(confirmation_number|request_number)'
          )
          OR EXISTS (
            SELECT 1
            FROM activity_log al
            WHERE al.case_id = c.id
              AND al.event_type = 'portal_submission'
              AND COALESCE(al.metadata::text, '') ~* 'confirmation_number'
              AND COALESCE(al.metadata->>'confirmation_number', '') <> ''
          )
        )
      ORDER BY c.created_at DESC
      LIMIT 20
    `),
    db.query(`
      SELECT ar.id as run_id, ar.case_id, ar.trigger_type, ar.status, ar.started_at
      FROM agent_runs ar
      JOIN cases c ON c.id = ar.case_id
      LEFT JOIN decision_traces dt ON dt.run_id = ar.id
      WHERE ar.started_at > NOW() - INTERVAL '7 days'
        AND ar.status IN ('completed', 'failed')
        AND ${REAL_CASES_WHERE}
        AND dt.id IS NULL
      ORDER BY ar.started_at DESC
      LIMIT 20
    `),
    db.query(`
      SELECT
        COUNT(DISTINCT m.id) FILTER (WHERE m.direction = 'inbound') AS inbound_with_attachments,
        COUNT(DISTINCT m.id) FILTER (
          WHERE m.direction = 'inbound'
            AND (a.extracted_text IS NULL OR a.extracted_text = '')
            AND a.content_type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/jpg')
        ) AS missing_extraction,
        COUNT(DISTINCT m.id) FILTER (
          WHERE m.direction = 'inbound'
            AND a.extracted_text IS NOT NULL AND a.extracted_text != ''
        ) AS has_extraction
      FROM messages m
      JOIN attachments a ON a.message_id = m.id
    `),
    db.query(`
      SELECT c.id as case_id, c.agency_name, c.state, c.status, c.pause_reason, c.updated_at
      FROM cases c
      WHERE c.status IN ('needs_human_review', 'needs_phone_call', 'needs_contact_info', 'needs_human_fee_approval')
        AND ${REAL_CASES_WHERE}
        AND NOT ${BLOCKED_IMPORT_CASE_SQL}
        AND NOT EXISTS (
            SELECT 1 FROM proposals p WHERE p.case_id = c.id
            AND p.status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED')
        )
        AND NOT EXISTS (
            SELECT 1 FROM agent_runs ar WHERE ar.case_id = c.id
            AND ar.status IN ('created', 'queued', 'processing', 'running', 'waiting')
        )
        AND NOT EXISTS (
            SELECT 1 FROM phone_call_queue pcq WHERE pcq.case_id = c.id
            AND pcq.status IN ('pending', 'claimed')
        )
        AND NOT EXISTS (
            SELECT 1 FROM portal_tasks pt WHERE pt.case_id = c.id
            AND pt.status IN ('PENDING', 'IN_PROGRESS')
        )
        AND (c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')
        AND c.agency_name NOT LIKE 'Synthetic %'
      ORDER BY c.updated_at DESC
      LIMIT 20
    `),
    db.query(`
      SELECT c.id as case_id, c.agency_name, c.state, c.status, c.pause_reason, c.updated_at
      FROM cases c
      WHERE c.status IN ('needs_human_review', 'needs_contact_info')
        AND ${REAL_CASES_WHERE}
        AND ${BLOCKED_IMPORT_CASE_SQL}
        AND NOT EXISTS (
            SELECT 1 FROM proposals p WHERE p.case_id = c.id
            AND p.status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED')
        )
        AND NOT EXISTS (
            SELECT 1 FROM agent_runs ar WHERE ar.case_id = c.id
            AND ar.status IN ('created', 'queued', 'processing', 'running', 'waiting')
        )
        AND NOT EXISTS (
            SELECT 1 FROM phone_call_queue pcq WHERE pcq.case_id = c.id
            AND pcq.status IN ('pending', 'claimed')
        )
        AND NOT EXISTS (
            SELECT 1 FROM portal_tasks pt WHERE pt.case_id = c.id
            AND pt.status IN ('PENDING', 'IN_PROGRESS')
        )
        AND (c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')
        AND c.agency_name NOT LIKE 'Synthetic %'
      ORDER BY c.updated_at DESC
      LIMIT 20
    `),
    db.query(`
      SELECT
        m.id AS message_id,
        m.from_email,
        m.subject,
        m.thread_id,
        m.case_id,
        COALESCE(m.received_at, m.created_at) AS received_at
      FROM messages m
      WHERE m.direction = 'inbound'
        AND COALESCE(m.received_at, m.created_at) > NOW() - INTERVAL '7 days'
        AND m.case_id IS NULL
        AND ${NON_SUBSTANTIVE_PORTAL_MESSAGE_SQL}
        AND (m.thread_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM email_threads t
          WHERE t.id = m.thread_id
            AND t.case_id IS NOT NULL
        ))
        AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.trigger_message_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM agent_runs ar WHERE ar.message_id = m.id)
        AND COALESCE(m.message_type, '') NOT IN ('simulated_inbound', 'manual_trigger')
        AND COALESCE(m.metadata->>'source', '') NOT IN ('synthetic', 'simulation')
      ORDER BY COALESCE(m.received_at, m.created_at) DESC
      LIMIT 20
    `),
    db.query(`
      SELECT
        m.id AS message_id,
        m.case_id,
        m.from_email,
        m.subject,
        m.thread_id,
        m.normalized_body_source,
        m.attachment_count,
        COALESCE(m.received_at, m.created_at) AS received_at
      FROM messages m
      WHERE m.direction = 'inbound'
        AND COALESCE(m.received_at, m.created_at) > NOW() - INTERVAL '7 days'
        AND COALESCE(NULLIF(m.normalized_body_text, ''), '') = ''
        AND ${NON_SUBSTANTIVE_PORTAL_MESSAGE_SQL}
        AND (
          COALESCE(NULLIF(m.body_text, ''), NULLIF(m.body_html, '')) IS NOT NULL
          OR COALESCE(m.attachment_count, 0) > 0
        )
        AND COALESCE(m.message_type, '') NOT IN ('simulated_inbound', 'manual_trigger')
        AND COALESCE(m.metadata->>'source', '') NOT IN ('synthetic', 'simulation')
      ORDER BY COALESCE(m.received_at, m.created_at) DESC
      LIMIT 20
    `),
    db.query(`
      SELECT
        p.id AS proposal_id,
        p.case_id AS proposal_case_id,
        p.status AS proposal_status,
        p.trigger_message_id,
        m.case_id AS message_case_id,
        m.subject,
        COALESCE(m.received_at, m.created_at) AS message_received_at,
        pc.agency_name AS proposal_agency_name,
        mc.agency_name AS message_agency_name
      FROM proposals p
      JOIN messages m ON m.id = p.trigger_message_id
      LEFT JOIN cases pc ON pc.id = p.case_id
      LEFT JOIN cases mc ON mc.id = m.case_id
      WHERE m.case_id IS NOT NULL
        AND m.case_id <> p.case_id
        AND COALESCE(p.created_at, m.created_at) > NOW() - INTERVAL '30 days'
        AND (pc.notion_page_id IS NULL OR pc.notion_page_id NOT LIKE 'test-%')
      ORDER BY COALESCE(p.created_at, m.created_at) DESC
      LIMIT 20
    `),
  ]);

  return {
    generated_at: new Date().toISOString(),
    dropped_actions: {
      count: droppedActions.rows.length,
      cases: droppedActions.rows.map(r => ({
        case_id: r.case_id,
        suggested_action: r.suggested_action,
        analysis_at: r.analysis_at,
        status: r.status,
        agency_name: r.agency_name,
      })),
    },
    processing_errors: {
      count: branchErrors.rows.length,
      messages: branchErrors.rows.map(r => ({
        message_id: r.message_id,
        case_id: r.case_id,
        from_email: r.from_email,
        subject: (r.subject || '').substring(0, 80),
        error: (r.last_error || '').substring(0, 120),
        created_at: r.created_at,
      })),
    },
    orphaned_inbound: Number(orphanedInbound.rows[0]?.count) || 0,
    stale_proposals: Number(staleProposals.rows[0]?.count) || 0,
    unanalyzed_inbound: {
      count: unanalyzedInbound.rows.length,
      messages: unanalyzedInbound.rows.map(r => ({
        message_id: r.message_id,
        case_id: r.case_id,
        from_email: r.from_email,
        subject: (r.subject || '').substring(0, 80),
        created_at: r.created_at,
      })),
    },
    portal_missing_request_number: {
      count: portalMissingRequestNumber.rows.length,
      cases: portalMissingRequestNumber.rows.map(r => ({
        case_id: r.case_id,
        case_name: (r.case_name || '').substring(0, 80),
        agency_name: r.agency_name,
        status: r.status,
        portal_url: r.portal_url,
        engine: r.last_portal_engine,
        portal_status: (r.last_portal_status || '').substring(0, 80),
      })),
    },
    runs_without_traces: {
      count: runsWithoutTraces.rows.length,
      runs: runsWithoutTraces.rows.map(r => ({
        run_id: r.run_id,
        case_id: r.case_id,
        trigger_type: r.trigger_type,
        status: r.status,
        started_at: r.started_at,
      })),
    },
    attachment_extraction: {
      inbound_with_attachments: Number(attachmentGaps.rows[0]?.inbound_with_attachments) || 0,
      has_extraction: Number(attachmentGaps.rows[0]?.has_extraction) || 0,
      missing_extraction: Number(attachmentGaps.rows[0]?.missing_extraction) || 0,
      extraction_rate: rate(
        Number(attachmentGaps.rows[0]?.has_extraction) || 0,
        Number(attachmentGaps.rows[0]?.inbound_with_attachments) || 0
      ),
    },
    dead_end_cases: {
      count: deadEndCases.rows.length,
      cases: deadEndCases.rows.map(r => ({
        case_id: r.case_id,
        agency_name: r.agency_name,
        state: r.state,
        status: r.status,
        pause_reason: r.pause_reason,
        updated_at: r.updated_at,
      })),
    },
    blocked_import_cases: {
      count: blockedImportCases.rows.length,
      cases: blockedImportCases.rows.map(r => ({
        case_id: r.case_id,
        agency_name: r.agency_name,
        state: r.state,
        status: r.status,
        pause_reason: r.pause_reason,
        updated_at: r.updated_at,
      })),
    },
    inbound_linkage_gaps: {
      count: inboundLinkageGaps.rows.length,
      messages: inboundLinkageGaps.rows.map(r => ({
        message_id: r.message_id,
        from_email: r.from_email,
        subject: (r.subject || '').substring(0, 120),
        thread_id: r.thread_id,
        case_id: r.case_id,
        received_at: r.received_at,
      })),
    },
    empty_normalized_inbound: {
      count: emptyNormalizedInbound.rows.length,
      messages: emptyNormalizedInbound.rows.map(r => ({
        message_id: r.message_id,
        case_id: r.case_id,
        from_email: r.from_email,
        subject: (r.subject || '').substring(0, 120),
        thread_id: r.thread_id,
        normalized_body_source: r.normalized_body_source || null,
        attachment_count: Number(r.attachment_count) || 0,
        received_at: r.received_at,
      })),
    },
    proposal_message_mismatches: {
      count: proposalMessageMismatches.rows.length,
      proposals: proposalMessageMismatches.rows.map(r => ({
        proposal_id: r.proposal_id,
        proposal_case_id: r.proposal_case_id,
        proposal_status: r.proposal_status,
        trigger_message_id: r.trigger_message_id,
        message_case_id: r.message_case_id,
        proposal_agency_name: r.proposal_agency_name,
        message_agency_name: r.message_agency_name,
        subject: (r.subject || '').substring(0, 120),
        message_received_at: r.message_received_at,
      })),
    },
  };
}

module.exports = {
  buildWeeklyQualityReport,
  buildClassificationConfusionMatrix,
  inferActualClassificationFromExpectedAction,
  normalizeIntentToCanonicalClass,
  buildReconciliationReport,
};
