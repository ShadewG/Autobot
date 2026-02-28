const express = require('express');
const router = express.Router();
const { db } = require('./_helpers');

/**
 * Utility endpoint to update contact info status
 * POST /api/test/fix-contact-status
 */
router.post('/fix-contact-status', async (req, res) => {
    try {
        const result = await db.query(`
            UPDATE cases
            SET status = 'needs_contact_info', updated_at = CURRENT_TIMESTAMP
            WHERE status = 'needs_human_review'
              AND substatus = 'No valid portal or email contact detected'
            RETURNING id, case_name, status, substatus
        `);

        res.json({
            success: true,
            updated: result.rowCount,
            cases: result.rows
        });
    } catch (error) {
        console.error('Error updating contact status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Fix state fields for cases 34, 35, 36
 * POST /api/test/fix-states
 */
router.post('/fix-states', async (req, res) => {
    try {
        console.log('🔧 Fixing state fields...');

        // Case 35: Austin PD = Texas
        await db.query('UPDATE cases SET state = $1 WHERE id = $2', ['TX', 35]);

        // Case 36: Springhill PD = Louisiana
        await db.query('UPDATE cases SET state = $1 WHERE id = $2', ['LA', 36]);

        // Case 34: Fayette Police Department, Iowa = Iowa
        await db.query('UPDATE cases SET state = $1 WHERE id = $2', ['IA', 34]);

        res.json({
            success: true,
            message: 'Updated states for cases 34, 35, 36',
            updates: [
                { case_id: 35, agency: 'Austin PD', state: 'TX' },
                { case_id: 36, agency: 'Springhill PD', state: 'LA' },
                { case_id: 34, agency: 'Fayette PD Iowa', state: 'IA' }
            ]
        });

    } catch (error) {
        console.error('Fix states error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Test stuck response detector
 * GET /api/test/stuck-responses
 */
router.get('/stuck-responses', async (req, res) => {
    try {
        console.log('🔍 Running stuck response detector...');

        const stuckResponseDetector = require('../../services/stuck-response-detector');
        const result = await stuckResponseDetector.detectAndFlagStuckResponses();

        res.json({
            success: true,
            message: result.flagged === 0
                ? 'No stuck responses found'
                : `Flagged ${result.flagged} stuck response(s) for human review`,
            flagged_count: result.flagged,
            case_ids: result.cases || []
        });

    } catch (error) {
        console.error('Stuck response detector error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Fix case 42: Extract portal URL and queue for submission
 * POST /api/test/fix-case-42
 */
router.post('/fix-case-42', async (req, res) => {
    try {
        console.log('🔧 Fixing case 42...');

        // Get message 85
        const messageResult = await db.query(
            'SELECT * FROM messages WHERE id = $1',
            [85]
        );

        if (messageResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Message 85 not found'
            });
        }

        const message = messageResult.rows[0];
        console.log(`✅ Found message 85 from ${message.from_email}`);

        // Extract portal URL from message body
        const bodyText = message.body_text || '';
        const urlMatch = bodyText.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi);

        if (!urlMatch || urlMatch.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No URL found in message body'
            });
        }

        const portalUrl = urlMatch[0].trim();
        console.log(`✅ Extracted portal URL: ${portalUrl}`);

        // Update case 42 with portal URL
        await db.query(
            'UPDATE cases SET portal_url = $1, portal_provider = $2 WHERE id = $3',
            [portalUrl, 'GovQA', 42]
        );
        console.log('✅ Updated case 42 with portal URL');

        // Queue for portal submission
        const { portalQueue } = require('../../queues/email-queue');
        await portalQueue.add('portal-submit', {
            caseId: 42
        }, {
            attempts: 2,
            backoff: {
                type: 'exponential',
                delay: 5000
            }
        });

        console.log('✅ Queued case 42 for portal submission');

        await db.logActivity('case_42_manual_fix', 'Manually extracted portal URL and queued for submission', {
            case_id: 42,
            portal_url: portalUrl,
            message_id: 85
        });

        res.json({
            success: true,
            message: 'Case 42 fixed and queued for portal submission',
            portal_url: portalUrl,
            case_id: 42,
            queued: true
        });

    } catch (error) {
        console.error('Fix case 42 error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
