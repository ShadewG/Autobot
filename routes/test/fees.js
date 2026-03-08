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
router.post('/fee-responses/:id/approve', async (_req, res) => {
    return res.status(410).json({
        success: false,
        error: 'Legacy fee response approval endpoint retired. Use the proposals review flow instead.'
    });
});

/**
 * Regenerate a fee response with new instructions
 */
router.post('/fee-responses/:id/regenerate', async (_req, res) => {
    return res.status(410).json({
        success: false,
        error: 'Legacy fee response regeneration endpoint retired. Use the proposals review flow instead.'
    });
});

module.exports = router;
