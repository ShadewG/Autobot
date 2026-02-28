const express = require('express');
const router = express.Router();
const {
    db,
    notify,
    normalizePortalUrl,
    isSupportedPortalUrl,
    detectPortalProviderByUrl,
    pdContactService
} = require('./_helpers');

/**
 * GET /api/monitor/cases
 * Case-centric monitoring list with progress signals.
 */
router.get('/cases', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
        const status = req.query.status || null;
        const userIdParam = req.query.user_id;
        const params = [];
        const whereParts = [];

        if (status) {
            params.push(status);
            whereParts.push(`c.status = $${params.length}`);
        }

        if (userIdParam === 'unowned') {
            whereParts.push('c.user_id IS NULL');
        } else if (userIdParam && !isNaN(parseInt(userIdParam))) {
            params.push(parseInt(userIdParam));
            whereParts.push(`c.user_id = $${params.length}`);
        }

        const whereClause = whereParts.length > 0 ? 'WHERE ' + whereParts.join(' AND ') : '';

        params.push(limit);
        const limitParam = `$${params.length}`;

        const result = await db.query(`
            SELECT
                c.id,
                c.case_name,
                c.agency_name,
                c.subject_name,
                c.status,
                c.substatus,
                c.agency_email,
                c.portal_url,
                c.created_at,
                c.updated_at,
                c.user_id,
                c.deadline_date,
                c.send_date,
                c.last_contact_research_at,
                c.tags,
                c.priority,
                c.outcome_type,
                CASE
                    WHEN c.deadline_date IS NOT NULL AND c.deadline_date < CURRENT_DATE
                         AND c.status IN ('sent', 'awaiting_response')
                    THEN (CURRENT_DATE - c.deadline_date::date)
                    ELSE 0
                END AS days_overdue,
                CASE
                    WHEN c.deadline_date IS NOT NULL AND c.deadline_date >= CURRENT_DATE
                         AND c.status IN ('sent', 'awaiting_response')
                    THEN (c.deadline_date::date - CURRENT_DATE)
                    ELSE NULL
                END AS days_remaining,
                u.name AS user_name,
                u.email_handle AS user_handle,
                msg_counts.total_messages,
                msg_counts.inbound_messages,
                msg_counts.outbound_messages,
                last_msg.last_message_at,
                last_msg.last_message_subject,
                proposal_counts.pending_approvals,
                active_run.id AS active_run_id,
                active_run.status AS active_run_status,
                active_run.trigger_type AS active_run_trigger_type
            FROM cases c
            LEFT JOIN users u ON c.user_id = u.id
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*)::int AS total_messages,
                    COUNT(*) FILTER (WHERE m.direction = 'inbound')::int AS inbound_messages,
                    COUNT(*) FILTER (WHERE m.direction = 'outbound')::int AS outbound_messages
                FROM messages m
                WHERE m.case_id = c.id
            ) msg_counts ON true
            LEFT JOIN LATERAL (
                SELECT
                    COALESCE(m.received_at, m.sent_at, m.created_at) AS last_message_at,
                    m.subject AS last_message_subject
                FROM messages m
                WHERE m.case_id = c.id
                ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at) DESC
                LIMIT 1
            ) last_msg ON true
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*) FILTER (WHERE p.status = 'PENDING_APPROVAL')::int AS pending_approvals
                FROM proposals p
                WHERE p.case_id = c.id
            ) proposal_counts ON true
            LEFT JOIN LATERAL (
                SELECT
                    r.id,
                    r.status,
                    r.trigger_type
                FROM agent_runs r
                WHERE r.case_id = c.id
                  AND r.status IN ('created', 'queued', 'running', 'paused')
                ORDER BY r.started_at DESC
                LIMIT 1
            ) active_run ON true
            ${whereClause}
            ORDER BY c.updated_at DESC
            LIMIT ${limitParam}
        `, params);

        res.json({ success: true, cases: result.rows, count: result.rows.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/monitor/case/:id
 * Full case inspection view with correspondence and progress.
 */
router.get('/case/:id', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        if (!caseId) {
            return res.status(400).json({ success: false, error: 'Invalid case id' });
        }

        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return res.status(404).json({ success: false, error: `Case ${caseId} not found` });
        }

        const portalAccount = caseData.portal_url
            ? await db.getPortalAccountByUrl(caseData.portal_url, caseData.user_id || null).catch(() => null)
            : null;

        const [threadResult, messagesResult, runsResult, proposalsResult, portalTasksResult, caseAgencies] = await Promise.all([
            db.query(`
                SELECT *
                FROM email_threads
                WHERE case_id = $1
                ORDER BY created_at DESC
                LIMIT 1
            `, [caseId]),
            db.query(`
                SELECT
                    id, direction, from_email, to_email, subject, body_text, body_html,
                    message_type, sendgrid_message_id, sent_at, received_at, created_at,
                    processed_at, processed_run_id, summary
                FROM messages
                WHERE case_id = $1
                ORDER BY COALESCE(received_at, sent_at, created_at) DESC
                LIMIT 300
            `, [caseId]),
            db.query(`
                SELECT
                    id, trigger_type, status, started_at, ended_at, error, autopilot_mode,
                    proposal_id, message_id, metadata
                FROM agent_runs
                WHERE case_id = $1
                ORDER BY started_at DESC
                LIMIT 100
            `, [caseId]),
            db.query(`
                SELECT
                    id, action_type, status, confidence, trigger_message_id, run_id,
                    draft_subject, draft_body_text, reasoning, created_at, updated_at, execution_key, email_job_id,
                    human_decision
                FROM proposals
                WHERE case_id = $1
                ORDER BY created_at DESC
                LIMIT 100
            `, [caseId]),
            db.query(`
                SELECT
                    id, status, portal_url, action_type, proposal_id,
                    assigned_to, completed_at, completion_notes, created_at, updated_at,
                    subject, body_text, instructions, confirmation_number
                FROM portal_tasks
                WHERE case_id = $1
                ORDER BY created_at DESC
                LIMIT 100
            `, [caseId]).catch(() => ({ rows: [] })),
            db.getCaseAgencies(caseId).catch(() => [])
        ]);

        res.json({
            success: true,
            case: caseData,
            thread: threadResult.rows[0] || null,
            messages: messagesResult.rows,
            runs: runsResult.rows,
            proposals: proposalsResult.rows,
            portal_tasks: portalTasksResult.rows,
            portal_account: portalAccount ? { email: portalAccount.email, password: portalAccount.password } : null,
            case_agencies: caseAgencies
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/monitor/cases/:id/audit
 * Return recent human actions for a case (audit trail)
 */
router.get('/cases/:id/audit', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id);
        const limit = parseInt(req.query.limit) || 10;
        const result = await db.query(`
            SELECT id, event_type, description, meta_jsonb, created_at, user_id
            FROM activity_log
            WHERE case_id = $1
            AND event_type IN (
                'proposal_approved', 'proposal_dismissed', 'proposal_adjusted',
                'human_decision', 'request_withdrawn', 'scope_item_updated',
                'email_sent', 'outbound_sent', 'portal_workflow_triggered',
                'human_review_proposal_created', 'agent_decision',
                'case_status_fix', 'manual_ai_trigger'
            )
            ORDER BY created_at DESC
            LIMIT $2
        `, [caseId, limit]);
        res.json({ success: true, actions: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/reset-state
 * Operational reset for clean slate testing.
 * Does not delete cases/messages/history; it closes active runs and dismisses pending approvals.
 */
router.post('/reset-state', express.json(), async (req, res) => {
    try {
        const resetRunsResult = await db.query(`
            UPDATE agent_runs
            SET status = 'failed',
                ended_at = COALESCE(ended_at, NOW()),
                error = COALESCE(error, 'Manual reset from monitor')
            WHERE status IN ('queued', 'running', 'paused')
            RETURNING id
        `);

        const dismissProposalsResult = await db.query(`
            UPDATE proposals
            SET status = 'DISMISSED',
                human_decision = COALESCE(
                    human_decision,
                    jsonb_build_object(
                        'action', 'DISMISS',
                        'reason', 'Manual reset from monitor',
                        'decidedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                        'decidedBy', 'monitor-reset'
                    )
                ),
                updated_at = NOW()
            WHERE status IN ('PENDING_APPROVAL', 'DECISION_RECEIVED')
            RETURNING id
        `);

        await db.logActivity('monitor_reset_state', 'Monitor reset operational state', {
            runs_reset: resetRunsResult.rowCount,
            proposals_dismissed: dismissProposalsResult.rowCount
        });

        res.json({
            success: true,
            message: 'Operational state reset',
            runs_reset: resetRunsResult.rowCount,
            proposals_dismissed: dismissProposalsResult.rowCount
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/monitor/case/:id/lookup-contact
 * Trigger a pd-contact lookup in the background. Returns immediately.
 */
router.post('/case/:id/lookup-contact', express.json(), async (req, res) => {
    const caseId = parseInt(req.params.id, 10);
    if (!caseId) return res.status(400).json({ success: false, error: 'Invalid case id' });
    const forceSearch = req.body?.forceSearch === true;

    const caseData = await db.getCaseById(caseId);
    if (!caseData) return res.status(404).json({ success: false, error: 'Case not found' });

    res.json({ success: true, message: 'Contact lookup started' });

    // Run in background
    (async () => {
        try {
            notify('info', forceSearch
                ? `Web-searching contacts for ${caseData.agency_name || caseData.case_name}...`
                : `Looking up contacts for ${caseData.agency_name || caseData.case_name}...`,
                { case_id: caseId });

            let result;
            try {
                result = await pdContactService.lookupContact(
                    caseData.agency_name,
                    caseData.state || caseData.incident_location,
                    { forceSearch }
                );
            } catch (lookupErr) {
                if (lookupErr.code === 'SERVICE_UNAVAILABLE') {
                    notify('error', `PD Contact service not reachable — is PD_CONTACT_API_URL set and the foia-researcher running?`, { case_id: caseId });
                } else {
                    notify('error', `Contact lookup failed: ${lookupErr.message}`, { case_id: caseId });
                }
                return;
            }

            if (!result || (!result.portal_url && !result.contact_email)) {
                notify('warning', `No contacts found for ${caseData.agency_name || caseData.case_name}`, { case_id: caseId });
                await db.updateCase(caseId, {
                    last_contact_research_at: new Date(),
                    contact_research_notes: 'pd-contact lookup returned no results'
                });
                return;
            }

            const updates = {
                last_contact_research_at: new Date(),
                contact_research_notes: [
                    result.notes,
                    result.records_officer ? `Records officer: ${result.records_officer}` : null,
                    `Source: ${result.source || 'pd-contact'}`,
                    `Confidence: ${result.confidence || 'unknown'}`
                ].filter(Boolean).join('. ')
            };

            if (result.contact_email && result.contact_email !== caseData.agency_email) {
                updates.alternate_agency_email = result.contact_email;
            }
            if (result.portal_url) {
                const normalized = normalizePortalUrl(result.portal_url);
                if (normalized && isSupportedPortalUrl(normalized)) {
                    updates.portal_url = normalized;
                    updates.portal_provider = result.portal_provider || detectPortalProviderByUrl(normalized)?.name || null;
                }
            }

            await db.updateCase(caseId, updates);

            // Create a case_agency row if research found an alternative email/portal
            if (result.contact_email && result.contact_email !== caseData.agency_email) {
                try {
                    await db.addCaseAgency(caseId, {
                        agency_name: result.agency_name || caseData.agency_name || 'Researched Agency',
                        agency_email: result.contact_email,
                        portal_url: updates.portal_url || null,
                        portal_provider: updates.portal_provider || null,
                        added_source: 'research',
                        notes: updates.contact_research_notes || null
                    });
                } catch (caErr) {
                    console.warn(`Failed to create case_agency from research: ${caErr.message}`);
                }
            }

            const parts = [];
            if (updates.portal_url) parts.push(`portal: ${updates.portal_url}`);
            if (updates.alternate_agency_email) parts.push(`email: ${updates.alternate_agency_email}`);
            if (result.contact_phone) parts.push(`phone: ${result.contact_phone}`);

            const fromNotion = !!result.fromNotion;
            notify('success', `Found contacts for ${caseData.agency_name || caseData.case_name}: ${parts.join(', ') || 'see research notes'}${fromNotion ? ' (from Notion cache)' : ''}`, { case_id: caseId, fromNotion });

            await db.logActivity('pd_contact_lookup', `PD contact lookup completed for case ${caseData.case_name}`, {
                case_id: caseId,
                portal_url: updates.portal_url || null,
                email: updates.alternate_agency_email || null,
                confidence: result.confidence
            });
        } catch (err) {
            console.error(`PD contact lookup failed for case ${caseId}:`, err.message);
            notify('error', `Contact lookup failed for ${caseData.agency_name || caseData.case_name}: ${err.message}`, { case_id: caseId });
        }
    })();
});

// =========================================================================
// Feature 2: Fee History
// =========================================================================

router.get('/case/:id/fee-history', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        if (!caseId) return res.status(400).json({ success: false, error: 'Invalid case id' });
        const history = await db.getFeeHistoryByCaseId(caseId);
        res.json({ success: true, fee_history: history });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================================================================
// Feature 6: Attachments list for a case
// =========================================================================

router.get('/case/:id/attachments', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        if (!caseId) return res.status(400).json({ success: false, error: 'Invalid case id' });
        const attachments = await db.getAttachmentsByCaseId(caseId);
        res.json({ success: true, attachments });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
