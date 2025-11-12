/**
 * Test the stuck response detector
 * Manually trigger to see if it catches case 42 and other stuck responses
 */
require('dotenv').config();
const stuckResponseDetector = require('./services/stuck-response-detector');

async function testDetector() {
    try {
        console.log('🧪 Testing stuck response detector...\n');

        const result = await stuckResponseDetector.detectAndFlagStuckResponses();

        console.log('\n📊 Results:');
        console.log(`   Flagged: ${result.flagged} case(s)`);

        if (result.cases && result.cases.length > 0) {
            console.log(`   Case IDs: ${result.cases.join(', ')}`);
        }

        process.exit(0);
    } catch (error) {
        console.error('❌ Error testing detector:', error);
        process.exit(1);
    }
}

testDetector();
