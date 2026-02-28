const express = require('express');
const router = express.Router();
const { db, notionService, aiService } = require('./_helpers');

/**
 * Re-trigger analysis for a specific case
 * POST /api/test/retrigger-analysis
 */
router.post('/retrigger-analysis', async (req, res) => {
    try {
        const { case_id } = req.body;

        if (!case_id) {
            return res.status(400).json({
                success: false,
                error: 'case_id is required'
            });
        }

        console.log(`🔄 Re-triggering analysis for case #${case_id}...`);

        // Get the latest inbound message for this case
        const result = await db.query(
            `SELECT m.id, m.message_id, m.case_id, m.from_email, m.subject, m.created_at
             FROM messages m
             WHERE m.case_id = $1
             AND m.direction = 'inbound'
             ORDER BY m.created_at DESC
             LIMIT 1`,
            [case_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: `No inbound messages found for case #${case_id}`
            });
        }

        const message = result.rows[0];
        console.log(`✅ Found inbound message from ${message.from_email}`);

        const { analysisQueue } = require('../../queues/email-queue');

        // Queue for analysis with instant reply
        await analysisQueue.add('analyze-response', {
            messageId: message.id,
            caseId: message.case_id,
            instantReply: true
        }, {
            delay: 0,
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 3000
            }
        });

        console.log(`✅ Message re-queued for analysis!`);

        res.json({
            success: true,
            message: `Case #${case_id} re-queued for analysis`,
            message_id: message.id,
            from_email: message.from_email,
            subject: message.subject,
            note: 'Analysis worker will process this and send auto-reply'
        });

    } catch (error) {
        console.error('Retrigger error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Test AI contact extraction for cases 34, 35, 36
 * GET /api/test/contact-extraction
 */
router.get('/contact-extraction', async (req, res) => {
    try {
        const caseIds = [34, 35, 36];
        const results = [];

        for (const caseId of caseIds) {
            const caseData = await db.getCaseById(caseId);

            if (!caseData) {
                results.push({ case_id: caseId, error: 'Case not found' });
                continue;
            }

            // Fetch from Notion to trigger AI extraction
            try {
                const enrichedData = await notionService.fetchPageById(caseData.notion_page_id);

                results.push({
                    case_id: caseId,
                    case_name: caseData.case_name,
                    agency_name: enrichedData.agency_name,
                    state: enrichedData.state,
                    portal_url: enrichedData.portal_url || null,
                    email: enrichedData.agency_email || null,
                    contact_method: enrichedData.portal_url ? 'Portal' : (enrichedData.agency_email ? 'Email' : 'None - Needs Human Review')
                });
            } catch (error) {
                results.push({
                    case_id: caseId,
                    case_name: caseData.case_name,
                    error: error.message
                });
            }
        }

        res.json({
            success: true,
            results: results
        });

    } catch (error) {
        console.error('Contact extraction test error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Regenerate samples for last 3 sent cases
 * GET /api/test/regen-last-3
 */
router.get('/regen-last-3', async (req, res) => {
    try {
        console.log('📝 Regenerating last 3 sent cases...');

        // Get last 3 sent cases
        const result = await db.query(`
            SELECT id, case_name, subject_name, agency_name, state, incident_date,
                   incident_location, additional_details, send_date
            FROM cases
            WHERE status = 'sent'
            ORDER BY send_date DESC
            LIMIT 3
        `);

        if (result.rows.length === 0) {
            return res.json({
                success: false,
                message: 'No sent cases found'
            });
        }

        const samples = [];

        for (const caseRow of result.rows) {
            try {
                const caseData = await db.getCaseById(caseRow.id);
                const generated = await aiService.generateFOIARequest(caseData);

                const simpleName = (caseData.subject_name || 'Information Request')
                    .split(' - ')[0]
                    .split('(')[0]
                    .trim();
                const subject = `Public Records Request - ${simpleName}`;

                samples.push({
                    case_id: caseRow.id,
                    case_name: caseRow.case_name,
                    subject_name: caseRow.subject_name,
                    agency_name: caseRow.agency_name,
                    state: caseRow.state,
                    subject: subject,
                    request_text: generated.request_text,
                    send_date: caseRow.send_date
                });

                // Small delay between generations
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (genError) {
                console.error(`Failed to generate for case ${caseRow.id}:`, genError);
                samples.push({
                    case_id: caseRow.id,
                    case_name: caseRow.case_name,
                    error: genError.message
                });
            }
        }

        res.json({
            success: true,
            count: samples.length,
            samples: samples
        });

    } catch (error) {
        console.error('Regen last 3 error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
