const express = require('express');
const router = express.Router();
const db = require('../services/database');

/**
 * Status mapping from database to API format (UPPER_SNAKE_CASE)
 */
const STATUS_MAP = {
    'draft': 'DRAFT',
    'ready_to_send': 'READY_TO_SEND',
    'sent': 'AWAITING_RESPONSE',
    'awaiting_response': 'AWAITING_RESPONSE',
    'responded': 'RECEIVED_RESPONSE',
    'completed': 'CLOSED',
    'error': 'NEEDS_HUMAN_REVIEW',
    'needs_human_review': 'NEEDS_HUMAN_REVIEW',
    'needs_contact_info': 'NEEDS_HUMAN_REVIEW',
    'needs_human_fee_approval': 'NEEDS_HUMAN_REVIEW',
    'portal_in_progress': 'AWAITING_RESPONSE'
};

/**
 * Derive cost_status from fee fields (supports both legacy columns and JSONB)
 */
function deriveCostStatus(caseData) {
    // Check JSONB first
    if (caseData.fee_quote_jsonb?.status) {
        return caseData.fee_quote_jsonb.status;
    }
    // Fall back to legacy columns
    if (!caseData.last_fee_quote_amount) return 'NONE';
    return 'QUOTED';
}

/**
 * Build due_info object from case data
 */
function buildDueInfo(caseData) {
    const dueInfo = caseData.due_info_jsonb || {};
    const nextDueAt = caseData.next_due_at || caseData.deadline_date;

    // Calculate overdue status
    let isOverdue = false;
    let overdueDays = null;
    if (nextDueAt) {
        const dueDate = new Date(nextDueAt);
        const now = new Date();
        if (dueDate < now) {
            isOverdue = true;
            overdueDays = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
        }
    }

    return {
        next_due_at: nextDueAt || null,
        due_type: dueInfo.due_type || (caseData.deadline_date ? 'STATUTORY' : null),
        statutory_days: dueInfo.statutory_days || null,
        statutory_due_at: dueInfo.statutory_due_at || caseData.deadline_date || null,
        snoozed_until: dueInfo.snoozed_until || null,
        is_overdue: isOverdue,
        overdue_days: overdueDays
    };
}

/**
 * Parse scope items from JSONB or derive from requested_records
 */
function parseScopeItems(caseData) {
    // Use JSONB if available
    if (caseData.scope_items_jsonb && Array.isArray(caseData.scope_items_jsonb) && caseData.scope_items_jsonb.length > 0) {
        return caseData.scope_items_jsonb;
    }

    // Derive from requested_records array
    if (Array.isArray(caseData.requested_records)) {
        return caseData.requested_records.map(name => ({
            name,
            status: 'REQUESTED'
        }));
    }

    return [];
}

/**
 * Parse constraints from JSONB
 */
function parseConstraints(caseData) {
    if (caseData.constraints_jsonb && Array.isArray(caseData.constraints_jsonb)) {
        return caseData.constraints_jsonb;
    }
    return [];
}

/**
 * Parse fee quote from JSONB or legacy columns
 */
function parseFeeQuote(caseData) {
    // Use JSONB if available
    if (caseData.fee_quote_jsonb && caseData.fee_quote_jsonb.amount) {
        return caseData.fee_quote_jsonb;
    }

    // Fall back to legacy columns
    if (caseData.last_fee_quote_amount) {
        return {
            amount: parseFloat(caseData.last_fee_quote_amount),
            currency: caseData.last_fee_quote_currency || 'USD',
            quoted_at: caseData.last_fee_quote_at,
            status: 'QUOTED'
        };
    }

    return null;
}

/**
 * Check if request is at risk (due within 48 hours)
 */
function isAtRisk(nextDueAt) {
    if (!nextDueAt) return false;
    const dueDate = new Date(nextDueAt);
    const now = new Date();
    const hoursUntilDue = (dueDate - now) / (1000 * 60 * 60);
    return hoursUntilDue <= 48 && hoursUntilDue > 0;
}

/**
 * Transform case data to RequestListItem format
 */
