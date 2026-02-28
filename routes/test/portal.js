const express = require('express');
const router = express.Router();
const { db, notionService } = require('./_helpers');

/**
 * Test portal agent with autonomous form filling
 * POST /api/test/portal-agent
 */
router.post('/portal-agent', async (req, res) => {
    try {
        const { portal_url, case_id, max_steps, dry_run } = req.body;

        if (!portal_url) {
            return res.status(400).json({
                success: false,
                error: 'portal_url is required'
            });
        }

        console.log(`🤖 Testing portal agent on: ${portal_url}`);

        // Get case data or use test data
        let caseData;
        if (case_id) {
            caseData = await db.getCaseById(case_id);
            if (!caseData) {
                return res.status(404).json({
                    success: false,
                    error: `Case ${case_id} not found`
                });
            }
        } else {
            // Use test data
            caseData = {
                id: 999,
                case_name: 'Test Case',
                subject_name: 'John Doe',
                agency_name: 'Test Agency',
                state: 'CA',
                incident_date: '2024-01-15',
                incident_location: '123 Main St',
                requested_records: 'Body camera footage, incident reports',
                additional_details: 'Test request'
            };
        }

        // Import portal agent service
        const portalAgentService = require('../../services/portal-agent-service');

        // Run the agent
        const result = await portalAgentService.submitToPortal(caseData, portal_url, {
            maxSteps: max_steps || 30,
            dryRun: dry_run !== false // Default to dry run
        });

        // Close browser
        await portalAgentService.closeBrowser();

        res.json({
            success: result.success,
            ...result,
            note: 'Portal agent uses Anthropic Claude with vision to autonomously navigate and fill forms'
        });

    } catch (error) {
        console.error('Error in portal agent test:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

/**
 * Force submit a case via portal
 * POST /api/test/force-portal-submit
 */
router.post('/force-portal-submit', async (req, res) => {
    try {
        const { case_id } = req.body;

        if (!case_id) {
            return res.status(400).json({
                success: false,
                error: 'case_id is required'
            });
        }

        console.log(`🚀 Force queueing case ${case_id} for portal submission...`);

        // Get case data
        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${case_id} not found`
            });
        }

        // Check if portal URL exists
        if (!caseData.portal_url) {
            return res.status(400).json({
                success: false,
                error: `Case ${case_id} has no portal URL`,
                case_name: caseData.case_name
            });
        }

        console.log(`✅ Case has portal URL: ${caseData.portal_url}`);

        // Queue for portal submission
        const { portalQueue } = require('../../queues/email-queue');
        await portalQueue.add('portal-submit', {
            caseId: case_id
        }, {
            attempts: 2,
            backoff: {
                type: 'exponential',
                delay: 5000
            }
        });

        console.log(`✅ Queued case ${case_id} for portal submission`);

        await db.logActivity('force_portal_submit', `Manually queued case for portal submission`, {
            case_id: case_id,
            portal_url: caseData.portal_url
        });

        res.json({
            success: true,
            message: `Case ${case_id} queued for portal submission`,
            case_id: case_id,
            case_name: caseData.case_name,
            portal_url: caseData.portal_url,
            portal_provider: caseData.portal_provider,
            queued: true
        });

    } catch (error) {
        console.error('Force portal submit error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Set portal URL and queue for submission
 * POST /api/test/set-portal-url
 */
router.post('/set-portal-url', async (req, res) => {
    try {
        const { case_id, portal_url, portal_provider } = req.body;

        if (!case_id || !portal_url) {
            return res.status(400).json({
                success: false,
                error: 'case_id and portal_url are required'
            });
        }

        console.log(`🌐 Setting portal URL for case ${case_id}: ${portal_url}`);

        // Get case data
        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${case_id} not found`
            });
        }

        // Update case with portal URL
        await db.updateCasePortalStatus(case_id, {
            portal_url: portal_url,
            portal_provider: portal_provider || 'NextRequest'
        });

        // Update status to portal_in_progress
        await db.updateCaseStatus(case_id, 'portal_in_progress', {
            substatus: 'Portal URL set - queued for submission'
        });

        console.log(`✅ Updated case ${case_id} with portal URL`);

        // Queue for portal submission
        const { portalQueue } = require('../../queues/email-queue');
        await portalQueue.add('portal-submit', {
            caseId: case_id
        }, {
            attempts: 2,
            backoff: {
                type: 'exponential',
                delay: 5000
            }
        });

        console.log(`✅ Queued case ${case_id} for portal submission`);

        await db.logActivity('set_portal_url', `Set portal URL and queued for submission`, {
            case_id: case_id,
            portal_url: portal_url,
            portal_provider: portal_provider || 'NextRequest'
        });

        res.json({
            success: true,
            message: `Portal URL set and case queued for submission`,
            case_id: case_id,
            case_name: caseData.case_name,
            portal_url: portal_url,
            portal_provider: portal_provider || 'NextRequest',
            status: 'portal_in_progress',
            queued: true
        });

    } catch (error) {
        console.error('Set portal URL error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Approve case for portal submission (from human review)
 * POST /api/test/approve-for-portal
 */
router.post('/approve-for-portal', async (req, res) => {
    try {
        const { case_id } = req.body;

        if (!case_id) {
            return res.status(400).json({
                success: false,
                error: 'case_id is required'
            });
        }

        console.log(`✅ Approving case ${case_id} for portal submission...`);

        // Get case data
        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${case_id} not found`
            });
        }

        // Check if portal URL exists
        if (!caseData.portal_url) {
            return res.status(400).json({
                success: false,
                error: `Case ${case_id} has no portal URL - cannot approve for portal`,
                case_name: caseData.case_name
            });
        }

        // Update status to awaiting_response with portal_submission_needed
        await db.updateCaseStatus(case_id, 'awaiting_response', {
            substatus: 'Approved - queued for portal submission'
        });

        // Sync to Notion
        await notionService.syncStatusToNotion(case_id);

        // Queue for portal submission
        const { portalQueue } = require('../../queues/email-queue');
        await portalQueue.add('portal-submit', {
            caseId: case_id
        }, {
            attempts: 2,
            backoff: {
                type: 'exponential',
                delay: 5000
            }
        });

        console.log(`✅ Case ${case_id} approved and queued for portal submission`);

        await db.logActivity('approve_for_portal', `Approved case for portal submission from human review`, {
            case_id: case_id,
            portal_url: caseData.portal_url
        });

        res.json({
            success: true,
            message: `Case ${case_id} approved and queued for portal submission`,
            case_id: case_id,
            case_name: caseData.case_name,
            portal_url: caseData.portal_url,
            new_status: 'awaiting_response',
            new_substatus: 'Approved - queued for portal submission',
            queued: true
        });

    } catch (error) {
        console.error('Approve for portal error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Resync case from Notion (re-extract contact info with AI)
 * POST /api/test/resync-case
 */
router.post('/resync-case', async (req, res) => {
    try {
        const { case_id } = req.body;

        if (!case_id) {
            return res.status(400).json({
                success: false,
                error: 'case_id is required'
            });
        }

        console.log(`🔄 Resyncing case ${case_id} from Notion...`);

        // Get current case data
        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${case_id} not found`
            });
        }

        if (!caseData.notion_page_id) {
            return res.status(400).json({
                success: false,
                error: `Case ${case_id} has no Notion page ID`
            });
        }

        console.log(`✅ Fetching Notion page: ${caseData.notion_page_id}`);

        // Fetch fresh data from Notion (this triggers AI extraction)
        const freshData = await notionService.fetchPageById(caseData.notion_page_id);

        console.log(`✅ Extracted data from Notion:`);
        console.log(`   Portal URL: ${freshData.portal_url || 'none'}`);
        console.log(`   Email: ${freshData.agency_email || 'none'}`);
        console.log(`   State: ${freshData.state || 'none'}`);

        // Update case with fresh data
        await db.query(`
            UPDATE cases
            SET portal_url = $1,
                portal_provider = $2,
                agency_email = $3,
                agency_name = $4,
                state = $5,
                updated_at = NOW()
            WHERE id = $6
        `, [
            freshData.portal_url || null,
            freshData.portal_provider || null,
            freshData.agency_email || null,
            freshData.agency_name || caseData.agency_name,
            freshData.state || caseData.state,
            case_id
        ]);

        console.log(`✅ Updated case ${case_id} with fresh Notion data`);

        await db.logActivity('resync_case_from_notion', `Manually resynced case from Notion`, {
            case_id: case_id,
            portal_url: freshData.portal_url,
            agency_email: freshData.agency_email
        });

        res.json({
            success: true,
            message: `Case ${case_id} resynced from Notion`,
            case_id: case_id,
            case_name: caseData.case_name,
            before: {
                portal_url: caseData.portal_url,
                agency_email: caseData.agency_email,
                state: caseData.state
            },
            after: {
                portal_url: freshData.portal_url || null,
                agency_email: freshData.agency_email || null,
                state: freshData.state || caseData.state
            }
        });

    } catch (error) {
        console.error('Resync case error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
