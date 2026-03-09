const { normalizePortalUrl } = require('./portal-utils');
const { normalizeStateCode, parseStateFromAgencyName } = require('./state-utils');

function normalizeImportText(value = '') {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeJsonParse(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function isPlaceholderAgencyEmail(email) {
  return /placeholder\.invalid/i.test(String(email || '').trim());
}

function isPlaceholderCaseTitle(value = '') {
  const normalized = normalizeImportText(value).toLowerCase();
  return !normalized || normalized === 'untitled case' || normalized === 'untitled';
}

function pickSafeSubjectDescriptor(...values) {
  for (const value of values) {
    const normalized = normalizeImportText(value);
    if (!normalized) continue;
    if (isPlaceholderCaseTitle(normalized)) continue;
    return normalized;
  }
  return 'Records Request';
}

function normalizePortalTimeoutSubstatus(substatus) {
  const value = String(substatus || '').trim();
  if (!value) return null;
  return value.replace(
    /Status:\s*created/gi,
    'No active submit-portal run; last portal task status was created'
  );
}

function deriveDisplayState(state, agencyName) {
  const normalizedState = normalizeStateCode(state);
  const parsedAgencyState = parseStateFromAgencyName(agencyName);

  // If the case row carries a stale state but the resolved agency name includes
  // an explicit trailing state label, trust the agency label. This keeps queue
  // and detail displays aligned when canonicalization has already fixed the
  // agency identity but the case row has not been backfilled yet.
  if (normalizedState && parsedAgencyState && normalizedState !== parsedAgencyState) {
    return parsedAgencyState;
  }

  return normalizedState || parsedAgencyState || null;
}

function extractResearchSuggestedAgency(contactResearchNotes) {
  const parsed = safeJsonParse(contactResearchNotes);
  if (!parsed || typeof parsed !== 'object') return null;

  const brief = parsed.brief && typeof parsed.brief === 'object' ? parsed.brief : {};
  const contact = parsed.contactResult && typeof parsed.contactResult === 'object' ? parsed.contactResult : {};
  const execution = parsed.execution && typeof parsed.execution === 'object' ? parsed.execution : {};

  const suggested = Array.isArray(brief.suggested_agencies) ? brief.suggested_agencies : [];
  const topSuggested = suggested.find((item) => item && typeof item === 'object' && String(item.name || '').trim());
  if (topSuggested) {
    return {
      name: String(topSuggested.name).trim(),
      reason: String(topSuggested.reason || brief.summary || '').trim() || null,
      confidence: typeof topSuggested.confidence === 'number' ? topSuggested.confidence : null,
      source: 'brief.suggested_agencies',
    };
  }

  const contactName = String(contact.agency_name || contact.name || '').trim();
  if (contactName && (contact.contact_email || contact.portal_url || contact.contact_phone || contact.phone)) {
    return {
      name: contactName,
      reason: String(contact.notes || brief.summary || '').trim() || null,
      confidence: typeof contact.confidence === 'number' ? contact.confidence : null,
      source: 'contactResult',
    };
  }

  const executionSuggestedAgency = String(execution.suggested_agency || '').trim();
  if (executionSuggestedAgency && !/^unknown\b/i.test(executionSuggestedAgency)) {
    return {
      name: executionSuggestedAgency,
      reason: String(execution.research_failure_reason || brief.summary || '').trim() || null,
      confidence: null,
      source: 'execution.suggested_agency',
    };
  }

  return null;
}

function hasUnresolvedResearchPlaceholder(contactResearchNotes) {
  const parsed = safeJsonParse(contactResearchNotes);
  if (!parsed || typeof parsed !== 'object') return false;

  const brief = parsed.brief && typeof parsed.brief === 'object' ? parsed.brief : {};
  const execution = parsed.execution && typeof parsed.execution === 'object' ? parsed.execution : {};
  const executionSuggestedAgency = String(execution.suggested_agency || '').trim();
  const summaryText = [
    brief.summary,
    brief.next_steps,
    execution.research_failure_reason,
  ]
    .filter(Boolean)
    .join(' ');

  return Boolean(
    !extractResearchSuggestedAgency(parsed)
    && (
      brief.researchFailed === true
      || execution.research_failed === true
      || /^unknown\b/i.test(executionSuggestedAgency)
      || /manual agency lookup needed/i.test(summaryText)
    )
  );
}

function shouldSuppressPlaceholderAgencyDisplay({ contactResearchNotes, agencyEmail, portalUrl, addedSource }) {
  return Boolean(
    isPlaceholderAgencyEmail(agencyEmail)
    && !String(portalUrl || '').trim()
    && (!addedSource || ['case_row_backfill', 'case_row_fallback'].includes(addedSource))
    && hasUnresolvedResearchPlaceholder(contactResearchNotes)
  );
}

function cleanMetadataLine(value) {
    return String(value || '')
        .replace(/\u200c/g, ' ')
        .replace(/\*\*/g, '')
        .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.:;,]+$/, '');
}

