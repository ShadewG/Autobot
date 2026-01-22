/**
 * Update Constraints Node
 *
 * Updates constraints and scope based on agency response.
 * Uses structured data from AI analysis (P1 fix #6).
 *
 * Critical for preventing contradictory proposals:
 * - If agency says "BWC exempt", add BWC_EXEMPT constraint
 * - If agency says "fee required", add FEE_REQUIRED constraint
 * - Update scope item statuses based on response
 */

const db = require('../../services/database');
const logger = require('../../services/logger');

/**
 * Normalize item name for matching:
 * - Strip number prefix (e.g., "1. ", "2. ")
 * - Convert to lowercase
 * - Trim whitespace
 */
function normalizeItemName(name) {
  if (!name) return '';
  // Strip leading number + period + space (e.g., "1. " or "10. ")
  const stripped = name.replace(/^\d+\.\s*/, '');
  return stripped.toLowerCase().trim();
}

/**
 * Merge scope updates from analysis with existing scope items
 * Handles both 'name' and 'item' formats for compatibility
 */
function mergeScopeUpdates(existing, updates) {
  // Normalize existing: use 'name' as canonical key, but handle 'item' too
  const byItem = new Map(existing.map(s => {
    const itemName = normalizeItemName(s.name || s.item);
    return [itemName, { ...s, name: s.name || s.item }];
  }));

  for (const update of updates) {
    // Handle both 'name' and 'item' in updates
    // Strip number prefix that AI might have included from the prompt
    const rawName = update.name || update.item || '';
    const itemName = normalizeItemName(rawName);
    if (!itemName) continue;

    if (byItem.has(itemName)) {
      // Update existing - merge with normalized name (keep original name, not numbered)
      const existingItem = byItem.get(itemName);
      byItem.set(itemName, {
        ...existingItem,
        status: update.status || existingItem.status,
        reason: update.reason || existingItem.reason,
        confidence: update.confidence || existingItem.confidence,
        // Keep the original name without number prefix
        name: existingItem.name
      });
    } else {
      // Add new with cleaned name (strip number prefix)
      const cleanName = rawName.replace(/^\d+\.\s*/, '');
      byItem.set(itemName, {
        ...update,
        name: cleanName
      });
    }
  }

  return Array.from(byItem.values());
}

/**
 * Update constraints using structured data from analysis
 */
