const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db, actionValidator, logger } = require('./_helpers');
const { processProposalDecision } = require('../monitor/_helpers');
const { buildOperatorActionErrorResponse } = require('../../services/operator-action-errors');

function normalizeProposalReasoning(reasoning, fallback = []) {
    if (Array.isArray(reasoning)) return reasoning;
    if (reasoning == null) return fallback;
    return [reasoning];
}

function formatLegacyNextActionFromProposal(proposal, instruction = null) {
    const reasoning = normalizeProposalReasoning(proposal.reasoning, ['AI-generated response to agency message']);
    const warnings = Array.isArray(proposal.warnings) ? proposal.warnings : [];
    const constraintsApplied = Array.isArray(proposal.constraints_applied) ? proposal.constraints_applied : [];

    return {
        id: String(proposal.id),
        action_type: proposal.action_type || 'SEND_EMAIL',
        proposal: proposal.proposal_short || `Send ${proposal.action_type || 'auto'} reply`,
        proposal_short: proposal.proposal_short || null,
        reasoning: instruction
            ? [...reasoning, `Revised using instruction: ${instruction}`]
            : reasoning,
        confidence: proposal.confidence != null ? Number(proposal.confidence) : 0.8,
        risk_flags: proposal.requires_human ? ['Requires Approval'] : [],
        warnings,
        can_auto_execute: !proposal.requires_human,
        blocked_reason: proposal.blocked_reason || (proposal.requires_human ? 'Requires human approval' : null),
        draft_content: proposal.draft_body_text || proposal.draft_body_html || null,
        draft_preview: proposal.draft_body_text
            ? proposal.draft_body_text.substring(0, 200)
            : (proposal.draft_body_html ? proposal.draft_body_html.substring(0, 200) : null),
        constraints_applied: constraintsApplied,
    };
}

async function findPendingProposalForLegacyRoute(requestId, actionId) {
    const proposals = await db.getPendingProposalsByCaseId(requestId);
    if (!proposals.length) return null;
    if (actionId) {
        return proposals.find((proposal) => proposal.id === parseInt(actionId, 10)) || null;
    }
    return proposals[0];
}

async function reviseProposalDraftWithInstruction(proposal, caseData, message, instruction) {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const revisionPrompt = `You are helping revise a FOIA request response.

Original subject:
${proposal.draft_subject || message?.subject || '(none)'}

Original draft:
${proposal.draft_body_text || proposal.draft_body_html || ''}

User instruction for revision:
${instruction}

Context:
- Agency: ${caseData.agency_name}
- State: ${caseData.state}
- Original message subject: ${message?.subject || 'N/A'}

Please provide the revised response body text only. Do not include explanations or markdown fences.`;

    const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
        messages: [
            {
                role: 'system',
                content: 'You are a professional FOIA request assistant helping revise correspondence with government agencies.'
            },
            {
                role: 'user',
                content: revisionPrompt
            }
        ],
        max_tokens: 1000
    });

    const revisedContent = completion.choices[0]?.message?.content?.trim();
    if (!revisedContent) {
        throw new Error('AI returned an empty revised draft');
    }

    const updatedProposal = await db.updateProposal(proposal.id, {
        draftBodyText: revisedContent,
        draftBodyHtml: null,
        adjustmentCount: (proposal.adjustment_count || 0) + 1,
        __versionActor: 'legacy-actions',
        __versionMetadata: {
            route: 'actions/revise',
            instruction,
        },
    });

    return updatedProposal;
}

async function createLegacyProposalDraft(caseData, latestInbound, instruction) {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const generatePrompt = `You are helping draft a FOIA request response.

Context:
- Agency: ${caseData.agency_name}
- State: ${caseData.state}
- Current status: ${caseData.status}
- Pause reason: ${caseData.pause_reason || 'N/A'}
${latestInbound ? `- Last message from agency: ${latestInbound.subject}` : ''}

User instruction:
${instruction}

Please draft a professional email to send to the agency. Only output the email body text, no explanations.`;

    const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
        messages: [
            {
                role: 'system',
                content: 'You are a professional FOIA request assistant helping draft correspondence with government agencies.'
            },
            {
                role: 'user',
                content: generatePrompt
            }
        ],
        max_tokens: 1000
    });

    const draftContent = completion.choices[0]?.message?.content?.trim();
    if (!draftContent) {
        throw new Error('AI returned an empty draft');
    }

    const inferredActionType = latestInbound ? 'SEND_CLARIFICATION' : 'SEND_INITIAL_REQUEST';
    return db.createProposal({
        proposalKey: `${caseData.id}:legacy-custom:${latestInbound?.id || 'none'}:${Date.now()}`,
        caseId: caseData.id,
        triggerMessageId: latestInbound?.id || null,
        actionType: inferredActionType,
        draftSubject: latestInbound?.subject || `FOIA request follow-up for case ${caseData.id}`,
        draftBodyText: draftContent,
        reasoning: ['Generated based on a legacy revise instruction', instruction],
        confidence: 0.75,
        warnings: [],
        canAutoExecute: false,
        requiresHuman: true,
        proposalShort: `Custom: ${instruction.substring(0, 50)}...`,
        status: 'PENDING_APPROVAL',
        adjustmentCount: 0,
    });
}

