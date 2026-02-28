const express = require('express');
const router = express.Router();
const { db, logger, triggerDispatch } = require('./_helpers');

/**
 * GET /api/requests/:id/proposals
 * Get all proposals for a case
 */
router.get('/:id/proposals', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);

        // Verify case exists
        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Get proposals from new proposals table
        const proposals = await db.getPendingProposalsByCaseId(requestId);

        const transformedProposals = proposals.map(p => ({
            id: p.id,
            proposal_key: p.proposal_key,
            action_type: p.action_type,
            status: p.status,
            draft_subject: p.draft_subject,
            draft_preview: p.draft_body_text ? p.draft_body_text.substring(0, 200) : null,
            reasoning: p.reasoning,
            confidence: p.confidence ? parseFloat(p.confidence) : 0.8,
            risk_flags: p.risk_flags || [],
            warnings: p.warnings || [],
            can_auto_execute: p.can_auto_execute,
            requires_human: p.requires_human,
            adjustment_count: p.adjustment_count || 0,
            created_at: p.created_at
        }));

        res.json({
            success: true,
            case_id: requestId,
            count: transformedProposals.length,
            proposals: transformedProposals
        });
    } catch (error) {
        console.error('Error fetching proposals:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/requests/:id/proposals/:proposalId
 * Get a single proposal with full details
 */
router.get('/:id/proposals/:proposalId', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const proposalId = parseInt(req.params.proposalId);

        const proposal = await db.getProposalById(proposalId);

        if (!proposal || proposal.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        res.json({
            success: true,
            proposal: {
                id: proposal.id,
                proposal_key: proposal.proposal_key,
                case_id: proposal.case_id,
                trigger_message_id: proposal.trigger_message_id,
                action_type: proposal.action_type,
                status: proposal.status,
                draft_subject: proposal.draft_subject,
                draft_body_text: proposal.draft_body_text,
                draft_body_html: proposal.draft_body_html,
                reasoning: proposal.reasoning,
                confidence: proposal.confidence ? parseFloat(proposal.confidence) : 0.8,
                risk_flags: proposal.risk_flags || [],
                warnings: proposal.warnings || [],
                can_auto_execute: proposal.can_auto_execute,
                requires_human: proposal.requires_human,
                adjustment_count: proposal.adjustment_count || 0,
                human_decision: proposal.human_decision,
                human_decided_at: proposal.human_decided_at,
                executed_at: proposal.executed_at,
                email_job_id: proposal.email_job_id,
                created_at: proposal.created_at,
                updated_at: proposal.updated_at
            }
        });
    } catch (error) {
        console.error('Error fetching proposal:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/proposals/:proposalId/approve
 * Approve a LangGraph proposal and resume the graph
 */
router.post('/:id/proposals/:proposalId/approve', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const proposalId = parseInt(req.params.proposalId);
    const log = logger.forCase(requestId);

    try {
        const proposal = await db.getProposalById(proposalId);

        if (!proposal || proposal.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        // Check if already executed
        if (proposal.status === 'EXECUTED') {
            return res.status(409).json({
                success: false,
                error: 'Proposal already executed',
                executed_at: proposal.executed_at
            });
        }

        // Check if not in pending state
        if (proposal.status !== 'PENDING_APPROVAL') {
            return res.status(400).json({
                success: false,
                error: `Proposal is in ${proposal.status} state, cannot approve`
            });
        }

        log.info(`Approving proposal ${proposalId}`);

        // Mark decision received (terminal-protected) before queueing resume
        await db.updateProposal(proposalId, {
            status: 'DECISION_RECEIVED',
            humanDecision: 'APPROVE',
            humanDecidedAt: new Date()
        });

        // Complete the Trigger.dev waitpoint token or handle legacy proposal
        if (proposal.waitpoint_token) {
            const { wait: triggerWait } = require('@trigger.dev/sdk');
            await triggerWait.completeToken(proposal.waitpoint_token, {
                action: 'APPROVE',
                proposalId: proposalId
            });
            log.info(`Trigger.dev waitpoint completed for approve on proposal ${proposalId}`);
        } else {
            // Legacy proposal — re-trigger inbound processing
            await triggerDispatch.triggerTask('process-inbound', {
                runId: proposal.run_id || 0,
                caseId: requestId,
                messageId: proposal.message_id || 0,
                autopilotMode: 'SUPERVISED'
            }, {
                queue: `case-${requestId}`,
                idempotencyKey: `req-approve:${requestId}:${proposalId}`,
                idempotencyKeyTTL: "1h",
            }, {
                caseId: requestId,
                source: 'requests_approve_legacy',
            });
            log.info(`Re-triggered process-inbound for legacy proposal ${proposalId}`);
        }

        res.json({
            success: true,
            message: 'Proposal approved, execution resuming',
            proposal_id: proposalId
        });
    } catch (error) {
        log.error(`Error approving proposal: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/proposals/:proposalId/adjust
 * Request adjustments to a proposal and resume graph with feedback
 */
router.post('/:id/proposals/:proposalId/adjust', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const proposalId = parseInt(req.params.proposalId);
    const { instruction, adjustments } = req.body;
    const log = logger.forCase(requestId);

    try {
        if (!instruction && !adjustments) {
            return res.status(400).json({
                success: false,
                error: 'Either instruction or adjustments is required'
            });
        }

        const proposal = await db.getProposalById(proposalId);

        if (!proposal || proposal.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        if (proposal.status !== 'PENDING_APPROVAL') {
            return res.status(400).json({
                success: false,
                error: `Proposal is in ${proposal.status} state, cannot adjust`
            });
        }

        log.info(`Adjusting proposal ${proposalId}`);

        // Update proposal with adjustment request
        await db.updateProposal(proposalId, {
            status: 'ADJUSTMENT_REQUESTED',
            humanDecision: 'ADJUST',
            humanDecidedAt: new Date(),
            adjustmentCount: (proposal.adjustment_count || 0) + 1
        });

        // Complete the Trigger.dev waitpoint token or handle legacy proposal
        if (proposal.waitpoint_token) {
            const { wait: triggerWait } = require('@trigger.dev/sdk');
            await triggerWait.completeToken(proposal.waitpoint_token, {
                action: 'ADJUST',
                proposalId: proposalId,
                instruction: instruction,
                adjustments: adjustments
            });
            log.info(`Trigger.dev waitpoint completed for adjust on proposal ${proposalId}`);
        } else {
            // Legacy proposal — re-trigger inbound processing with adjustment context
            await triggerDispatch.triggerTask('process-inbound', {
                runId: proposal.run_id || 0,
                caseId: requestId,
                messageId: proposal.message_id || 0,
                autopilotMode: 'SUPERVISED'
            }, {
                queue: `case-${requestId}`,
                idempotencyKey: `req-adjust:${requestId}:${proposalId}`,
                idempotencyKeyTTL: "1h",
            }, {
                caseId: requestId,
                source: 'requests_adjust_legacy',
            });
            log.info(`Re-triggered process-inbound for legacy adjust on proposal ${proposalId}`);
        }

        res.json({
            success: true,
            message: 'Adjustment requested, re-drafting',
            proposal_id: proposalId
        });
    } catch (error) {
        log.error(`Error adjusting proposal: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/proposals/:proposalId/dismiss
 * Dismiss a proposal and resume graph to try different action
 */
router.post('/:id/proposals/:proposalId/dismiss', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const proposalId = parseInt(req.params.proposalId);
    const { reason } = req.body;
    const log = logger.forCase(requestId);

    try {
        const proposal = await db.getProposalById(proposalId);

        if (!proposal || proposal.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        if (proposal.status !== 'PENDING_APPROVAL') {
            return res.status(400).json({
                success: false,
                error: `Proposal is in ${proposal.status} state, cannot dismiss`
            });
        }

        log.info(`Dismissing proposal ${proposalId}`);

        // Update proposal as dismissed
        await db.updateProposal(proposalId, {
            status: 'DISMISSED',
            humanDecision: 'DISMISS',
            humanDecidedAt: new Date()
        });

        // Complete the Trigger.dev waitpoint token or handle legacy proposal
        if (proposal.waitpoint_token) {
            const { wait: triggerWait } = require('@trigger.dev/sdk');
            await triggerWait.completeToken(proposal.waitpoint_token, {
                action: 'DISMISS',
                proposalId: proposalId,
                reason: reason
            });
            log.info(`Trigger.dev waitpoint completed for dismiss on proposal ${proposalId}`);
        } else {
            // Legacy proposal — just mark as dismissed, no re-trigger needed
            log.info(`Legacy proposal ${proposalId} dismissed (no waitpoint token)`);
        }

        res.json({
            success: true,
            message: 'Proposal dismissed',
            proposal_id: proposalId
        });
    } catch (error) {
        log.error(`Error dismissing proposal: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/proposals/:proposalId/withdraw
 * Withdraw from processing entirely (no further agent action)
 */
router.post('/:id/proposals/:proposalId/withdraw', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const proposalId = parseInt(req.params.proposalId);
    const { reason } = req.body;
    const log = logger.forCase(requestId);

    try {
        const proposal = await db.getProposalById(proposalId);

        if (!proposal || proposal.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        log.info(`Withdrawing proposal ${proposalId}`);

        // Update proposal as withdrawn
        await db.updateProposal(proposalId, {
            status: 'WITHDRAWN',
            humanDecision: 'WITHDRAW',
            humanDecidedAt: new Date()
        });

        // Mark case for manual handling (no auto-resume)
        await db.updateCase(requestId, {
            requires_human: true,
            pause_reason: 'MANUAL',
            autopilot_mode: 'MANUAL'
        });

        // Log the withdrawal
        await db.logActivity('proposal_withdrawn', `Proposal withdrawn: ${reason || 'No reason given'}`, {
            case_id: requestId,
            proposal_id: proposalId,
            reason: reason
        });

        log.info(`Proposal withdrawn, case set to MANUAL mode`);

        res.json({
            success: true,
            message: 'Proposal withdrawn, case set to manual handling',
            proposal_id: proposalId
        });
    } catch (error) {
        log.error(`Error withdrawing proposal: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
