const db = require('./database');

function inferAgencyType(agencyName) {
  const text = String(agencyName || '').toLowerCase();
  if (!text) return 'unknown agency';
  if (text.includes('sheriff')) return 'sheriff agency';
  if (text.includes('police')) return 'police agency';
  if (text.includes('state patrol') || text.includes('trooper') || text.includes('dci')) return 'state law enforcement agency';
  if (text.includes('district attorney') || text.includes('prosecutor')) return 'prosecutor office';
  if (text.includes('attorney general')) return 'attorney general office';
  if (text.includes('county')) return 'county agency';
  if (text.includes('city')) return 'city agency';
  return 'records agency';
}

function normalizeRequestedRecords(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join('; ');
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

async function getRelevantExamples(caseData, { classification = null, actionType = null, limit = 3 } = {}) {
  try {
    const agencyType = inferAgencyType(caseData?.agency_name);
    const stateCode = caseData?.state || caseData?.agency_state || null;
    const cappedLimit = Math.max(1, Math.min(Number(limit) || 3, 5));
    const fetchLimit = cappedLimit * 5;
    const result = await db.query(
      `SELECT proposal_id,
              action_type,
              classification,
              agency_name,
              agency_type,
              state_code,
              draft_subject,
              draft_body_text,
              human_edited,
              created_at,
              (
                CASE WHEN $1::text IS NOT NULL AND classification = $1 THEN 4 ELSE 0 END +
                CASE WHEN $2::text IS NOT NULL AND agency_type = $2 THEN 3 ELSE 0 END +
                CASE WHEN $3::text IS NOT NULL AND state_code = $3 THEN 2 ELSE 0 END +
                CASE WHEN $4::text IS NOT NULL AND action_type = $4 THEN 2 ELSE 0 END
              ) AS match_score
       FROM successful_examples
       WHERE outcome = 'approved'
         AND (
           ($1::text IS NOT NULL AND classification = $1) OR
           ($2::text IS NOT NULL AND agency_type = $2) OR
           ($3::text IS NOT NULL AND state_code = $3) OR
           ($4::text IS NOT NULL AND action_type = $4)
         )
       ORDER BY match_score DESC, human_edited ASC, created_at DESC
       LIMIT $5`,
      [classification || null, agencyType || null, stateCode || null, actionType || null, fetchLimit]
    );

    return result.rows
      .filter((row) => Number(row.match_score || 0) > 0)
      .slice(0, cappedLimit);
  } catch (error) {
    console.warn(`Successful example retrieval failed: ${error.message}`);
    return [];
  }
}

function formatExamplesForPrompt(examples, { heading = 'Similar approved examples' } = {}) {
  if (!Array.isArray(examples) || examples.length === 0) return '';
  const formatted = examples.map((example, index) => {
    const body = String(example.draft_body_text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 700);
    return [
      `Example ${index + 1}:`,
      `- Classification: ${example.classification || 'unknown'}`,
      `- Agency type: ${example.agency_type || 'unknown'}`,
      `- State: ${example.state_code || 'unknown'}`,
      `- Approved action: ${example.action_type}`,
      `- Subject: ${example.draft_subject || '(no subject)'}`,
      `- Body: ${body}`,
    ].join('\n');
  });

  return `\n## ${heading}\nUse these as patterns, not text to copy verbatim.\n${formatted.join('\n\n')}\n`;
}

async function storeApprovedExample(proposal, { decidedBy = null } = {}) {
  try {
    if (!proposal?.id || !proposal?.case_id || !proposal?.action_type) return null;

    const latestProposal = await db.getProposalById(proposal.id).catch(() => proposal);
    const draftSubject = latestProposal?.draft_subject || proposal?.draft_subject || null;
    const draftBodyText = latestProposal?.draft_body_text || proposal?.draft_body_text || null;
    if (!draftSubject || !draftBodyText) return null;

    const [caseData, latestAnalysis] = await Promise.all([
      db.getCaseById(proposal.case_id).catch(() => null),
      db.getLatestResponseAnalysis(proposal.case_id).catch(() => null),
    ]);

    const metadata = {
      agency_email: caseData?.agency_email || caseData?.alternate_agency_email || null,
      portal_url: caseData?.portal_url || null,
      case_status: caseData?.status || null,
      case_substatus: caseData?.substatus || null,
    };

    const result = await db.query(
      `INSERT INTO successful_examples (
          proposal_id,
          case_id,
          trigger_message_id,
          action_type,
          classification,
          agency_name,
          agency_type,
          state_code,
          requested_records,
          draft_subject,
          draft_body_text,
          human_edited,
          approved_by,
          outcome,
          metadata
       ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'approved', $14::jsonb
       )
       ON CONFLICT (proposal_id) DO UPDATE
         SET trigger_message_id = EXCLUDED.trigger_message_id,
             action_type = EXCLUDED.action_type,
             classification = EXCLUDED.classification,
             agency_name = EXCLUDED.agency_name,
             agency_type = EXCLUDED.agency_type,
             state_code = EXCLUDED.state_code,
             requested_records = EXCLUDED.requested_records,
             draft_subject = EXCLUDED.draft_subject,
             draft_body_text = EXCLUDED.draft_body_text,
             human_edited = EXCLUDED.human_edited,
             approved_by = EXCLUDED.approved_by,
             outcome = EXCLUDED.outcome,
             metadata = EXCLUDED.metadata,
             updated_at = NOW()
       RETURNING id`,
      [
        proposal.id,
        proposal.case_id,
        proposal.trigger_message_id || proposal.message_id || null,
        latestProposal?.action_type || proposal.action_type,
        latestAnalysis?.classification || null,
        caseData?.agency_name || null,
        inferAgencyType(caseData?.agency_name),
        caseData?.state || caseData?.agency_state || null,
        normalizeRequestedRecords(caseData?.requested_records),
        draftSubject,
        draftBodyText,
        Boolean(latestProposal?.human_edited),
        decidedBy || null,
        JSON.stringify(metadata),
      ]
    );

    return result.rows[0] || null;
  } catch (error) {
    console.warn(`Successful example capture failed for proposal ${proposal?.id}: ${error.message}`);
    return null;
  }
}

module.exports = {
  formatExamplesForPrompt,
  getRelevantExamples,
  inferAgencyType,
  normalizeRequestedRecords,
  storeApprovedExample,
};
