const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const {
    db,
    queueInboundRunForMessage
} = require('./_helpers');

/**
 * POST /api/monitor/trigger-inbound-run
 * Trigger run-engine inbound flow by message id
 */
router.post('/trigger-inbound-run', express.json(), async (req, res) => {
    try {
        const { message_id, force_new_run = false } = req.body || {};
        const autopilotMode = 'SUPERVISED';
        if (!message_id) {
            return res.status(400).json({ success: false, error: 'message_id is required' });
        }

        const message = await db.getMessageById(parseInt(message_id));
        if (!message) {
            return res.status(404).json({ success: false, error: `Message ${message_id} not found` });
        }
        if (message.direction !== 'inbound') {
            return res.status(400).json({ success: false, error: 'Only inbound messages can be processed' });
        }

        const { run, job } = await queueInboundRunForMessage(message, { autopilotMode, force_new_run });

        await db.logActivity('manual_ai_trigger', `AI triggered for inbound message ${message.id}`, {
            case_id: message.case_id,
            message_id: message.id,
            autopilotMode,
            force_new_run
        });

        res.json({
            success: true,
            approval_required: true,
            autopilot_mode: autopilotMode,
            run: {
                id: run.id,
                status: run.status,
                message_id: message.id,
                thread_id: run.langgraph_thread_id
            },
            job_id: job?.id || null
        });
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json({ success: false, error: error.message, ...(error.payload || {}) });
    }
});

/**
 * POST /api/monitor/simulate-inbound
 * Create deterministic inbound message for testing
 */
router.post('/simulate-inbound', express.json(), async (req, res) => {
    try {
        const {
            case_id,
            subject,
            body_text,
            from_email,
            attach_to_thread = true,
            mark_processed = false
        } = req.body || {};

        if (!case_id || !body_text || !from_email) {
            return res.status(400).json({
                success: false,
                error: 'case_id, body_text, and from_email are required'
            });
        }

        const caseData = await db.getCaseById(parseInt(case_id));
        if (!caseData) {
            return res.status(404).json({ success: false, error: `Case ${case_id} not found` });
        }

        let thread = null;
        if (attach_to_thread) {
            thread = await db.getThreadByCaseId(caseData.id);
            if (!thread) {
                thread = await db.createEmailThread({
                    case_id: caseData.id,
                    thread_id: `sim:${caseData.id}:${Date.now()}`,
                    subject: subject || `Re: ${caseData.case_name || 'Public Records Request'}`,
                    agency_email: caseData.agency_email,
                    initial_message_id: null,
                    status: 'active'
                });
            }
        }

        const syntheticId = `sim:${caseData.id}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`;
        const message = await db.createMessage({
            thread_id: thread?.id || null,
            case_id: caseData.id,
            message_id: syntheticId,
            sendgrid_message_id: null,
            direction: 'inbound',
            from_email,
            to_email: 'requests@foib-request.com',
            subject: subject || `Re: ${caseData.case_name || 'Public Records Request'}`,
            body_text,
            body_html: `<p>${String(body_text).replace(/\n/g, '<br>')}</p>`,
            message_type: 'simulated_inbound',
            received_at: new Date()
        });

        if (mark_processed) {
            await db.query(`
                UPDATE messages
                SET processed_at = NOW()
                WHERE id = $1
            `, [message.id]);
        }

        await db.logActivity('simulated_inbound_created', `Simulated inbound created for case ${caseData.id}`, {
            case_id: caseData.id,
            message_id: message.id
        });

        res.status(201).json({
            success: true,
            message_id: message.id,
            case_id: caseData.id,
            thread_id: thread?.id || null,
            created_at: message.created_at
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