/**
 * POST /api/requests/:id/actions/approve
 * Approve a pending action (legacy)
 */
router.post('/:id/actions/approve', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const { action_id } = req.body;
    const log = logger.forCase(requestId);

    try {
        const activeProposal = await findPendingProposalForLegacyRoute(requestId, action_id);
        if (activeProposal) {
            const result = await processProposalDecision(activeProposal.id, 'APPROVE', {
                route_mode: 'legacy_actions',
                decidedBy: req.body?.decidedBy || 'legacy-actions',
            });
            return res.json({
                success: true,
                message: result.message || 'Action approved and queued for sending',
                proposal_id: activeProposal.id,
                trigger_run_id: result.trigger_run_id || result.triggerRunId || null,
            });
        }

        // Find the pending reply
        const replyResult = await db.query(
            `SELECT * FROM auto_reply_queue
             WHERE case_id = $1 AND status IN ('pending', 'approved')
             ${action_id ? 'AND id = $2' : ''}
             ORDER BY created_at DESC
             LIMIT 1`,
            action_id ? [requestId, parseInt(action_id)] : [requestId]
        );

        if (replyResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No pending action found'
            });
        }

        const reply = replyResult.rows[0];
        log.info(`Approve request for proposal ${reply.id}`);

        // Step 1: Check if already executed
        const executionStatus = await db.isProposalExecuted(reply.id);
        if (executionStatus?.executed) {
            log.warn(`Proposal ${reply.id} already executed at ${executionStatus.executedAt}`);
            return res.status(409).json({
                success: false,
                error: 'Action already executed',
                executed_at: executionStatus.executedAt,
                email_job_id: executionStatus.emailJobId
            });
        }

        // Get case and message data
        const message = await db.getMessageById(reply.message_id);
        const caseData = await db.getCaseById(requestId);

        if (!message || !caseData) {
            return res.status(404).json({
                success: false,
                error: 'Message or case not found'
            });
        }

        // Step 2: Validate against policy rules
        const validation = await actionValidator.validateAction(requestId, reply);
        if (validation.blocked) {
            log.warn(`Action blocked by policy: ${validation.violations.map(v => v.rule).join(', ')}`);
            await actionValidator.blockProposal(reply.id, validation.violations);
            return res.status(403).json({
                success: false,
                error: 'Action blocked by policy',
                violations: validation.violations
            });
        }

        // Step 3: Generate unique execution key
        const executionKey = `exec-${requestId}-${reply.id}-${crypto.randomBytes(8).toString('hex')}`;

        // Step 4: Atomic claim execution slot
        const claimed = await db.claimProposalExecution(reply.id, executionKey);
        if (!claimed) {
            log.warn(`Failed to claim execution slot for proposal ${reply.id} - already claimed`);
            return res.status(409).json({
                success: false,
                error: 'Action already being executed by another request'
            });
        }

        log.info(`Claimed execution slot with key: ${executionKey}`);

        // Step 5: Queue the email with execution key as job ID for deduplication
        const { emailQueue } = require('../../queues/email-queue');
        const job = await emailQueue.add('send-auto-reply', {
            type: 'auto_reply',
            caseId: requestId,
            toEmail: message.from_email,
            subject: message.subject,
            content: reply.generated_reply,
            originalMessageId: message.message_id,
            proposalId: reply.id,
            executionKey: executionKey
        }, {
            jobId: executionKey  // BullMQ deduplication
        });

        // Step 6: Mark executed
        await db.markProposalExecuted(reply.id, job.id);

        // Clear requires_human if this was the blocking action
        await db.updateCase(requestId, {
            requires_human: false,
            pause_reason: null
        });

        log.info(`Proposal ${reply.id} approved and queued (job: ${job.id})`);
        logger.proposalEvent('approved', { ...reply, status: 'approved' });

        res.json({
            success: true,
            message: 'Action approved and queued for sending',
            execution_key: executionKey,
            job_id: job.id
        });
    } catch (error) {
        log.error(`Error approving action: ${error.message}`);
        res.status(500).json(buildOperatorActionErrorResponse(error, 'LEGACY_APPROVE_FAILED'));
    }
});

/**
 * POST /api/requests/:id/actions/revise
 * Ask AI to revise a draft
 */
