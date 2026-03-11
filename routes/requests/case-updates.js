const express = require('express');
const router = express.Router();
const { db, generateOutcomeSummary, parseScopeItems, toRequestDetail } = require('./_helpers');

/**
 * PATCH /api/requests/:id
 * Update case fields
 */
router.patch('/:id', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const updates = {};

        // Allowed fields for update
        if (req.body.autopilot_mode) {
            if (!['AUTO', 'SUPERVISED', 'MANUAL'].includes(req.body.autopilot_mode)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid autopilot_mode. Must be AUTO, SUPERVISED, or MANUAL'
                });
            }
            updates.autopilot_mode = req.body.autopilot_mode;
        }

        if (req.body.requires_human !== undefined) {
            updates.requires_human = req.body.requires_human;
        }

        if (req.body.pause_reason !== undefined) {
            const validReasons = ['FEE_QUOTE', 'SCOPE', 'DENIAL', 'ID_REQUIRED', 'SENSITIVE', 'CLOSE_ACTION', 'RESEARCH_HANDOFF', null];
            if (!validReasons.includes(req.body.pause_reason)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid pause_reason'
                });
            }
            updates.pause_reason = req.body.pause_reason;
        }

        if (req.body.next_due_at !== undefined) {
            updates.next_due_at = req.body.next_due_at;
        }

        if (req.body.portal_url !== undefined) {
            updates.portal_url = req.body.portal_url || null;
        }

        if (req.body.portal_provider !== undefined) {
            updates.portal_provider = req.body.portal_provider || null;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No valid fields to update'
            });
        }

        const updatedCase = await db.updateCase(requestId, updates);

        if (!updatedCase) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        res.json({
            success: true,
            request: toRequestDetail(updatedCase)
        });
    } catch (error) {
        console.error('Error updating request:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * PATCH /api/requests/:id/scope-items/:itemIndex
 * Update a scope item's status (for manually setting Unknown items)
 */
router.patch('/:id/scope-items/:itemIndex', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const itemIndex = parseInt(req.params.itemIndex);
        const { status, reason } = req.body;

        // Validate status
        const validStatuses = ['REQUESTED', 'PENDING', 'CONFIRMED_AVAILABLE', 'NOT_DISCLOSABLE', 'NOT_HELD'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        // Get case
        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Parse current scope items
        let scopeItems = parseScopeItems(caseData);

        // Validate index
        if (itemIndex < 0 || itemIndex >= scopeItems.length) {
            return res.status(400).json({
                success: false,
                error: `Invalid item index. Must be between 0 and ${scopeItems.length - 1}`
            });
        }

        // Update the item
        scopeItems[itemIndex] = {
            ...scopeItems[itemIndex],
            status: status,
            reason: reason || scopeItems[itemIndex].reason || `Manually set to ${status}`,
            updated_at: new Date().toISOString(),
            updated_by: 'human'
        };

        // Save back to database
        await db.updateCase(requestId, {
            scope_items_jsonb: JSON.stringify(scopeItems)
        });

        // Log activity
        await db.logActivity('scope_item_updated', `Scope item "${scopeItems[itemIndex].name}" status set to ${status}`, {
            case_id: requestId,
            item_index: itemIndex,
            item_name: scopeItems[itemIndex].name,
            new_status: status,
            reason: reason,
            actor_type: 'human',
            source_service: 'dashboard',
        });

        res.json({
            success: true,
            message: 'Scope item updated',
            scope_items: scopeItems
        });
    } catch (error) {
        console.error('Error updating scope item:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/mark-bugged
 * Mark a case as bugged so the team can investigate later
 */
router.post('/:id/mark-bugged', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const { description } = req.body;

        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Request not found' });
        }

        const previousStatus = caseData.status;

        await db.updateCaseStatus(requestId, 'bugged', {
            pause_reason: 'BUG_REPORTED',
        });

        // Dismiss pending proposals so the case leaves the approval queue
        try {
            await db.dismissPendingProposals(requestId, 'Case marked as bugged');
        } catch (_) {}

        // Cancel active agent runs so no in-flight task can change the status back
        try {
            await db.query(
                `UPDATE agent_runs SET status = 'failed', error = 'case_marked_bugged', ended_at = NOW()
                 WHERE case_id = $1 AND status IN ('created', 'queued', 'processing', 'running', 'paused', 'waiting')`,
                [requestId]
            );
        } catch (_) {}

        // Cancel active portal tasks
        try {
            await db.query(
                `UPDATE portal_tasks SET status = 'CANCELLED', updated_at = NOW()
                 WHERE case_id = $1 AND status IN ('PENDING', 'IN_PROGRESS')`,
                [requestId]
            );
        } catch (_) {}

        await db.logActivity('case_marked_bugged', `Case marked as bugged: ${description || 'No description'}`, {
            case_id: requestId,
            previous_status: previousStatus,
            description: description || null,
            actor_type: 'human',
            source_service: 'dashboard',
        });

        // Also create a feedback entry linked to this case
        if (description) {
            await db.query(
                `INSERT INTO user_feedback (type, title, description, case_id, created_by, created_by_email, priority)
                 VALUES ('bug_report', $1, $2, $3, $4, $5, 'high')`,
                [
                    `Case #${requestId} bugged: ${caseData.agency_name || 'Unknown'}`.slice(0, 200),
                    description,
                    requestId,
                    req.user?.id || null,
                    req.user?.email || null,
                ]
            );
        }

        res.json({ success: true, message: 'Case marked as bugged' });
    } catch (error) {
        console.error('Error marking case as bugged:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
