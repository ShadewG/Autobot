/**
 * Action Validator Service
 *
 * Implements safety/policy blocklist layer for agent actions.
 * Validates proposals against policy rules before execution.
 *
 * Deliverable 4: Safety/Policy Blocklist Layer
 */

const db = require('./database');
const discordService = require('./discord-service');

// Fee threshold for auto-approval (from env or default)
const FEE_AUTO_APPROVE_THRESHOLD = parseFloat(process.env.FEE_AUTO_APPROVE_MAX || '100');

// Sensitive keywords that require human review
const SENSITIVE_KEYWORDS = [
    'lawsuit', 'litigation', 'attorney', 'lawyer', 'legal action',
    'subpoena', 'court order', 'deposition', 'settlement',
    'criminal', 'felony', 'misdemeanor', 'arrest',
    'death', 'deceased', 'fatal', 'suicide', 'homicide',
    'minor', 'juvenile', 'child', 'under 18',
    'confidential', 'classified', 'sealed', 'protected'
];

/**
 * Policy rules and their validators
 */
const POLICY_RULES = {
    /**
     * PORTAL_CASE_EMAIL: Block email actions on cases with portal_url
     */
    PORTAL_CASE_EMAIL: {
        description: 'Cannot send email for portal-based cases',
        check: (caseData, proposal) => {
            const hasPortalUrl = !!caseData.portal_url;
            const isEmailAction = proposal.action_type?.startsWith('SEND_') ||
                                  proposal.response_type?.includes('email');

            if (hasPortalUrl && isEmailAction) {
                return {
                    violated: true,
                    action: 'BLOCK',
                    reason: `Case has portal URL (${caseData.portal_url}) - email action blocked`
                };
            }
            return { violated: false };
        }
    },

    /**
     * FEE_WITHOUT_APPROVAL: Block high fees without human approval
     */
    FEE_WITHOUT_APPROVAL: {
        description: 'High fees require human approval',
        check: (caseData, proposal) => {
            const feeAmount = parseFloat(proposal.metadata?.fee_amount ||
                                         caseData.last_fee_quote_amount || 0);
            const requiresApproval = proposal.requires_approval;

            if (feeAmount > FEE_AUTO_APPROVE_THRESHOLD && !requiresApproval) {
                return {
                    violated: true,
                    action: 'BLOCK',
                    reason: `Fee amount $${feeAmount} exceeds auto-approve threshold ($${FEE_AUTO_APPROVE_THRESHOLD})`
                };
            }
            return { violated: false };
        }
    },

    /**
     * EXEMPT_REQUEST_REBUTTAL: Block auto-rebuttal on high-confidence exemptions
     */
    EXEMPT_REQUEST_REBUTTAL: {
        description: 'Do not auto-rebut high-confidence exemption denials',
        check: (caseData, proposal, analysis) => {
            const isRebuttal = proposal.action_type === 'SEND_REBUTTAL' ||
                              proposal.response_type === 'denial_rebuttal';
            const isExemption = analysis?.intent === 'denial' &&
                               analysis?.full_analysis_json?.exemption_cited;
            const highConfidence = parseFloat(analysis?.confidence_score || 0) > 0.85;

            if (isRebuttal && isExemption && highConfidence) {
                return {
                    violated: true,
                    action: 'BLOCK',
                    reason: 'High-confidence exemption denial - human review required before rebuttal'
                };
            }
            return { violated: false };
        }
    },

    /**
     * HOSTILE_SENTIMENT_AUTO: Require approval for hostile sentiment
     */
    HOSTILE_SENTIMENT_AUTO: {
        description: 'Hostile sentiment requires human approval',
        check: (caseData, proposal, analysis) => {
            const isHostile = analysis?.sentiment === 'hostile';
            const requiresApproval = proposal.requires_approval;

            if (isHostile && !requiresApproval) {
                return {
                    violated: true,
                    action: 'REQUIRE_APPROVAL',
                    reason: 'Agency response has hostile sentiment - human approval required'
                };
            }
            return { violated: false };
        }
    },

    /**
     * SENSITIVE_CONTENT: Flag sensitive keywords for review
     */
    SENSITIVE_CONTENT: {
        description: 'Sensitive content requires human review',
        check: (caseData, proposal, analysis) => {
            const content = (proposal.generated_reply || '') +
                           (caseData.additional_details || '') +
                           (analysis?.key_points?.join(' ') || '');

            const contentLower = content.toLowerCase();
            const foundKeywords = SENSITIVE_KEYWORDS.filter(kw =>
                contentLower.includes(kw.toLowerCase())
            );

            if (foundKeywords.length > 0 && !proposal.requires_approval) {
                return {
                    violated: true,
                    action: 'REQUIRE_APPROVAL',
                    reason: `Sensitive content detected: ${foundKeywords.join(', ')}`
                };
            }
            return { violated: false };
        }
    },

    /**
     * ALREADY_EXECUTED: Prevent re-execution of already executed proposals
     */
    ALREADY_EXECUTED: {
        description: 'Cannot execute already-executed proposals',
        check: async (caseData, proposal) => {
            if (proposal.id) {
                const status = await db.isProposalExecuted(proposal.id);
                if (status?.executed) {
                    return {
                        violated: true,
                        action: 'BLOCK',
                        reason: `Proposal already executed at ${status.executed_at || 'unknown time'}`
                    };
                }
            }
            return { violated: false };
        }
    }
};

/**
 * Validate an action/proposal against all policy rules.
 *
 * @param {number} caseId - The case ID
 * @param {Object} proposal - The proposal to validate
 * @param {Object} [analysis] - Optional analysis data for context
 * @returns {Promise<{valid: boolean, blocked: boolean, violations: Array}>}
 */
