const express = require('express');
const router = express.Router();
const { db, crypto } = require('./_helpers');

/**
 * Simulate agency reply (for dashboard testing)
 * POST /api/test/simulate-reply
 */
router.post('/simulate-reply', async (req, res) => {
    try {
        const { case_id, reply_text, reply_type } = req.body;

        if (!case_id || !reply_text) {
            return res.status(400).json({
                success: false,
                error: 'case_id and reply_text are required'
            });
        }

        console.log(`📬 Simulating ${reply_type} reply for case ${case_id}`);

        // Get case data
        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Case not found'
            });
        }

        // Get thread
        const thread = await db.getThreadByCaseId(case_id);
        if (!thread) {
            return res.status(404).json({
                success: false,
                error: 'Email thread not found'
            });
        }

        // Create fake message ID
        const messageId = `<sim-${Date.now()}-${crypto.randomUUID()}@test.com>`;

        // Store inbound message
        const message = await db.createMessage({
            thread_id: thread.id,
            case_id: case_id,
            message_id: messageId,
            sendgrid_message_id: `sg-test-${Date.now()}`,
            direction: 'inbound',
            from_email: caseData.agency_email || 'test-agency@example.com',
            to_email: 'requests@foia.foib-request.com',
            subject: `Re: ${caseData.case_name}`,
            body_text: reply_text,
            body_html: `<p>${reply_text}</p>`,
            message_type: 'agency_response',
            received_at: new Date()
        });

        console.log(`✅ Simulated message stored: ${message.id}`);

        // Analyze response — with full thread context
        const aiService = require('../../services/ai-service');
        const threadMessages = await db.getMessagesByCaseId(caseData.id);
        const analysis = await aiService.analyzeResponse(message, caseData, { threadMessages });

        console.log(`📊 Analysis complete: ${analysis.intent}`);

        // Check if agent should handle this (complex cases only)
        const isComplexCase = (
            analysis.intent === 'denial' ||
            analysis.intent === 'request_info' ||
            (analysis.intent === 'fee_notice' && analysis.extracted_fee_amount > 100) ||
            analysis.sentiment === 'hostile'
        );

        let agentResult = null;
        if (isComplexCase) {
            console.log(`🤖 Triggering agent for complex case...`);
            const foiaCaseAgent = require('../../services/foia-case-agent');
            agentResult = await foiaCaseAgent.handleCase(case_id, {
                type: 'agency_reply',
                messageId: message.id
            });

            // Mark as agent-handled
            await db.query('UPDATE cases SET agent_handled = true WHERE id = $1', [case_id]);
        }

        res.json({
            success: true,
            message_id: message.id,
            analysis: {
                intent: analysis.intent,
                sentiment: analysis.sentiment,
                requires_action: analysis.requires_action
            },
            agent_handled: isComplexCase,
            agent_iterations: agentResult?.iterations || 0
        });
    } catch (error) {
        console.error('Error simulating reply:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/test/cases/:caseId/simulate-response
 *
 * Simulates an inbound agency response for testing the agent pipeline.
 * Creates a message record and triggers the agent to process it.
 *
 * Body:
 * - classification: FEE_QUOTE, ACKNOWLEDGMENT, DENIAL, CLARIFICATION_REQUEST, RECORDS_READY
 * - body: The email body text
 * - subject: (optional) Email subject
 * - extracted_fee: (optional) Fee amount for FEE_QUOTE responses
 * - from_email: (optional) Sender email, defaults to agency email
 * - trigger_agent: (optional) Whether to trigger agent processing, default true
 */
router.post('/cases/:caseId/simulate-response', async (req, res) => {
    const caseId = parseInt(req.params.caseId);
    const {
        classification = 'ACKNOWLEDGMENT',
        body = 'This is a simulated agency response.',
        subject,
        extracted_fee,
        from_email,
        trigger_agent = true
    } = req.body;

    try {
        // Get case details
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${caseId} not found`
            });
        }

        // Get or create thread for this case (CRITICAL for messages to show in conversation)
        let thread = await db.getThreadByCaseId(caseId);
        if (!thread) {
            const threadResult = await db.query(`
                INSERT INTO email_threads (case_id, subject, created_at, updated_at)
                VALUES ($1, $2, NOW(), NOW())
                RETURNING *
            `, [caseId, `Thread for case ${caseId}`]);
            thread = threadResult.rows[0];
            console.log(`[simulate-response] Created thread ${thread.id} for case ${caseId}`);
        }

        // Create the inbound message with thread_id
        const message = await db.createMessage({
            thread_id: thread.id,  // CRITICAL: Link to thread for conversation display
            case_id: caseId,
            message_id: `sim-${Date.now()}-${Math.random().toString(36).slice(2)}`,  // Unique identifier
            direction: 'inbound',
            from_email: from_email || caseData.agency_email || 'records@agency.gov',
            to_email: process.env.INBOUND_EMAIL || 'foia@autobot.test',
            subject: subject || `RE: ${caseData.case_name || 'FOIA Request'}`,
            body_text: body,
            body_html: `<p>${body.replace(/\n/g, '</p><p>')}</p>`,
            received_at: new Date()
        });

        console.log(`[simulate-response] Created message ${message.id} for case ${caseId}`);

        // Create response analysis record
        await db.query(`
            INSERT INTO response_analysis (case_id, message_id, intent, sentiment, extracted_fee_amount)
            VALUES ($1, $2, $3, $4, $5)
        `, [caseId, message.id, classification, 'neutral', extracted_fee || null]);

        console.log(`[simulate-response] Created analysis: ${classification}`);

        // Trigger agent processing if requested
        let run = null;
        let jobId = null;

        if (trigger_agent) {
            try {
                const { tasks: triggerTasks } = require('@trigger.dev/sdk/v3');
                const autopilotMode = caseData.autopilot_mode || 'SUPERVISED';

                // Trigger Trigger.dev inbound processing task
                const handle = await triggerTasks.trigger('process-inbound', {
                    caseId,
                    messageId: message.id,
                    autopilotMode
                });
                jobId = handle.id;
                console.log(`[simulate-response] Triggered Trigger.dev process-inbound (run: ${handle.id})`);
            } catch (agentError) {
                console.error('[simulate-response] Failed to trigger agent:', agentError.message);
                // Continue - message was still created
            }
        }

        res.status(201).json({
            success: true,
            message: 'Simulated response created',
            data: {
                message_id: message.id,
                classification,
                extracted_fee: extracted_fee || null,
                run_id: run?.id || null,
                job_id: jobId,
                trigger_agent
            },
            next_steps: trigger_agent ? [
                `Check /api/runs/${run?.id} for agent status`,
                'Check /queue for any proposals needing approval',
                `Check /requests/detail?id=${caseId} for the timeline`
            ] : [
                'Agent was not triggered. Set trigger_agent: true to process this message.'
            ]
        });

    } catch (error) {
        console.error('[simulate-response] Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/test/cases/:caseId/simulate-outbound
 *
 * Simulates an outbound message (our request/reply to agency).
 * Useful for testing the conversation display.
 *
 * Body:
 * - body: The email body text
 * - subject: (optional) Email subject
 * - to_email: (optional) Recipient email
 * - type: 'initial' | 'reply' (optional, affects subject line)
 */
router.post('/cases/:caseId/simulate-outbound', async (req, res) => {
    const caseId = parseInt(req.params.caseId);
    const {
        body = 'This is a FOIA request for records related to the incident.',
        subject,
        to_email,
        type = 'initial'
    } = req.body;

    try {
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${caseId} not found`
            });
        }

        // Get or create thread
        let thread = await db.getThreadByCaseId(caseId);
        if (!thread) {
            const threadResult = await db.query(`
                INSERT INTO email_threads (case_id, subject, created_at, updated_at)
                VALUES ($1, $2, NOW(), NOW())
                RETURNING *
            `, [caseId, `Thread for case ${caseId}`]);
            thread = threadResult.rows[0];
        }

        const defaultSubject = type === 'initial'
            ? `FOIA Request: ${caseData.case_name || 'Records Request'}`
            : `RE: ${caseData.case_name || 'Records Request'}`;

        const message = await db.createMessage({
            thread_id: thread.id,
            case_id: caseId,
            message_id: `sim-out-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            direction: 'outbound',
            from_email: process.env.INBOUND_EMAIL || 'foia@autobot.test',
            to_email: to_email || caseData.agency_email || 'records@agency.gov',
            subject: subject || defaultSubject,
            body_text: body,
            body_html: `<p>${body.replace(/\n/g, '</p><p>')}</p>`,
            sent_at: new Date()
        });

        res.status(201).json({
            success: true,
            message: 'Simulated outbound message created',
            data: {
                message_id: message.id,
                thread_id: thread.id,
                direction: 'outbound',
                type
            }
        });

    } catch (error) {
        console.error('[simulate-outbound] Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/test/cases/:caseId/setup-for-e2e
 *
 * Sets up a case with required fields for E2E testing:
 * - Sets agency_email (required for sending)
 * - Sets status to DRAFT (so initial request can be sent)
 * - Optionally triggers the initial request flow
 */
router.post('/cases/:caseId/setup-for-e2e', async (req, res) => {
    const caseId = parseInt(req.params.caseId);
    const {
        agency_email = 'records@testpd.gov',
        run_initial = false,
        autopilot_mode = 'AUTO'
    } = req.body;

    try {
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${caseId} not found`
            });
        }

        // Update case with required fields for E2E testing
        await db.query(`
            UPDATE cases SET
                agency_email = $1,
                status = 'draft',
                submitted_at = NULL,
                updated_at = NOW()
            WHERE id = $2
        `, [agency_email, caseId]);

        const result = {
            success: true,
            message: 'Case set up for E2E testing',
            case_id: caseId,
            agency_email
        };

        // Optionally trigger initial request
        if (run_initial) {
            const { tasks: triggerTasks } = require('@trigger.dev/sdk/v3');

            // Trigger Trigger.dev initial request task
            const handle = await triggerTasks.trigger('process-initial-request', {
                caseId,
                autopilotMode: autopilot_mode
            });

            result.run = { status: 'triggered' };
            result.trigger_run_id = handle.id;
        }

        res.json(result);

    } catch (error) {
        console.error('[setup-for-e2e] Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/test/cases/:caseId/analysis
 *
 * Get response analysis records for a case.
 * Useful for debugging AI analysis and scope_updates.
 */
router.get('/cases/:caseId/analysis', async (req, res) => {
    const caseId = parseInt(req.params.caseId);

    try {
        const result = await db.query(`
            SELECT ra.*, m.body_text AS message_text
            FROM response_analysis ra
            LEFT JOIN messages m ON m.id = ra.message_id
            WHERE ra.case_id = $1
            ORDER BY ra.created_at DESC
        `, [caseId]);

        res.json({
            success: true,
            count: result.rows.length,
            analysis: result.rows
        });
    } catch (error) {
        console.error('[analysis] Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/test/cases/:caseId/conversation
 *
 * Get the full conversation history for a case (messages + proposals).
 * Useful for debugging and testing.
 */
router.get('/cases/:caseId/conversation', async (req, res) => {
    const caseId = parseInt(req.params.caseId);

    try {
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${caseId} not found`
            });
        }

        // Get messages
        const messages = await db.query(`
            SELECT m.*, ra.intent AS classification, ra.sentiment, ra.extracted_fee_amount
            FROM messages m
            LEFT JOIN response_analysis ra ON ra.message_id = m.id
            WHERE m.case_id = $1
            ORDER BY m.created_at ASC
        `, [caseId]);

        // Get proposals
        const proposals = await db.query(`
            SELECT id, action_type, status, draft_subject, draft_body_text,
                   reasoning, created_at, updated_at, human_decision
            FROM proposals
            WHERE case_id = $1
            ORDER BY created_at ASC
        `, [caseId]);

        // Get agent runs
        const runs = await db.query(`
            SELECT id, trigger_type, status, error AS error_message, started_at AS created_at, ended_at
            FROM agent_runs
            WHERE case_id = $1
            ORDER BY started_at ASC
        `, [caseId]);

        res.json({
            success: true,
            case: {
                id: caseData.id,
                case_name: caseData.case_name,
                agency_name: caseData.agency_name,
                status: caseData.status,
                autopilot_mode: caseData.autopilot_mode
            },
            messages: messages.rows,
            proposals: proposals.rows,
            runs: runs.rows
        });

    } catch (error) {
        console.error('[conversation] Error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
