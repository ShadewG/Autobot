require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./services/database');

/**
 * Run database migration
 * Usage: node run-migration.js migrations/add-agent-tables.sql
 */
async function runMigration(migrationFile) {
    console.log(`\n🔄 Running migration: ${migrationFile}\n`);

    try {
        // Read SQL file
        const sqlPath = path.join(__dirname, migrationFile);
        const sql = fs.readFileSync(sqlPath, 'utf8');

        console.log('📄 Migration SQL:');
        console.log('─'.repeat(60));
        console.log(sql);
        console.log('─'.repeat(60));
        console.log('');

        // Execute migration
        console.log('⏳ Executing migration...\n');
        const result = await db.query(sql);

        console.log('✅ Migration completed successfully!\n');

        // Verify tables exist
        console.log('🔍 Verifying new tables...\n');

        const tables = await db.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name IN ('agent_decisions', 'escalations')
            ORDER BY table_name
        `);

        if (tables.rows.length > 0) {
            console.log('✓ Tables created:');
            tables.rows.forEach(row => {
                console.log(`  - ${row.table_name}`);
            });
        }

        // Verify views exist
        const views = await db.query(`
            SELECT table_name
            FROM information_schema.views
            WHERE table_schema = 'public'
            AND table_name IN ('pending_escalations', 'agent_performance')
            ORDER BY table_name
        `);

        if (views.rows.length > 0) {
            console.log('\n✓ Views created:');
            views.rows.forEach(row => {
                console.log(`  - ${row.table_name}`);
            });
        }

        console.log('\n🎉 Migration complete!\n');

    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        console.error(error);
        process.exit(1);
    } finally {
        await db.pool.end();
    }
}

// Get migration file from command line args
const migrationFile = process.argv[2];

if (!migrationFile) {
    console.error('Usage: node run-migration.js <migration-file>');
    console.error('Example: node run-migration.js migrations/add-agent-tables.sql');
    process.exit(1);
}

// Run migration
runMigration(migrationFile).catch(console.error);
