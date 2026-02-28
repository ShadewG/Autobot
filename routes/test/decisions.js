const express = require('express');
const router = express.Router();
const {
    db, notionService, safeJsonParse, normalizePortalEvents,
    extractUrls, normalizePortalUrl, isSupportedPortalUrl,
    detectPortalProviderByUrl, generateQueue, portalQueue,
    transitionCaseRuntime
} = require('./_helpers');

/**
 * Human review queue
 */
router.get('/human-reviews', async (req, res) => {
    try {
        const reviews = await db.getHumanReviewCases(100);
        const enriched = reviews.map((item) => ({
            ...item,
            last_portal_details: safeJsonParse(item.last_portal_details),
            portal_events: normalizePortalEvents(item.portal_events)
        }));
        res.json({
            success: true,
            cases: enriched
        });
    } catch (error) {
        console.error('Error fetching human review cases:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

router.post('/human-reviews/:caseId/decision', async (req, res) => {
    try {
        const caseId = parseInt(req.params.caseId, 10);
        const { action, note, next_status } = req.body || {};

        if (!['approve', 'reject', 'change'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: 'action must be approve, reject, or change'
            });
        }

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Case not found'
            });
        }

        const urlsFromNote = note ? extractUrls(note) : [];
        let portalUrlFromNote = null;
        let portalProviderFromNote = null;

        for (const rawUrl of urlsFromNote || []) {
            const normalized = normalizePortalUrl(rawUrl);
            if (normalized && isSupportedPortalUrl(normalized)) {
                portalUrlFromNote = normalized;
                const provider = detectPortalProviderByUrl(normalized);
                portalProviderFromNote = provider?.name || 'Manual Portal';
                break;
            }
        }

        let newStatus = caseData.status;
        let substatus = caseData.substatus || '';

        const priorPortalFlag = (caseData.substatus || '').toLowerCase().includes('portal_submission');
        const portalNeeded = priorPortalFlag || !!portalUrlFromNote;

        if (action === 'approve') {
            if (portalNeeded) {
                newStatus = 'portal_in_progress';
                substatus = note ? `Portal submission queued: ${note}` : 'Portal submission queued';
            } else {
                newStatus = next_status || 'ready_to_send';
                substatus = note ? `Approved: ${note}` : 'Approved by human reviewer';
            }
        } else if (action === 'reject') {
            newStatus = next_status || 'needs_manual_processing';
            substatus = note ? `Rejected: ${note}` : 'Rejected by human reviewer';
        } else if (action === 'change') {
            newStatus = next_status || caseData.status;
            substatus = note ? `Change requested: ${note}` : 'Human requested changes';
        }

        if (portalUrlFromNote) {
            await db.updateCasePortalStatus(caseId, {
                portal_url: portalUrlFromNote,
                portal_provider: portalProviderFromNote
            });

            await db.logActivity('portal_link_added', 'Portal link provided via human review', {
                case_id: caseId,
                portal_url: portalUrlFromNote,
                portal_provider: portalProviderFromNote
            });
        }

        const ESCALATION_STATUSES = new Set(['needs_human_review', 'needs_phone_call', 'pending_fee_decision', 'needs_rebuttal']);

        if (newStatus === 'portal_in_progress') {
            await transitionCaseRuntime(caseId, 'PORTAL_STARTED', { substatus });
        } else if (newStatus === 'needs_human_fee_approval') {
            await transitionCaseRuntime(caseId, 'FEE_QUOTE_RECEIVED', { substatus });
        } else if (ESCALATION_STATUSES.has(newStatus)) {
            await transitionCaseRuntime(caseId, 'CASE_ESCALATED', {
                targetStatus: newStatus,
                substatus,
                pauseReason: newStatus === 'pending_fee_decision' ? 'FEE_DECISION_NEEDED' : 'UNSPECIFIED',
            });
        } else {
            await transitionCaseRuntime(caseId, 'CASE_RECONCILED', {
                targetStatus: newStatus,
                substatus,
            });
        }
        const updatedCase = await db.getCaseById(caseId);
        await notionService.syncStatusToNotion(caseId);

        await db.logActivity('human_review_decision', `Human review ${action} for ${caseData.case_name}`, {
            case_id: caseId,
            action,
            note,
            next_status: newStatus
        });

        if (action === 'approve') {
            if (portalNeeded) {
                if (updatedCase.portal_url) {
                    console.log(`✅ Human approval -> queueing portal submission for case ${caseId}`);
                    await portalQueue.add('portal-submit', {
                        caseId
                    }, {
                        attempts: 2,
                        backoff: {
                            type: 'exponential',
                            delay: 5000
                        }
                    });
                } else {
                    console.warn(`⚠️ Portal submission approved for case ${caseId} but no portal URL is saved.`);
                }
            } else if (!updatedCase.send_date) {
                console.log(`✅ Human approval -> queueing case ${caseId} for generation`);
                await generateQueue.add('generate-foia', { caseId });
            }
        }

        res.json({
            success: true,
            case_id: caseId,
            status: newStatus
        });
    } catch (error) {
        console.error('Error recording human review decision:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Get agent decisions (for dashboard)
 * GET /api/test/agent/decisions
 */
router.get('/agent/decisions', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                ad.id,
                ad.case_id,
                c.case_name,
                ad.reasoning,
                ad.action_taken,
                ad.confidence,
                ad.created_at
            FROM agent_decisions ad
            LEFT JOIN cases c ON ad.case_id = c.id
            ORDER BY ad.created_at DESC
            LIMIT 20
        `);

        res.json({
            success: true,
            decisions: result.rows
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Get escalations (for dashboard)
 * GET /api/test/agent/escalations
 */
router.get('/agent/escalations', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                e.id,
                e.case_id,
                c.case_name,
                e.reason,
                e.urgency,
                e.suggested_action,
                e.status,
                e.created_at
            FROM escalations e
            LEFT JOIN cases c ON e.case_id = c.id
            WHERE e.status = 'pending'
            ORDER BY
                CASE e.urgency
                    WHEN 'high' THEN 1
                    WHEN 'medium' THEN 2
                    WHEN 'low' THEN 3
                END,
                e.created_at DESC
            LIMIT 20
        `);

        res.json({
            success: true,
            escalations: result.rows
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Chat endpoint for testing AI responses
 * POST /api/test/chat
 */
router.post('/chat', async (req, res) => {
    try {
        const { scenario, systemPrompt, conversationHistory } = req.body;

        if (!conversationHistory || !Array.isArray(conversationHistory)) {
            return res.status(400).json({
                success: false,
                error: 'conversationHistory is required'
            });
        }

        // Use OpenAI for chat testing
        const OpenAI = require('openai');
        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });

        const response = await openai.chat.completions.create({
            model: 'gpt-5.2-2025-12-11',
            messages: [
                { role: 'system', content: systemPrompt || 'You are a helpful FOIA assistant.' },
                ...conversationHistory
            ],
            temperature: 0.7,
            max_tokens: 500
        });

        const aiResponse = response.choices[0]?.message?.content;

        if (!aiResponse) {
            throw new Error('No response from AI');
        }

        res.json({
            success: true,
            response: aiResponse,
            scenario: scenario
        });

    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