router.post('/:id/actions/revise', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const { instruction, action_id } = req.body;

        if (!instruction) {
            return res.status(400).json({
                success: false,
                error: 'instruction is required'
            });
        }

        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        const activeProposal = await findPendingProposalForLegacyRoute(requestId, action_id);
        if (activeProposal) {
            const message = activeProposal.trigger_message_id
                ? await db.getMessageById(activeProposal.trigger_message_id)
                : null;
            const updatedProposal = await reviseProposalDraftWithInstruction(
                activeProposal,
                caseData,
                message,
                instruction
            );

            return res.json({
                success: true,
                next_action_proposal: formatLegacyNextActionFromProposal(updatedProposal, instruction)
            });
        }

        // Find the pending reply to revise
        const replyResult = await db.query(
            `SELECT * FROM auto_reply_queue
             WHERE case_id = $1 AND status = 'pending'
             ${action_id ? 'AND id = $2' : ''}
             ORDER BY created_at DESC
             LIMIT 1`,
            action_id ? [requestId, parseInt(action_id)] : [requestId]
        );

        let reply = replyResult.rows[0];
        let message = reply ? await db.getMessageById(reply.message_id) : null;

        // If no pending action, generate a new proposal based on the instruction
        if (!reply) {
            const latestInbound = await db.getLatestInboundMessage(requestId);
            const newProposal = await createLegacyProposalDraft(caseData, latestInbound, instruction);

            return res.json({
                success: true,
                next_action_proposal: formatLegacyNextActionFromProposal(newProposal, instruction)
            });
        } else {
            // Existing pending action - revise it
            const OpenAI = require('openai');
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

            const revisionPrompt = `You are helping revise a FOIA request response.

Original draft:
${reply.generated_reply}

User instruction for revision:
${instruction}

Context:
- Agency: ${caseData.agency_name}
- Original message subject: ${message?.subject || 'N/A'}

Please provide the revised response following the user's instruction. Only output the revised response text, no explanations.`;

            const completion = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a professional FOIA request assistant helping revise correspondence with government agencies.'
                    },
                    {
                        role: 'user',
                        content: revisionPrompt
                    }
                ],
                max_tokens: 1000
            });

            const revisedContent = completion.choices[0].message.content;

            // Update the reply with revised content
            reply = await db.updateAutoReplyQueueEntry(reply.id, {
                generated_reply: revisedContent,
                last_regenerated_at: new Date(),
                metadata: JSON.stringify({
                    ...JSON.parse(reply.metadata || '{}'),
                    revision_instruction: instruction,
                    revised_at: new Date().toISOString()
                })
            });
        }

        // Parse JSONB fields from reply
        const reasoning = reply.reasoning_jsonb || ['Generated based on your instruction', instruction];
        const warnings = reply.warnings_jsonb || [];
        const constraintsApplied = reply.constraints_applied_jsonb || [];
        const draftContent = reply.generated_reply;

        // Return next action
        const nextAction = {
            id: String(reply.id),
            action_type: reply.action_type || 'SEND_EMAIL',
            proposal: reply.proposal_short || `Send ${reply.response_type || 'auto'} reply`,
            proposal_short: reply.proposal_short,
            reasoning: Array.isArray(reasoning) ? reasoning : [reasoning],
            confidence: reply.confidence_score ? parseFloat(reply.confidence_score) : 0.8,
            risk_flags: reply.requires_approval ? ['Requires Approval'] : [],
            warnings: Array.isArray(warnings) ? warnings : [],
            can_auto_execute: !reply.requires_approval,
            blocked_reason: reply.blocked_reason || (reply.requires_approval ? 'Requires human approval' : null),
            draft_content: draftContent,
            draft_preview: draftContent ? draftContent.substring(0, 200) : null,
            constraints_applied: Array.isArray(constraintsApplied) ? constraintsApplied : []
        };

        res.json({
            success: true,
            next_action_proposal: nextAction
        });
    } catch (error) {
        console.error('Error revising action:', error);
        res.status(500).json(buildOperatorActionErrorResponse(error, 'LEGACY_REVISE_FAILED'));
    }
});

/**
 * POST /api/requests/:id/actions/dismiss
 * Dismiss a pending action
 */
router.post('/:id/actions/dismiss', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const { action_id } = req.body;

        const activeProposal = await findPendingProposalForLegacyRoute(requestId, action_id);
        if (activeProposal) {
            const result = await processProposalDecision(activeProposal.id, 'DISMISS', {
                route_mode: 'legacy_actions',
                decidedBy: req.body?.decidedBy || 'legacy-actions',
            });
            return res.json({
                success: true,
                message: result.message || 'Action dismissed',
                proposal_id: activeProposal.id,
            });
        }

        const replyResult = await db.query(
            `SELECT * FROM auto_reply_queue
             WHERE case_id = $1 AND status = 'pending'
             ${action_id ? 'AND id = $2' : ''}
             ORDER BY created_at DESC
             LIMIT 1`,
            action_id ? [requestId, parseInt(action_id)] : [requestId]
        );

        if (replyResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No pending action found'
            });
        }

        await db.updateAutoReplyQueueEntry(replyResult.rows[0].id, {
            status: 'rejected'
        });

        res.json({
            success: true,
            message: 'Action dismissed'
        });
    } catch (error) {
        console.error('Error dismissing action:', error);
        res.status(500).json(buildOperatorActionErrorResponse(error, 'LEGACY_DISMISS_FAILED'));
    }
});

module.exports = router;
