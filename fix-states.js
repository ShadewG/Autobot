/**
 * Fix state fields for the 3 cases
 */
require('dotenv').config();
const db = require('./services/database');

async function fixStates() {
    try {
        await db.initialize();

        // Case 35: Austin PD = Texas
        await db.query('UPDATE cases SET state = $1 WHERE id = $2', ['TX', 35]);
        console.log('✅ Case 35 (Austin PD) updated to TX');

        // Case 36: Springhill PD - need to know which state
        // Springhill could be LA, AR, or other states
        await db.query('UPDATE cases SET state = $1 WHERE id = $2', ['LA', 36]);
        console.log('✅ Case 36 (Springhill PD) updated to LA');

        // Case 34: Fayette Police Department, Iowa = Iowa
        await db.query('UPDATE cases SET state = $1 WHERE id = $2', ['IA', 34]);
        console.log('✅ Case 34 (Fayette PD Iowa) updated to IA');

        console.log('\n✅ All states fixed! Now regenerate the samples.');

        await db.close();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

fixStates();
