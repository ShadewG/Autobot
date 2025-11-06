require('dotenv').config();
const db = require('./services/database');

/**
 * Clear all cases from the database
 * This will:
 * 1. Create a backup of all data
 * 2. Delete all cases and related records
 * 3. Reset sequences
 */
async function clearAllCases() {
    console.log('🗑️  Starting database cleanup...\n');

    try {
        // Step 1: Count current data
        console.log('📊 Current database state:');
        const casesCount = await db.query('SELECT COUNT(*) as count FROM cases');
        const messagesCount = await db.query('SELECT COUNT(*) as count FROM messages');
        const threadsCount = await db.query('SELECT COUNT(*) as count FROM email_threads');
        const analysisCount = await db.query('SELECT COUNT(*) as count FROM response_analysis');

        console.log(`   Cases: ${casesCount.rows[0].count}`);
        console.log(`   Messages: ${messagesCount.rows[0].count}`);
        console.log(`   Email Threads: ${threadsCount.rows[0].count}`);
        console.log(`   Response Analysis: ${analysisCount.rows[0].count}\n`);

        // Step 2: Create backup
        console.log('💾 Creating backup...');
        const backupData = {
            timestamp: new Date().toISOString(),
            cases: (await db.query('SELECT * FROM cases')).rows,
            messages: (await db.query('SELECT * FROM messages')).rows,
            threads: (await db.query('SELECT * FROM email_threads')).rows,
            analysis: (await db.query('SELECT * FROM response_analysis')).rows,
            followUps: (await db.query('SELECT * FROM follow_up_schedule')).rows,
            generated: (await db.query('SELECT * FROM generated_requests')).rows
        };

        const fs = require('fs');
        const backupPath = `./backup-${Date.now()}.json`;
        fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));
        console.log(`✅ Backup saved: ${backupPath}\n`);

        // Step 3: Delete all related records (in correct order due to foreign keys)
        console.log('🗑️  Deleting all records...');

        // Delete in order of dependencies
        await db.query('DELETE FROM auto_reply_queue');
        console.log('   ✓ Cleared auto_reply_queue');

        await db.query('DELETE FROM response_analysis');
        console.log('   ✓ Cleared response_analysis');

        await db.query('DELETE FROM follow_up_schedule');
        console.log('   ✓ Cleared follow_up_schedule');

        await db.query('DELETE FROM generated_requests');
        console.log('   ✓ Cleared generated_requests');

        await db.query('DELETE FROM messages');
        console.log('   ✓ Cleared messages');

        await db.query('DELETE FROM email_threads');
        console.log('   ✓ Cleared email_threads');

        await db.query('DELETE FROM cases');
        console.log('   ✓ Cleared cases');

        // Also clear activity log for clean slate
        await db.query('DELETE FROM activity_log');
        console.log('   ✓ Cleared activity_log');

        // Step 4: Reset sequences (auto-increment IDs)
        console.log('\n🔄 Resetting ID sequences...');
        await db.query('ALTER SEQUENCE cases_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE messages_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE email_threads_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE response_analysis_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE follow_up_schedule_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE generated_requests_id_seq RESTART WITH 1');
        await db.query('ALTER SEQUENCE activity_log_id_seq RESTART WITH 1');
        console.log('   ✓ All sequences reset to 1');

        // Step 5: Verify empty
        console.log('\n✅ Verification:');
        const finalCount = await db.query('SELECT COUNT(*) as count FROM cases');
        console.log(`   Cases remaining: ${finalCount.rows[0].count}`);

        console.log('\n🎉 Database cleared successfully!');
        console.log(`📦 Backup saved to: ${backupPath}`);
        console.log('\n🚀 You can now start fresh with new cases from Notion!');

    } catch (error) {
        console.error('\n❌ Error clearing database:', error);
        console.error(error.stack);
        process.exit(1);
    } finally {
        // Close database connection
        await db.pool.end();
    }
}

// Run the cleanup
clearAllCases().catch(console.error);
