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
            const validReasons = ['FEE_QUOTE', 'SCOPE', 'DENIAL', 'ID_REQUIRED', 'SENSITIVE', 'CLOSE_ACTION', null];
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
            reason: reason
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

module.exports = router;