async function updateConstraintsNode(state) {
  const { caseId, latestInboundMessageId, classification, extractedFeeAmount, constraints, scopeItems } = state;

  // Skip if no inbound message to analyze
  if (!latestInboundMessageId) {
    return { logs: ['No inbound message, skipping constraint update'] };
  }

  try {
    // Fetch the analysis (which should have structured constraints)
    const analysis = await db.getResponseAnalysisByMessageId(latestInboundMessageId);

    if (!analysis?.full_analysis_json) {
      return { logs: ['No analysis found, skipping constraint update'] };
    }

    const parsed = typeof analysis.full_analysis_json === 'string'
      ? JSON.parse(analysis.full_analysis_json)
      : analysis.full_analysis_json;

    // Get current constraints (use JSONB columns)
    const caseData = await db.getCaseById(caseId);
    const currentConstraints = caseData.constraints_jsonb || caseData.constraints || constraints || [];
    const currentScopeItems = caseData.scope_items_jsonb || caseData.scope_items || scopeItems || [];

    const newConstraints = [...currentConstraints];
    const logs = [];

    // Add constraints from AI analysis if available (P1 structured approach)
    if (parsed.constraints_to_add && Array.isArray(parsed.constraints_to_add)) {
      for (const constraint of parsed.constraints_to_add) {
        if (!newConstraints.includes(constraint)) {
          newConstraints.push(constraint);
          logs.push(`Added constraint from AI: ${constraint}`);
        }
      }
    }

    // Fallback: Extract constraints from key_points if no structured data
    if (!parsed.constraints_to_add && parsed.key_points) {
      for (const point of parsed.key_points) {
        const pointLower = point.toLowerCase();

        // BWC exemption detection
        if ((pointLower.includes('body camera') || pointLower.includes('bwc')) &&
            (pointLower.includes('exempt') || pointLower.includes('not available') ||
             pointLower.includes('cannot provide') || pointLower.includes('withheld'))) {
          if (!newConstraints.includes('BWC_EXEMPT')) {
            newConstraints.push('BWC_EXEMPT');
            logs.push('Added constraint: BWC_EXEMPT (from key_points)');
          }
        }

        // Fee requirement detection
        if ((pointLower.includes('fee') || pointLower.includes('cost') || pointLower.includes('payment')) &&
            !newConstraints.includes('FEE_REQUIRED') && extractedFeeAmount > 0) {
          newConstraints.push('FEE_REQUIRED');
          logs.push(`Added constraint: FEE_REQUIRED (amount: $${extractedFeeAmount})`);
        }

        // ID requirement detection
        if ((pointLower.includes('identification') || pointLower.includes('verify identity') ||
             pointLower.includes('proof of') || pointLower.includes('notarized')) &&
            !newConstraints.includes('ID_REQUIRED')) {
          newConstraints.push('ID_REQUIRED');
          logs.push('Added constraint: ID_REQUIRED');
        }

        // Ongoing investigation detection
        if ((pointLower.includes('ongoing investigation') || pointLower.includes('active case') ||
             pointLower.includes('pending litigation')) &&
            !newConstraints.includes('INVESTIGATION_ACTIVE')) {
          newConstraints.push('INVESTIGATION_ACTIVE');
          logs.push('Added constraint: INVESTIGATION_ACTIVE');
        }
      }
    }

    // Handle denial classification
    if (classification === 'DENIAL') {
      if (!newConstraints.includes('DENIAL_RECEIVED')) {
        newConstraints.push('DENIAL_RECEIVED');
        logs.push('Added constraint: DENIAL_RECEIVED');
      }
    }

    // Merge scope updates
    const updatedScopeItems = parsed.scope_updates && Array.isArray(parsed.scope_updates)
      ? mergeScopeUpdates(currentScopeItems, parsed.scope_updates)
      : currentScopeItems;

    // Build fee quote update if fee breakdown available
    let feeQuoteUpdate = null;
    if (parsed.fee_breakdown || extractedFeeAmount) {
      const currentFeeQuote = caseData.fee_quote_jsonb || {};
      feeQuoteUpdate = {
        ...currentFeeQuote,
        amount: extractedFeeAmount || currentFeeQuote.amount,
        quoted_at: new Date().toISOString(),
        status: 'QUOTED'
      };

      if (parsed.fee_breakdown) {
        feeQuoteUpdate.hourly_rate = parsed.fee_breakdown.hourly_rate || currentFeeQuote.hourly_rate;
        feeQuoteUpdate.estimated_hours = parsed.fee_breakdown.estimated_hours || currentFeeQuote.estimated_hours;
        feeQuoteUpdate.breakdown = parsed.fee_breakdown.items || currentFeeQuote.breakdown;
        feeQuoteUpdate.deposit_required = parsed.fee_breakdown.deposit_required || currentFeeQuote.deposit_required;
      }
      logs.push(`Updated fee quote: $${feeQuoteUpdate.amount}`);
    }

    // Persist updated constraints to DB if changed
    const constraintsChanged = JSON.stringify(newConstraints.sort()) !== JSON.stringify(currentConstraints.sort());
    const scopeChanged = JSON.stringify(updatedScopeItems) !== JSON.stringify(currentScopeItems);

    const updatePayload = {};
    // JSONB columns need to be stringified for PostgreSQL pg driver
    if (constraintsChanged) updatePayload.constraints_jsonb = JSON.stringify(newConstraints);
    if (scopeChanged) updatePayload.scope_items_jsonb = JSON.stringify(updatedScopeItems);
    if (feeQuoteUpdate) updatePayload.fee_quote_jsonb = JSON.stringify(feeQuoteUpdate);

    if (Object.keys(updatePayload).length > 0) {
      await db.updateCase(caseId, updatePayload);
      logs.push('Persisted constraint/scope/fee updates to database');
    }

    return {
      constraints: newConstraints,
      scopeItems: updatedScopeItems,
      logs: logs.length > 0 ? logs : ['No constraint updates needed']
    };
  } catch (error) {
    logger.error('update_constraints_node error', { caseId, error: error.message });
    return {
      errors: [`Failed to update constraints: ${error.message}`]
    };
  }
}

module.exports = { updateConstraintsNode };
