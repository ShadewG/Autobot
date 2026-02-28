const express = require('express');
const router = express.Router();
const { db, notionService, aiService, emailQueue, transitionCaseRuntime } = require('./_helpers');

/**
 * Pending fee responses (needs approval)
 */
router.get('/fee-responses', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                ar.*,
                c.case_name,
                c.agency_name,
                c.agency_email,
                c.portal_url,
                c.state,
                m.subject AS message_subject,
                m.body_text AS original_message,
                m.from_email
            FROM auto_reply_queue ar
            JOIN cases c ON ar.case_id = c.id
            JOIN messages m ON ar.message_id = m.id
            WHERE ar.response_type = 'fee_negotiation'
              AND ar.status IN ('pending', 'updated')
              AND ar.requires_approval = true
            ORDER BY ar.created_at DESC
        `);

        res.json({
            success: true,
            items: result.rows
        });
    } catch (error) {
        console.error('Error fetching fee responses:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Approve & send a fee response
 */
router.post('/fee-responses/:id/approve', async (req, res) => {
    try {
        const entryId = parseInt(req.params.id, 10);
        const entry = await db.getAutoReplyQueueEntryById(entryId);

        if (!entry || entry.response_type !== 'fee_negotiation') {
            return res.status(404).json({
                success: false,
                error: 'Fee response not found'
            });
        }

        const caseData = await db.getCaseById(entry.case_id);
        const message = await db.getMessageById(entry.message_id);

        if (!caseData || !message) {
            return res.status(400).json({
                success: false,
                error: 'Missing case or message data for this response'
            });
        }

        await emailQueue.add('send-auto-reply', {
            type: 'auto_reply',
            caseId: entry.case_id,
            toEmail: message.from_email,
            subject: message.subject,
            content: entry.generated_reply,
            originalMessageId: message.message_id
        });

        const now = new Date();
        await db.updateAutoReplyQueueEntry(entryId, {
            status: 'sent',
            approved_at: now,
            sent_at: now,
            approved_by: req.body?.approved_by || 'dashboard'
        });

        const metadata = entry.metadata || {};
        await transitionCaseRuntime(caseData.id, 'CASE_RECONCILED', {
            targetStatus: 'fee_negotiation',
            substatus: `Fee response sent (${metadata.recommended_action || 'negotiate'})`,
        });
        await notionService.syncStatusToNotion(caseData.id);

        await db.logActivity('fee_response_sent', `Fee response approved and sent for case ${caseData.case_name}`, {
            case_id: caseData.id,
            auto_reply_queue_id: entryId,
            metadata
        });

        res.json({
            success: true,
            message: 'Fee response approved and queued for sending'
        });
    } catch (error) {
        console.error('Error approving fee response:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Regenerate a fee response with new instructions
 */
router.post('/fee-responses/:id/regenerate', async (req, res) => {
    try {
        const entryId = parseInt(req.params.id, 10);
        const { instructions, action } = req.body || {};

        const entry = await db.getAutoReplyQueueEntryById(entryId);
        if (!entry || entry.response_type !== 'fee_negotiation') {
            return res.status(404).json({
                success: false,
                error: 'Fee response not found'
            });
        }

        const caseData = await db.getCaseById(entry.case_id);
        if (!caseData) {
            return res.status(400).json({
                success: false,
                error: 'Case not found'
            });
        }

        const metadata = entry.metadata || {};
        const feeAmount = metadata.fee_amount || caseData.last_fee_quote_amount;

        if (!feeAmount) {
            return res.status(400).json({
                success: false,
                error: 'Fee amount missing from metadata'
            });
        }

        const recommendedAction = action || metadata.recommended_action || 'negotiate';
        const draft = await aiService.generateFeeResponse(caseData, {
            feeAmount,
            currency: metadata.fee_currency || 'USD',
            recommendedAction,
            instructions: instructions || metadata.instructions || null
        });

        const updatedMetadata = {
            ...metadata,
            recommended_action: recommendedAction,
            instructions: instructions || metadata.instructions || null,
            last_regenerated_at: new Date().toISOString()
        };

        await db.updateAutoReplyQueueEntry(entryId, {
            generated_reply: draft.reply_text,
            metadata: updatedMetadata,
            status: 'pending',
            last_regenerated_at: new Date()
        });

        await db.logActivity('fee_response_regenerated', `Fee response regenerated (${recommendedAction})`, {
            case_id: caseData.id,
            auto_reply_queue_id: entryId,
            metadata: updatedMetadata
        });

        res.json({
            success: true,
            message: 'Fee response regenerated',
            metadata: updatedMetadata
        });
    } catch (error) {
        console.error('Error regenerating fee response:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
