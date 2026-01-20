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
 * Merge scope updates from analysis with existing scope items
 */
function mergeScopeUpdates(existing, updates) {
  const byItem = new Map(existing.map(s => [s.item.toLowerCase(), s]));

  for (const update of updates) {
    const key = update.item.toLowerCase();
    if (byItem.has(key)) {
      // Update existing
      byItem.set(key, { ...byItem.get(key), ...update });
    } else {
      // Add new
      byItem.set(key, update);
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

    // Get current constraints
    const caseData = await db.getCaseById(caseId);
    const currentConstraints = caseData.constraints || constraints || [];
    const currentScopeItems = caseData.scope_items || scopeItems || [];

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

    // Persist updated constraints to DB if changed
    const constraintsChanged = JSON.stringify(newConstraints.sort()) !== JSON.stringify(currentConstraints.sort());
    const scopeChanged = JSON.stringify(updatedScopeItems) !== JSON.stringify(currentScopeItems);

    if (constraintsChanged || scopeChanged) {
      await db.updateCase(caseId, {
        constraints: newConstraints,
        scope_items: updatedScopeItems
      });
      logs.push('Persisted constraint/scope updates to database');
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
