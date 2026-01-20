/**
 * Safety Check Node
 *
 * Validates draft against constraints.
 * CRITICAL: Prevents sending contradictory requests.
 * Example: Don't request BWC if agency already said it's exempt.
 */

const logger = require('../../services/logger');

/**
 * Validate draft against constraints
 */
async function safetyCheckNode(state) {
  const {
    caseId, draftSubject, draftBodyText, constraints, scopeItems,
    proposalActionType
  } = state;

  const logs = [];
  const riskFlags = [];
  const warnings = [];

  if (!draftBodyText) {
    return {
      riskFlags: ['NO_DRAFT'],
      logs: ['Safety check skipped: no draft to validate']
    };
  }

  const draftLower = draftBodyText.toLowerCase();

  // === Constraint Violations ===

  // Check for BWC requests when exempt
  if ((constraints || []).includes('BWC_EXEMPT')) {
    if (draftLower.includes('body camera') || draftLower.includes('bwc') ||
        draftLower.includes('body worn')) {
      // Only flag if we're requesting it, not acknowledging exemption
      if (!draftLower.includes('understand') && !draftLower.includes('acknowledge') &&
          !draftLower.includes('noted')) {
        riskFlags.push('REQUESTS_EXEMPT_ITEM');
        warnings.push('Draft requests body camera footage that agency has marked as exempt');
        logs.push('WARNING: Draft requests BWC despite BWC_EXEMPT constraint');
      }
    }
  }

  // Check for fee negotiation when already accepted
  if ((constraints || []).includes('FEE_ACCEPTED')) {
    if (draftLower.includes('negotiate') || draftLower.includes('reduce') ||
        draftLower.includes('waive')) {
      riskFlags.push('CONTRADICTS_FEE_ACCEPTANCE');
      warnings.push('Draft attempts to negotiate fee after already accepting');
      logs.push('WARNING: Draft tries to negotiate already-accepted fee');
    }
  }

  // Check for requesting items marked as delivered
  const deliveredItems = (scopeItems || []).filter(s => s.status === 'DELIVERED');
  for (const item of deliveredItems) {
    if (draftLower.includes(item.item.toLowerCase())) {
      // Check context - is it acknowledging receipt or re-requesting?
      if (!draftLower.includes('received') && !draftLower.includes('thank')) {
        warnings.push(`Draft may be re-requesting already-delivered item: ${item.item}`);
        logs.push(`NOTE: Draft mentions delivered item "${item.item}"`);
      }
    }
  }

  // Check for investigation-blocked items
  if ((constraints || []).includes('INVESTIGATION_ACTIVE')) {
    if (proposalActionType === 'SEND_REBUTTAL') {
      warnings.push('Rebuttal sent while investigation is active - may be futile');
      logs.push('NOTE: Investigation is active, rebuttal may not succeed');
    }
  }

  // === Tone/Content Checks ===

  // Check for aggressive language
  const aggressiveTerms = ['demand', 'lawsuit', 'attorney', 'legal action', 'violation', 'sue'];
  const aggressiveFound = aggressiveTerms.filter(t => draftLower.includes(t));
  if (aggressiveFound.length > 0 && proposalActionType !== 'SEND_REBUTTAL') {
    warnings.push(`Draft contains potentially aggressive language: ${aggressiveFound.join(', ')}`);
    logs.push(`NOTE: Aggressive terms found: ${aggressiveFound.join(', ')}`);
  }

  // Check for PII in draft (basic check)
  const ssnPattern = /\d{3}-\d{2}-\d{4}/;
  if (ssnPattern.test(draftBodyText)) {
    riskFlags.push('CONTAINS_PII');
    warnings.push('Draft may contain SSN - review before sending');
    logs.push('WARNING: Possible SSN detected in draft');
  }

  // Check for email addresses that shouldn't be exposed
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = draftBodyText.match(emailPattern) || [];
  const suspiciousEmails = emails.filter(e =>
    !e.includes(process.env.REQUESTER_EMAIL || '') &&
    !e.includes('agency') && !e.includes('gov')
  );
  if (suspiciousEmails.length > 0) {
    warnings.push(`Draft contains email addresses: ${suspiciousEmails.join(', ')}`);
    logs.push(`NOTE: Found emails in draft: ${suspiciousEmails.join(', ')}`);
  }

  // === Determine if safe to proceed ===
  const hasCriticalRisk = riskFlags.some(f =>
    ['REQUESTS_EXEMPT_ITEM', 'CONTRADICTS_FEE_ACCEPTANCE', 'CONTAINS_PII'].includes(f)
  );

  if (hasCriticalRisk) {
    logs.push('Safety check FAILED - critical risk flags detected');
    return {
      riskFlags,
      warnings,
      canAutoExecute: false,  // Force human review
      requiresHuman: true,
      pauseReason: 'SENSITIVE',
      logs
    };
  }

  logs.push(`Safety check passed (${warnings.length} warnings, ${riskFlags.length} flags)`);
  return {
    riskFlags,
    warnings,
    logs
  };
}

module.exports = { safetyCheckNode };