async function validateAction(caseId, proposal, analysis = null) {
    const violations = [];
    let shouldBlock = false;
    let requiresApproval = proposal.requires_approval || false;

    // Get case data
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
        return {
            valid: false,
            blocked: true,
            violations: [{
                rule: 'CASE_NOT_FOUND',
                action: 'BLOCK',
                reason: `Case ${caseId} not found`
            }]
        };
    }

    // Run all policy checks
    for (const [ruleName, rule] of Object.entries(POLICY_RULES)) {
        try {
            const result = await rule.check(caseData, proposal, analysis);

            if (result.violated) {
                violations.push({
                    rule: ruleName,
                    action: result.action,
                    reason: result.reason
                });

                if (result.action === 'BLOCK') {
                    shouldBlock = true;
                } else if (result.action === 'REQUIRE_APPROVAL') {
                    requiresApproval = true;
                }
            }
        } catch (error) {
            console.error(`Policy rule ${ruleName} check failed:`, error.message);
            // Don't block on rule check errors, but log them
            violations.push({
                rule: ruleName,
                action: 'WARNING',
                reason: `Rule check failed: ${error.message}`
            });
        }
    }

    return {
        valid: !shouldBlock,
        blocked: shouldBlock,
        requiresApproval,
        violations
    };
}

/**
 * Block a proposal and notify via Discord.
 *
 * @param {number} proposalId - The proposal ID to block
 * @param {Array} violations - Array of violations that caused the block
 * @returns {Promise<Object>}
 */
async function blockProposal(proposalId, violations) {
    const reasonText = violations
        .filter(v => v.action === 'BLOCK')
        .map(v => `[${v.rule}] ${v.reason}`)
        .join('; ');

    // Update proposal status
    const proposal = await db.blockProposal(proposalId, reasonText);

    if (!proposal) {
        console.error(`Failed to block proposal ${proposalId} - not found`);
        return null;
    }

    // Get case data for notification
    const caseData = await db.getCaseById(proposal.case_id);

    // Notify Discord about blocked action
    try {
        await discordService.notifyBlockedAction({
            caseId: proposal.case_id,
            caseName: caseData?.case_name || 'Unknown',
            agencyName: caseData?.agency_name || 'Unknown',
            proposalId,
            actionType: proposal.action_type,
            violations,
            blockedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('Failed to send Discord notification for blocked action:', error.message);
    }

    // Log activity
    await db.logActivity('action_blocked', `Action blocked: ${reasonText}`, {
        case_id: proposal.case_id,
        proposal_id: proposalId,
        violations: violations
    });

    return proposal;
}

/**
 * Mark a proposal as requiring approval based on policy check.
 *
 * @param {number} proposalId - The proposal ID
 * @param {Array} violations - Array of violations that require approval
 * @returns {Promise<Object>}
 */
async function requireApproval(proposalId, violations) {
    const reasonText = violations
        .filter(v => v.action === 'REQUIRE_APPROVAL')
        .map(v => `[${v.rule}] ${v.reason}`)
        .join('; ');

    const proposal = await db.updateAutoReplyQueueEntry(proposalId, {
        requires_approval: true,
        status: 'pending',
        metadata: JSON.stringify({
            approval_required_reason: reasonText,
            approval_required_at: new Date().toISOString()
        })
    });

    // Log activity
    await db.logActivity('approval_required', `Approval required: ${reasonText}`, {
        case_id: proposal.case_id,
        proposal_id: proposalId,
        violations: violations.filter(v => v.action === 'REQUIRE_APPROVAL')
    });

    return proposal;
}

/**
 * Validate a proposal and apply appropriate actions (block or require approval).
 * This is a convenience method that combines validateAction with blockProposal/requireApproval.
 *
 * @param {number} caseId - The case ID
 * @param {Object} proposal - The proposal to validate (must have id property)
 * @param {Object} [analysis] - Optional analysis data
 * @returns {Promise<{valid: boolean, blocked: boolean, proposal: Object}>}
 */
async function validateAndApply(caseId, proposal, analysis = null) {
    const validation = await validateAction(caseId, proposal, analysis);

    if (validation.blocked) {
        const blockedProposal = await blockProposal(proposal.id, validation.violations);
        return {
            valid: false,
            blocked: true,
            proposal: blockedProposal,
            violations: validation.violations
        };
    }

    if (validation.requiresApproval && !proposal.requires_approval) {
        const updatedProposal = await requireApproval(proposal.id, validation.violations);
        return {
            valid: true,
            blocked: false,
            requiresApproval: true,
            proposal: updatedProposal,
            violations: validation.violations
        };
    }

    return {
        valid: true,
        blocked: false,
        requiresApproval: proposal.requires_approval || false,
        proposal,
        violations: validation.violations
    };
}

/**
 * Check if an action type is blocked for a case (quick check).
 *
 * @param {number} caseId - The case ID
 * @param {string} actionType - The action type to check
 * @returns {Promise<{blocked: boolean, reason?: string}>}
 */
async function isActionBlocked(caseId, actionType) {
    const caseData = await db.getCaseById(caseId);

    if (!caseData) {
        return { blocked: true, reason: 'Case not found' };
    }

    // Quick check: email actions on portal cases
    if (caseData.portal_url && actionType?.startsWith('SEND_')) {
        return {
            blocked: true,
            reason: `Portal case - ${actionType} blocked`
        };
    }

    return { blocked: false };
}

module.exports = {
    validateAction,
    blockProposal,
    requireApproval,
    validateAndApply,
    isActionBlocked,
    POLICY_RULES,
    SENSITIVE_KEYWORDS,
    FEE_AUTO_APPROVE_THRESHOLD
};
