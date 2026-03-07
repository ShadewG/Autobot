const express = require('express');
const router = express.Router();
const { db, notionService, discordService, generateQueue, detectPortalProviderByUrl, transitionCaseRuntime } = require('./_helpers');
const { dispatchReadyToSend } = require('../../services/dispatch-helper');

async function enqueueOrDispatch(caseId, { instantMode = true, source = 'notion_test' } = {}) {
    if (generateQueue) {
        await generateQueue.add('generate-foia', {
            caseId,
            instantMode,
        });
        return { mode: 'queue' };
    }

    const result = await dispatchReadyToSend(caseId, { source });
    return { mode: 'dispatch', result };
}

function applyTestDeliveryOverride(caseData, testEmail) {
    if (!testEmail) return { ...caseData };

    return {
        ...caseData,
        agency_email: testEmail,
        alternate_agency_email: null,
        portal_url: null,
        portal_provider: null,
        agency_id: null,
        last_portal_status: null,
        last_portal_status_at: null,
        last_portal_engine: null,
        last_portal_run_id: null,
        last_portal_details: null,
        last_portal_task_url: null,
        last_portal_recording_url: null,
        last_portal_account_email: null,
        last_portal_screenshot_url: null,
    };
}

async function persistTestDeliveryOverride(caseId, testEmail) {
    if (!testEmail) return;

    await db.query(
        `UPDATE cases
         SET agency_email = $1,
             alternate_agency_email = NULL,
             portal_url = NULL,
             portal_provider = NULL,
             agency_id = NULL,
             last_portal_status = NULL,
             last_portal_status_at = NULL,
             last_portal_engine = NULL,
             last_portal_run_id = NULL,
             last_portal_details = NULL,
             last_portal_task_url = NULL,
             last_portal_recording_url = NULL,
             last_portal_account_email = NULL,
             last_portal_screenshot_url = NULL
         WHERE id = $2`,
        [testEmail, caseId]
    );
}

/**
 * Test endpoint: Process a Notion page with instant mode
 * POST /api/test/process-notion
 */
router.post('/process-notion', async (req, res) => {
    try {
        const { notion_page_id, test_email, instant_mode } = req.body;

        if (!notion_page_id) {
            return res.status(400).json({
                success: false,
                error: 'notion_page_id is required'
            });
        }

        console.log(`🧪 Test: Processing Notion page ${notion_page_id} with instant mode`);

        // Fetch the page from Notion
        const notionPage = await notionService.fetchPageById(notion_page_id);

        if (!notionPage) {
            return res.status(404).json({
                success: false,
                error: 'Notion page not found or could not be accessed'
            });
        }

        // Check if case already exists
        const existing = await db.query(
            'SELECT * FROM cases WHERE notion_page_id = $1',
            [notion_page_id]
        );

        let caseId;
        let caseData;

        if (existing.rows.length > 0) {
            // Update existing case
            caseId = existing.rows[0].id;
            caseData = existing.rows[0];

            if (test_email) {
                await persistTestDeliveryOverride(caseId, test_email);
                await db.query(
                    `UPDATE cases
                     SET status = $1,
                         requires_human = false,
                         pause_reason = NULL,
                         substatus = NULL
                     WHERE id = $2`,
                    ['ready_to_send', caseId]
                );
                caseData = applyTestDeliveryOverride(caseData, test_email);
            } else {
                await db.query(
                    'UPDATE cases SET agency_email = COALESCE($1, agency_email), status = $2, requires_human = false, pause_reason = NULL, substatus = NULL WHERE id = $3',
                    [null, 'ready_to_send', caseId]
                );
            }
            caseData.status = 'ready_to_send';

            console.log(`Using existing case ${caseId}, updated for testing`);
        } else {
            // Create new case from Notion data
            const seededCase = applyTestDeliveryOverride({
                ...notionPage,
                agency_email: test_email || notionPage.agency_email
            }, test_email || null);
            const newCase = await db.createCase(seededCase);
            caseId = newCase.id;
            await persistTestDeliveryOverride(caseId, test_email || null);

            await db.query(
                'UPDATE cases SET status = $1, requires_human = false, pause_reason = NULL, substatus = NULL WHERE id = $2',
                ['ready_to_send', caseId]
            );

            caseData = {
                ...newCase,
                status: 'ready_to_send',
                agency_email: test_email || notionPage.agency_email,
            };
            console.log(`Created new case ${caseId} from Notion`);
        }

        const dispatch = await enqueueOrDispatch(caseId, {
            instantMode: instant_mode !== false,
            source: 'notion_test_process',
        });

        console.log(`Queued case ${caseId} for instant processing via ${dispatch.mode}`);

        res.json({
            success: true,
            message: dispatch.mode === 'queue' ? 'Case queued for instant processing' : 'Case dispatched directly for instant processing',
            case_id: caseId,
            case_name: caseData.case_name,
            email: caseData.agency_email,
            instant_mode: instant_mode !== false,
            dispatch
        });

    } catch (error) {
        console.error('Error processing Notion page:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.body
        });
    }
});

