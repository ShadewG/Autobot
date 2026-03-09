const crypto = require('crypto');
const db = require('./database');
const logger = require('./logger');
const { normalizeStateCode, parseStateFromAgencyName } = require('../utils/state-utils');

function createDeterministicSyntheticId(seed) {
  return crypto.createHash('sha256').update(String(seed || crypto.randomUUID())).digest('hex').slice(0, 32);
}

function extractFirstUrl(text) {
  if (!text) return null;
  const match = String(text).match(/https?:\/\/[^\s<>"')]+/i);
  return match ? match[0] : null;
}

function cleanForwardedSubject(subject) {
  return String(subject || '')
    .replace(/^\s*(fwd?|fw):\s*/i, '')
    .trim();
}

function parseEmailAddresses(value) {
  if (!value) return [];
  const matches = String(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return Array.from(new Set((matches || []).map((email) => email.toLowerCase())));
}

function getConfiguredIntakeAddresses() {
  return new Set(
    [process.env.EMAIL_INTAKE_ADDRESS, process.env.EMAIL_INTAKE_ADDRESSES, process.env.EMAIL_INTAKE_RECIPIENTS]
      .flatMap((value) => parseEmailAddresses(value))
  );
}

function isEmailIntakeRecipient(toValue) {
  const configured = getConfiguredIntakeAddresses();
  if (configured.size === 0) return false;
  const recipients = parseEmailAddresses(toValue);
  return recipients.some((recipient) => configured.has(recipient));
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'EMAIL_INTAKE_VALIDATION';
  return error;
}

async function createEmailIntakeCase({
  forwarded_subject = '',
  forwarded_body_text = '',
  forwarded_from = null,
  source_article_url = null,
  source_article_id = null,
  case_name = null,
  subject_name = null,
  agency_name = null,
  state = null,
  additional_details = null,
  tags = [],
  priority = 0,
  user_id = null,
} = {}) {
  const extractedUrl = source_article_url || extractFirstUrl(forwarded_body_text);
  const cleanedSubject = cleanForwardedSubject(forwarded_subject);
  const resolvedCaseName = case_name || cleanedSubject || (extractedUrl ? `Article Intake: ${extractedUrl}` : null);
  const resolvedSubjectName = subject_name || cleanedSubject || 'Unknown subject';
  const resolvedAgencyName = agency_name || 'Unknown agency';
  const normalizedState = normalizeStateCode(state) || parseStateFromAgencyName(resolvedAgencyName) || null;

  if (!resolvedCaseName) {
    throw validationError('A forwarded subject, case_name, or source_article_url is required');
  }

  if (!extractedUrl) {
    throw validationError('A source article URL is required in source_article_url or forwarded_body_text');
  }

  try {
    const syntheticId = createDeterministicSyntheticId(source_article_id || extractedUrl);
    const existing = await db.getCaseByNotionId(syntheticId);
    if (existing) {
      return {
        created: false,
        message: 'Case already exists (dedup)',
        case_id: existing.id,
        case: {
          id: existing.id,
          notion_page_id: existing.notion_page_id,
          case_name: existing.case_name,
          subject_name: existing.subject_name,
          agency_name: existing.agency_name,
          state: existing.state,
          status: existing.status,
        },
      };
    }

    const details = [
      additional_details || null,
      `Source article: ${extractedUrl}`,
      forwarded_from ? `Forwarded from: ${forwarded_from}` : null,
      cleanedSubject ? `Forwarded subject: ${cleanedSubject}` : null,
    ].filter(Boolean).join('\n');

    // Use placeholder email to satisfy email_or_portal_required constraint.
    // Case starts in needs_human_review — operator will set real contact info.
    const newCase = await db.createCase({
      notion_page_id: syntheticId,
      case_name: resolvedCaseName,
      subject_name: resolvedSubjectName,
      agency_name: resolvedAgencyName,
      agency_email: 'pending-research@intake.autobot',
      alternate_agency_email: null,
      portal_url: null,
      portal_provider: null,
      state: normalizedState,
      incident_date: null,
      incident_location: null,
      requested_records: ['Review forwarded article and create request strategy'],
      additional_details: details,
      tags: Array.from(new Set([...(Array.isArray(tags) ? tags : []), 'source:email_intake'])),
      priority,
      user_id,
      status: 'needs_human_review',
    });

    await db.logActivity('case_created_email_intake', `Created case "${resolvedCaseName}" from forwarded article email`, {
      case_id: newCase.id,
      actor_type: 'system',
      source_service: 'email_intake',
      source_article_url: extractedUrl,
      forwarded_from,
    });

    return {
      created: true,
      case_id: newCase.id,
      case: {
        id: newCase.id,
        notion_page_id: newCase.notion_page_id,
        case_name: newCase.case_name,
        subject_name: newCase.subject_name,
        agency_name: newCase.agency_name,
        state: newCase.state,
        status: newCase.status,
      },
    };
  } catch (error) {
    logger.error('Error creating case via email intake', { error: error.message, forwarded_subject });
    throw error;
  }
}

module.exports = {
  createEmailIntakeCase,
  isEmailIntakeRecipient,
  getConfiguredIntakeAddresses,
  parseEmailAddresses,
  extractFirstUrl,
  cleanForwardedSubject,
};
