const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../services/database');
const actionValidator = require('../services/action-validator');
const logger = require('../services/logger');
const { cleanEmailBody, htmlToPlainText } = require('../lib/email-cleaner');

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
    'portal_in_progress': 'AWAITING_RESPONSE',
    'id_state': 'ID_STATE'
};

/**
 * Generate AI outcome summary when a case is closed.
 * Summarizes what happened, why it was closed, and the result.
 */
async function generateOutcomeSummary(caseId, caseData, closeInstruction) {
    try {
        const messages = await db.getMessagesByCaseId(caseId);
        const proposals = await db.getAllProposalsByCaseId(caseId);

        const inboundCount = messages.filter(m => m.direction === 'inbound').length;
        const outboundCount = messages.filter(m => m.direction === 'outbound').length;
        const lastInbound = messages.filter(m => m.direction === 'inbound').pop();

        // Build outcome context
        const parts = [];
        parts.push(`Agency: ${caseData.agency_name || 'Unknown'} (${caseData.state || '?'})`);
        parts.push(`Subject: ${caseData.subject_name || caseData.case_name || 'Unknown'}`);
        parts.push(`Records requested: ${Array.isArray(caseData.requested_records) ? caseData.requested_records.join(', ') : caseData.requested_records || 'Unknown'}`);
        parts.push(`Messages: ${outboundCount} sent, ${inboundCount} received`);

        if (caseData.outcome_type) {
            parts.push(`Outcome: ${caseData.outcome_type.replace(/_/g, ' ')}`);
        }

        if (caseData.fee_quote_jsonb?.amount) {
            parts.push(`Fee: $${caseData.fee_quote_jsonb.amount}`);
        }

        if (lastInbound?.body_text) {
            const preview = lastInbound.body_text.substring(0, 300);
            parts.push(`Last agency response: ${preview}`);
        }

        if (closeInstruction) {
            parts.push(`Close reason: ${closeInstruction}`);
        }

        // Use OpenAI to generate a concise summary
        const OpenAI = require('openai');
        const openai = new OpenAI();
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{
                role: 'system',
                content: 'You summarize the outcome of FOIA/public records requests in 1-2 sentences. Be specific about what happened (records received, denied, fee quoted, no response, etc). Do not use generic language.'
            }, {
                role: 'user',
                content: parts.join('\n')
            }],
            max_tokens: 150,
        });

        const summary = completion.choices[0]?.message?.content?.trim();
        if (summary) {
            await db.updateCase(caseId, { outcome_summary: summary });

            // Sync summary to Notion
            try {
                const notionService = require('../services/notion-service');
                await notionService.addAISummaryToNotion(caseId, summary);
            } catch (_) {}
        }
    } catch (err) {
        console.error(`Failed to generate outcome summary for case ${caseId}:`, err.message);
    }
}

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
 * Normalizes format to use 'name' (frontend expects 'name', some backend uses 'item')
 */
function parseScopeItems(caseData) {
    // Use JSONB if available
    if (caseData.scope_items_jsonb && Array.isArray(caseData.scope_items_jsonb) && caseData.scope_items_jsonb.length > 0) {
        // Normalize: some sources use 'item', frontend expects 'name'
        return caseData.scope_items_jsonb.map(si => ({
            name: si.name || si.item || 'Unknown Item',
            status: si.status || 'REQUESTED',
            reason: si.reason || null,
            confidence: si.confidence
        }));
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
 * Parse constraints from JSONB.
 * Normalizes both plain string constraints (legacy) and full objects
 * into { type, description, source, confidence, affected_items } shape.
 */
// Known constraint types with human-readable labels
const CONSTRAINT_LABELS = {
    FEE_REQUIRED: 'Fee payment required',
    PREPAYMENT_REQUIRED: 'Prepayment required before records are released',
    CASH_OR_CHECK_ONLY: 'Payment by cash or check only',
    CERTIFICATION_REQUIRED: 'Certification or notarized statement required',
    CERTIFICATION_NO_FINANCIAL_GAIN_REQUIRED: 'Must certify records are not for financial gain',
    NO_FINANCIAL_GAIN_CERT_REQUIRED: 'Must certify records are not for financial gain',
    CERTIFICATION_REQUIRED_NONCOMMERCIAL_USE: 'Must certify non-commercial use of records',
    EXEMPTION: 'Agency claimed an exemption',
    BWC_EXEMPT: 'Body-worn camera footage exempt',
    NOT_HELD: 'Agency states records are not held',
    RECORDS_NOT_HELD: 'Agency states records are not held',
    REDACTION_REQUIRED: 'Records require redaction before release',
    ID_REQUIRED: 'Photo ID or identity verification required',
    INVESTIGATION_ACTIVE: 'Active investigation — records may be delayed or withheld',
    PARTIAL_DENIAL: 'Some records denied, others may be available',
    DENIAL_RECEIVED: 'Agency denied the request',
    IN_PERSON_VIEWING_OPTION: 'In-person viewing/inspection available',
    IN_PERSON_INSPECTION_OPTION: 'In-person viewing/inspection available',
    VIEW_IN_PERSON_OPTION: 'In-person viewing/inspection available',
    SCOPE_NARROWING_SUGGESTED: 'Agency suggests narrowing scope',
    SCOPE_NARROW_SUGGESTED: 'Agency suggests narrowing scope',
    SCOPE_NARROWING_OPTION: 'Agency suggests narrowing scope',
    RESPONSE_DEADLINE: 'Response deadline applies',
    DEADLINE_10_BUSINESS_DAYS: 'Must respond within 10 business days',
    RESPONSE_DEADLINE_10_BUSINESS_DAYS: 'Must respond within 10 business days',
    WITHDRAWAL_IF_NO_RESPONSE_10_BUSINESS_DAYS: 'Auto-withdrawal after 10 business days without response',
    AUTO_WITHDRAW_10_BUSINESS_DAYS: 'Auto-withdrawal after 10 business days without response',
    FEE_ESTIMATE_PROVIDED: 'Fee estimate provided',
};

// Collapse duplicate/variant constraint types to a canonical form
const CONSTRAINT_CANONICAL = {
    RECORDS_NOT_HELD: 'NOT_HELD',
    NO_FINANCIAL_GAIN_CERT_REQUIRED: 'CERTIFICATION_NO_FINANCIAL_GAIN_REQUIRED',
    CERTIFICATION_REQUIRED_NONCOMMERCIAL_USE: 'CERTIFICATION_NO_FINANCIAL_GAIN_REQUIRED',
    IN_PERSON_INSPECTION_OPTION: 'IN_PERSON_VIEWING_OPTION',
    VIEW_IN_PERSON_OPTION: 'IN_PERSON_VIEWING_OPTION',
    SCOPE_NARROW_SUGGESTED: 'SCOPE_NARROWING_SUGGESTED',
    SCOPE_NARROWING_OPTION: 'SCOPE_NARROWING_SUGGESTED',
    DEADLINE_10_BUSINESS_DAYS: 'RESPONSE_DEADLINE_10_BUSINESS_DAYS',
    RESPONSE_DEADLINE: 'RESPONSE_DEADLINE_10_BUSINESS_DAYS',
    AUTO_WITHDRAW_10_BUSINESS_DAYS: 'WITHDRAWAL_IF_NO_RESPONSE_10_BUSINESS_DAYS',
    FEE_ESTIMATE_PROVIDED: 'FEE_REQUIRED', // redundant when FEE_REQUIRED is present
};

function parseConstraints(caseData) {
    if (!caseData.constraints_jsonb || !Array.isArray(caseData.constraints_jsonb)) {
        return [];
    }

    const seen = new Set();
    const results = [];

    for (const c of caseData.constraints_jsonb) {
        let constraint;
        if (c && typeof c === 'object' && c.type) {
            constraint = c;
        } else {
            const type = typeof c === 'string' ? c : 'UNKNOWN';
            constraint = {
                type,
                description: CONSTRAINT_LABELS[type] || type.replace(/_/g, ' ').toLowerCase(),
                source: 'Agency response',
                confidence: 1.0,
                affected_items: [],
            };
        }

        // Canonicalize to collapse duplicates
        const canonical = CONSTRAINT_CANONICAL[constraint.type] || constraint.type;
        if (seen.has(canonical)) continue;
        seen.add(canonical);

        // Use canonical type's label if available
        constraint.type = canonical;
        if (CONSTRAINT_LABELS[canonical]) {
            constraint.description = CONSTRAINT_LABELS[canonical];
        }

        results.push(constraint);
    }

    return results;
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
        at_risk: isAtRisk(dueInfo.next_due_at),
        outcome_type: caseData.outcome_type || null,
        outcome_summary: caseData.outcome_summary || null,
        closed_at: caseData.closed_at || null,
        substatus: caseData.substatus || null
    };
}

/**
 * Detect review reason from case data when requires_human is true.
 * Uses pause_reason first, then infers from substatus/status.
 */
function detectReviewReason(caseData) {
    // Map pause_reason directly if set
    const pauseReason = (caseData.pause_reason || '').toUpperCase();
    if (pauseReason === 'FEE_QUOTE') return 'FEE_QUOTE';
    if (pauseReason === 'DENIAL') return 'DENIAL';

    const substatus = (caseData.substatus || '').toLowerCase();
    const status = (caseData.status || '').toLowerCase();

    // Portal stuck/timeout indicators (swept from portal_in_progress)
    if (substatus.includes('portal') && substatus.includes('timed out')) return 'PORTAL_STUCK';

    // Portal failure indicators
    if (substatus.includes('portal') && (substatus.includes('fail') || substatus.includes('error'))) return 'PORTAL_FAILED';
    if (status === 'error' && caseData.portal_url) return 'PORTAL_FAILED';

    // Fee quote indicators
    if (substatus.includes('fee') || substatus.includes('quote') || substatus.includes('cost')) return 'FEE_QUOTE';
    if (caseData.last_fee_quote_amount) return 'FEE_QUOTE';

    // Denial indicators
    if (substatus.includes('denial') || substatus.includes('denied') || substatus.includes('reject')) return 'DENIAL';

    // Missing info indicators
    if (substatus.includes('missing') || substatus.includes('contact') || substatus.includes('info')) return 'MISSING_INFO';
    if (status === 'needs_contact_info') return 'MISSING_INFO';

    return 'GENERAL';
}

/**
 * Transform case data to RequestDetail format
 */
function toRequestDetail(caseData) {
    const listItem = toRequestListItem(caseData);
    const scopeItems = parseScopeItems(caseData);
    const constraints = parseConstraints(caseData);
    const feeQuote = parseFeeQuote(caseData);

    // Build Notion URL from page ID
    const notionUrl = caseData.notion_page_id
        ? `https://notion.so/${caseData.notion_page_id.replace(/-/g, '')}`
        : null;

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
        portal_request_number: caseData.portal_request_number || null,
        last_portal_task_url: caseData.last_portal_task_url || null,
        last_portal_status: caseData.last_portal_status || null,
        notion_url: notionUrl,
        submitted_at: caseData.send_date || null,
        statutory_due_at: listItem.due_info.statutory_due_at,
        attachments: [], // Will be populated from messages
        substatus: caseData.substatus || null,
        review_reason: caseData.requires_human
            ? detectReviewReason(caseData)
            : undefined
    };
}