/**
 * Manual Notion sync trigger
 * POST /api/test/sync-notion
 */
router.post('/sync-notion', async (req, res) => {
    try {
        console.log('🔄 Manual Notion sync triggered');

        // Fetch cases with status "Ready to Send"
        const notionCases = await notionService.fetchCasesWithStatus('Ready to Send');
        console.log(`Found ${notionCases.length} cases in Notion with status "Ready to Send"`);

        let imported = 0;
        let queued = 0;
        let skipped = 0;
        const results = [];

        for (const notionCase of notionCases) {
            // Check if case already exists in database
            const existing = await db.query(
                'SELECT * FROM cases WHERE notion_page_id = $1',
                [notionCase.notion_page_id]
            );

            if (existing.rows.length > 0) {
                const existingCase = existing.rows[0];

                // If case exists but hasn't been sent yet, queue it
                // Check for both database format and Notion format
                const isReadyToSend = !existingCase.send_date &&
                                     (existingCase.status === 'ready_to_send' ||
                                      existingCase.status === 'Ready to Send');

                if (isReadyToSend) {
                    console.log(`Case exists but not sent yet, queueing: ${existingCase.case_name}`);

                    const dispatch = await enqueueOrDispatch(existingCase.id, {
                        instantMode: true,
                        source: 'notion_test_sync_existing'
                    });
                    console.log(`Queued/dispatched existing case ${existingCase.id} for generation and sending via ${dispatch.mode}`);
                    queued++;

                    results.push({
                        case_id: existingCase.id,
                        case_name: existingCase.case_name,
                        agency_email: existingCase.agency_email,
                        status: 'queued',
                        reason: 'Existing case queued for sending (not sent yet)',
                        dispatch
                    });
                } else {
                    console.log(`Case already exists and was sent: ${existingCase.case_name}`);
                    skipped++;
                    results.push({
                        case_name: existingCase.case_name,
                        status: 'skipped',
                        reason: 'Already sent'
                    });
                }
                continue;
            }

            // Import new case
            const newCase = await db.createCase(notionCase);
            console.log(`Imported new case: ${newCase.case_name} (ID: ${newCase.id})`);
            imported++;

            // Queue for email generation and sending
            const dispatch = await enqueueOrDispatch(newCase.id, {
                instantMode: true,
                source: 'notion_test_sync_new'
            });
            console.log(`Queued/dispatched case ${newCase.id} for generation and sending via ${dispatch.mode}`);
            queued++;

            results.push({
                case_id: newCase.id,
                case_name: newCase.case_name,
                agency_email: newCase.agency_email,
                status: 'queued',
                reason: 'New case imported and queued for sending',
                dispatch
            });
        }

        res.json({
            success: true,
            message: `Notion sync complete`,
            summary: {
                total_found: notionCases.length,
                imported: imported,
                queued: queued,
                skipped: skipped
            },
            results: results
        });

    } catch (error) {
        console.error('Error syncing Notion:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Force sync from Notion and process all "Ready to Send" cases
 * POST /api/test/force-notion-sync
 */
router.post('/force-notion-sync', async (req, res) => {
    try {
        console.log('🔄 Force syncing cases from Notion...');

        // Sync cases with "Ready To Send" status (exact match from Notion)
        const cases = await notionService.syncCasesFromNotion('Ready To Send');

        if (cases.length === 0) {
            return res.json({
                success: true,
                message: 'No new "Ready to Send" cases found in Notion',
                synced_count: 0,
                queued_count: 0
            });
        }

        console.log(`✅ Synced ${cases.length} cases from Notion`);

        let queuedCount = 0;
        let reviewCount = 0;
        const results = [];

        // Process each case
        for (const caseData of cases) {
            const result = {
                id: caseData.id,
                case_name: caseData.case_name,
                status: null,
                message: null
            };

            // Check if case has contact info (portal URL or email)
            const hasPortal = caseData.portal_url && caseData.portal_url.trim().length > 0;
            const hasEmail = caseData.agency_email && caseData.agency_email.trim().length > 0;

            if (!hasPortal && !hasEmail) {
                // No contact info - flag for contact info needed
                await transitionCaseRuntime(caseData.id, 'CASE_RECONCILED', {
                    targetStatus: 'needs_contact_info',
                    substatus: 'Missing contact information (no portal URL or email)',
                });
                await notionService.syncStatusToNotion(caseData.id);
                await db.logActivity('contact_missing', `Case ${caseData.id} flagged - missing contact info`, {
                    case_id: caseData.id
                });

                result.status = 'needs_contact_info';
                result.message = 'Missing contact info - needs portal URL or email';
                reviewCount++;
            } else {
                // Has contact info - queue for processing
                const dispatch = await enqueueOrDispatch(caseData.id, {
                    instantMode: true,
                    source: 'notion_test_force_sync'
                });

                result.status = 'queued';
                result.message = hasPortal ? 'Queued for portal submission' : 'Queued for email';
                result.dispatch = dispatch;
                queuedCount++;
            }

            results.push(result);
            console.log(`  ${result.status === 'queued' ? '✅' : '⚠️'} Case ${caseData.id}: ${result.message}`);
        }

        await db.logActivity('notion_force_sync', `Force synced ${cases.length} cases from Notion`, {
            synced_count: cases.length,
            queued_count: queuedCount,
            review_count: reviewCount
        });

        // Notify Discord about bulk sync
        await discordService.notifyBulkSync(cases.length, queuedCount, reviewCount);

        res.json({
            success: true,
            message: `Synced ${cases.length} cases from Notion`,
            synced_count: cases.length,
            queued_count: queuedCount,
            review_count: reviewCount,
            results: results
        });

    } catch (error) {
        console.error('Force Notion sync error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * CHECK ALL NOTION CASES: Query all cases in Notion regardless of status
 * GET /api/test/check-all-notion
 */
router.get('/check-all-notion', async (req, res) => {
    try {
        const { Client } = require('@notionhq/client');
        const notion = new Client({ auth: process.env.NOTION_API_KEY });
        const databaseId = process.env.NOTION_CASES_DATABASE_ID;

        console.log('Querying ALL cases in Notion...');

        let allPages = [];
        let hasMore = true;
        let startCursor = undefined;

        while (hasMore) {
            const response = await notion.databases.query({
                database_id: databaseId,
                start_cursor: startCursor
            });
            allPages = allPages.concat(response.results);
            hasMore = response.has_more;
            startCursor = response.next_cursor;
        }

        console.log(`Total cases found: ${allPages.length}`);

        // Count by status
        const statusCounts = {};
        const caseList = [];

        for (const page of allPages) {
            const name = page.properties.Name?.title?.[0]?.plain_text || 'Untitled';
            const status = page.properties.Status?.status?.name || 'No Status';

            statusCounts[status] = (statusCounts[status] || 0) + 1;

            caseList.push({
                name: name.substring(0, 80),
                status: status,
                page_id: page.id
            });
        }

        res.json({
            success: true,
            total_count: allPages.length,
            status_breakdown: statusCounts,
            cases: caseList
        });

    } catch (error) {
        console.error('Check all Notion error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
