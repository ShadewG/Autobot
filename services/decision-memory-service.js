/**
 * Decision Memory Service
 *
 * Operational memory for AI decision-making. Stores lessons learned from
 * outcomes and manually-added rules. Queried before the AI makes decisions
 * to inject relevant context into prompts.
 *
 * Two sources:
 *   - 'manual': Human-added rules (e.g., "never propose SUBMIT_PORTAL for denials")
 *   - 'auto':   Learned from outcomes (e.g., "portal failed 3x for Odessa PD")
 */

const db = require('./database');
const logger = require('./logger');

class DecisionMemoryService {

    /**
     * Get lessons relevant to a case context.
     * Returns lessons matching the case's situation, ordered by priority.
     */
    async getRelevantLessons(caseData, { messages = [], priorProposals = [], limit = 10 } = {}) {
        try {
            // Build context keywords from the case
            const keywords = this._extractKeywords(caseData, messages, priorProposals);

            // Get all active lessons
            const result = await db.query(`
                SELECT id, category, trigger_pattern, lesson, priority, source
                FROM ai_decision_lessons
                WHERE active = true
                ORDER BY priority DESC, times_applied DESC
            `);

            // Score each lesson by relevance to current context
            const scored = result.rows.map(lesson => {
                const score = this._scoreLessonRelevance(lesson, keywords, caseData, priorProposals);
                return { ...lesson, relevance_score: score };
            })
            .filter(l => l.relevance_score > 0)
            .sort((a, b) => (b.priority * b.relevance_score) - (a.priority * a.relevance_score))
            .slice(0, limit);

            // Increment times_applied for matched lessons
            if (scored.length > 0) {
                const ids = scored.map(l => l.id);
                await db.query(
                    `UPDATE ai_decision_lessons SET times_applied = times_applied + 1, updated_at = NOW() WHERE id = ANY($1)`,
                    [ids]
                ).catch(() => {}); // fire-and-forget
            }

            return scored;
        } catch (error) {
            logger.error('Error fetching decision lessons:', error.message);
            return [];
        }
    }

    /**
     * Format lessons into a prompt-injection block for the AI.
     */
    formatLessonsForPrompt(lessons) {
        if (!lessons || lessons.length === 0) return '';

        const lines = lessons.map((l, i) =>
            `${i + 1}. [${l.category.toUpperCase()}] ${l.lesson}`
        );

        return `\nLESSONS FROM EXPERIENCE (follow these strictly):\n${lines.join('\n')}\n`;
    }

    /**
     * Auto-learn a lesson from a decision outcome.
     * Called when a proposal is dismissed, a portal fails, etc.
     */
    async learnFromOutcome({ category, triggerPattern, lesson, sourceCaseId, priority = 5 }) {
        try {
            // Check for duplicate (same category + similar trigger)
            const existing = await db.query(
                `SELECT id FROM ai_decision_lessons WHERE category = $1 AND trigger_pattern = $2 AND active = true`,
                [category, triggerPattern]
            );
            if (existing.rows.length > 0) {
                // Boost priority of existing lesson
                await db.query(
                    `UPDATE ai_decision_lessons SET priority = LEAST(priority + 1, 10), updated_at = NOW() WHERE id = $1`,
                    [existing.rows[0].id]
                );
                return existing.rows[0].id;
            }

            const result = await db.query(`
                INSERT INTO ai_decision_lessons (category, trigger_pattern, lesson, source, source_case_id, priority)
                VALUES ($1, $2, $3, 'auto', $4, $5)
                RETURNING id
            `, [category, triggerPattern, lesson, sourceCaseId, priority]);

            logger.info('Auto-learned new lesson', { id: result.rows[0].id, category, triggerPattern });
            return result.rows[0].id;
        } catch (error) {
            logger.error('Error auto-learning lesson:', error.message);
            return null;
        }
    }

    /**
     * Add a manual lesson (human-provided rule).
     */
    async addManualLesson({ category, triggerPattern, lesson, priority = 7 }) {
        const result = await db.query(`
            INSERT INTO ai_decision_lessons (category, trigger_pattern, lesson, source, priority)
            VALUES ($1, $2, $3, 'manual', $4)
            RETURNING *
        `, [category, triggerPattern, lesson, priority]);
        return result.rows[0];
    }

    /**
     * List all lessons (for admin UI).
     */
    async listLessons({ activeOnly = true } = {}) {
        const where = activeOnly ? 'WHERE active = true' : '';
        const result = await db.query(`SELECT * FROM ai_decision_lessons ${where} ORDER BY priority DESC, created_at DESC`);
        return result.rows;
    }