/**
 * Transform message to ThreadMessage format
 * Includes cleaned body (boilerplate removed) and raw_body (original)
 */
function toThreadMessage(message) {
    // Prefer body_text; fall back to body_html converted to plain text
    const rawBody = message.body_text || (message.body_html ? htmlToPlainText(message.body_html) : '');
    const cleanedBody = cleanEmailBody(rawBody);
    const timestamp = message.sent_at || message.received_at || message.created_at;

    return {
        id: message.id,  // Numeric ID for API calls
        direction: message.direction === 'outbound' ? 'OUTBOUND' : 'INBOUND',
        channel: message.portal_notification ? 'PORTAL' : 'EMAIL',
        from_email: message.from_email || '—',
        to_email: message.to_email || '—',
        subject: message.subject || '(No subject)',
        body: cleanedBody,
        raw_body: rawBody !== cleanedBody ? rawBody : undefined,
        sent_at: timestamp,
        timestamp: timestamp,  // Alias for convenience
        processed_at: message.processed_at || null,  // When this message was processed by the agent
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
 * Calculate business days between two dates
 */
function businessDaysDiff(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    let count = 0;
    const current = new Date(start);

    while (current < end) {
        const dayOfWeek = current.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            count++;
        }
        current.setDate(current.getDate() + 1);
    }

    return count;
}

/**
 * Build deadline milestones for the timeline
 */
function buildDeadlineMilestones(caseData, timelineEvents, stateDeadline) {
    const milestones = [];

    // Submitted milestone
    if (caseData.send_date) {
        milestones.push({
            date: caseData.send_date,
            type: 'SUBMITTED',
            label: 'Submitted'
        });
    }

    // Acknowledgment milestone (from timeline events)
    const ackEvent = timelineEvents.find(e =>
        e.classification?.type === 'ACKNOWLEDGMENT' ||
        e.type === 'RECEIVED' && e.summary?.toLowerCase().includes('acknowledg')
    );
    if (ackEvent && caseData.send_date) {
        const days = businessDaysDiff(caseData.send_date, ackEvent.timestamp);
        milestones.push({
            date: ackEvent.timestamp,
            type: 'ACKNOWLEDGED',
            label: 'Acknowledged',
            days_from_prior: days,
            is_met: days <= 3, // Typical acknowledgment deadline
            statutory_limit: 3
        });
    }

    // Fee quote milestone
    if (caseData.fee_quote_jsonb?.quoted_at) {
        const priorDate = ackEvent?.timestamp || caseData.send_date;
        const days = priorDate ? businessDaysDiff(priorDate, caseData.fee_quote_jsonb.quoted_at) : null;
        milestones.push({
            date: caseData.fee_quote_jsonb.quoted_at,
            type: 'FEE_QUOTED',
            label: 'Fee Quote Received',
            days_from_prior: days
        });
    }

    // Statutory due date
    if (caseData.deadline_date) {
        milestones.push({
            date: caseData.deadline_date,
            type: 'STATUTORY_DUE',
            label: `Statutory Due (${stateDeadline?.response_days || '?'} days)`,
            citation: stateDeadline?.statute_citation,
            statutory_limit: stateDeadline?.response_days
        });
    }

    return milestones;
}

/**
 * GET /api/requests
 * List requests with filters
 */
router.get('/', async (req, res) => {
    try {
        const { requires_human, status, agency_id, q } = req.query;

        const includeCompleted = req.query.include_completed === 'true';

        let query = `
            SELECT c.*
            FROM cases c
            WHERE 1=1
        `;
        const params = [];

        // Exclude completed/cancelled cases from main view unless explicitly requested
        if (!includeCompleted && !status) {
            query += ` AND c.status NOT IN ('completed', 'cancelled')`;
        }

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

        // Fetch completed cases separately (most recent 50)
        const completedResult = await db.query(`
            SELECT c.* FROM cases c
            WHERE c.status IN ('completed', 'cancelled')
            ORDER BY c.closed_at DESC NULLS LAST, c.updated_at DESC
            LIMIT 50
        `);
        const completed = completedResult.rows.map(toRequestListItem);

        // Separate into paused and ongoing for client convenience
        const paused = requests.filter(r => r.requires_human);
        const ongoing = requests.filter(r => !r.requires_human);

        res.json({
            success: true,
            count: requests.length,
            paused_count: paused.length,
            ongoing_count: ongoing.length,
            completed_count: completed.length,
            requests,
            completed
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

            // Fetch analysis for all inbound messages first
            for (const msg of messages.filter(m => m.direction === 'inbound')) {
                const analysis = await db.getAnalysisByMessageId(msg.id);
                if (analysis) {
                    analysisMap[msg.id] = analysis;
                }
            }

            // Build thread messages with analysis data attached
            threadMessages = messages.map(msg => {
                const tm = toThreadMessage(msg);
                const analysis = analysisMap[msg.id];
                if (analysis) {
                    tm.classification = analysis.intent || null;
                    tm.summary = Array.isArray(analysis.key_points)
                        ? analysis.key_points.join('; ')
                        : (analysis.key_points || null);
                    tm.sentiment = analysis.sentiment || null;
                }
                return tm;
            });
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

        // Build state deadline info (static data - would come from state_deadlines table)
        const STATE_DEADLINES = {
            SC: { state_code: 'SC', response_days: 10, statute_citation: 'SC Code § 30-4-30(c): 10 business days' },
            NC: { state_code: 'NC', response_days: 10, statute_citation: 'NC G.S. § 132-6(a): 10 working days' },
            GA: { state_code: 'GA', response_days: 3, statute_citation: 'O.C.G.A. § 50-18-71(b)(1)(A): 3 business days' },
            FL: { state_code: 'FL', response_days: 5, statute_citation: 'Fla. Stat. § 119.07(1)(c): Prompt response' },
            TX: { state_code: 'TX', response_days: 10, statute_citation: 'Tex. Gov\'t Code § 552.221(a): 10 business days' },
            VA: { state_code: 'VA', response_days: 5, statute_citation: 'Va. Code § 2.2-3704(B): 5 working days' },
            OK: { state_code: 'OK', response_days: 3, statute_citation: '51 O.S. § 24A.5(5): Prompt response' },
            TN: { state_code: 'TN', response_days: 7, statute_citation: 'Tenn. Code § 10-7-503(a)(2)(B): 7 business days' },
            AL: { state_code: 'AL', response_days: 5, statute_citation: 'No statutory deadline - reasonable time' },
            MS: { state_code: 'MS', response_days: 7, statute_citation: 'Miss. Code § 25-61-5: 7 working days' },
        };

        const stateDeadline = STATE_DEADLINES[caseData.state?.toUpperCase()] || null;
        const deadlineMilestones = buildDeadlineMilestones(caseData, timelineEvents, stateDeadline);

        // Fetch latest pending Trigger.dev proposal (not from auto_reply_queue)
        const pendingProposalResult = await db.query(`
            SELECT id, action_type, status, draft_subject, draft_body_text, reasoning, waitpoint_token, pause_reason
            FROM proposals
            WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'BLOCKED')
            ORDER BY created_at DESC
            LIMIT 1
        `, [requestId]);
        const pendingProposal = pendingProposalResult.rows[0] || null;

        res.json({
            success: true,
            request: toRequestDetail(caseData),
            timeline_events: timelineEvents,
            thread_messages: threadMessages,
            next_action_proposal: nextActionProposal,
            agency_summary: agencySummary,
            deadline_milestones: deadlineMilestones,
            state_deadline: stateDeadline,
            pending_proposal: pendingProposal
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
 * POST /api/requests/:id/research-exemption
 * Research counterarguments for an exemption claim
 */
router.post('/:id/research-exemption', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const { constraint_index } = req.body;

        if (constraint_index === undefined) {
            return res.status(400).json({
                success: false,
                error: 'constraint_index is required'
            });
        }

        // Fetch case data
        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Get constraints
        const constraints = parseConstraints(caseData);
        const constraint = constraints[constraint_index];

        if (!constraint) {
            return res.status(404).json({
                success: false,
                error: 'Constraint not found at specified index'
            });
        }

        // Build research prompt
        const prompt = `Research counterarguments to this FOIA exemption claim:

State: ${caseData.state}
Agency Claim: "${constraint.description}"
Legal Basis: ${constraint.source || 'Not specified'}
Records Affected: ${constraint.affected_items?.join(', ') || 'Not specified'}

Please research and provide:
1. Known exceptions to this exemption
2. Recent court cases that limited or overturned similar exemptions
3. Procedural failures the agency might have made
4. Alternative arguments for record disclosure
5. Questions to ask the agency for clarification

Be specific to ${caseData.state} law where possible.`;

        // Call OpenAI for research
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const completion = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
            messages: [
                {
                    role: 'system',
                    content: 'You are a legal research assistant specializing in FOIA/public records law. Provide specific, actionable research to help challenge exemption claims. Cite specific statutes and cases where possible.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: 2000
        });

        const researchContent = completion.choices[0].message.content;

        // Store research results in constraint (optional - could update constraints_jsonb)
        const researchResults = {
            searched_at: new Date().toISOString(),
            content: researchContent,
            constraint_description: constraint.description
        };

        // Log activity
        await db.logActivity('exemption_researched', `Researched exemption claim: "${constraint.description}"`, {
            case_id: requestId,
            constraint_index: constraint_index,
            state: caseData.state
        });

        res.json({
            success: true,
            research: researchResults
        });
    } catch (error) {
        console.error('Error researching exemption:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/withdraw
 * Withdraw/close a FOIA request
 */
router.post('/:id/withdraw', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const { reason } = req.body;
    const log = logger.forCase(requestId);

    try {
        // Verify case exists
        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        log.info(`Withdrawing request: ${reason || 'No reason given'}`);

        // Update case to closed/withdrawn status
        await db.updateCase(requestId, {
            status: 'completed',
            requires_human: false,
            pause_reason: null,
            autopilot_mode: 'MANUAL'
        });

        // Log the withdrawal activity
        await db.logActivity('request_withdrawn', `Request withdrawn: ${reason || 'No reason given'}`, {
            case_id: requestId,
            reason: reason || null,
            previous_status: caseData.status
        });

        // Dismiss any pending proposals
        await db.query(
            `UPDATE auto_reply_queue SET status = 'rejected' WHERE case_id = $1 AND status = 'pending'`,
            [requestId]
        );

        // Sync status to Notion
        try {
            const notionService = require('../services/notion-service');
            await notionService.syncStatusToNotion(requestId);
            log.info('Notion status synced to Completed');
        } catch (notionError) {
            log.warn(`Failed to sync to Notion: ${notionError.message}`);
            // Don't fail the request if Notion sync fails
        }

        log.info('Request withdrawn successfully');

        res.json({
            success: true,
            message: 'Request withdrawn successfully'
        });
    } catch (error) {
        log.error(`Error withdrawing request: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/resolve-review
 * Resolve a human review with a chosen action + optional custom instruction
 */
router.post('/:id/resolve-review', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const { action, instruction } = req.body;
    const log = logger.forCase(requestId);

    try {
        if (!action) {
            return res.status(400).json({
                success: false,
                error: 'action is required'
            });
        }

        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        log.info(`Resolving human review with action: ${action}`);

        // Immediate actions — update status directly, no agent invocation
        const IMMEDIATE_ACTIONS = {
            put_on_hold: { status: 'awaiting_response', substatus: 'On hold (manual)' },
            close: { status: 'completed', substatus: 'Closed by user' },
            submit_manually: { status: 'portal_in_progress', substatus: 'Manual portal submission' },
            mark_sent: { status: 'sent', substatus: 'Marked as sent by user' },
            clear_portal: { status: 'needs_human_review', substatus: 'Portal URL cleared — needs alternative submission method' }
        };

        if (IMMEDIATE_ACTIONS[action]) {
            const { status, substatus } = IMMEDIATE_ACTIONS[action];
            const updates = {
                status,
                substatus,
                requires_human: false,
                pause_reason: null
            };

            // mark_sent: set send_date if not already set
            if (action === 'mark_sent' && !caseData.send_date) {
                updates.send_date = new Date();
            }

            // clear_portal: remove portal URL so case can proceed via email
            if (action === 'clear_portal') {
                updates.portal_url = null;
                updates.portal_provider = null;
                updates.requires_human = true; // keep in review so user can choose next step
            }

            // On close: set closed_at and generate outcome summary
            if (action === 'close') {
                updates.closed_at = new Date();
                updates.outcome_recorded = true;
            }

            await db.updateCase(requestId, updates);

            // When marking as sent, dismiss only submission-related proposals (keep rebuttals, fee negotiations)
            // When closing, dismiss ALL pending proposals
            if (action === 'mark_sent') {
                try { await db.dismissPendingProposals(requestId, `Review resolved: ${action}`, ['SUBMIT_PORTAL', 'SEND_FOLLOWUP', 'SEND_INITIAL_REQUEST']); } catch (_) {}
            } else if (action === 'close') {
                try { await db.dismissPendingProposals(requestId, `Review resolved: ${action}`); } catch (_) {}
            }

            await db.logActivity('human_decision', `Review resolved: ${action}${instruction ? ` — ${instruction}` : ''}`, {
                case_id: requestId,
                review_action: action,
                instruction: instruction || null,
                previous_status: caseData.status
            });

            // On close: generate AI outcome summary asynchronously
            if (action === 'close') {
                generateOutcomeSummary(requestId, caseData, instruction).catch(err => {
                    log.warn(`Failed to generate outcome summary: ${err.message}`);
                });
            }

            // Sync to Notion
            try {
                const notionService = require('../services/notion-service');
                await notionService.syncStatusToNotion(requestId);
            } catch (notionError) {
                log.warn(`Failed to sync to Notion: ${notionError.message}`);
            }

            log.info(`Review resolved immediately: ${action}`);
            return res.json({
                success: true,
                message: `Review resolved: ${action}`,
                immediate: true
            });
        }

        // Agent-based actions — clear review flags, enqueue agent job
        const ACTION_INSTRUCTIONS = {
            retry_portal: 'Retry the portal submission',
            send_via_email: 'Switch to email submission',
            appeal: 'Draft an appeal citing legal grounds',
            narrow_scope: 'Narrow scope and resubmit',
            negotiate_fee: 'Negotiate the quoted fee',
            accept_fee: 'Accept fee and proceed',
            reprocess: 'Re-analyze and determine best action',
            decline_fee: 'Decline the quoted fee',
            escalate: 'Escalate to human oversight',
            research_agency: 'Research the correct agency for this request',
            reformulate_request: 'Reformulate the request with a different approach',
            custom: instruction || 'Follow custom instructions'
        };

        const baseInstruction = ACTION_INSTRUCTIONS[action];
        if (!baseInstruction) {
            return res.status(400).json({
                success: false,
                error: `Unknown action: ${action}`
            });
        }

        // Build combined instruction
        const combinedInstruction = instruction
            ? `${baseInstruction}. Additional instructions: ${instruction}`
            : baseInstruction;

        // Loop prevention: if there's already a PENDING_APPROVAL proposal matching
        // this action, don't dismiss it and start over — tell the user to review it.
        const ACTION_TO_PROPOSAL_TYPE = {
            negotiate_fee: 'NEGOTIATE_FEE', accept_fee: 'ACCEPT_FEE', decline_fee: 'DECLINE_FEE',
            appeal: 'SEND_REBUTTAL', narrow_scope: 'SEND_REBUTTAL',
            send_via_email: 'SEND_INITIAL_REQUEST',
        };
        const matchingProposalType = ACTION_TO_PROPOSAL_TYPE[action];
        if (matchingProposalType) {
            const existingProposal = await db.query(
                `SELECT id, action_type, draft_body_text FROM proposals
                 WHERE case_id = $1 AND status = 'PENDING_APPROVAL' AND action_type = $2
                 LIMIT 1`,
                [requestId, matchingProposalType]
            );
            if (existingProposal.rows.length > 0) {
                const ep = existingProposal.rows[0];
                log.info(`Loop prevention: existing ${ep.action_type} proposal #${ep.id} already pending`);
                return res.json({
                    success: true,
                    message: `A ${action.replace(/_/g, ' ')} draft is already waiting for your review (proposal #${ep.id}). Open the case to approve, adjust, or dismiss it.`,
                    immediate: true,
                    existing_proposal_id: ep.id
                });
            }
        }

        // Complete waitpoint tokens on active proposals before dismissing.
        // This unblocks any Trigger.dev tasks waiting on human approval so they exit cleanly.
        try {
            const tokensToComplete = await db.query(
                `SELECT id, waitpoint_token FROM proposals
                 WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'BLOCKED')
                 AND waitpoint_token IS NOT NULL`,
                [requestId]
            );
            if (tokensToComplete.rows.length > 0) {
                const { wait: triggerWait } = require('@trigger.dev/sdk/v3');
                for (const p of tokensToComplete.rows) {
                    try {
                        await triggerWait.completeToken(p.waitpoint_token, {
                            action: 'DISMISS',
                            reason: `Superseded by human review action: ${action}`,
                        });
                    } catch (_) {} // Token may already be expired/completed
                }
            }
        } catch (_) {}

        // Dismiss all active proposals — human is taking a new direction
        await db.query(
            `UPDATE proposals SET status = 'DISMISSED', human_decision = $1
             WHERE case_id = $2 AND status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL')`,
            [JSON.stringify(`Superseded by human review action: ${action}`), requestId]
        );

        // Clear review flags
        await db.updateCase(requestId, {
            requires_human: false,
            pause_reason: null,
            substatus: `Resolving: ${action}`
        });

        // Log activity
        await db.logActivity('human_decision', `Review resolved: ${action}${instruction ? ` — ${instruction}` : ''}`, {
            case_id: requestId,
            review_action: action,
            instruction: instruction || null,
            previous_status: caseData.status
        });

        // Trigger Trigger.dev task for re-processing — pass review action + instruction
        const { tasks: triggerTasks } = require('@trigger.dev/sdk/v3');
        const latestMsg = await db.query('SELECT id FROM messages WHERE case_id = $1 AND direction = \'inbound\' ORDER BY created_at DESC LIMIT 1', [requestId]);
        const triggerRun = await db.createAgentRunFull({
            case_id: requestId,
            trigger_type: 'human_review_resolution',
            status: 'queued',
            autopilot_mode: 'SUPERVISED',
            langgraph_thread_id: `review:${requestId}:${Date.now()}`
        });
        const handle = await triggerTasks.trigger('process-inbound', {
            runId: triggerRun.id,
            caseId: requestId,
            messageId: latestMsg.rows[0]?.id || null,
            autopilotMode: 'SUPERVISED',
            triggerType: 'HUMAN_REVIEW_RESOLUTION',
            reviewAction: action,
            reviewInstruction: combinedInstruction,
        });
        const job = { id: handle.id };

        // Sync to Notion
        try {
            const notionService = require('../services/notion-service');
            await notionService.syncStatusToNotion(requestId);
        } catch (notionError) {
            log.warn(`Failed to sync to Notion: ${notionError.message}`);
        }

        log.info(`Review resolved with agent job: ${job.id}`);

        res.json({
            success: true,
            message: `Review resolved: ${action}`,
            job_id: job.id
        });
    } catch (error) {
        log.error(`Error resolving review: ${error.message}`);
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

/**
 * POST /api/requests/:id/actions/approve
 * Approve a pending action (e.g., send auto-reply)
 *
 * Implements exactly-once execution (Deliverable 1):
 * 1. Check if already executed (return 409 if so)
 * 2. Atomic claim execution slot
 * 3. Validate against policy rules
 * 4. Queue email with jobId: executionKey (BullMQ deduplication)
 * 5. Mark executed
 */
router.post('/:id/actions/approve', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const { action_id } = req.body;
    const log = logger.forCase(requestId);

    try {
        // Find the pending reply
        const replyResult = await db.query(
            `SELECT * FROM auto_reply_queue
             WHERE case_id = $1 AND status IN ('pending', 'approved')
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
        log.info(`Approve request for proposal ${reply.id}`);

        // Step 1: Check if already executed
        const executionStatus = await db.isProposalExecuted(reply.id);
        if (executionStatus?.executed) {
            log.warn(`Proposal ${reply.id} already executed at ${executionStatus.executedAt}`);
            return res.status(409).json({
                success: false,
                error: 'Action already executed',
                executed_at: executionStatus.executedAt,
                email_job_id: executionStatus.emailJobId
            });
        }

        // Get case and message data
        const message = await db.getMessageById(reply.message_id);
        const caseData = await db.getCaseById(requestId);

        if (!message || !caseData) {
            return res.status(404).json({
                success: false,
                error: 'Message or case not found'
            });
        }

        // Step 2: Validate against policy rules
        const validation = await actionValidator.validateAction(requestId, reply);
        if (validation.blocked) {
            log.warn(`Action blocked by policy: ${validation.violations.map(v => v.rule).join(', ')}`);
            await actionValidator.blockProposal(reply.id, validation.violations);
            return res.status(403).json({
                success: false,
                error: 'Action blocked by policy',
                violations: validation.violations
            });
        }

        // Step 3: Generate unique execution key
        const executionKey = `exec-${requestId}-${reply.id}-${crypto.randomBytes(8).toString('hex')}`;

        // Step 4: Atomic claim execution slot
        const claimed = await db.claimProposalExecution(reply.id, executionKey);
        if (!claimed) {
            log.warn(`Failed to claim execution slot for proposal ${reply.id} - already claimed`);
            return res.status(409).json({
                success: false,
                error: 'Action already being executed by another request'
            });
        }

        log.info(`Claimed execution slot with key: ${executionKey}`);

        // Step 5: Queue the email with execution key as job ID for deduplication
        const { emailQueue } = require('../queues/email-queue');
        const job = await emailQueue.add('send-auto-reply', {
            type: 'auto_reply',
            caseId: requestId,
            toEmail: message.from_email,
            subject: message.subject,
            content: reply.generated_reply,
            originalMessageId: message.message_id,
            proposalId: reply.id,
            executionKey: executionKey
        }, {
            jobId: executionKey  // BullMQ deduplication
        });

        // Step 6: Mark executed
        await db.markProposalExecuted(reply.id, job.id);

        // Clear requires_human if this was the blocking action
        await db.updateCase(requestId, {
            requires_human: false,
            pause_reason: null
        });

        log.info(`Proposal ${reply.id} approved and queued (job: ${job.id})`);
        logger.proposalEvent('approved', { ...reply, status: 'approved' });

        res.json({
            success: true,
            message: 'Action approved and queued for sending',
            execution_key: executionKey,
            job_id: job.id
        });
    } catch (error) {
        log.error(`Error approving action: ${error.message}`);
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

        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        let reply = replyResult.rows[0];
        let message = reply ? await db.getMessageById(reply.message_id) : null;

        // If no pending action, generate a new draft based on the instruction
        if (!reply) {
            // Get the latest inbound message for context
            const thread = await db.getThreadByCaseId(requestId);
            let latestInbound = null;
            if (thread) {
                const messagesResult = await db.query(
                    `SELECT * FROM messages WHERE thread_id = $1 AND direction = 'inbound' ORDER BY received_at DESC LIMIT 1`,
                    [thread.id]
                );
                latestInbound = messagesResult.rows[0];
            }

            // Generate a new draft using the instruction
            const OpenAI = require('openai');
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

            const generatePrompt = `You are helping draft a FOIA request response.

Context:
- Agency: ${caseData.agency_name}
- State: ${caseData.state}
- Current status: ${caseData.status}
- Pause reason: ${caseData.pause_reason || 'N/A'}
${latestInbound ? `- Last message from agency: ${latestInbound.subject}` : ''}

User instruction:
${instruction}

Please draft a professional email to send to the agency. Only output the email body text, no explanations.`;

            const completion = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a professional FOIA request assistant helping draft correspondence with government agencies.'
                    },
                    {
                        role: 'user',
                        content: generatePrompt
                    }
                ],
                max_tokens: 1000
            });

            const draftContent = completion.choices[0].message.content;

            // Create a new pending reply entry
            const newReplyResult = await db.query(
                `INSERT INTO auto_reply_queue (case_id, message_id, generated_reply, response_type, status, requires_approval, created_at, proposal_short, reasoning_jsonb)
                 VALUES ($1, $2, $3, 'custom', 'pending', true, NOW(), $4, $5)
                 RETURNING *`,
                [
                    requestId,
                    latestInbound?.id || null,
                    draftContent,
                    `Custom: ${instruction.substring(0, 50)}...`,
                    JSON.stringify(['Generated based on your instruction', instruction])
                ]
            );

            reply = newReplyResult.rows[0];
            message = latestInbound;
        } else {
            // Existing pending action - revise it
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
                model: process.env.OPENAI_MODEL || 'gpt-5.2-2025-12-11',
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
            reply = await db.updateAutoReplyQueueEntry(reply.id, {
                generated_reply: revisedContent,
                last_regenerated_at: new Date(),
                metadata: JSON.stringify({
                    ...JSON.parse(reply.metadata || '{}'),
                    revision_instruction: instruction,
                    revised_at: new Date().toISOString()
                })
            });
        }

        // Parse JSONB fields from reply
        const reasoning = reply.reasoning_jsonb || ['Generated based on your instruction', instruction];
        const warnings = reply.warnings_jsonb || [];
        const constraintsApplied = reply.constraints_applied_jsonb || [];
        const draftContent = reply.generated_reply;

        // Return next action
        const nextAction = {
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
            draft_content: draftContent,
            draft_preview: draftContent ? draftContent.substring(0, 200) : null,
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

/**
 * GET /api/requests/:id/agent-runs
 * Get agent run history for a request (Deliverable 5: Observability)
 */
router.get('/:id/agent-runs', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const limit = parseInt(req.query.limit) || 20;

        // Verify case exists
        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Get agent runs with proposal details
        const runs = await db.getAgentRunsByCaseId(requestId, limit);

        // Transform runs for API response
        const transformedRuns = runs.map(run => ({
            id: run.id,
            trigger_type: run.trigger_type,
            started_at: run.started_at,
            ended_at: run.ended_at,
            duration_ms: run.ended_at && run.started_at
                ? new Date(run.ended_at) - new Date(run.started_at)
                : null,
            status: run.status,
            error: run.error || null,
            lock_acquired: run.lock_acquired,
            proposal: run.proposal_id ? {
                id: run.proposal_id,
                action_type: run.proposal_action_type,
                status: run.proposal_status,
                content_preview: run.proposal_content
                    ? run.proposal_content.substring(0, 200)
                    : null
            } : null,
            metadata: run.metadata || {}
        }));

        res.json({
            success: true,
            case_id: requestId,
            count: transformedRuns.length,
            agent_runs: transformedRuns
        });
    } catch (error) {
        console.error('Error fetching agent runs:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================================================================
// LangGraph Proposal Endpoints (New Proposals Table)
// =========================================================================

/**
 * GET /api/requests/:id/proposals
 * Get pending proposals for a request (from new proposals table)
 */
router.get('/:id/proposals', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);

        // Verify case exists
        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Get proposals from new proposals table
        const proposals = await db.getPendingProposalsByCaseId(requestId);

        const transformedProposals = proposals.map(p => ({
            id: p.id,
            proposal_key: p.proposal_key,
            action_type: p.action_type,
            status: p.status,
            draft_subject: p.draft_subject,
            draft_preview: p.draft_body_text ? p.draft_body_text.substring(0, 200) : null,
            reasoning: p.reasoning,
            confidence: p.confidence ? parseFloat(p.confidence) : 0.8,
            risk_flags: p.risk_flags || [],
            warnings: p.warnings || [],
            can_auto_execute: p.can_auto_execute,
            requires_human: p.requires_human,
            adjustment_count: p.adjustment_count || 0,
            created_at: p.created_at
        }));

        res.json({
            success: true,
            case_id: requestId,
            count: transformedProposals.length,
            proposals: transformedProposals
        });
    } catch (error) {
        console.error('Error fetching proposals:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/requests/:id/proposals/:proposalId
 * Get a single proposal with full details
 */
router.get('/:id/proposals/:proposalId', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const proposalId = parseInt(req.params.proposalId);

        const proposal = await db.getProposalById(proposalId);

        if (!proposal || proposal.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        res.json({
            success: true,
            proposal: {
                id: proposal.id,
                proposal_key: proposal.proposal_key,
                case_id: proposal.case_id,
                trigger_message_id: proposal.trigger_message_id,
                action_type: proposal.action_type,
                status: proposal.status,
                draft_subject: proposal.draft_subject,
                draft_body_text: proposal.draft_body_text,
                draft_body_html: proposal.draft_body_html,
                reasoning: proposal.reasoning,
                confidence: proposal.confidence ? parseFloat(proposal.confidence) : 0.8,
                risk_flags: proposal.risk_flags || [],
                warnings: proposal.warnings || [],
                can_auto_execute: proposal.can_auto_execute,
                requires_human: proposal.requires_human,
                adjustment_count: proposal.adjustment_count || 0,
                human_decision: proposal.human_decision,
                human_decided_at: proposal.human_decided_at,
                executed_at: proposal.executed_at,
                email_job_id: proposal.email_job_id,
                created_at: proposal.created_at,
                updated_at: proposal.updated_at
            }
        });
    } catch (error) {
        console.error('Error fetching proposal:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/proposals/:proposalId/approve
 * Approve a LangGraph proposal and resume the graph
 */
router.post('/:id/proposals/:proposalId/approve', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const proposalId = parseInt(req.params.proposalId);
    const log = logger.forCase(requestId);

    try {
        const proposal = await db.getProposalById(proposalId);

        if (!proposal || proposal.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        // Check if already executed
        if (proposal.status === 'EXECUTED') {
            return res.status(409).json({
                success: false,
                error: 'Proposal already executed',
                executed_at: proposal.executed_at
            });
        }

        // Check if not in pending state
        if (proposal.status !== 'PENDING_APPROVAL') {
            return res.status(400).json({
                success: false,
                error: `Proposal is in ${proposal.status} state, cannot approve`
            });
        }

        log.info(`Approving proposal ${proposalId}`);

        // Mark decision received (terminal-protected) before queueing resume
        await db.updateProposal(proposalId, {
            status: 'DECISION_RECEIVED',
            humanDecision: 'APPROVE',
            humanDecidedAt: new Date()
        });

        // Complete the Trigger.dev waitpoint token or handle legacy proposal
        if (proposal.waitpoint_token) {
            const { wait: triggerWait } = require('@trigger.dev/sdk/v3');
            await triggerWait.completeToken(proposal.waitpoint_token, {
                action: 'APPROVE',
                proposalId: proposalId
            });
            log.info(`Trigger.dev waitpoint completed for approve on proposal ${proposalId}`);
        } else {
            // Legacy proposal — re-trigger inbound processing
            const { tasks } = require('@trigger.dev/sdk/v3');
            await tasks.trigger('process-inbound', {
                runId: proposal.run_id || 0,
                caseId: requestId,
                messageId: proposal.message_id || 0,
                autopilotMode: 'SUPERVISED'
            }, {
                queue: `case-${requestId}`,
                idempotencyKey: `req-approve:${requestId}:${proposalId}`,
                idempotencyKeyTTL: "1h",
            });
            log.info(`Re-triggered process-inbound for legacy proposal ${proposalId}`);
        }

        res.json({
            success: true,
            message: 'Proposal approved, execution resuming',
            proposal_id: proposalId
        });
    } catch (error) {
        log.error(`Error approving proposal: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/proposals/:proposalId/adjust
 * Request adjustments to a proposal and resume graph with feedback
 */
router.post('/:id/proposals/:proposalId/adjust', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const proposalId = parseInt(req.params.proposalId);
    const { instruction, adjustments } = req.body;
    const log = logger.forCase(requestId);

    try {
        if (!instruction && !adjustments) {
            return res.status(400).json({
                success: false,
                error: 'Either instruction or adjustments is required'
            });
        }

        const proposal = await db.getProposalById(proposalId);

        if (!proposal || proposal.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        if (proposal.status !== 'PENDING_APPROVAL') {
            return res.status(400).json({
                success: false,
                error: `Proposal is in ${proposal.status} state, cannot adjust`
            });
        }

        log.info(`Adjusting proposal ${proposalId}`);

        // Update proposal with adjustment request
        await db.updateProposal(proposalId, {
            status: 'ADJUSTMENT_REQUESTED',
            humanDecision: 'ADJUST',
            humanDecidedAt: new Date(),
            adjustmentCount: (proposal.adjustment_count || 0) + 1
        });

        // Complete the Trigger.dev waitpoint token or handle legacy proposal
        if (proposal.waitpoint_token) {
            const { wait: triggerWait } = require('@trigger.dev/sdk/v3');
            await triggerWait.completeToken(proposal.waitpoint_token, {
                action: 'ADJUST',
                proposalId: proposalId,
                instruction: instruction,
                adjustments: adjustments
            });
            log.info(`Trigger.dev waitpoint completed for adjust on proposal ${proposalId}`);
        } else {
            // Legacy proposal — re-trigger inbound processing with adjustment context
            const { tasks } = require('@trigger.dev/sdk/v3');
            await tasks.trigger('process-inbound', {
                runId: proposal.run_id || 0,
                caseId: requestId,
                messageId: proposal.message_id || 0,
                autopilotMode: 'SUPERVISED'
            }, {
                queue: `case-${requestId}`,
                idempotencyKey: `req-adjust:${requestId}:${proposalId}`,
                idempotencyKeyTTL: "1h",
            });
            log.info(`Re-triggered process-inbound for legacy adjust on proposal ${proposalId}`);
        }

        res.json({
            success: true,
            message: 'Adjustment requested, re-drafting',
            proposal_id: proposalId
        });
    } catch (error) {
        log.error(`Error adjusting proposal: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/proposals/:proposalId/dismiss
 * Dismiss a proposal and resume graph to try different action
 */
router.post('/:id/proposals/:proposalId/dismiss', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const proposalId = parseInt(req.params.proposalId);
    const { reason } = req.body;
    const log = logger.forCase(requestId);

    try {
        const proposal = await db.getProposalById(proposalId);

        if (!proposal || proposal.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        if (proposal.status !== 'PENDING_APPROVAL') {
            return res.status(400).json({
                success: false,
                error: `Proposal is in ${proposal.status} state, cannot dismiss`
            });
        }

        log.info(`Dismissing proposal ${proposalId}`);

        // Update proposal as dismissed
        await db.updateProposal(proposalId, {
            status: 'DISMISSED',
            humanDecision: 'DISMISS',
            humanDecidedAt: new Date()
        });

        // Complete the Trigger.dev waitpoint token or handle legacy proposal
        if (proposal.waitpoint_token) {
            const { wait: triggerWait } = require('@trigger.dev/sdk/v3');
            await triggerWait.completeToken(proposal.waitpoint_token, {
                action: 'DISMISS',
                proposalId: proposalId,
                reason: reason
            });
            log.info(`Trigger.dev waitpoint completed for dismiss on proposal ${proposalId}`);
        } else {
            // Legacy proposal — just mark as dismissed, no re-trigger needed
            log.info(`Legacy proposal ${proposalId} dismissed (no waitpoint token)`);
        }

        res.json({
            success: true,
            message: 'Proposal dismissed',
            proposal_id: proposalId
        });
    } catch (error) {
        log.error(`Error dismissing proposal: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/proposals/:proposalId/withdraw
 * Withdraw from processing entirely (no further agent action)
 */
router.post('/:id/proposals/:proposalId/withdraw', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const proposalId = parseInt(req.params.proposalId);
    const { reason } = req.body;
    const log = logger.forCase(requestId);

    try {
        const proposal = await db.getProposalById(proposalId);

        if (!proposal || proposal.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        log.info(`Withdrawing proposal ${proposalId}`);

        // Update proposal as withdrawn
        await db.updateProposal(proposalId, {
            status: 'WITHDRAWN',
            humanDecision: 'WITHDRAW',
            humanDecidedAt: new Date()
        });

        // Mark case for manual handling (no auto-resume)
        await db.updateCase(requestId, {
            requires_human: true,
            pause_reason: 'MANUAL',
            autopilot_mode: 'MANUAL'
        });

        // Log the withdrawal
        await db.logActivity('proposal_withdrawn', `Proposal withdrawn: ${reason || 'No reason given'}`, {
            case_id: requestId,
            proposal_id: proposalId,
            reason: reason
        });

        log.info(`Proposal withdrawn, case set to MANUAL mode`);

        res.json({
            success: true,
            message: 'Proposal withdrawn, case set to manual handling',
            proposal_id: proposalId
        });
    } catch (error) {
        log.error(`Error withdrawing proposal: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/invoke-agent
 * Manually trigger the agent for a case
 */
router.post('/:id/invoke-agent', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const { trigger_type } = req.body;
    const log = logger.forCase(requestId);

    try {
        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        log.info(`Manual agent invocation requested`);

        const { tasks: triggerTasks } = require('@trigger.dev/sdk/v3');
        const latestMsg = await db.query('SELECT id FROM messages WHERE case_id = $1 AND direction = \'inbound\' ORDER BY created_at DESC LIMIT 1', [requestId]);
        const triggerRun = await db.createAgentRunFull({
            case_id: requestId,
            trigger_type: trigger_type || 'MANUAL',
            status: 'queued',
            autopilot_mode: 'SUPERVISED',
            langgraph_thread_id: `manual:${requestId}:${Date.now()}`
        });
        const handle = await triggerTasks.trigger('process-inbound', {
            runId: triggerRun.id,
            caseId: requestId,
            messageId: latestMsg.rows[0]?.id || null,
            autopilotMode: 'SUPERVISED',
        });

        log.info(`Trigger.dev task triggered (run: ${handle.id})`);

        res.json({
            success: true,
            message: 'Agent invoked via Trigger.dev',
            trigger_run_id: handle.id
        });
    } catch (error) {
        log.error(`Error invoking agent: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================================================================
// Replay / Dry-Run Tooling
// =========================================================================

/**
 * POST /api/requests/:id/agent-runs/:runId/replay
 * Replay an agent run for debugging purposes.
 *
 * Query params:
 * - mode: 'dry_run' (default) or 'live'
 *
 * Body (optional overrides for testing):
 * - autopilotMode: 'AUTO' | 'SUPERVISED' | 'MANUAL'
 * - feeThreshold: number (override FEE_AUTO_APPROVE_MAX)
 * - simulatePortal: boolean (pretend case has/doesn't have portal_url)
 * - humanDecision: { action: 'approve'|'adjust'|'dismiss', reason?: string }
 * - forceConfidence: number (override analysis confidence)
 *
 * Dry-run mode:
 * - Runs full agent logic
 * - Generates proposals and logs
 * - Never sends emails or takes real actions
 * - Stores diff against original run
 */
router.post('/:id/agent-runs/:runId/replay', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const runId = parseInt(req.params.runId);
    const mode = req.query.mode || 'dry_run';
    const log = logger.forCase(requestId);

    // Extract override options from request body
    const overrides = {
        autopilotMode: req.body.autopilotMode || null,
        feeThreshold: req.body.feeThreshold || null,
        simulatePortal: req.body.simulatePortal ?? null,
        humanDecision: req.body.humanDecision || null,
        forceConfidence: req.body.forceConfidence || null,
        forceActionType: req.body.forceActionType || null
    };

    try {
        // Verify case exists
        let caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Get the original run
        const originalRun = await db.getAgentRunById(runId);
        if (!originalRun || originalRun.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Agent run not found'
            });
        }

        log.info(`Replaying agent run ${runId} in ${mode} mode`, { overrides });

        // Apply overrides to case data (for dry-run simulation)
        const effectiveCaseData = { ...caseData };
        if (overrides.autopilotMode) {
            effectiveCaseData.autopilot_mode = overrides.autopilotMode;
        }
        if (overrides.simulatePortal === true) {
            effectiveCaseData.portal_url = effectiveCaseData.portal_url || 'https://simulated-portal.example.com';
        } else if (overrides.simulatePortal === false) {
            effectiveCaseData.portal_url = null;
        }

        // Create a new agent run record for the replay
        const replayRun = await db.createAgentRun(requestId, `REPLAY_${originalRun.trigger_type}`, {
            is_replay: true,
            replay_of_run_id: runId,
            dry_run: mode === 'dry_run',
            original_trigger_type: originalRun.trigger_type,
            original_started_at: originalRun.started_at,
            overrides_applied: overrides
        });

        // Update the run to mark it as a replay
        await db.updateAgentRun(replayRun.id, {
            is_replay: true,
            replay_of_run_id: runId,
            dry_run: mode === 'dry_run'
        });

        if (mode === 'dry_run') {
            // Dry-run mode: simulate agent without taking actions
            const actionValidator = require('../services/action-validator');

            // Get the original proposal if any
            let originalProposal = null;
            if (originalRun.proposal_id) {
                const result = await db.query(
                    'SELECT * FROM auto_reply_queue WHERE id = $1',
                    [originalRun.proposal_id]
                );
                originalProposal = result.rows[0];
            }

            // Get original proposal from proposals table too
            let originalProposalNew = null;
            if (originalRun.proposal_id) {
                const pResult = await db.query(
                    'SELECT * FROM proposals WHERE id = $1',
                    [originalRun.proposal_id]
                );
                originalProposalNew = pResult.rows[0];
            }

            // Simulate what the agent would do now
            const latestMessage = await db.getLatestInboundMessage(requestId);
            const analysis = latestMessage ? await db.getAnalysisByMessageId(latestMessage.id) : null;

            // Apply confidence override
            let effectiveConfidence = analysis?.confidence_score || 0.5;
            if (overrides.forceConfidence !== null) {
                effectiveConfidence = overrides.forceConfidence;
            }

            // Determine effective action type
            let effectiveActionType = analysis?.suggested_action || 'UNKNOWN';
            if (overrides.forceActionType) {
                effectiveActionType = overrides.forceActionType;
            }

            // Build simulated proposal
            const simulatedProposal = {
                case_id: requestId,
                action_type: effectiveActionType,
                reasoning: ['Dry-run simulation based on current case state'],
                confidence: effectiveConfidence,
                warnings: [],
                requires_human: effectiveCaseData.autopilot_mode !== 'AUTO'
            };

            // Calculate whether this would auto-execute
            const FEE_THRESHOLD = overrides.feeThreshold ||
                parseInt(process.env.FEE_AUTO_APPROVE_MAX) || 100;

            let canAutoExecute = false;
            if (effectiveCaseData.autopilot_mode === 'AUTO') {
                if (effectiveActionType === 'SEND_FOLLOWUP') {
                    canAutoExecute = true;
                } else if (effectiveActionType === 'APPROVE_FEE') {
                    const feeAmount = analysis?.extracted_fee_amount || 0;
                    canAutoExecute = feeAmount <= FEE_THRESHOLD;
                } else if (effectiveActionType === 'MARK_COMPLETE') {
                    canAutoExecute = effectiveConfidence >= 0.9;
                }
            }

            simulatedProposal.can_auto_execute = canAutoExecute;

            // Validate the simulated action
            const validation = await actionValidator.validateAction(
                requestId,
                simulatedProposal,
                analysis,
                effectiveCaseData  // Pass effective case data with overrides
            );

            // Build state snapshot for debugging
            const stateSnapshot = {
                case: {
                    id: requestId,
                    status: effectiveCaseData.status,
                    autopilot_mode: effectiveCaseData.autopilot_mode,
                    has_portal: !!effectiveCaseData.portal_url,
                    requires_human: effectiveCaseData.requires_human,
                    pause_reason: effectiveCaseData.pause_reason,
                    last_fee_quote_amount: effectiveCaseData.last_fee_quote_amount
                },
                analysis: analysis ? {
                    classification: analysis.intent,
                    suggested_action: analysis.suggested_action,
                    confidence: analysis.confidence_score,
                    fee_amount: analysis.extracted_fee_amount
                } : null,
                config: {
                    fee_threshold: FEE_THRESHOLD,
                    autopilot_enabled: effectiveCaseData.autopilot_mode !== 'MANUAL'
                }
            };

            // Build comprehensive diff
            const diff = {
                original_proposal: originalProposal ? {
                    action_type: originalProposal.action_type,
                    status: originalProposal.status,
                    confidence: originalProposal.confidence_score,
                    draft_subject: originalProposal.subject,
                    draft_body_preview: (originalProposal.generated_reply || '').substring(0, 200)
                } : (originalProposalNew ? {
                    action_type: originalProposalNew.action_type,
                    status: originalProposalNew.status,
                    confidence: originalProposalNew.confidence,
                    draft_subject: originalProposalNew.draft_subject,
                    draft_body_preview: (originalProposalNew.draft_body_text || '').substring(0, 200)
                } : null),
                simulated_proposal: {
                    action_type: simulatedProposal.action_type,
                    confidence: simulatedProposal.confidence,
                    can_auto_execute: simulatedProposal.can_auto_execute,
                    would_be_blocked: validation.blocked,
                    requires_human: simulatedProposal.requires_human
                },
                state_snapshot: stateSnapshot,
                validator_result: {
                    valid: validation.valid,
                    blocked: validation.blocked,
                    violations: validation.violations,
                    rules_checked: validation.rules_checked || []
                },
                overrides_applied: overrides,
                changes_detected: {
                    action_type_changed: originalProposal?.action_type !== simulatedProposal.action_type,
                    confidence_changed: originalProposal?.confidence_score !== simulatedProposal.confidence,
                    blocking_changed: validation.blocked !== (originalProposal?.status === 'blocked')
                },
                executed_at: new Date().toISOString()
            };

            // Simulate human decision if provided
            if (overrides.humanDecision) {
                diff.simulated_human_decision = {
                    action: overrides.humanDecision.action,
                    reason: overrides.humanDecision.reason,
                    would_result_in: overrides.humanDecision.action === 'approve'
                        ? (validation.blocked ? 'BLOCKED' : 'EXECUTED')
                        : (overrides.humanDecision.action === 'dismiss' ? 'DISMISSED' : 'ADJUSTED')
                };
            }

            await db.updateAgentRun(replayRun.id, {
                status: 'completed',
                ended_at: new Date(),
                replay_diff: JSON.stringify(diff)
            });

            // Log activity
            await db.logActivity('agent_run_replayed', `Dry-run replay of run ${runId}`, {
                case_id: requestId,
                original_run_id: runId,
                replay_run_id: replayRun.id,
                mode: 'dry_run',
                overrides_applied: Object.keys(overrides).filter(k => overrides[k] !== null).length > 0
            });

            res.json({
                success: true,
                message: 'Dry-run replay completed',
                replay_run_id: replayRun.id,
                original_run_id: runId,
                mode: 'dry_run',
                diff: diff,
                state_snapshot: stateSnapshot,
                overrides_applied: overrides
            });
        } else {
            // Live mode: actually re-run the agent
            log.warn('Live replay mode requested - queueing agent job');

            const { tasks: triggerTasks } = require('@trigger.dev/sdk/v3');
            const latestMsg = await db.query('SELECT id FROM messages WHERE case_id = $1 AND direction = \'inbound\' ORDER BY created_at DESC LIMIT 1', [requestId]);
            const handle = await triggerTasks.trigger('process-inbound', {
                runId: replayRun.id,
                caseId: requestId,
                messageId: latestMsg.rows[0]?.id || null,
                autopilotMode: 'SUPERVISED',
            });

            await db.updateAgentRun(replayRun.id, {
                metadata: JSON.stringify({
                    ...replayRun.metadata,
                    trigger_run_id: handle.id
                })
            });

            res.json({
                success: true,
                message: 'Live replay queued via Trigger.dev',
                replay_run_id: replayRun.id,
                original_run_id: runId,
                mode: 'live',
                trigger_run_id: handle.id
            });
        }
    } catch (error) {
        log.error(`Error replaying agent run: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/requests/:id/agent-runs/:runId/diff
 * Get the diff for a replay run
 */
router.get('/:id/agent-runs/:runId/diff', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const runId = parseInt(req.params.runId);

    try {
        const run = await db.getAgentRunById(runId);

        if (!run || run.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Agent run not found'
            });
        }

        if (!run.is_replay) {
            return res.status(400).json({
                success: false,
                error: 'This is not a replay run'
            });
        }

        // Get the original run for comparison
        let originalRun = null;
        if (run.replay_of_run_id) {
            originalRun = await db.getAgentRunById(run.replay_of_run_id);
        }

        res.json({
            success: true,
            run_id: runId,
            is_replay: true,
            dry_run: run.dry_run,
            original_run_id: run.replay_of_run_id,
            diff: run.replay_diff,
            original_run: originalRun ? {
                id: originalRun.id,
                trigger_type: originalRun.trigger_type,
                status: originalRun.status,
                started_at: originalRun.started_at,
                ended_at: originalRun.ended_at
            } : null
        });
    } catch (error) {
        console.error('Error fetching replay diff:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================================================================
// DLQ Management Endpoints
// =========================================================================

/**
 * GET /api/dlq
 * Get dead letter queue items
 */
router.get('/dlq', async (req, res) => {
    try {
        const { getDLQItems } = require('../queues/queue-config');
        const { queue_name, resolution, limit, offset } = req.query;

        const items = await getDLQItems({
            queueName: queue_name,
            resolution: resolution || 'pending',
            limit: parseInt(limit) || 50,
            offset: parseInt(offset) || 0
        });

        res.json({
            success: true,
            count: items.length,
            items: items
        });
    } catch (error) {
        console.error('Error fetching DLQ items:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/dlq/:id/retry
 * Retry a DLQ item
 */
router.post('/dlq/:id/retry', async (req, res) => {
    try {
        const dlqId = parseInt(req.params.id);
        const { retryDLQItem } = require('../queues/queue-config');

        const result = await retryDLQItem(dlqId);

        res.json({
            success: true,
            message: 'DLQ item retried',
            new_job_id: result.newJobId
        });
    } catch (error) {
        console.error('Error retrying DLQ item:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/dlq/:id/discard
 * Discard a DLQ item
 */
router.post('/dlq/:id/discard', async (req, res) => {
    try {
        const dlqId = parseInt(req.params.id);
        const { reason } = req.body;
        const { discardDLQItem } = require('../queues/queue-config');

        await discardDLQItem(dlqId, reason || 'Manually discarded');

        res.json({
            success: true,
            message: 'DLQ item discarded'
        });
    } catch (error) {
        console.error('Error discarding DLQ item:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================================================================
// Reaper Status Endpoint
// =========================================================================

/**
 * GET /api/reaper/status
 * Get reaper status and recent audit log
 */
router.get('/reaper/status', async (req, res) => {
    try {
        const reaperService = require('../services/reaper-service');
        const status = await reaperService.getReaperStatus(parseInt(req.query.limit) || 20);

        res.json({
            success: true,
            ...status
        });
    } catch (error) {
        console.error('Error fetching reaper status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/reaper/run
 * Manually trigger the reapers
 */
router.post('/reaper/run', async (req, res) => {
    try {
        const reaperService = require('../services/reaper-service');
        const results = await reaperService.runReapers();

        res.json({
            success: true,
            message: 'Reapers executed',
            results
        });
    } catch (error) {
        console.error('Error running reapers:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
