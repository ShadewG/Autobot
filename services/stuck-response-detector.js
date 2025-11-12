/**
 * Stuck Response Detector Service
 *
 * Monitors for cases stuck in "responded" status and auto-flags them for human review
 * This is a critical fallback for when the analysis queue fails
 */

const db = require('./database');
const notionService = require('./notion-service');
const discordService = require('./discord-service');

// How long a case can sit in "responded" before we flag it (in hours)
const STUCK_THRESHOLD_HOURS = 2;

class StuckResponseDetector {
    /**
     * Find and flag cases that have been in "responded" status too long
     */
    async detectAndFlagStuckResponses() {
        try {
            console.log(`\n🔍 Checking for stuck responses (threshold: ${STUCK_THRESHOLD_HOURS} hours)...`);

            // Find cases in "responded" status for more than threshold hours
            const query = `
                SELECT c.id, c.case_name, c.status, c.last_response_date,
                       EXTRACT(EPOCH FROM (NOW() - c.last_response_date))/3600 AS hours_stuck
                FROM cases c
                WHERE c.status = 'responded'
                  AND c.last_response_date IS NOT NULL
                  AND c.last_response_date < NOW() - INTERVAL '${STUCK_THRESHOLD_HOURS} hours'
                ORDER BY c.last_response_date ASC
            `;

            const result = await db.query(query);

            if (result.rows.length === 0) {
                console.log('✅ No stuck responses found');
                return { flagged: 0 };
            }

            console.log(`⚠️  Found ${result.rows.length} stuck response(s):\n`);

            for (const caseData of result.rows) {
                console.log(`  Case ${caseData.id}: ${caseData.case_name}`);
                console.log(`    Stuck for: ${Math.round(caseData.hours_stuck)} hours`);

                // Check if there's an analysis record - if not, the analysis queue definitely failed
                const analysisCheck = await db.query(
                    `SELECT id FROM analyses
                     WHERE case_id = $1
                     ORDER BY created_at DESC
                     LIMIT 1`,
                    [caseData.id]
                );

                const hasAnalysis = analysisCheck.rows.length > 0;
                const reason = hasAnalysis
                    ? `Response received but stuck in processing for ${Math.round(caseData.hours_stuck)} hours`
                    : `Analysis queue failed - no analysis record found after ${Math.round(caseData.hours_stuck)} hours`;

                // Flag for human review
                await db.updateCaseStatus(caseData.id, 'needs_human_review', {
                    substatus: 'Stuck response - auto-flagged by monitoring system',
                    escalation_reason: reason
                });

                // Sync to Notion
                await notionService.syncStatusToNotion(caseData.id);

                // Log activity
                await db.logActivity(
                    'stuck_response_detected',
                    `Case auto-flagged: ${reason}`,
                    { case_id: caseData.id, hours_stuck: Math.round(caseData.hours_stuck) }
                );

                // Notify Discord
                try {
                    await discordService.notifyStuckResponse(caseData, Math.round(caseData.hours_stuck));
                } catch (discordError) {
                    console.error(`Failed to notify Discord for case ${caseData.id}:`, discordError.message);
                }

                console.log(`    ✅ Flagged for human review\n`);
            }

            return {
                flagged: result.rows.length,
                cases: result.rows.map(r => r.id)
            };
        } catch (error) {
            console.error('Error in stuck response detector:', error);
            throw error;
        }
    }
}

module.exports = new StuckResponseDetector();
