require('dotenv').config();
const db = require('./services/database');

/**
 * Delete test cases up to and including case #19
 */
async function deleteTestCases() {
    try {
        console.log('🗑️  Deleting test cases (IDs 1-19)...\n');

        // Get the cases first to show what we're deleting
        const casesResult = await db.query(
            'SELECT id, case_name, agency_name, status FROM cases WHERE id <= 19 ORDER BY id'
        );

        if (casesResult.rows.length === 0) {
            console.log('✅ No test cases found (already deleted)');
            process.exit(0);
        }

        console.log(`Found ${casesResult.rows.length} test cases:\n`);
        casesResult.rows.forEach(c => {
            console.log(`   #${c.id}: ${c.case_name || 'Untitled'} - ${c.agency_name || 'Unknown'} (${c.status})`);
        });

        console.log('\n🔄 Deleting cases and all related data...');

        // Delete cases (CASCADE will handle related records)
        const deleteResult = await db.query(
            'DELETE FROM cases WHERE id <= 19'
        );

        console.log(`\n✅ Deleted ${deleteResult.rowCount} test cases!`);
        console.log('   Related data (messages, threads, analysis, etc.) also deleted via CASCADE');

        // Log the activity
        await db.logActivity(
            'bulk_delete_test_cases',
            `Deleted test cases with IDs 1-19 (${deleteResult.rowCount} cases)`,
            {
                deleted_count: deleteResult.rowCount,
                max_case_id: 19
            }
        );

        console.log('\n✅ Done!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error deleting test cases:', error);
        process.exit(1);
    }
}

deleteTestCases();
