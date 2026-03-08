const db = require('./database');

const PATTERNS = [
  'portal_confirmation',
  'portal_release',
  'portal_access_issue',
  'blank_request_form',
  'fee_letter',
  'denial_letter',
  'mixed_partial_release',
  'wrong_agency_referral',
];

const REVIEW_CANDIDATE_REASONS = [
  'other_intent',
  'low_confidence',
  'requires_action_without_suggestion',
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function collectMessageText(record = {}) {
  const body = normalizeText(record.body_text || record.body_html || '');
  const subject = normalizeText(record.subject || '');
  const attachmentText = Array.isArray(record.attachments)
    ? record.attachments
        .map((attachment) => normalizeText(attachment?.extracted_text || ''))
        .filter(Boolean)
        .join(' ')
    : '';
  return normalizeText([subject, body, attachmentText].filter(Boolean).join(' ')).toLowerCase();
}

function classifyPromptPattern(record = {}) {
  const text = collectMessageText(record);
  const analysis = record.analysis || record.full_analysis_json || {};
  const intent = (record.intent || analysis.intent || '').toLowerCase();
  const denialSubtype = (record.denial_subtype || analysis.denial_subtype || '').toLowerCase();
  const portalType = (record.portal_notification_type || '').toLowerCase();
  const isPortal = Boolean(record.portal_notification || portalType || record.portal_notification_provider);

  if (isPortal && /(password|unlock|locked|activate|activation|reset your password|sign in)/.test(text)) {
    return 'portal_access_issue';
  }

  if (isPortal && /(successfully submitted|submission confirmation|request has been submitted|received your request|tracking number|reference number)/.test(text)) {
    return 'portal_confirmation';
  }

  if ((isPortal || intent === 'records_ready' || intent === 'delivery') && /(download|available for download|records are now available|documents are available|portal)/.test(text)) {
    return 'portal_release';
  }

  if (/(attached.*form|complete the attached form|fill out.*form|blank request form|request form attached|mailing address.*for cd)/.test(text)) {
    return 'blank_request_form';
  }

  if (intent === 'fee_request' || /(fee estimate|estimate.*fee|payment required|deposit required|cost estimate|not-to-exceed|invoice)/.test(text)) {
    return 'fee_letter';
  }

  if (intent === 'wrong_agency' || denialSubtype === 'wrong_agency' || /(wrong agency|not the custodian|contact .*records|please direct your request to|we do not maintain these records)/.test(text)) {
    return 'wrong_agency_referral';
  }

  if (intent === 'partial_delivery' || /(some records.*withheld|partial release|partially responsive|redacted|segregable|withheld pursuant)/.test(text)) {
    return 'mixed_partial_release';
  }

  if (intent === 'denial' || /(denied|exempt|withheld|privilege|vaughn|appeal rights)/.test(text)) {
    return 'denial_letter';
  }

  return null;
}

function buildExample(record, pattern) {
  const body = normalizeText(record.body_text || record.body_html || '');
  const attachmentSummary = Array.isArray(record.attachments)
    ? record.attachments
        .map((attachment) => ({
          filename: attachment?.filename || null,
          content_type: attachment?.content_type || null,
          extracted_text_excerpt: normalizeText(attachment?.extracted_text || '').slice(0, 500) || null,
        }))
        .filter((attachment) => attachment.extracted_text_excerpt)
    : [];

  return {
    pattern,
    message_id: record.id,
    case_id: record.case_id,
    received_at: record.received_at,
    subject: record.subject || null,
    from_email: record.from_email || null,
    agency_name: record.agency_name || null,
    state: record.state || null,
    intent: record.intent || record.analysis?.intent || null,
    denial_subtype: record.denial_subtype || record.analysis?.denial_subtype || null,
    suggested_action: record.suggested_action || record.analysis?.suggested_action || null,
    requires_action: record.requires_action ?? record.analysis?.requires_action ?? null,
    portal_notification: Boolean(record.portal_notification),
    portal_notification_type: record.portal_notification_type || null,
    body_excerpt: body.slice(0, 1200) || null,
    attachment_summary: attachmentSummary,
  };
}

function classifyReviewCandidate(record = {}, { confidenceThreshold = 0.6 } = {}) {
  const analysis = record.analysis || record.full_analysis_json || {};
  const intent = String(record.intent || analysis.intent || '').trim().toLowerCase();
  const confidenceScore = normalizeNumber(
    record.confidence_score ?? analysis.confidence_score
  );
  const suggestedAction = normalizeText(record.suggested_action || analysis.suggested_action || '');
  const requiresAction = record.requires_action ?? analysis.requires_action ?? null;

  const reviewReasons = [];

  if (intent === 'other' || intent === 'unclassified') {
    reviewReasons.push('other_intent');
  }

  if (confidenceScore !== null && confidenceScore < confidenceThreshold) {
    reviewReasons.push('low_confidence');
  }

  if (requiresAction === true && !suggestedAction) {
    reviewReasons.push('requires_action_without_suggestion');
  }

  return reviewReasons;
}

function buildReviewCandidate(record, options = {}) {
  const reviewReasons = classifyReviewCandidate(record, options);
  if (!reviewReasons.length) return null;

  const promptPatternHint = classifyPromptPattern(record);
  const example = buildExample(record, promptPatternHint);

  return {
    ...example,
    prompt_pattern_hint: promptPatternHint,
    confidence_score: normalizeNumber(
      record.confidence_score ?? record.analysis?.confidence_score
    ),
    review_reasons: reviewReasons,
    attachment_count: Array.isArray(record.attachments) ? record.attachments.length : 0,
  };
}

async function fetchCandidateMessages({ limit = 500, sinceDays = 365 } = {}) {
  const result = await db.query(
    `SELECT
        m.id,
        m.case_id,
        m.subject,
        m.from_email,
        m.body_text,
        m.body_html,
        m.portal_notification,
        m.portal_notification_type,
        m.portal_notification_provider,
        m.received_at,
        c.agency_name,
        c.state,
        ra.intent,
        ra.confidence_score,
        ra.full_analysis_json->>'denial_subtype' AS denial_subtype,
        ra.requires_action,
        ra.suggested_action,
        ra.full_analysis_json,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'filename', a.filename,
            'content_type', a.content_type,
            'extracted_text', LEFT(a.extracted_text, 4000)
          ))
          FROM attachments a
          WHERE a.message_id = m.id
            AND COALESCE(a.extracted_text, '') <> ''
        ), '[]'::jsonb) AS attachments
      FROM messages m
      LEFT JOIN cases c ON c.id = m.case_id
      LEFT JOIN response_analysis ra ON ra.message_id = m.id
      WHERE m.direction = 'inbound'
        AND m.received_at >= NOW() - ($1::int * INTERVAL '1 day')
      ORDER BY m.received_at DESC
      LIMIT $2`,
    [sinceDays, limit]
  );

  return result.rows.map((row) => ({
    ...row,
    analysis: typeof row.full_analysis_json === 'string'
      ? JSON.parse(row.full_analysis_json)
      : (row.full_analysis_json || null),
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
  }));
}

async function buildReviewCandidateDataset({
  limit = 500,
  sinceDays = 30,
  perReason = 25,
  confidenceThreshold = 0.6,
} = {}) {
  const rows = await fetchCandidateMessages({ limit, sinceDays });
  const candidates = [];
  const counts = Object.fromEntries(REVIEW_CANDIDATE_REASONS.map((reason) => [reason, 0]));

  for (const row of rows) {
    const candidate = buildReviewCandidate(row, { confidenceThreshold });
    if (!candidate) continue;

    for (const reason of candidate.review_reasons) {
      counts[reason] += 1;
    }

    candidates.push(candidate);
  }

  const limited = [];
  const perReasonCounts = Object.fromEntries(REVIEW_CANDIDATE_REASONS.map((reason) => [reason, 0]));
  for (const candidate of candidates) {
    const wouldOverflow = candidate.review_reasons.every((reason) => perReasonCounts[reason] >= perReason);
    if (wouldOverflow) continue;

    limited.push(candidate);
    for (const reason of candidate.review_reasons) {
      if (perReasonCounts[reason] < perReason) {
        perReasonCounts[reason] += 1;
      }
    }
  }

  return {
    generated_at: new Date().toISOString(),
    source: {
      since_days: sinceDays,
      scanned_messages: rows.length,
      per_reason_limit: perReason,
      confidence_threshold: confidenceThreshold,
    },
    counts: {
      ...counts,
      candidates: candidates.length,
      returned_candidates: limited.length,
    },
    candidates: limited,
  };
}

async function buildPromptPatternDataset({ limit = 500, sinceDays = 365, perPattern = 12 } = {}) {
  const rows = await fetchCandidateMessages({ limit, sinceDays });
  const buckets = new Map(PATTERNS.map((pattern) => [pattern, []]));

  for (const row of rows) {
    const pattern = classifyPromptPattern(row);
    if (!pattern) continue;
    const bucket = buckets.get(pattern);
    if (bucket.length >= perPattern) continue;
    bucket.push(buildExample(row, pattern));
  }

  const patterns = {};
  for (const pattern of PATTERNS) {
    patterns[pattern] = buckets.get(pattern) || [];
  }

  return {
    generated_at: new Date().toISOString(),
    source: {
      since_days: sinceDays,
      scanned_messages: rows.length,
      per_pattern_limit: perPattern,
    },
    counts: Object.fromEntries(PATTERNS.map((pattern) => [pattern, patterns[pattern].length])),
    patterns,
  };
}

module.exports = {
  PATTERNS,
  REVIEW_CANDIDATE_REASONS,
  buildPromptPatternDataset,
  buildReviewCandidateDataset,
  buildReviewCandidate,
  classifyReviewCandidate,
  classifyPromptPattern,
  collectMessageText,
};
