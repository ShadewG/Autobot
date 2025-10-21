require('dotenv').config();
const db = require('../services/database');

async function runMigration() {
    try {
        console.log('Starting database migration...');
        console.log('Database URL:', process.env.DATABASE_URL ? 'Connected' : 'Not set');

        await db.initialize();

        console.log('\n✓ Migration completed successfully!');
        console.log('\nTables created:');
        console.log('  - cases');
        console.log('  - email_threads');
        console.log('  - messages');
        console.log('  - attachments');
        console.log('  - response_analysis');
        console.log('  - follow_up_schedule');
        console.log('  - auto_reply_queue');
        console.log('  - generated_requests');
        console.log('  - state_deadlines');
        console.log('  - activity_log');

        await db.close();
        process.exit(0);
    } catch (error) {
        console.error('\n✗ Migration failed:', error);
        process.exit(1);
    }
}

runMigration();
