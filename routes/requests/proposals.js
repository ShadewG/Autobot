const express = require('express');
const router = express.Router();
const { db, logger, triggerDispatch } = require('./_helpers');
const proposalLifecycle = require('../../services/proposal-lifecycle');
const { autoCaptureEvalCase, captureDismissFeedback } = require('../../services/proposal-feedback');
const { buildHumanDecision } = proposalLifecycle;
const { shouldEscalateManualPasteMismatch } = require('../../trigger/lib/manual-paste-guard.ts');

const CONTRADICTORY_NO_RESPONSE_ACTIONS = new Set([
    'SEND_INITIAL_REQUEST',
    'SEND_FOLLOWUP',
    'SEND_REBUTTAL',
    'SEND_CLARIFICATION',
    'SEND_PDF_EMAIL',
    'ACCEPT_FEE',
    'NEGOTIATE_FEE',
    'DECLINE_FEE',
    'RESPOND_PARTIAL_APPROVAL',
]);

function proposalSignalsNoResponseDraft(draftBodyText) {
    const text = String(draftBodyText || '').trim();
    return /^(no response needed|no reply needed)\b/i.test(text);
}

function isContradictoryNoResponseProposal(proposal) {
    if (!proposal) return false;
    return CONTRADICTORY_NO_RESPONSE_ACTIONS.has(String(proposal.action_type || '').toUpperCase())
        && proposalSignalsNoResponseDraft(proposal.draft_body_text);
}

async function detectLatestInboundManualPasteMismatch(caseId) {
    try {
        if (!Number.isInteger(Number(caseId)) || Number(caseId) <= 0) return null;

        let threads = [];
        if (typeof db.getThreadsByCaseId === 'function') {
            threads = await db.getThreadsByCaseId(Number(caseId));
        } else if (typeof db.getThreadByCaseId === 'function') {
            const singleThread = await db.getThreadByCaseId(Number(caseId));
            threads = singleThread ? [singleThread] : [];
        }
        if (!threads.length || typeof db.getMessagesByThreadId !== 'function') return null;

        const messagesByThread = await Promise.all(
            threads.map(async (thread) => {
                const messages = await db.getMessagesByThreadId(thread.id);
                return Array.isArray(messages)
                    ? messages.map((message) => ({ ...message, __thread: thread }))
                    : [];
            })
        );

        const latestInboundPair = messagesByThread
            .flat()
            .filter((message) => String(message.direction || '').toUpperCase() === 'INBOUND')
            .sort((a, b) => {
                const aTime = new Date(a.created_at || a.received_at || 0).getTime();
                const bTime = new Date(b.created_at || b.received_at || 0).getTime();
                return bTime - aTime;
            })[0];

        if (!latestInboundPair) return null;

        const { __thread, ...latestInbound } = latestInboundPair;
        return shouldEscalateManualPasteMismatch(latestInbound, __thread || null, null);
    } catch (_) {
        return null;
    }
}

