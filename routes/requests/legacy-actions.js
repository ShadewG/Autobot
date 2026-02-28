const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db, actionValidator, logger } = require('./_helpers');

/**
 * POST /api/requests/:id/actions/approve
 * Approve a pending action (legacy)
 */
router.post('/:id/actions/approve', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const { action_id } = req.body;
    const log = logger.forCase(requestId);

    try {
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
        res.status(500).json({
            success: false,
            error: error.message
        });
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

        // Find the pending reply to revise
        const replyResult = await db.query(
            `SELECT * FROM auto_reply_queue
             WHERE case_id = $1 AND status = 'pending'
             ${action_id ? 'AND id = $2' : ''}
             ORDER BY created_at DESC
             LIMIT 1`,
            action_id ? [requestId, parseInt(action_id)] : [requestId]
        );

        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        let reply = replyResult.rows[0];
        let message = reply ? await db.getMessageById(reply.message_id) : null;

        // If no pending action, generate a new draft based on the instruction
        if (!reply) {
            // Get the latest inbound message for context
            const thread = await db.getThreadByCaseId(requestId);
            let latestInbound = null;
            if (thread) {
                const messagesResult = await db.query(
                    `SELECT * FROM messages WHERE thread_id = $1 AND direction = 'inbound' ORDER BY received_at DESC LIMIT 1`,
                    [thread.id]
                );
                latestInbound = messagesResult.rows[0];
            }

            // Generate a new draft using the instruction
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

            const draftContent = completion.choices[0].message.content;

            // Create a new pending reply entry
            const newReplyResult = await db.query(
                `INSERT INTO auto_reply_queue (case_id, message_id, generated_reply, response_type, status, requires_approval, created_at, proposal_short, reasoning_jsonb)
                 VALUES ($1, $2, $3, 'custom', 'pending', true, NOW(), $4, $5)
                 RETURNING *`,
                [
                    requestId,
                    latestInbound?.id || null,
                    draftContent,
                    `Custom: ${instruction.substring(0, 50)}...`,
                    JSON.stringify(['Generated based on your instruction', instruction])
                ]
            );

            reply = newReplyResult.rows[0];
            message = latestInbound;
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
        res.status(500).json({
            success: false,
            error: error.message
        });
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
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