function toRequestListItem(caseData) {
    const subject = caseData.subject_name
        ? `${caseData.subject_name}${caseData.requested_records?.length ? ` — ${Array.isArray(caseData.requested_records) ? caseData.requested_records.slice(0, 2).join(', ') : 'Records Request'}` : ''}`
        : caseData.case_name || 'Unknown Request';

    const dueInfo = buildDueInfo(caseData);
    const feeQuote = parseFeeQuote(caseData);

    return {
        id: String(caseData.id),
        subject: subject,
        agency_name: caseData.agency_name || '—',
        state: caseData.state || '—',
        status: STATUS_MAP[caseData.status] || 'DRAFT',
        last_inbound_at: caseData.last_response_date || null,
        last_activity_at: caseData.updated_at || caseData.created_at,
        next_due_at: dueInfo.next_due_at,
        due_info: dueInfo,
        requires_human: caseData.requires_human || false,
        pause_reason: caseData.pause_reason || null,
        autopilot_mode: caseData.autopilot_mode || 'SUPERVISED',
        cost_status: deriveCostStatus(caseData),
        cost_amount: feeQuote?.amount || null,
        at_risk: isAtRisk(dueInfo.next_due_at)
    };
}

/**
 * Transform case data to RequestDetail format
 */
function toRequestDetail(caseData) {
    const listItem = toRequestListItem(caseData);
    const scopeItems = parseScopeItems(caseData);
    const constraints = parseConstraints(caseData);
    const feeQuote = parseFeeQuote(caseData);

    return {
        ...listItem,
        case_name: caseData.case_name,
        incident_date: caseData.incident_date || null,
        incident_location: caseData.incident_location || null,
        requested_records: Array.isArray(caseData.requested_records)
            ? caseData.requested_records.join(', ')
            : caseData.requested_records || '',
        additional_details: caseData.additional_details || null,
        scope_summary: Array.isArray(caseData.requested_records)
            ? caseData.requested_records.slice(0, 3).join(', ')
            : caseData.requested_records || 'General records request',
        scope_items: scopeItems,
        constraints: constraints,
        fee_quote: feeQuote,
        portal_url: caseData.portal_url || null,
        portal_provider: caseData.portal_provider || null,
        submitted_at: caseData.send_date || null,
        statutory_due_at: listItem.due_info.statutory_due_at,
        attachments: [] // Will be populated from messages
    };
}

/**
 * Transform message to ThreadMessage format
 */
function toThreadMessage(message) {
    return {
        id: String(message.id),
        direction: message.direction === 'outbound' ? 'OUTBOUND' : 'INBOUND',
        channel: message.portal_notification ? 'PORTAL' : 'EMAIL',
        from_email: message.from_email || '—',
        to_email: message.to_email || '—',
        subject: message.subject || '(No subject)',
        body: message.body_text || message.body_html || '',
        sent_at: message.sent_at || message.received_at || message.created_at,
        attachments: []
    };
}

/**
 * Map event types to categories
 */
const EVENT_CATEGORY_MAP = {
    'email_sent': 'MESSAGE',
    'email_received': 'MESSAGE',
    'case_created': 'STATUS',
    'followup_scheduled': 'STATUS',
    'fee_quote_received': 'COST',
    'denial_received': 'GATE',
    'portal_submission': 'AGENT',
    'portal_task_started': 'AGENT',
    'portal_task_completed': 'AGENT',
    'portal_task_failed': 'AGENT',
    'gate_triggered': 'GATE',
    'constraint_detected': 'RESEARCH',
    'scope_updated': 'STATUS'
};

/**
 * Transform activity log to TimelineEvent format
 */
