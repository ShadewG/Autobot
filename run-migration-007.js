require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    try {
        console.log('🔧 Running migration 007: Add UNIQUE constraint to auto_reply_queue.message_id');

        const migrationPath = path.join(__dirname, 'migrations', '007_add_unique_constraint_auto_reply_queue.sql');
        const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

        console.log('📝 Executing SQL...');
        await pool.query(migrationSQL);

        console.log('✅ Migration completed successfully!');
        console.log('   Added UNIQUE constraint to auto_reply_queue.message_id');

        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error.message);

        if (error.message.includes('already exists')) {
            console.log('ℹ️  Constraint already exists, skipping...');
            process.exit(0);
        }

        process.exit(1);
    } finally {
        await pool.end();
    }
}

runMigration();