function normalizeMetadataText(value) {
    return String(value || '')
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n');
}

function normalizeNotionReferenceId(value = '') {
  const normalized = String(value || '').trim().replace(/-/g, '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(normalized) ? normalized : null;
}

function hasAlphabeticCharacters(value = '') {
  return /[a-z]/i.test(String(value || ''));
}

function isNotionReferenceList(value = '') {
  const parts = String(value || '')
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 0 && parts.every((part) => Boolean(normalizeNotionReferenceId(part)));
}

function isReferenceLikeMetadataValue(value = '') {
  const normalized = cleanMetadataLine(String(value || ''));
  if (!normalized) return true;
  if (normalizeNotionReferenceId(normalized) || isNotionReferenceList(normalized)) return true;

  const withoutIds = normalized
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, ' ')
    .replace(/\b[a-f0-9]{32}\b/gi, ' ')
    .replace(/[,\s]+/g, ' ')
    .trim();

  return !hasAlphabeticCharacters(withoutIds);
}

function extractMetadataAgencyHint(additionalDetails) {
    const text = normalizeMetadataText(additionalDetails);
    if (!text.trim()) return null;

  const patterns = [
    /(?:^|\n)\*{0,2}Police Department:\*{0,2}\s*([^\n\r]+)/gi,
    /(?:^|\n)\*{0,2}Sheriff(?:'s)? Office:\*{0,2}\s*([^\n\r]+)/gi,
    /(?:^|\n)\*{0,2}Agency:\*{0,2}\s*([^\n\r]+)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = cleanMetadataLine(match[1]);
      if (!name || isReferenceLikeMetadataValue(name)) {
        continue;
      }

      return {
        name,
        state: parseStateFromAgencyName(name),
        source: 'additional_details',
      };
    }
  }

  return null;
}

function isGenericAgencyLabel(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (!normalized) return false;

  return new Set([
    'agency',
    'department',
    'department unknown',
    'law enforcement',
    'police',
    'police department',
    'records department',
    'sheriff office',
    'sheriffs office',
    'sheriff s office',
    'unknown agency',
    'unknown department',
  ]).has(normalized);
}

const AGENCY_COMPARISON_STOPWORDS = new Set([
  'agency',
  'bureau',
  'city',
  'county',
  'department',
  'division',
  'office',
  'police',
  'public',
  'records',
  'sheriff',
  'state',
  'unit',
  'the',
  'of',
]);

function agencyComparisonTokens(name) {
  return Array.from(new Set(
    String(name || '')
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter((token) => token.length > 2)
      .filter((token) => !AGENCY_COMPARISON_STOPWORDS.has(token))
  ));
}

function detectCaseMetadataAgencyMismatch({ currentAgencyName, additionalDetails }) {
  const hintedAgency = extractMetadataAgencyHint(additionalDetails);
  const currentName = String(currentAgencyName || '').trim();
  if (!hintedAgency?.name || !currentName) return null;

  if (isGenericAgencyLabel(currentName)) {
    return {
      expectedAgencyName: hintedAgency.name,
      expectedState: hintedAgency.state || null,
      currentAgencyName: currentName,
      source: hintedAgency.source,
    };
  }

  const currentTokens = agencyComparisonTokens(currentName);
  const hintedTokens = agencyComparisonTokens(hintedAgency.name);
  if (!currentTokens.length || !hintedTokens.length) return null;

  const overlap = hintedTokens.filter((token) => currentTokens.includes(token));
  const overlapRatio = overlap.length / Math.min(currentTokens.length, hintedTokens.length);

  const currentState = parseStateFromAgencyName(currentName);
  const hintedState = hintedAgency.state;
  const strongStateConflict = Boolean(currentState && hintedState && currentState !== hintedState);
  const noMeaningfulOverlap = overlap.length === 0 || overlapRatio < 0.5;

  if (!noMeaningfulOverlap && !strongStateConflict) {
    return null;
  }

  return {
    expectedAgencyName: hintedAgency.name,
    expectedState: hintedAgency.state || null,
    currentAgencyName: currentName,
    source: hintedAgency.source,
  };
}