function toTimelineEvent(activity, analysisMap = {}) {
    const typeMap = {
        'email_sent': 'SENT',
        'email_received': 'RECEIVED',
        'case_created': 'CREATED',
        'followup_scheduled': 'FOLLOW_UP',
        'fee_quote_received': 'FEE_QUOTE',
        'denial_received': 'DENIAL',
        'portal_submission': 'PORTAL_TASK',
        'portal_task_started': 'PORTAL_TASK',
        'portal_task_completed': 'PORTAL_TASK',
        'portal_task_failed': 'PORTAL_TASK',
        'gate_triggered': 'GATE_TRIGGERED',
        'constraint_detected': 'CONSTRAINT_DETECTED',
        'scope_updated': 'SCOPE_UPDATED',
        'proposal_queued': 'PROPOSAL_QUEUED',
        'human_decision': 'HUMAN_DECISION'
    };

    // Extract meta from meta_jsonb if available
    const meta = activity.meta_jsonb || activity.metadata || {};

    const event = {
        id: String(activity.id),
        timestamp: activity.created_at,
        type: typeMap[activity.event_type] || 'CREATED',
        summary: activity.description || activity.event_type,
        category: meta.category || EVENT_CATEGORY_MAP[activity.event_type] || 'STATUS',
        raw_content: meta.raw_content || activity.metadata?.raw_content || null
    };

    // Add classification if present
    if (meta.classification) {
        event.classification = meta.classification;
    }

    // Add gate details if present
    if (meta.gate_details) {
        event.gate_details = meta.gate_details;
    }

    // Add AI audit from meta or from analysis
    if (meta.ai_audit) {
        event.ai_audit = meta.ai_audit;
    } else if (activity.message_id && analysisMap[activity.message_id]) {
        const analysis = analysisMap[activity.message_id];
        event.ai_audit = {
            summary: analysis.key_points || [],
            confidence: analysis.confidence_score ? parseFloat(analysis.confidence_score) : null,
            risk_flags: analysis.requires_action ? ['Requires Action'] : [],
            statute_matches: analysis.full_analysis_json?.statute_matches || null,
            citations: analysis.full_analysis_json?.citations || null
        };
    }

    return event;
}

/**
 * GET /api/requests
 * List requests with filters
 */
