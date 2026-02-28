const express = require('express');
const router = express.Router();
const { db, notionService, aiService, generateQueue } = require('./_helpers');

/**
 * Clear all cases and start fresh
 * POST /api/test/clear-all-cases
 * WARNING: This deletes ALL cases and related data!
 */
router.post('/clear-all-cases', async (req, res) => {
    try {
        const { confirm } = req.body;

        if (confirm !== 'DELETE_ALL_CASES') {
            return res.status(400).json({
                success: false,
                error: 'Must confirm with: confirm: "DELETE_ALL_CASES"'
            });
        }

        console.log('🗑️ Starting database cleanup via API...');

        // Count current data
        const casesCount = await db.query('SELECT COUNT(*) as count FROM cases');
        const messagesCount = await db.query('SELECT COUNT(*) as count FROM messages');

        const initialCounts = {
            cases: parseInt(casesCount.rows[0].count),
            messages: parseInt(messagesCount.rows[0].count)
        };

        // Delete all related records (in order of dependencies)
        await db.query('DELETE FROM auto_reply_queue');
        await db.query('DELETE FROM response_analysis');
        await db.query('DELETE FROM follow_up_schedule');
        await db.query('DELETE FROM generated_requests');
        await db.query('DELETE FROM messages');
        await db.query('DELETE FROM email_threads');
        await db.query('DELETE FROM cases');
        await db.query('DELETE FROM activity_log');

        // Reset sequences
        await db.query('ALTER SEQUENCE cases_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE messages_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE email_threads_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE response_analysis_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE follow_up_schedule_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE generated_requests_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE activity_log_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE auto_reply_queue_id_seq RESTART WITH 1');

        // Verify
        const finalCount = await db.query('SELECT COUNT(*) as count FROM cases');

        res.json({
            success: true,
            message: 'All cases cleared successfully',
            deleted: initialCounts,
            remaining: parseInt(finalCount.rows[0].count),
            note: 'Database is now empty and ready for fresh cases'
        });

    } catch (error) {
        console.error('Error clearing cases:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Run database migration (for dashboard)
 * POST /api/test/run-migration
 */
router.post('/run-migration', async (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');

        // Get migration filename from request body, default to add-agent-tables.sql
        const migrationFile = req.body.migration || 'add-agent-tables.sql';
        const migrationName = migrationFile.replace('.sql', '');

        console.log(`🔄 Running migration: ${migrationName}...`);

        // Read migration file
        const migrationPath = path.join(__dirname, '..', '..', 'migrations', `${migrationName}.sql`);
        if (!fs.existsSync(migrationPath)) {
            return res.status(404).json({
                success: false,
                error: `Migration file not found: ${migrationName}.sql`
            });
        }

        const sql = fs.readFileSync(migrationPath, 'utf8');

        // Execute migration
        await db.query(sql);

        console.log('✅ Migration completed');

        // Verify tables exist
        const tables = await db.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name IN ('agent_decisions', 'escalations')
            ORDER BY table_name
        `);

        const views = await db.query(`
            SELECT table_name
            FROM information_schema.views
            WHERE table_schema = 'public'
            AND table_name IN ('pending_escalations', 'agent_performance')
            ORDER BY table_name
        `);

        res.json({
            success: true,
            message: 'Migration completed successfully',
            tables: tables.rows.map(r => r.table_name),
            views: views.rows.map(r => r.table_name)
        });
    } catch (error) {
        console.error('Migration error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Run migration 007: Add UNIQUE constraint to auto_reply_queue
 * POST /api/test/run-migration-007
 */
router.post('/run-migration-007', async (req, res) => {
    try {
        console.log('🔧 Running migration 007...');

        const migrationSQL = `
            -- Add UNIQUE constraint to auto_reply_queue.message_id
            ALTER TABLE auto_reply_queue
            ADD CONSTRAINT auto_reply_queue_message_id_unique UNIQUE (message_id);
        `;

        await db.query(migrationSQL);

        console.log('✅ Migration 007 completed!');

        res.json({
            success: true,
            message: 'Migration 007 completed: Added UNIQUE constraint to auto_reply_queue.message_id'
        });

    } catch (error) {
        console.error('Migration 007 error:', error);

        // If constraint already exists, that's fine
        if (error.message.includes('already exists')) {
            return res.json({
                success: true,
                message: 'Constraint already exists (skipped)',
                note: 'This is expected if migration was already run'
            });
        }

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Delete test cases up to a specific ID
 * POST /api/test/delete-test-cases
 */
router.post('/delete-test-cases', async (req, res) => {
    try {
        const { max_case_id } = req.body;

        if (!max_case_id || max_case_id < 1) {
            return res.status(400).json({
                success: false,
                error: 'max_case_id is required and must be > 0'
            });
        }

        console.log(`🗑️  Deleting test cases with ID <= ${max_case_id}...`);

        // Get the cases first
        const casesResult = await db.query(
            'SELECT id, case_name, agency_name, status FROM cases WHERE id <= $1 ORDER BY id',
            [max_case_id]
        );

        if (casesResult.rows.length === 0) {
            return res.json({
                success: true,
                message: 'No cases found to delete',
                deleted_count: 0
            });
        }

        const casesList = casesResult.rows.map(c => ({
            id: c.id,
            name: c.case_name,
            agency: c.agency_name,
            status: c.status
        }));

        // Delete cases (CASCADE will handle related records)
        const deleteResult = await db.query(
            'DELETE FROM cases WHERE id <= $1',
            [max_case_id]
        );

        console.log(`✅ Deleted ${deleteResult.rowCount} test cases`);

        // Log the activity
        await db.logActivity(
            'bulk_delete_test_cases',
            `Deleted test cases with IDs 1-${max_case_id} (${deleteResult.rowCount} cases)`,
            {
                deleted_count: deleteResult.rowCount,
                max_case_id: max_case_id,
                cases: casesList
            }
        );

        res.json({
            success: true,
            message: `Deleted ${deleteResult.rowCount} test cases (IDs 1-${max_case_id})`,
            deleted_count: deleteResult.rowCount,
            deleted_cases: casesList
        });

    } catch (error) {
        console.error('Delete test cases error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Clear all pending jobs from generate queue
 * POST /api/test/clear-generate-queue
 */
router.post('/clear-generate-queue', async (req, res) => {
    try {
        console.log('🗑️ Clearing all pending jobs from generate queue...');

        // Get all waiting and delayed jobs
        const waitingJobs = await generateQueue.getWaiting();
        const delayedJobs = await generateQueue.getDelayed();

        let clearedCount = 0;

        // Remove waiting jobs
        for (const job of waitingJobs) {
            await job.remove();
            clearedCount++;
        }

        // Remove delayed jobs
        for (const job of delayedJobs) {
            await job.remove();
            clearedCount++;
        }

        console.log(`✅ Cleared ${clearedCount} pending jobs from generate queue`);

        res.json({
            success: true,
            message: `Cleared ${clearedCount} pending jobs`,
            cleared_count: clearedCount
        });

    } catch (error) {
        console.error('Clear queue error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Generate a sample FOIA request for a case
 * POST /api/test/generate-sample
 */
router.post('/generate-sample', async (req, res) => {
    try {
        const { case_id } = req.body;

        if (!case_id) {
            return res.status(400).json({
                success: false,
                error: 'case_id is required'
            });
        }

        console.log(`📝 Generating sample FOIA request for case ${case_id}...`);

        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: `Case ${case_id} not found`
            });
        }

        // Generate FOIA request
        const generated = await aiService.generateFOIARequest(caseData);

        // Create simple subject line
        const simpleName = (caseData.subject_name || 'Information Request')
            .split(' - ')[0]
            .split('(')[0]
            .trim();
        const subject = `Public Records Request - ${simpleName}`;

        res.json({
            success: true,
            case_id: case_id,
            case_name: caseData.case_name,
            subject: subject,
            request_text: generated.request_text,
            agency_name: caseData.agency_name,
            agency_email: caseData.agency_email,
            portal_url: caseData.portal_url
        });

    } catch (error) {
        console.error('Generate sample error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * COMPLETE RESET: Clear database, reset Notion statuses, and resync
 * POST /api/test/complete-reset
 */
router.post('/complete-reset', async (req, res) => {
    try {
        console.log('🚨 COMPLETE RESET INITIATED');

        const { Client } = require('@notionhq/client');
        const notion = new Client({ auth: process.env.NOTION_API_KEY });

        // Clear all queues
        const { generateQueue } = require('../../queues/email-queue');
        const waitingJobs = await generateQueue.getWaiting();
        const delayedJobs = await generateQueue.getDelayed();
        const activeJobs = await generateQueue.getActive();

        let clearedCount = 0;
        for (const job of [...waitingJobs, ...delayedJobs, ...activeJobs]) {
            try {
                await job.remove();
                clearedCount++;
            } catch (e) {
                console.log(`   ⚠️  Could not remove job ${job.id}: ${e.message}`);
            }
        }

        // Delete all database records (ignore errors if table doesn't exist)
        const tablesToClear = [
            'auto_reply_queue',
            'analysis',
            'messages',
            'threads',
            'generated_requests',
            'cases',
            'activity_log'
        ];

        for (const table of tablesToClear) {
            try {
                await db.query(`DELETE FROM ${table}`);
            } catch (e) {
                console.log(`   ⚠️  Table ${table} doesn't exist or error: ${e.message}`);
            }
        }

        // Respond immediately, then continue in background
        res.json({
            success: true,
            message: 'Database cleared, Notion sync and queueing started in background',
            cleared_jobs: clearedCount
        });

        // Continue in background (no await on client)
        (async () => {
            try {
                console.log('📋 Querying all Notion pages...');
                // Reset ALL Notion statuses to "Ready to Send"
                const databaseId = process.env.NOTION_CASES_DATABASE_ID;
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

                console.log(`📄 Found ${allPages.length} pages, updating statuses...`);
                let updatedCount = 0;
                for (const page of allPages) {
                    try {
                        await notion.pages.update({
                            page_id: page.id,
                            properties: {
                                Status: { status: { name: 'Ready to Send' } }
                            }
                        });
                        updatedCount++;
                    } catch (e) {
                        // Skip pages that can't be updated
                    }
                }

                console.log(`✅ Updated ${updatedCount} pages to "Ready to Send"`);
                console.log('🔄 Syncing from Notion with AI extraction...');

                // Sync from Notion
                const cases = await notionService.syncCasesFromNotion('Ready to Send');
                console.log(`✅ Synced ${cases.length} cases`);

                // Process and queue cases
                let queuedCount = 0;
                let reviewCount = 0;

                for (const caseData of cases) {
                    const hasPortal = caseData.portal_url && caseData.portal_url.trim().length > 0;
                    const hasEmail = caseData.agency_email && caseData.agency_email.trim().length > 0;

                    if (!hasPortal && !hasEmail) {
                        await db.query(
                            'UPDATE cases SET status = $1, substatus = $2 WHERE id = $3',
                            ['needs_human_review', 'Missing contact information', caseData.id]
                        );
                        reviewCount++;
                        console.log(`⚠️  Case #${caseData.id} flagged for review (no contact info)`);
                    } else {
                        await generateQueue.add('generate-and-send', {
                            caseId: caseData.id,
                            instantMode: false
                        }, {
                            delay: queuedCount * 15000
                        });
                        queuedCount++;
                        console.log(`✅ Case #${caseData.id} queued: ${caseData.case_name}`);
                    }
                }

                console.log('\n' + '='.repeat(80));
                console.log('🎉 COMPLETE RESET FINISHED');
                console.log('='.repeat(80));
                console.log(`✅ Queued for sending: ${queuedCount} cases`);
                console.log(`⚠️  Flagged for review: ${reviewCount} cases`);
                console.log('='.repeat(80));

            } catch (bgError) {
                console.error('❌ Background reset error:', bgError);
            }
        })();

    } catch (error) {
        console.error('Complete reset error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * NUCLEAR RESET: Delete all cases and resync from Notion
 * POST /api/test/nuclear-reset
 */
router.post('/nuclear-reset', async (req, res) => {
    try {
        console.log('🚨 NUCLEAR RESET INITIATED');

        // Clear all queues
        const { generateQueue } = require('../../queues/email-queue');
        const waitingJobs = await generateQueue.getWaiting();
        const delayedJobs = await generateQueue.getDelayed();
        const activeJobs = await generateQueue.getActive();

        let clearedCount = 0;
        for (const job of [...waitingJobs, ...delayedJobs, ...activeJobs]) {
            try {
                await job.remove();
                clearedCount++;
            } catch (e) {
                console.log(`   ⚠️  Could not remove job ${job.id}: ${e.message}`);
            }
        }

        // Delete all database records (ignore errors if table doesn't exist)
        const tablesToClear = [
            'auto_reply_queue',
            'analysis',
            'messages',
            'threads',
            'generated_requests',
            'cases',
            'activity_log'
        ];

        for (const table of tablesToClear) {
            try {
                await db.query(`DELETE FROM ${table}`);
            } catch (e) {
                console.log(`   ⚠️  Table ${table} doesn't exist or error: ${e.message}`);
            }
        }

        // Sync from Notion
        const cases = await notionService.syncCasesFromNotion('Ready to Send');

        // Process and queue cases
        let queuedCount = 0;
        let reviewCount = 0;
        const results = [];

        for (const caseData of cases) {
            const hasPortal = caseData.portal_url && caseData.portal_url.trim().length > 0;
            const hasEmail = caseData.agency_email && caseData.agency_email.trim().length > 0;

            if (!hasPortal && !hasEmail) {
                await db.query(
                    'UPDATE cases SET status = $1, substatus = $2 WHERE id = $3',
                    ['needs_human_review', 'Missing contact information', caseData.id]
                );
                reviewCount++;
                results.push({ id: caseData.id, status: 'needs_review', reason: 'No contact info' });
            } else if (!caseData.state) {
                await db.query(
                    'UPDATE cases SET status = $1, substatus = $2 WHERE id = $3',
                    ['needs_human_review', 'Missing state field', caseData.id]
                );
                reviewCount++;
                results.push({ id: caseData.id, status: 'needs_review', reason: 'Missing state' });
            } else {
                await generateQueue.add('generate-and-send', {
                    caseId: caseData.id,
                    instantMode: true
                }, {
                    delay: queuedCount * 10000 // Stagger by 10 seconds
                });
                queuedCount++;
                results.push({ id: caseData.id, status: 'queued', case_name: caseData.case_name });
            }
        }

        res.json({
            success: true,
            message: 'Nuclear reset complete',
            cleared_jobs: clearedCount,
            synced_count: cases.length,
            queued_count: queuedCount,
            review_count: reviewCount,
            results: results
        });

    } catch (error) {
        console.error('Nuclear reset error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
