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
  const normalized = String(email || '').trim().toLowerCase();
  return normalized === 'pending-research@intake.autobot' || /placeholder\.invalid/i.test(normalized);
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

const SYNTHETIC_CHANNEL_PATTERNS = [
  /test@agency\.gov/i,
  /placeholder\.invalid/i,
  /localhost qa/i,
  /synthetic qa/i,
  /scenario agency/i,
];

function textContainsSyntheticChannel(text = '') {
  const value = String(text || '');
  return SYNTHETIC_CHANNEL_PATTERNS.some((pattern) => pattern.test(value));
}

function sanitizeStaleResearchHandoffDraft(draftText) {
  const original = String(draftText || '').trim();
  if (!original || !textContainsSyntheticChannel(original)) {
    return original || null;
  }

  let sanitized = original;

  sanitized = sanitized.replace(
    /Research completed but no new channels were found\.\s*Existing channels:\s*[^.]+?\.\s*Review and decide whether to retry via existing channels or try a different approach\./i,
    'Research completed but no verified existing channels were found. Review and decide whether to retry research or try a different approach.'
  );

  sanitized = sanitized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^Existing channels:/i.test(line) && textContainsSyntheticChannel(line)) return false;
      return !textContainsSyntheticChannel(line);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!sanitized) {
    return 'Research completed but no verified existing channels were found. Review and decide whether to retry research or try a different approach.';
  }

  return sanitized;
}

function sanitizeStaleResearchHandoffReasoning(reasoning) {
  if (!Array.isArray(reasoning)) return reasoning;
  const filtered = reasoning
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .filter((line) => !textContainsSyntheticChannel(line));

  return filtered.length > 0 ? filtered : ['Research completed but existing synthetic channels were ignored.'];
}

function filterStaleImportWarnings(importWarnings, {
  originalAgencyName,
  resolvedAgencyName,
  resolvedAgencyId,
  currentAgencyId,
  suppressPlaceholderAgencyDisplay,
  forceCorrectedAgencyDisplay,
  useResearchSuggestedDisplay,
}) {
  if (!Array.isArray(importWarnings) || importWarnings.length === 0) {
    return importWarnings || null;
  }

  const originalName = String(originalAgencyName || '').trim();
  const resolvedName = String(resolvedAgencyName || '').trim();
  const hideSyntheticPlaceholderWarnings = Boolean(
    suppressPlaceholderAgencyDisplay ||
    forceCorrectedAgencyDisplay ||
    useResearchSuggestedDisplay ||
    /^unknown agency$/i.test(resolvedName)
  );

  const filtered = importWarnings.filter((warning) => {
    const message = String(warning?.message || '');

    if (/placeholder\.invalid/i.test(message)) {
      return false;
    }

    if (
      (resolvedAgencyId || currentAgencyId) &&
      originalName &&
      message.includes(`Agency "${originalName}" not found in directory`)
    ) {
      return false;
    }

    if (
      hideSyntheticPlaceholderWarnings &&
      originalName &&
      resolvedName &&
      originalName.toLowerCase() !== resolvedName.toLowerCase() &&
      message.includes(`Agency "${originalName}" not found in directory`)
    ) {
      return false;
    }

    return true;
  });

  return filtered.length > 0 ? filtered : null;
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

function extractMetadataCityHint(additionalDetails = '') {
  const text = normalizeMetadataText(additionalDetails);
  if (!text.trim()) return null;

  const patterns = [
    /(?:^|\n)\*{0,2}City\s*:?\*{0,2}\s*([^\n\r]+)/gi,
    /(?:^|\n)\*{0,2}Incident Location\s*:?\*{0,2}\s*([^\n\r]+)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = cleanMetadataLine(match[1]);
      if (!value || isReferenceLikeMetadataValue(value)) continue;
      const city = value.split(',')[0]?.trim();
      if (city && hasAlphabeticCharacters(city)) {
        return {
          name: city,
          source: 'additional_details',
        };
      }
    }
  }

  return null;
}