async function completeProposalWaitpoint(proposal, data, log) {
    if (!proposal?.waitpoint_token) return null;

    let tokenId = proposal.waitpoint_token;
    if (!tokenId.startsWith('waitpoint_')) {
        const { wait: triggerWait } = require('@trigger.dev/sdk');
        const token = await triggerWait.createToken({ idempotencyKey: tokenId, timeout: '30d' });
        tokenId = token.id;
        log.info(`Resolved waitpoint idempotency key for proposal ${proposal.id}`, {
            proposalId: proposal.id,
            idempotencyKey: proposal.waitpoint_token,
            resolvedTokenId: tokenId,
        });
    }

    const triggerApiUrl = process.env.TRIGGER_API_URL || 'https://api.trigger.dev';
    const completeResp = await fetch(
        `${triggerApiUrl}/api/v1/waitpoints/tokens/${tokenId}/complete`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.TRIGGER_SECRET_KEY}`,
            },
            body: JSON.stringify({ data }),
        }
    );

    if (!completeResp.ok) {
        const errorBody = await completeResp.text();
        throw new Error(`Failed to complete waitpoint token ${tokenId}: ${completeResp.status} ${errorBody}`);
    }

    return tokenId;
}

/**
 * GET /api/requests/:id/proposals
 * Get proposals for a case. Pass ?all=true to include historical (non-pending) proposals.
 */
router.get('/:id/proposals', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const includeAll = req.query.all === 'true';
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));

        // Verify case exists
        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        let proposals;
        if (includeAll) {
            const result = await db.query(
                `SELECT * FROM proposals WHERE case_id = $1 ORDER BY created_at DESC LIMIT $2`,
                [requestId, limit]
            );
            proposals = result.rows;
        } else {
            proposals = await db.getPendingProposalsByCaseId(requestId);
            const manualPasteMismatch = await detectLatestInboundManualPasteMismatch(requestId);
            if (manualPasteMismatch?.mismatch) {
                proposals = [];
            }
            proposals = proposals.filter((proposal) => !isContradictoryNoResponseProposal(proposal));
        }

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
            human_decision: p.human_decision || null,
            human_decided_by: p.human_decided_by || null,
            human_decided_at: p.human_decided_at || null,
            human_edited: p.human_edited || false,
            original_draft_subject: p.original_draft_subject || null,
            original_draft_body_text: p.original_draft_body_text || null,
            executed_at: p.executed_at || null,
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
                human_decided_by: proposal.human_decided_by || null,
                human_decided_at: proposal.human_decided_at,
                original_draft_subject: proposal.original_draft_subject || null,
                original_draft_body_text: proposal.original_draft_body_text || null,
                human_edited: proposal.human_edited || false,
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
 * GET /api/requests/:id/proposals/:proposalId/versions
 * Return append-only draft/version history for a proposal.
 */
router.get('/:id/proposals/:proposalId/versions', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id, 10);
        const proposalId = parseInt(req.params.proposalId, 10);

        const proposal = await db.getProposalById(proposalId);
        if (!proposal || proposal.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        const versions = await db.getProposalContentVersions(proposalId);
        res.json({
            success: true,
            proposal_id: proposalId,
            count: versions.length,
            versions
        });
    } catch (error) {
        console.error('Error fetching proposal versions:', error);
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
        await proposalLifecycle.markProposalDecisionReceived(proposalId, {
            humanDecision: buildHumanDecision('APPROVE', {
                proposalId,
                decidedBy: req.body?.decidedBy || 'human',
            }),
        });
        await autoCaptureEvalCase(proposal, {
            action: 'APPROVE',
            decidedBy: req.body?.decidedBy || 'human',
        });

        // Complete the Trigger.dev waitpoint token or handle legacy proposal
        if (proposal.waitpoint_token) {
            await completeProposalWaitpoint(proposal, {
                action: 'APPROVE',
                proposalId: proposalId
            }, log);
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
        await proposalLifecycle.applyHumanReviewDecision(proposalId, {
            status: 'ADJUSTMENT_REQUESTED',
            humanDecision: buildHumanDecision('ADJUST', {
                proposalId,
                decidedBy: req.body?.decidedBy || 'human',
                instruction: instruction || null,
                adjustments: adjustments || null,
            }),
            adjustmentCount: (proposal.adjustment_count || 0) + 1,
        });
        await autoCaptureEvalCase(proposal, {
            action: 'ADJUST',
            instruction: instruction || null,
            reason: null,
            decidedBy: req.body?.decidedBy || 'human',
        });

        // Complete the Trigger.dev waitpoint token or handle legacy proposal
        if (proposal.waitpoint_token) {
            await completeProposalWaitpoint(proposal, {
                action: 'ADJUST',
                proposalId: proposalId,
                instruction: instruction,
                adjustments: adjustments
            }, log);
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
        await proposalLifecycle.applyHumanReviewDecision(proposalId, {
            status: 'DISMISSED',
            humanDecision: buildHumanDecision('DISMISS', {
                proposalId,
                decidedBy: req.body?.decidedBy || 'human',
                reason: reason || null,
            }),
        });
        await captureDismissFeedback(proposal, {
            reason: reason || null,
            decidedBy: req.body?.decidedBy || 'human',
        });

        // If this was the last active proposal, clear stale human-review flags.
        const remainingActive = await db.query(
            `SELECT id FROM proposals
             WHERE case_id = $1
               AND status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL')
             LIMIT 1`,
            [requestId]
        );
        if (remainingActive.rows.length === 0) {
            const caseData = await db.getCaseById(requestId);
            const isReviewStatus = String(caseData?.status || '').startsWith('needs_');
            await db.updateCase(requestId, {
                status: isReviewStatus
                    ? (caseData?.status === 'needs_phone_call' ? 'needs_phone_call' : 'needs_human_review')
                    : undefined,
                requires_human: isReviewStatus ? true : false,
                pause_reason: isReviewStatus ? 'EXECUTION_BLOCKED' : null,
                substatus: isReviewStatus ? 'Proposal dismissed — manual action required' : undefined,
            });
        }

        // Complete the Trigger.dev waitpoint token or handle legacy proposal
        if (proposal.waitpoint_token) {
            await completeProposalWaitpoint(proposal, {
                action: 'DISMISS',
                proposalId: proposalId,
                reason: reason
            }, log);
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
        await proposalLifecycle.applyHumanReviewDecision(proposalId, {
            status: 'WITHDRAWN',
            humanDecision: buildHumanDecision('WITHDRAW', {
                proposalId,
                decidedBy: req.body?.decidedBy || 'human',
                reason: reason || null,
            }),
        });

        // Mark case for manual handling (no auto-resume)
        await db.updateCase(requestId, {
            requires_human: true,
            pause_reason: 'EXECUTION_BLOCKED',
            autopilot_mode: 'MANUAL'
        });

        // Log the withdrawal
        await db.logActivity('proposal_withdrawn', `Proposal withdrawn: ${reason || 'No reason given'}`, {
            case_id: requestId,
            proposal_id: proposalId,
            reason: reason,
            actor_type: 'human',
            source_service: 'dashboard',
        });

        if (proposal.waitpoint_token) {
            await completeProposalWaitpoint(proposal, {
                action: 'WITHDRAW',
                proposalId: proposalId,
                reason: reason
            }, log);
            log.info(`Trigger.dev waitpoint completed for withdraw on proposal ${proposalId}`);
        }

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
