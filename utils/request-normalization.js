const { normalizeStateCode, parseStateFromAgencyName } = require('./state-utils');

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

module.exports = {
  safeJsonParse,
  isPlaceholderAgencyEmail,
  normalizePortalTimeoutSubstatus,
  deriveDisplayState,
  extractResearchSuggestedAgency,
  hasUnresolvedResearchPlaceholder,
  shouldSuppressPlaceholderAgencyDisplay,
};
