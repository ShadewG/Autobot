const express = require('express');
const router = express.Router();
const { db, logger, toRequestListItem, toRequestDetail, toThreadMessage, toTimelineEvent, dedupeTimelineEvents, buildDeadlineMilestones, attachActivePortalTask, parseScopeItems, parseConstraints, parseFeeQuote, safeJsonParse, extractAgencyCandidatesFromResearchNotes, resolveReviewState, resolveControlState, detectControlMismatches, STATUS_MAP, buildDueInfo, detectReviewReason, businessDaysDiff } = require('./_helpers');

/**
 * GET /api/requests
 * List requests with filters
 */
router.get('/', async (req, res) => {
    try {
        const { requires_human, status, agency_id, q } = req.query;

        const includeCompleted = req.query.include_completed === 'true';

        let query = `
            SELECT
                c.*,
                ar.status AS active_run_status,
                ar.trigger_type AS active_run_trigger_type,
                ar.started_at AS active_run_started_at,
                ar.trigger_run_id AS active_run_trigger_run_id,
                pt.status AS active_portal_task_status,
                pt.action_type AS active_portal_task_type,
                pp.status AS active_proposal_status
            FROM cases c
            LEFT JOIN LATERAL (
                SELECT
                    status,
                    trigger_type,
                    started_at,
                    COALESCE(metadata->>'triggerRunId', metadata->>'trigger_run_id') AS trigger_run_id
                FROM agent_runs
                WHERE case_id = c.id
                  AND status IN ('created', 'queued', 'processing', 'waiting', 'running')
                ORDER BY started_at DESC NULLS LAST, id DESC
                LIMIT 1
            ) ar ON TRUE
            LEFT JOIN LATERAL (
                SELECT status, action_type
                FROM portal_tasks
                WHERE case_id = c.id
                  AND status IN ('PENDING', 'IN_PROGRESS')
                ORDER BY updated_at DESC NULLS LAST, id DESC
                LIMIT 1
            ) pt ON TRUE
            LEFT JOIN LATERAL (
                SELECT status
                FROM proposals
                WHERE case_id = c.id
                  AND status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED')
                ORDER BY created_at DESC
                LIMIT 1
            ) pp ON TRUE
            WHERE (c.notion_page_id IS NULL OR c.notion_page_id NOT LIKE 'test-%')
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
        const rawCaseData = await db.getCaseById(requestId);
        const caseData = await attachActivePortalTask(rawCaseData);

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
        const rawCaseData = await db.getCaseById(requestId);
        const caseData = await attachActivePortalTask(rawCaseData);
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

            // Fetch attachments for the case and group by message_id
            const caseAttachments = await db.getAttachmentsByCaseId(requestId);
            const attachmentsByMessageId = {};
            for (const att of caseAttachments) {
                if (!attachmentsByMessageId[att.message_id]) {
                    attachmentsByMessageId[att.message_id] = [];
                }
                attachmentsByMessageId[att.message_id].push({
                    id: att.id,
                    filename: att.filename,
                    content_type: att.content_type,
                    size_bytes: att.size_bytes,
                    url: att.storage_url || null,
                });
            }

            // Build thread messages with analysis data attached
            threadMessages = messages.map(msg => {
                const tm = toThreadMessage(msg, attachmentsByMessageId[msg.id] || []);
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
        const timelineEvents = dedupeTimelineEvents(activityResult.rows.map(a => toTimelineEvent(a, analysisMap)));

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

        // Resolve canonical agency id for deep-linking to /agencies/detail.
        // Never use case id as an agency id.
        let resolvedAgencyId = caseData.agency_id || null;
        let resolvedAgencyName = null;
        if (!resolvedAgencyId && caseData.agency_name) {
            const agencyLookup = await db.query(
                `SELECT id
                 FROM agencies
                 WHERE name = $1
                    OR LOWER(name) = LOWER($1)
                    OR name ILIKE $2
                 ORDER BY
                    CASE WHEN name = $1 THEN 0
                         WHEN LOWER(name) = LOWER($1) THEN 1
                         ELSE 2
                    END
                 LIMIT 1`,
                [caseData.agency_name, `%${caseData.agency_name}%`]
            );
            resolvedAgencyId = agencyLookup.rows[0]?.id || null;
        }
        if (!resolvedAgencyId && caseData.portal_url) {
            const agencyLookupByPortal = await db.query(
                `SELECT id
                 FROM agencies
                 WHERE portal_url = $1 OR portal_url_alt = $1
                 LIMIT 1`,
                [caseData.portal_url]
            );
            resolvedAgencyId = agencyLookupByPortal.rows[0]?.id || null;
        }
        if (!resolvedAgencyId && caseData.agency_email) {
            const agencyLookupByEmail = await db.query(
                `SELECT id
                 FROM agencies
                 WHERE LOWER(email_main) = LOWER($1)
                    OR LOWER(email_foia) = LOWER($1)
                 LIMIT 1`,
                [caseData.agency_email]
            );
            resolvedAgencyId = agencyLookupByEmail.rows[0]?.id || null;
        }
        if (resolvedAgencyId) {
            const canonicalAgency = await db.query(
                `SELECT name
                 FROM agencies
                 WHERE id = $1
                 LIMIT 1`,
                [resolvedAgencyId]
            );
            resolvedAgencyName = canonicalAgency.rows[0]?.name || null;
        }

        const agencySummary = {
            id: resolvedAgencyId != null ? String(resolvedAgencyId) : '',
            name: resolvedAgencyName || caseData.agency_name || '—',
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

        const caseAgencies = await db.getCaseAgencies(requestId, false);
        let sortedCaseAgencies = [...caseAgencies].sort((a, b) => {
            if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
            const aStatus = String(a.status || 'pending').toLowerCase();
            const bStatus = String(b.status || 'pending').toLowerCase();
            const rank = { active: 0, pending: 1, researching: 2, inactive: 3 };
            const ar = rank[aStatus] ?? 9;
            const br = rank[bStatus] ?? 9;
            if (ar !== br) return ar - br;
            return new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
        });
        // Backfill: create a real case_agencies row from the case record so buttons work.
        if (sortedCaseAgencies.length === 0 && (caseData.agency_name || caseData.agency_email || caseData.portal_url)) {
            try {
                const backfilled = await db.addCaseAgency(requestId, {
                    agency_id: resolvedAgencyId || null,
                    agency_name: resolvedAgencyName || caseData.agency_name || '—',
                    agency_email: caseData.agency_email || null,
                    portal_url: caseData.portal_url || null,
                    portal_provider: caseData.portal_provider || null,
                    is_primary: true,
                    added_source: 'case_row_backfill',
                    status: 'active',
                });
                sortedCaseAgencies = [backfilled];
            } catch (backfillErr) {
                console.warn(`[workspace] Failed to backfill case_agencies for case ${requestId}:`, backfillErr.message);
                // Fall back to synthetic entry so the UI still renders
                sortedCaseAgencies = [{
                    id: -requestId,
                    case_id: requestId,
                    agency_id: resolvedAgencyId || null,
                    agency_name: resolvedAgencyName || caseData.agency_name || '—',
                    agency_email: caseData.agency_email || null,
                    portal_url: caseData.portal_url || null,
                    portal_provider: caseData.portal_provider || null,
                    is_primary: true,
                    is_active: true,
                    added_source: 'case_row_fallback',
                    status: 'active',
                    created_at: caseData.created_at,
                    updated_at: caseData.updated_at,
                }];
            }
        }
        const agencyCandidates = extractAgencyCandidatesFromResearchNotes(caseData.contact_research_notes);

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

        // Fetch latest active proposal (includes DECISION_RECEIVED for review_state)
        const pendingProposalResult = await db.query(`
            SELECT id, action_type, status, draft_subject, draft_body_text, reasoning, waitpoint_token, pause_reason, confidence, gate_options
            FROM proposals
            WHERE case_id = $1 AND status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED')
            ORDER BY created_at DESC
            LIMIT 1
        `, [requestId]);
        const pendingProposal = pendingProposalResult.rows[0] || null;

        // Build portal_helper for SUBMIT_PORTAL proposals — one-stop copy-paste cheat sheet
        let portalHelper = null;
        if (pendingProposal?.action_type === 'SUBMIT_PORTAL') {
            const caseOwner = caseData.user_id ? await db.getUserById(caseData.user_id) : null;
            const ownerName = caseOwner?.name || process.env.REQUESTER_NAME || 'Samuel Hylton';
            const ownerEmail = caseOwner?.email || process.env.REQUESTER_EMAIL || 'sam@foib-request.com';
            const ownerPhone = caseOwner?.signature_phone || process.env.REQUESTER_PHONE || '209-800-7702';
            const ownerOrg = caseOwner
                ? (caseOwner.signature_organization ?? '')
                : (process.env.REQUESTER_ORG || 'Dr Insanity / FOIA Request Team');
            const ownerTitle = caseOwner?.signature_title || process.env.REQUESTER_TITLE || 'Documentary Researcher';

            const rawRecords = caseData.requested_records;
            let recordsList = [];
            if (Array.isArray(rawRecords)) {
                recordsList = rawRecords;
            } else if (typeof rawRecords === 'string') {
                try { recordsList = JSON.parse(rawRecords); } catch { recordsList = [rawRecords]; }
            }

            portalHelper = {
                portal_url: agencySummary?.portal_url || caseData.portal_url || null,
                agency_name: resolvedAgencyName || caseData.agency_name || null,
                requester: {
                    name: ownerName,
                    email: ownerEmail,
                    phone: ownerPhone,
                    organization: ownerOrg,
                    title: ownerTitle,
                },
                address: {
                    line1: caseOwner?.address_street || process.env.REQUESTER_ADDRESS || '3021 21st Ave W',
                    line2: caseOwner?.address_street2 || process.env.REQUESTER_ADDRESS_LINE2 || 'Apt 202',
                    city: caseOwner?.address_city || process.env.REQUESTER_CITY || 'Seattle',
                    state: caseOwner?.address_state || process.env.REQUESTER_STATE || 'WA',
                    zip: caseOwner?.address_zip || process.env.REQUESTER_ZIP || '98199',
                },
                case_info: {
                    subject_name: caseData.subject_name || caseData.case_name || null,
                    incident_date: caseData.incident_date || null,
                    incident_location: caseData.incident_location || null,
                    requested_records: recordsList,
                    additional_details: caseData.additional_details || null,
                },
                fee_waiver_reason: 'Non-commercial documentary / public interest',
                preferred_delivery: 'electronic',
            };
        }

        const agentDecisionsResult = await db.query(
            `SELECT id, reasoning, action_taken, confidence, trigger_type, outcome, created_at
             FROM agent_decisions
             WHERE case_id = $1
             ORDER BY created_at DESC
             LIMIT 100`,
            [requestId]
        );
        const agentDecisions = agentDecisionsResult.rows;

        // Fetch active agent run for review_state
        const activeRunResult = await db.query(`
            SELECT
                id,
                status,
                trigger_type,
                started_at,
                metadata->>'triggerRunId' AS trigger_run_id,
                metadata->>'trigger_run_id' AS trigger_run_id_legacy,
                metadata->>'current_node' AS current_node,
                COALESCE(
                    metadata->>'skyvern_task_url',
                    metadata->>'skyvernTaskUrl',
                    metadata->>'portal_task_url',
                    metadata->>'portalTaskUrl'
                ) AS skyvern_task_url
            FROM agent_runs
            WHERE case_id = $1 AND status IN ('created', 'queued', 'processing', 'waiting', 'running')
            ORDER BY started_at DESC NULLS LAST
            LIMIT 1
        `, [requestId]);
        const activeRun = activeRunResult.rows[0]
            ? {
                ...activeRunResult.rows[0],
                trigger_run_id: activeRunResult.rows[0].trigger_run_id || activeRunResult.rows[0].trigger_run_id_legacy || null
            }
            : null;

        // Compute derived review_state
        const review_state = resolveReviewState({
            caseData: rawCaseData,
            activeProposal: pendingProposal,
            activeRun,
        });
        const control_mismatches = detectControlMismatches({
            caseData: rawCaseData,
            reviewState: review_state,
            pendingProposal,
            activeRun,
            activePortalTaskStatus: caseData.active_portal_task_status || null,
        });
        const control_state = resolveControlState({
            caseData: rawCaseData,
            reviewState: review_state,
            pendingProposal,
            activeRun,
            activePortalTaskStatus: caseData.active_portal_task_status || null,
        });
        if (control_mismatches.length > 0) {
            logger.warn('[control-state-mismatch]', {
                case_id: requestId,
                review_state,
                control_state,
                mismatch_codes: control_mismatches.map((m) => m.code),
                active_run_status: activeRun?.status || null,
                active_portal_task_status: caseData.active_portal_task_status || null,
                requires_human: Boolean(rawCaseData?.requires_human),
            });
        }

        const requestDetail = toRequestDetail(caseData);
        if (resolvedAgencyName) {
            requestDetail.agency_name = resolvedAgencyName;
        }
        // Keep workspace request fields aligned with derived state to prevent
        // transient "needs decision" UI while an execution run is active.
        requestDetail.requires_human = review_state === 'DECISION_REQUIRED';
        if (review_state !== 'DECISION_REQUIRED') {
            requestDetail.pause_reason = null;
        }

        res.json({
            success: true,
            request: requestDetail,
            timeline_events: timelineEvents,
            thread_messages: threadMessages,
            next_action_proposal: nextActionProposal,
            agency_summary: agencySummary,
            case_agencies: sortedCaseAgencies,
            agency_candidates: agencyCandidates,
            deadline_milestones: deadlineMilestones,
            state_deadline: stateDeadline,
            pending_proposal: pendingProposal,
            portal_helper: portalHelper,
            review_state,
            control_state,
            control_mismatches,
            active_run: activeRun,
            agent_decisions: agentDecisions,
        });
    } catch (error) {
        console.error('Error fetching request workspace:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