function detectAgencyStateMismatch({ currentAgencyName, caseState }) {
  const normalizedCaseState = normalizeStateCode(caseState);
  const currentName = String(currentAgencyName || '').trim();
  if (!normalizedCaseState || !currentName) return null;

  const agencyState = parseStateFromAgencyName(currentName);
  if (!agencyState || agencyState === normalizedCaseState) return null;

  return {
    currentAgencyName: currentName,
    agencyState,
    caseState: normalizedCaseState,
    source: 'case_state',
  };
}

function evaluateImportAutoDispatchSafety({
  caseName,
  subjectName,
  agencyName,
  state,
  additionalDetails,
  importWarnings,
  agencyEmail,
  portalUrl,
}) {
  const warningTypes = Array.isArray(importWarnings)
    ? importWarnings
        .map((warning) => String(warning?.type || '').trim().toUpperCase())
        .filter(Boolean)
    : [];

  const metadataMismatch = detectCaseMetadataAgencyMismatch({
    currentAgencyName: agencyName,
    additionalDetails,
  });
  const agencyStateMismatch = detectAgencyStateMismatch({
    currentAgencyName: agencyName,
    caseState: state,
  });
  const metadataHint = extractMetadataAgencyHint(additionalDetails);
  const notionReferenceAgency = Boolean(
    normalizeNotionReferenceId(agencyName) ||
    isNotionReferenceList(agencyName)
  );
  const placeholderCaseTitle = isPlaceholderCaseTitle(caseName);
  const placeholderSubject = isPlaceholderCaseTitle(subjectName);
  const genericAgency = isGenericAgencyLabel(agencyName);
  const hasDeliveryPath = Boolean(normalizeImportText(agencyEmail) || normalizePortalUrl(portalUrl));

  const shouldBlockAutoDispatch = Boolean(
    ((!notionReferenceAgency) && (metadataMismatch || agencyStateMismatch || warningTypes.includes('AGENCY_METADATA_MISMATCH'))) ||
    (placeholderCaseTitle && placeholderSubject) ||
    (genericAgency && metadataHint && hasDeliveryPath)
  );

  let reasonCode = null;
  if (metadataMismatch || warningTypes.includes('AGENCY_METADATA_MISMATCH')) {
    reasonCode = 'AGENCY_METADATA_MISMATCH';
  } else if (agencyStateMismatch) {
    reasonCode = 'AGENCY_STATE_MISMATCH';
  } else if (placeholderCaseTitle && placeholderSubject) {
    reasonCode = 'PLACEHOLDER_TITLE';
  } else if (genericAgency && metadataHint && hasDeliveryPath) {
    reasonCode = 'GENERIC_AGENCY_WITH_CHANNEL';
  }

  return {
    shouldBlockAutoDispatch,
    reasonCode,
    metadataMismatch,
    agencyStateMismatch,
    metadataHint,
    warningTypes,
    placeholderCaseTitle,
    placeholderSubject,
  };
}

module.exports = {
  safeJsonParse,
  normalizeImportText,
  isPlaceholderAgencyEmail,
  isPlaceholderCaseTitle,
  pickSafeSubjectDescriptor,
  normalizePortalTimeoutSubstatus,
  deriveDisplayState,
  extractResearchSuggestedAgency,
  hasUnresolvedResearchPlaceholder,
  shouldSuppressPlaceholderAgencyDisplay,
  extractMetadataAgencyHint,
  isGenericAgencyLabel,
  detectCaseMetadataAgencyMismatch,
  detectAgencyStateMismatch,
  evaluateImportAutoDispatchSafety,
  isNotionReferenceList,
};