router.get('/', async (req, res) => {
    try {
        const { requires_human, status, agency_id, q } = req.query;

        let query = `
            SELECT c.*
            FROM cases c
            WHERE 1=1
        `;
        const params = [];

        // Filter by requires_human
        if (requires_human === 'true') {
            params.push(true);
            query += ` AND c.requires_human = $${params.length}`;
        } else if (requires_human === 'false') {
            params.push(false);
            query += ` AND (c.requires_human = $${params.length} OR c.requires_human IS NULL)`;
        }

        // Filter by status (map from API format to DB format)
        if (status) {
            const dbStatuses = Object.entries(STATUS_MAP)
                .filter(([_, v]) => v === status)
                .map(([k]) => k);
            if (dbStatuses.length > 0) {
                params.push(dbStatuses);
                query += ` AND c.status = ANY($${params.length})`;
            }
        }

        // Search by subject/agency name (V1: simple ILIKE)
        if (q) {
            params.push(`%${q}%`);
            query += ` AND (c.subject_name ILIKE $${params.length} OR c.agency_name ILIKE $${params.length} OR c.case_name ILIKE $${params.length})`;
        }

        // Sort: requires_human first (by next_due_at), then by last_activity
        query += `
            ORDER BY
                c.requires_human DESC NULLS LAST,
                CASE WHEN c.requires_human = true THEN c.next_due_at END ASC NULLS LAST,
                c.updated_at DESC
            LIMIT 500
        `;

        const result = await db.query(query, params);
        const requests = result.rows.map(toRequestListItem);

        // Separate into paused and ongoing for client convenience
        const paused = requests.filter(r => r.requires_human);
        const ongoing = requests.filter(r => !r.requires_human);

        res.json({
            success: true,
            count: requests.length,
            paused_count: paused.length,
            ongoing_count: ongoing.length,
            requests
        });
    } catch (error) {
        console.error('Error fetching requests:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/requests/:id
 * Get single request details
 */
router.get('/:id', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const caseData = await db.getCaseById(requestId);

        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        res.json({
            success: true,
            request: toRequestDetail(caseData)
        });
    } catch (error) {
        console.error('Error fetching request:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/requests/:id/workspace
 * Get combined detail for request workspace (single fetch)
 */
router.get('/:id/workspace', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);

        // Fetch case data
        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Fetch thread and messages
        const thread = await db.getThreadByCaseId(requestId);
        let threadMessages = [];
        let analysisMap = {};

        if (thread) {
            const messages = await db.getMessagesByThreadId(thread.id);
            threadMessages = messages.map(toThreadMessage);

            // Fetch analysis for all inbound messages
            for (const msg of messages.filter(m => m.direction === 'inbound')) {
                const analysis = await db.getAnalysisByMessageId(msg.id);
                if (analysis) {
                    analysisMap[msg.id] = analysis;
                }
            }
        }

        // Fetch activity log for timeline events
        const activityResult = await db.query(
            `SELECT * FROM activity_log
             WHERE case_id = $1
             ORDER BY created_at DESC
             LIMIT 50`,
            [requestId]
        );
        const timelineEvents = activityResult.rows.map(a => toTimelineEvent(a, analysisMap));

        // Build next action proposal from latest pending reply
        let nextActionProposal = null;
        const latestPendingReply = await db.query(
            `SELECT * FROM auto_reply_queue
             WHERE case_id = $1 AND status = 'pending'
             ORDER BY created_at DESC
             LIMIT 1`,
            [requestId]
        );

        if (latestPendingReply.rows.length > 0) {
            const reply = latestPendingReply.rows[0];

            // Parse JSONB fields with fallbacks
            const reasoning = reply.reasoning_jsonb || ['AI-generated response to agency message'];
            const warnings = reply.warnings_jsonb || [];
            const constraintsApplied = reply.constraints_applied_jsonb || [];

            nextActionProposal = {
                id: String(reply.id),
                action_type: reply.action_type || 'SEND_EMAIL',
                proposal: reply.proposal_short || `Send ${reply.response_type || 'auto'} reply`,
                proposal_short: reply.proposal_short,
                reasoning: Array.isArray(reasoning) ? reasoning : [reasoning],
                confidence: reply.confidence_score ? parseFloat(reply.confidence_score) : 0.8,
                risk_flags: reply.requires_approval ? ['Requires Approval'] : [],
                warnings: Array.isArray(warnings) ? warnings : [],
                can_auto_execute: !reply.requires_approval,
                blocked_reason: reply.blocked_reason || (reply.requires_approval ? 'Requires human approval' : null),
                draft_content: reply.generated_reply,
                draft_preview: reply.generated_reply ? reply.generated_reply.substring(0, 200) : null,
                constraints_applied: Array.isArray(constraintsApplied) ? constraintsApplied : []
            };
        }

        // Build agency summary with rules
        // Note: In a full implementation, these rules would come from an agencies table
        // For now, we derive some from case context or use defaults
        const feeQuote = parseFeeQuote(caseData);
        const constraints = parseConstraints(caseData);

        const agencySummary = {
            id: String(requestId), // Use case ID as placeholder since we don't have agency table
            name: caseData.agency_name || '—',
            state: caseData.state || '—',
            submission_method: caseData.portal_url ? 'PORTAL' : 'EMAIL',
            portal_url: caseData.portal_url || undefined,
            default_autopilot_mode: caseData.autopilot_mode || 'SUPERVISED',
            notes: caseData.contact_research_notes || undefined,
            // Agency rules (derived or default - in full implementation these would be stored)
            rules: {
                fee_auto_approve_threshold: 50.00, // Default threshold
                always_human_gates: ['DENIAL', 'SENSITIVE'], // Default gates requiring human
                known_exemptions: constraints
                    .filter(c => c.type === 'EXEMPTION')
                    .map(c => c.description),
                typical_response_days: null // Would come from agency stats
            }
        };

        res.json({
            success: true,
            request: toRequestDetail(caseData),
            timeline_events: timelineEvents,
            thread_messages: threadMessages,
            next_action_proposal: nextActionProposal,
            agency_summary: agencySummary
        });
    } catch (error) {
        console.error('Error fetching request workspace:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * PATCH /api/requests/:id
 * Update request fields (autopilot_mode, etc.)
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
 * POST /api/requests/:id/actions/approve
 * Approve a pending action (e.g., send auto-reply)
 */
router.post('/:id/actions/approve', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const { action_id } = req.body;

        // Find the pending reply
        const replyResult = await db.query(
            `SELECT * FROM auto_reply_queue
             WHERE case_id = $1 AND status = 'pending'
             ${action_id ? 'AND id = $2' : ''}
             ORDER BY created_at DESC
             LIMIT 1`,
            action_id ? [requestId, parseInt(action_id)] : [requestId]
        );

        if (replyResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No pending action found'
            });
        }

        const reply = replyResult.rows[0];

        // Get the original message to reply to
        const message = await db.getMessageById(reply.message_id);
        const caseData = await db.getCaseById(requestId);

        if (!message || !caseData) {
            return res.status(404).json({
                success: false,
                error: 'Message or case not found'
            });
        }

        // Queue the email for sending
        const { emailQueue } = require('../queues/email-queue');
        await emailQueue.add('send-auto-reply', {
            type: 'auto_reply',
            caseId: requestId,
            toEmail: message.from_email,
            subject: message.subject,
            content: reply.generated_reply,
            originalMessageId: message.message_id
        });

        // Update reply status
        await db.updateAutoReplyQueueEntry(reply.id, {
            status: 'approved',
            approved_at: new Date()
        });

        // Clear requires_human if this was the blocking action
        await db.updateCase(requestId, {
            requires_human: false,
            pause_reason: null
        });

        res.json({
            success: true,
            message: 'Action approved and queued for sending'
        });
    } catch (error) {
        console.error('Error approving action:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/actions/revise
 * Ask AI to revise a draft
 */
router.post('/:id/actions/revise', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const { instruction, action_id } = req.body;

        if (!instruction) {
            return res.status(400).json({
                success: false,
                error: 'instruction is required'
            });
        }

        // Find the pending reply to revise
        const replyResult = await db.query(
            `SELECT * FROM auto_reply_queue
             WHERE case_id = $1 AND status = 'pending'
             ${action_id ? 'AND id = $2' : ''}
             ORDER BY created_at DESC
             LIMIT 1`,
            action_id ? [requestId, parseInt(action_id)] : [requestId]
        );

        if (replyResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No pending action found to revise'
            });
        }

        const reply = replyResult.rows[0];
        const caseData = await db.getCaseById(requestId);
        const message = await db.getMessageById(reply.message_id);

        // Use OpenAI to revise the draft
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const revisionPrompt = `You are helping revise a FOIA request response.

Original draft:
${reply.generated_reply}

User instruction for revision:
${instruction}

Context:
- Agency: ${caseData.agency_name}
- Original message subject: ${message?.subject || 'N/A'}

Please provide the revised response following the user's instruction. Only output the revised response text, no explanations.`;

        const completion = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: 'You are a professional FOIA request assistant helping revise correspondence with government agencies.'
                },
                {
                    role: 'user',
                    content: revisionPrompt
                }
            ],
            max_tokens: 1000
        });

        const revisedContent = completion.choices[0].message.content;

        // Update the reply with revised content
        const updatedReply = await db.updateAutoReplyQueueEntry(reply.id, {
            generated_reply: revisedContent,
            last_regenerated_at: new Date(),
            metadata: JSON.stringify({
                ...JSON.parse(reply.metadata || '{}'),
                revision_instruction: instruction,
                revised_at: new Date().toISOString()
            })
        });

        // Parse JSONB fields from updated reply
        const reasoning = updatedReply.reasoning_jsonb || ['Revised based on your instruction', instruction];
        const warnings = updatedReply.warnings_jsonb || [];
        const constraintsApplied = updatedReply.constraints_applied_jsonb || [];

        // Return updated next action
        const nextAction = {
            id: String(updatedReply.id),
            action_type: updatedReply.action_type || 'SEND_EMAIL',
            proposal: updatedReply.proposal_short || `Send ${updatedReply.response_type || 'auto'} reply`,
            proposal_short: updatedReply.proposal_short,
            reasoning: Array.isArray(reasoning) ? reasoning : [reasoning],
            confidence: updatedReply.confidence_score ? parseFloat(updatedReply.confidence_score) : 0.8,
            risk_flags: updatedReply.requires_approval ? ['Requires Approval'] : [],
            warnings: Array.isArray(warnings) ? warnings : [],
            can_auto_execute: !updatedReply.requires_approval,
            blocked_reason: updatedReply.blocked_reason || (updatedReply.requires_approval ? 'Requires human approval' : null),
            draft_content: revisedContent,
            draft_preview: revisedContent ? revisedContent.substring(0, 200) : null,
            constraints_applied: Array.isArray(constraintsApplied) ? constraintsApplied : []
        };

        res.json({
            success: true,
            next_action_proposal: nextAction
        });
    } catch (error) {
        console.error('Error revising action:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/actions/dismiss
 * Dismiss a pending action
 */
router.post('/:id/actions/dismiss', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const { action_id } = req.body;

        const replyResult = await db.query(
            `SELECT * FROM auto_reply_queue
             WHERE case_id = $1 AND status = 'pending'
             ${action_id ? 'AND id = $2' : ''}
             ORDER BY created_at DESC
             LIMIT 1`,
            action_id ? [requestId, parseInt(action_id)] : [requestId]
        );

        if (replyResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No pending action found'
            });
        }

        await db.updateAutoReplyQueueEntry(replyResult.rows[0].id, {
            status: 'rejected'
        });

        res.json({
            success: true,
            message: 'Action dismissed'
        });
    } catch (error) {
        console.error('Error dismissing action:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