function extractAgencyNameFromAdditionalDetails(additionalDetails = '') {
  const metadataHint = extractMetadataAgencyHint(additionalDetails);
  if (metadataHint?.name) {
    return metadataHint.name;
  }

  const lines = String(additionalDetails || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    const bulletAgencyMatch = line.match(/^[-*]\s*\*{0,2}([^:\n\r*]+?(?:Police Department|Sheriff(?:'s)? Office|Police Services)[^:\n\r*]*)\*{0,2}\s*:/i);
    if (bulletAgencyMatch?.[1]) {
      const candidate = cleanMetadataLine(bulletAgencyMatch[1]);
      if (candidate && !normalizeNotionReferenceId(candidate) && !isNotionReferenceList(candidate) && !isGenericAgencyLabel(candidate)) {
        return candidate;
      }
    }

    if (!/^(?:\*\*)?Police Department:?/i.test(line)) continue;

    const candidate = line
        .replace(/^(?:\*\*)?Police Department:?\s*/i, '')
        .replace(/\*\*$/g, '')
      .trim();

    if (!candidate || normalizeNotionReferenceId(candidate) || isNotionReferenceList(candidate)) {
      continue;
    }

    return candidate
      .replace(/\s*,?\s*with\s+.+$/i, '')
      .trim();
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

function detectAgencyCityMismatch({ currentAgencyName, additionalDetails }) {
  const cityHint = extractMetadataCityHint(additionalDetails);
  const currentName = String(currentAgencyName || '').trim();
  if (!cityHint?.name || !currentName) return null;
  if (!/police department/i.test(currentName)) return null;

  const narrativeAgency = extractAgencyNameFromAdditionalDetails(additionalDetails);
  if (narrativeAgency) {
    const currentAgencyTokens = agencyComparisonTokens(currentName);
    const narrativeAgencyTokens = agencyComparisonTokens(narrativeAgency);
    const narrativeOverlap = narrativeAgencyTokens.filter((token) => currentAgencyTokens.includes(token));
    if (narrativeOverlap.length > 0) {
      return null;
    }
  }

  const currentTokens = agencyComparisonTokens(currentName);
  const cityTokens = agencyComparisonTokens(cityHint.name);
  if (!currentTokens.length || !cityTokens.length) return null;

  const overlap = cityTokens.filter((token) => currentTokens.includes(token));
  if (overlap.length > 0) return null;

  return {
    currentAgencyName: currentName,
    expectedCity: cityHint.name,
    source: cityHint.source,
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
  const agencyCityMismatch = detectAgencyCityMismatch({
    currentAgencyName: agencyName,
    additionalDetails,
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
    ((!notionReferenceAgency) && (metadataMismatch || agencyStateMismatch || agencyCityMismatch || warningTypes.includes('AGENCY_METADATA_MISMATCH'))) ||
    (placeholderCaseTitle && placeholderSubject) ||
    (genericAgency && metadataHint && hasDeliveryPath)
  );

  let reasonCode = null;
  if (metadataMismatch || warningTypes.includes('AGENCY_METADATA_MISMATCH')) {
    reasonCode = 'AGENCY_METADATA_MISMATCH';
  } else if (agencyStateMismatch) {
    reasonCode = 'AGENCY_STATE_MISMATCH';
  } else if (agencyCityMismatch) {
    reasonCode = 'AGENCY_CITY_MISMATCH';
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
    agencyCityMismatch,
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
  extractAgencyNameFromAdditionalDetails,
  isGenericAgencyLabel,
  detectCaseMetadataAgencyMismatch,
  detectAgencyStateMismatch,
  extractMetadataCityHint,
  detectAgencyCityMismatch,
  evaluateImportAutoDispatchSafety,
  isNotionReferenceList,
  textContainsSyntheticChannel,
  sanitizeStaleResearchHandoffDraft,
  sanitizeStaleResearchHandoffReasoning,
  filterStaleImportWarnings,
};
