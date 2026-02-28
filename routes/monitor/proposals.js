const express = require('express');
const router = express.Router();
const {
    db,
    processProposalDecision
} = require('./_helpers');

/**
 * POST /api/monitor/proposals/:id/approve
 * Convenience wrapper to approve a proposal
 */
router.post('/proposals/:id/approve', express.json(), async (req, res) => {
    try {
        const proposalId = parseInt(req.params.id);
        const userId = req.headers['x-user-id'] || null;
        const result = await processProposalDecision(proposalId, 'APPROVE', { userId });
        res.status(202).json(result);
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json({ success: false, error: error.message, ...(error.payload || {}) });
    }
});

/**
 * POST /api/monitor/proposals/:id/decision
 * Unified proposal decisions from monitor (APPROVE|ADJUST|DISMISS)
 */
router.post('/proposals/:id/decision', express.json(), async (req, res) => {
    try {
        const proposalId = parseInt(req.params.id);
        const { action, instruction = null, reason = null, dismiss_reason = null, route_mode = null } = req.body || {};
        const userId = req.headers['x-user-id'] || null;
        const result = await processProposalDecision(proposalId, action, { instruction, reason: reason || dismiss_reason, route_mode, userId });
        res.status(action === 'DISMISS' ? 200 : 202).json(result);
    } catch (error) {
        const status = error.status || 500;
        res.status(status).json({ success: false, error: error.message, ...(error.payload || {}) });
    }
});

/**
 * POST /api/monitor/proposals/:id/generate-draft
 * Generate draft content for a proposal that has no draft (e.g., from reprocessing)
 */
router.post('/proposals/:id/generate-draft', express.json(), async (req, res) => {
    try {
        const proposalId = parseInt(req.params.id);
        const proposal = await db.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
        if (!proposal.rows[0]) {
            return res.status(404).json({ success: false, error: 'Proposal not found' });
        }
        const p = proposal.rows[0];

        if (p.draft_body_text) {
            return res.status(400).json({ success: false, error: 'Proposal already has draft content' });
        }

        const aiService = require('../../services/ai-service');
        const caseData = await db.getCaseById(p.case_id);
        const latestInbound = p.trigger_message_id ? await db.getMessageById(p.trigger_message_id) : null;
        const latestAnalysis = latestInbound ? await db.getResponseAnalysisByMessageId(latestInbound.id) : null;

        let draft = { subject: null, body_text: null, body_html: null };
        const actionType = p.action_type;

        if (actionType === 'SEND_FOLLOWUP' || actionType === 'SEND_STATUS_UPDATE') {
            const followup = await db.getFollowUpScheduleByCaseId(p.case_id);
            draft = await aiService.generateFollowUp(caseData, (followup?.followup_count || 0) + 1, {});
        } else if (actionType === 'SEND_REBUTTAL' || actionType === 'SEND_APPEAL') {
            draft = await aiService.generateDenialRebuttal(latestInbound, latestAnalysis, caseData, {
                scopeItems: p.metadata?.scope_items || [],
            });
        } else if (actionType === 'ACCEPT_FEE' || actionType === 'NEGOTIATE_FEE' || actionType === 'DECLINE_FEE' || actionType === 'SEND_FEE_WAIVER_REQUEST') {
            const feeAmt = p.metadata?.fee_amount || caseData.fee_amount || 0;
            const actionMap = { ACCEPT_FEE: 'accept', NEGOTIATE_FEE: 'negotiate', DECLINE_FEE: 'decline', SEND_FEE_WAIVER_REQUEST: 'waiver' };
            draft = await aiService.generateFeeResponse(caseData, { feeAmount: feeAmt, recommendedAction: actionMap[actionType], agencyMessage: latestInbound, agencyAnalysis: latestAnalysis });
        } else if (actionType === 'SEND_CLARIFICATION') {
            draft = await aiService.generateAutoReply(latestInbound, latestAnalysis, caseData);
        } else {
            return res.status(400).json({ success: false, error: `Draft generation not supported for action type: ${actionType}` });
        }

        if (!draft.body_text && !draft.subject) {
            return res.status(500).json({ success: false, error: 'Draft generation returned empty content' });
        }

        // Update the proposal with the generated draft
        await db.query(`
            UPDATE proposals
            SET draft_subject = $1, draft_body_text = $2, draft_body_html = $3, updated_at = NOW()
            WHERE id = $4
        `, [draft.subject || null, draft.body_text || null, draft.body_html || null, proposalId]);

        res.json({
            success: true,
            draft: {
                subject: draft.subject,
                body_text: draft.body_text,
                body_html: draft.body_html
            }
        });
    } catch (error) {
        console.error('Generate draft error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
