const express = require('express');
const router = express.Router();

/**
 * GET /api/monitor/lessons
 * List AI decision lessons
 */
router.get('/lessons', async (req, res) => {
    try {
        const decisionMemory = require('../../services/decision-memory-service');
        const lessons = await decisionMemory.listLessons({ activeOnly: req.query.active !== 'false' });
        res.json({ success: true, lessons });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/lessons
 * Create a new AI decision lesson
 */
router.post('/lessons', async (req, res) => {
    try {
        const decisionMemory = require('../../services/decision-memory-service');
        const { category, trigger_pattern, lesson, priority } = req.body;
        if (!category || !trigger_pattern || !lesson) {
            return res.status(400).json({ success: false, error: 'category, trigger_pattern, and lesson are required' });
        }
        const created = await decisionMemory.addManualLesson({
            category, triggerPattern: trigger_pattern, lesson, priority: priority || 7
        });
        res.json({ success: true, lesson: created });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PUT /api/monitor/lessons/:id
 * Update an existing AI decision lesson
 */
router.put('/lessons/:id', async (req, res) => {
    try {
        const decisionMemory = require('../../services/decision-memory-service');
        const updated = await decisionMemory.updateLesson(parseInt(req.params.id), req.body);
        res.json({ success: true, lesson: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/lessons/parse
 * AI-powered: translate natural language into a structured lesson
 */
router.post('/lessons/parse', express.json(), async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || !text.trim()) {
            return res.status(400).json({ success: false, error: 'text is required' });
        }

        const Anthropic = require('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const response = await anthropic.messages.create({
            model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            system: `You translate natural language instructions into structured AI decision lessons for a FOIA (Freedom of Information Act) case management system.

The system processes agency responses and decides actions. Lessons teach the AI how to handle specific situations.

Available action types (use the CODE, not the label):
- SEND_INITIAL_REQUEST — Send the first FOIA request to an agency
- SEND_FOLLOWUP — Send a follow-up when no response received
- SEND_REBUTTAL — Challenge a denial with legal arguments
- SEND_CLARIFICATION — Respond to agency asking for more info
- RESPOND_PARTIAL_APPROVAL — Accept released records + challenge withheld ones
- ACCEPT_FEE — Agree to pay a quoted fee
- NEGOTIATE_FEE — Counter-offer or request fee waiver
- DECLINE_FEE — Reject fee and explain why
- ESCALATE — Flag for human review
- RESEARCH_AGENCY — Find the correct agency/contact info
- REFORMULATE_REQUEST — Rewrite the request differently
- SUBMIT_PORTAL — Submit via an online portal instead of email
- CLOSE_CASE — Mark case as done
- WITHDRAW — Cancel/withdraw the request
- NONE — No action needed

Available categories: denial, portal, fee, followup, agency, general

Available denial subtypes: no_records, ongoing_investigation, privacy_exemption, overly_broad, excessive_fees, wrong_agency, retention_expired, format_issue

Respond with ONLY a JSON object:
{
  "category": "one of: denial, portal, fee, followup, agency, general",
  "trigger_pattern": "space-separated keywords that would match this scenario",
  "lesson": "Precise instruction for the AI, referencing the action type code. e.g. 'When agency cites ongoing investigation exemption, propose SEND_REBUTTAL requesting segregable non-exempt portions under state FOIA law.'",
  "priority": 1-10 (10 = highest, default 7),
  "recommended_action": "the primary ACTION_TYPE code this lesson recommends"
}`,
            messages: [{ role: 'user', content: text.trim() }]
        });

        const raw = response.content[0].text.trim();
        // Extract JSON from response (handle markdown code blocks)
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return res.status(422).json({ success: false, error: 'AI could not parse the lesson', raw });
        }

        const parsed = JSON.parse(jsonMatch[0]);
        res.json({ success: true, parsed });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/monitor/lessons/:id
 * Delete an AI decision lesson
 */
router.delete('/lessons/:id', async (req, res) => {
    try {
        const decisionMemory = require('../../services/decision-memory-service');
        await decisionMemory.deleteLesson(parseInt(req.params.id));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