    /**
     * Update a lesson.
     */
    async updateLesson(id, updates) {
        const fields = [];
        const values = [];
        let idx = 1;
        for (const [key, value] of Object.entries(updates)) {
            if (['category', 'trigger_pattern', 'lesson', 'priority', 'active'].includes(key)) {
                fields.push(`${key} = $${idx++}`);
                values.push(value);
            }
        }
        if (fields.length === 0) return null;
        fields.push(`updated_at = NOW()`);
        values.push(id);
        const result = await db.query(
            `UPDATE ai_decision_lessons SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );
        return result.rows[0];
    }

    /**
     * Delete a lesson.
     */
    async deleteLesson(id) {
        await db.query('DELETE FROM ai_decision_lessons WHERE id = $1', [id]);
    }

    // ---- Internal helpers ----

    _extractKeywords(caseData, messages, priorProposals) {
        const keywords = new Set();

        // From case
        if (caseData.status) keywords.add(caseData.status);
        if (caseData.portal_url) keywords.add('has_portal');
        if (!caseData.portal_url) keywords.add('no_portal');
        if (caseData.agency_name) keywords.add(caseData.agency_name.toLowerCase());
        if (caseData.substatus) {
            caseData.substatus.toLowerCase().split(/\s+/).forEach(w => keywords.add(w));
        }
        if (caseData.followup_count > 0) keywords.add('has_followups');
        if (caseData.followup_count >= 2) keywords.add('multiple_followups');
        if (caseData.last_fee_quote_amount) {
            keywords.add('has_fee_quote');
            if (caseData.last_fee_quote_amount > 500) keywords.add('high_fee');
        }
        // Check if requested_records include BWC/video
        const reqRecords = (Array.isArray(caseData.requested_records) ? caseData.requested_records.join(' ') : (caseData.requested_records || '')).toLowerCase();
        if (reqRecords.includes('body cam') || reqRecords.includes('bodycam') || reqRecords.includes('bwc') || reqRecords.includes('body worn') || reqRecords.includes('video')) {
            keywords.add('bwc_involved');
        }

        // From messages — detect denials, fees, etc.
        for (const m of (messages || []).slice(0, 5)) {
            const text = ((m.body_text || '') + ' ' + (m.subject || '')).toLowerCase();
            if (text.includes('denied') || text.includes('denial') || text.includes('unable to release')) keywords.add('denial');
            if (text.includes('ongoing investigation') || text.includes('active investigation')) keywords.add('ongoing_investigation');
            if (text.includes('privacy') || text.includes('exemption')) keywords.add('privacy_exemption');
            if (text.includes('fee') || text.includes('cost') || text.includes('payment')) keywords.add('fee');
            if (text.includes('portal') || text.includes('nextrequest') || text.includes('govqa')) keywords.add('portal');
            if (text.includes('no responsive') || text.includes('no records')) keywords.add('no_records');
            if (text.includes('resubmit') || text.includes('submit through')) keywords.add('portal_redirect');
            if (text.includes('too broad') || text.includes('overly broad') || text.includes('narrow your request') || text.includes('narrow the scope')) keywords.add('overly_broad');
            if (text.includes('wrong agency') || text.includes('not our jurisdiction') || text.includes('incorrect agency') || text.includes('not our department') || text.includes('contact the')) keywords.add('wrong_agency');
            if (text.includes('retention') || text.includes('destroyed') || text.includes('purged') || text.includes('no longer maintain')) keywords.add('retention_expired');
            if (text.includes('hostile') || text.includes('stop contacting') || text.includes('harassment') || text.includes('cease')) keywords.add('hostile');
            if (text.includes('partial') || text.includes('some records') || text.includes('released') || text.includes('withheld') || text.includes('redacted')) keywords.add('partial_approval');
            if (text.includes('received your request') || text.includes('acknowledge') || text.includes('we will respond') || text.includes('working on your request')) keywords.add('acknowledgment');
            if (text.includes('clarif') || text.includes('additional information') || text.includes('please provide') || text.includes('more details')) keywords.add('clarification_request');
            if (text.includes('waiver') || text.includes('public interest') || text.includes('media') || text.includes('journalist') || text.includes('documentary')) keywords.add('fee_waiver_eligible');
            if (text.includes('appeal') || text.includes('administrative review') || text.includes('attorney general')) keywords.add('appeal');
            if (text.includes('segregab') || text.includes('non-exempt portion') || text.includes('releasable portion')) keywords.add('segregable');
            if (text.includes('excessive') || text.includes('unreasonable') || text.includes('prohibitive')) keywords.add('excessive_fee');
            if (text.includes('forward') || text.includes('transferred') || text.includes('refer')) keywords.add('forwarded');
            if (text.includes('download') || text.includes('attached') || text.includes('records ready') || text.includes('available for pickup')) keywords.add('records_ready');
            if (text.includes('duplicate') || text.includes('already submitted') || text.includes('previously received')) keywords.add('duplicate_request');
            if (text.includes('body cam') || text.includes('body-cam') || text.includes('bodycam') || text.includes('bwc') || text.includes('body worn') || text.includes('body-worn')) keywords.add('bwc_involved');
            if ((text.includes('body cam') || text.includes('bodycam') || text.includes('bwc') || text.includes('body worn') || text.includes('video')) && (text.includes('denied') || text.includes('withheld') || text.includes('exempt') || text.includes('unable to release'))) keywords.add('bwc_denied');
        }

        // From prior proposals
        const dismissedActions = new Set();
        for (const p of (priorProposals || [])) {
            if (p.status === 'DISMISSED') {
                dismissedActions.add(p.action_type);
                keywords.add('dismissed_' + (p.action_type || '').toLowerCase());
            }
            if (p.status === 'EXECUTED' || p.status === 'APPROVED') {
                keywords.add('tried_' + (p.action_type || '').toLowerCase());
            }
        }
        if (dismissedActions.size >= 2) keywords.add('multiple_dismissals');

        return keywords;
    }

    _scoreLessonRelevance(lesson, keywords, caseData, priorProposals) {
        const trigger = lesson.trigger_pattern.toLowerCase();
        let score = 0;

        // Direct keyword matches in trigger
        for (const kw of keywords) {
            if (trigger.includes(kw)) score += 2;
        }

        // Category match bonus
        if (lesson.category === 'general') score += 1;
        if (lesson.category === 'denial' && keywords.has('denial')) score += 3;
        if (lesson.category === 'portal' && (keywords.has('has_portal') || keywords.has('portal'))) score += 3;
        if (lesson.category === 'fee' && keywords.has('fee')) score += 3;
        if (lesson.category === 'followup' && caseData.status === 'awaiting_response') score += 3;
        if (lesson.category === 'bwc' && (keywords.has('bwc_involved') || keywords.has('bwc_denied'))) score += 5;

        return score;
    }
}

module.exports = new DecisionMemoryService();
