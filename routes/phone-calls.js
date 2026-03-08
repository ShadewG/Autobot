/**
 * Phone Call Queue Routes
 *
 * API for managing phone call escalation tasks.
 * Reasons include: no email response, details too complex for email,
 * portal failures, and clarification requests needing phone discussion.
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { transitionCaseRuntime, CaseLockContention } = require('../services/case-runtime');
const twilioVoiceService = require('../services/twilio-voice-service');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function transitionCaseRuntimeWithRetry(caseId, event, context = {}, options = {}) {
    const attempts = Number.isFinite(options.attempts) ? options.attempts : 4;
    const baseDelayMs = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : 150;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await transitionCaseRuntime(caseId, event, context);
        } catch (error) {
            lastError = error;
            const isLockError = error instanceof CaseLockContention || error?.name === 'CaseLockContention';
            if (!isLockError || attempt === attempts) {
                throw error;
            }
            await sleep(baseDelayMs * attempt);
        }
    }

    throw lastError || new Error(`transitionCaseRuntimeWithRetry failed for case ${caseId}`);
}

async function ensureCaseThread(caseId) {
    let thread = await db.getThreadByCaseId(caseId);
    if (thread) return thread;

    const threadResult = await db.query(`
        INSERT INTO email_threads (case_id, subject, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
        ON CONFLICT (case_id) DO UPDATE SET updated_at = NOW()
        RETURNING *
    `, [caseId, `Correspondence for case ${caseId}`]);
    return threadResult.rows[0];
}

async function appendAutomatedCallTranscript({ task, transcriptText, transcriptStatus, recordingUrl }) {
    const caseData = await db.getCaseById(task.case_id);
    const aiService = require('../services/ai-service');

    let summary = null;
    try {
        summary = await aiService.summarizePhoneCallForConversation({
            outcome: 'automated_status_check',
            notes: transcriptText || '',
            checked_points: ['automated_status_check'],
            case_name: caseData?.case_name,
            agency_name: task.agency_name || caseData?.agency_name,
        });
    } catch (error) {
        console.warn('Failed to summarize automated phone transcript:', error.message);
    }

    const thread = await ensureCaseThread(task.case_id);
    const bodyLines = [
        'Automated status check call transcript received.',
        transcriptStatus ? `Transcript status: ${transcriptStatus}.` : null,
        transcriptText ? `Transcript: ${transcriptText}` : 'Transcript unavailable.',
        recordingUrl ? `Recording: ${recordingUrl}` : null,
        summary?.recommended_follow_up ? `Recommended follow-up: ${summary.recommended_follow_up}` : null,
    ].filter(Boolean);

    const message = await db.createMessage({
        thread_id: thread.id,
        case_id: task.case_id,
        message_id: `phone-auto:${task.id}:${Date.now()}`,
        sendgrid_message_id: null,
        direction: 'inbound',
        from_email: task.agency_name || caseData?.agency_name || 'Agency Contact',
        to_email: 'Our Team',
        subject: 'Automated phone status check transcript',
        body_text: bodyLines.join('\n\n'),
        body_html: null,
        message_type: 'phone_call',
        portal_notification: false,
        sent_at: null,
        received_at: new Date(),
        summary: summary?.summary || null,
        metadata: {
            source: 'twilio_status_check',
            phone_call_task_id: task.id,
            agency_phone: task.agency_phone || null,
            transcript_status: transcriptStatus || null,
            recording_url: recordingUrl || null,
            transcript: transcriptText || null,
            ai_summary: summary || null,
        },
    });

    await db.query(`
        UPDATE phone_call_queue
        SET twilio_transcript_summary = $2,
            updated_at = NOW()
        WHERE id = $1
    `, [task.id, summary?.summary || transcriptText || null]);

    return { message, summary };
}

/**
 * GET /phone-calls
 * List phone call tasks, filterable by status
 */
router.get('/', async (req, res) => {
    try {
        const status = req.query.status;
        const limit = parseInt(req.query.limit) || 50;
        const userIdParam = req.query.user_id;
        const userId = userIdParam && userIdParam !== 'unowned' ? parseInt(userIdParam, 10) || null : null;
        const unownedOnly = userIdParam === 'unowned';

        let tasks;
        if (status) {
            tasks = await db.getPhoneCallsByStatus(status, limit);
        } else {
            tasks = await db.getPendingPhoneCalls(limit);
        }

        let stats = await db.getPhoneCallQueueStats();

        // Filter by user if specified
        if (userId || unownedOnly) {
            tasks = tasks.filter(t => {
                const caseUserId = t.user_id;
                if (userId) return caseUserId === userId;
                if (unownedOnly) return caseUserId == null;
                return true;
            });
            // Recompute stats from filtered tasks
            stats = {
                pending: tasks.filter(t => t.status === 'pending').length,
                claimed: tasks.filter(t => t.status === 'claimed').length,
                completed: 0,
                skipped: 0
            };
        }

        res.json({
            success: true,
            count: tasks.length,
            stats,
            tasks
        });
    } catch (error) {
        console.error('Error fetching phone calls:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /phone-calls
 * Create a new phone call task from the dashboard
 * Body: { case_id, reason, notes }
 */
router.post('/', async (req, res) => {
    try {
        const { case_id, reason, notes } = req.body;

        if (!case_id) {
            return res.status(400).json({ success: false, error: 'case_id is required' });
        }

        // Check for existing pending/claimed task for this case
        const existing = await db.getPhoneCallByCaseId(case_id);
        if (existing && (existing.status === 'pending' || existing.status === 'claimed')) {
            return res.json({
                success: true,
                message: 'Case already in phone queue',
                task: existing,
                already_exists: true
            });
        }

        // Load case data for auto-populating fields
        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        // Get agency phone if available
        let agencyPhone = null;
        if (caseData.agency_id) {
            try {
                const agencyResult = await db.query(
                    'SELECT phone FROM agencies WHERE id = $1', [caseData.agency_id]
                );
                if (agencyResult.rows[0]?.phone) agencyPhone = agencyResult.rows[0].phone;
            } catch (e) { /* ignore */ }
        }

        const task = await db.createPhoneCallTask({
            case_id,
            agency_name: caseData.agency_name,
            agency_phone: agencyPhone,
            agency_state: caseData.state,
            reason: reason || 'manual_add',
            priority: 1,
            notes: notes || 'Added manually from dashboard',
            days_since_sent: caseData.send_date
                ? Math.floor((Date.now() - new Date(caseData.send_date).getTime()) / 86400000)
                : null
        });

        await db.logActivity('phone_call_created',
            `Phone call task created manually for case ${case_id}: ${reason || 'manual_add'}`,
            { case_id }
        );

        // Fire-and-forget: generate AI briefing + auto-lookup phone if missing
        (async () => {
            try {
                const messages = await db.getMessagesByCaseId(case_id, 20);
                const aiService = require('../services/ai-service');
                const briefing = await aiService.generatePhoneCallBriefing(task, caseData, messages);
                await db.updatePhoneCallBriefing(task.id, briefing);
            } catch (err) {
                console.warn('Failed to auto-generate phone call briefing:', err.message);
            }
        })();

        // Fire-and-forget: auto-search for phone number if none on file
        if (!agencyPhone) {
            (async () => {
                try {
                    const notionService = require('../services/notion-service');
                    const pdContactService = require('../services/pd-contact-service');

                    const [notionResult, webResult, firecrawlResult] = await Promise.allSettled([
                        caseData.notion_page_id
                            ? notionService.lookupPhoneFromNotion(caseData.notion_page_id)
                            : Promise.resolve({ phone: null, pdPageId: null }),
                        caseData.agency_name
                            ? notionService.searchForAgencyPhone(caseData.agency_name, caseData.state)
                            : Promise.resolve({ phone: null, confidence: 'low' }),
                        caseData.agency_name
                            ? pdContactService.lookupContact(caseData.agency_name, caseData.state, { forceSearch: true })
                            : Promise.resolve(null)
                    ]);

                    const notion = notionResult.status === 'fulfilled' ? notionResult.value : { phone: null };
                    const web = webResult.status === 'fulfilled' ? webResult.value : { phone: null };
                    const firecrawl = firecrawlResult.status === 'fulfilled' ? firecrawlResult.value : null;

                    const phoneOptions = {
                        notion: { phone: notion.phone || null, source: 'Notion PD Card' },
                        web_search: { phone: web.phone || null, source: 'Web Search (Firecrawl+AI)', confidence: web.confidence || null },
                        firecrawl: firecrawl ? { phone: firecrawl.contact_phone || null, source: 'Firecrawl' } : null
                    };

                    const bestPhone = notion.phone || firecrawl?.contact_phone || web.phone || null;

                    const setClauses = ['phone_options = $1', 'updated_at = NOW()'];
                    const values = [JSON.stringify(phoneOptions)];
                    let paramIdx = 2;
                    if (bestPhone) {
                        setClauses.push(`agency_phone = $${paramIdx}`);
                        values.push(bestPhone);
                        paramIdx++;
                    }
                    values.push(task.id);
                    await db.query(
                        `UPDATE phone_call_queue SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
                        values
                    );

                    if (bestPhone && caseData.agency_id) {
                        await db.query(
                            'UPDATE agencies SET phone = $1 WHERE id = $2 AND (phone IS NULL OR phone = \'\')',
                            [bestPhone, caseData.agency_id]
                        );
                    }

                    console.log(`Auto phone lookup for task ${task.id}: found=${bestPhone || 'none'}`);
                } catch (err) {
                    console.warn('Failed to auto-lookup phone number:', err.message);
                }
            })();
        }

        res.json({ success: true, message: 'Phone call task created', task });
    } catch (error) {
        console.error('Error creating phone call:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /phone-calls/stats
 * Get queue statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await db.getPhoneCallQueueStats();
        res.json({ success: true, stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /phone-calls/:id/start-auto-call
 * Start an automated Twilio status check call for the task's current agency phone.
 */
router.post('/:id/start-auto-call', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const { initiatedBy } = req.body || {};

        const task = await db.getPhoneCallById(id);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Phone call task not found' });
        }
        if (task.status === 'completed' || task.status === 'skipped') {
            return res.status(409).json({ success: false, error: `Task is already ${task.status}` });
        }
        if (!twilioVoiceService.isConfigured()) {
            return res.status(503).json({ success: false, error: 'Twilio voice is not configured' });
        }
        if (!task.agency_phone) {
            return res.status(400).json({ success: false, error: 'Task does not have an agency phone number' });
        }

        const caseData = await db.getCaseById(task.case_id);
        const call = await twilioVoiceService.startStatusCheckCall({ task, caseData });
        const updatedResult = await db.query(`
            UPDATE phone_call_queue
            SET auto_call_mode = 'status_check',
                twilio_call_sid = $2,
                twilio_call_status = $3,
                twilio_call_started_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
        `, [id, call.callSid, call.status || 'queued']);

        await db.logActivity('phone_call_auto_started', `Started automated status-check call for task ${id}`, {
            case_id: task.case_id,
            actor_type: 'system',
            source_service: 'twilio_voice',
            phone_call_task_id: id,
            twilio_call_sid: call.callSid,
            agency_phone: task.agency_phone,
            initiated_by: initiatedBy || 'system',
        });

        return res.json({ success: true, task: updatedResult.rows[0], call });
    } catch (error) {
        const status = Number.isInteger(error.status) ? error.status : 500;
        return res.status(status).json({ success: false, error: error.message });
    }
});

/**
 * POST /phone-calls/twilio/status
 * Twilio call status callback.
 */
router.post('/twilio/status', async (req, res) => {
    try {
        const { CallSid, CallStatus, AnsweredBy, CallDuration } = req.body || {};
        if (!CallSid) {
            return res.status(400).json({ success: false, error: 'CallSid is required' });
        }

        const result = await db.query(`
            UPDATE phone_call_queue
            SET twilio_call_status = COALESCE($2, twilio_call_status),
                twilio_call_answered_by = COALESCE($3, twilio_call_answered_by),
                twilio_call_completed_at = CASE
                    WHEN COALESCE($2, '') IN ('completed', 'busy', 'failed', 'no-answer', 'canceled') THEN NOW()
                    ELSE twilio_call_completed_at
                END,
                updated_at = NOW()
            WHERE twilio_call_sid = $1
            RETURNING id, case_id
        `, [CallSid, CallStatus || null, AnsweredBy || null]);

        if (result.rows[0]) {
            await db.logActivity('phone_call_auto_status', `Twilio status update: ${CallStatus || 'unknown'}`, {
                case_id: result.rows[0].case_id,
                actor_type: 'system',
                source_service: 'twilio_voice',
                phone_call_task_id: result.rows[0].id,
                twilio_call_sid: CallSid,
                twilio_call_status: CallStatus || null,
                twilio_answered_by: AnsweredBy || null,
                twilio_call_duration: CallDuration || null,
            });
        }

        return res.status(200).send('ok');
    } catch (error) {
        return res.status(500).send(error.message);
    }
});

/**
 * POST /phone-calls/twilio/recording
 * Twilio recording callback.
 */
router.post('/twilio/recording', async (req, res) => {
    try {
        const { CallSid, RecordingSid, RecordingUrl, RecordingStatus } = req.body || {};
        if (!CallSid) {
            return res.status(400).json({ success: false, error: 'CallSid is required' });
        }

        const result = await db.query(`
            UPDATE phone_call_queue
            SET twilio_recording_sid = COALESCE($2, twilio_recording_sid),
                twilio_recording_url = COALESCE($3, twilio_recording_url),
                twilio_recording_status = COALESCE($4, twilio_recording_status),
                updated_at = NOW()
            WHERE twilio_call_sid = $1
            RETURNING id, case_id
        `, [CallSid, RecordingSid || null, RecordingUrl || null, RecordingStatus || null]);

        if (result.rows[0]) {
            await db.logActivity('phone_call_recording_received', 'Received Twilio phone call recording', {
                case_id: result.rows[0].case_id,
                actor_type: 'system',
                source_service: 'twilio_voice',
                phone_call_task_id: result.rows[0].id,
                twilio_call_sid: CallSid,
                twilio_recording_sid: RecordingSid || null,
                twilio_recording_url: RecordingUrl || null,
                twilio_recording_status: RecordingStatus || null,
            });
        }

        return res.status(200).send('ok');
    } catch (error) {
        return res.status(500).send(error.message);
    }
});

/**
 * POST /phone-calls/twilio/transcription
 * Twilio transcription callback.
 */
router.post('/twilio/transcription', async (req, res) => {
    try {
        const { CallSid, TranscriptionText, TranscriptionStatus } = req.body || {};
        if (!CallSid) {
            return res.status(400).json({ success: false, error: 'CallSid is required' });
        }

        const result = await db.query(`
            UPDATE phone_call_queue
            SET twilio_transcript = COALESCE($2, twilio_transcript),
                twilio_transcript_status = COALESCE($3, twilio_transcript_status),
                call_notes = COALESCE($2, call_notes),
                updated_at = NOW()
            WHERE twilio_call_sid = $1
            RETURNING *
        `, [CallSid, TranscriptionText || null, TranscriptionStatus || null]);
        const task = result.rows[0];

        if (!task) {
            return res.status(200).send('ok');
        }

        const transcriptResult = await appendAutomatedCallTranscript({
            task,
            transcriptText: TranscriptionText || '',
            transcriptStatus: TranscriptionStatus || 'completed',
            recordingUrl: task.twilio_recording_url || null,
        });

        await db.logActivity('phone_call_transcription_received', 'Received Twilio phone call transcription', {
            case_id: task.case_id,
            actor_type: 'system',
            source_service: 'twilio_voice',
            phone_call_task_id: task.id,
            twilio_call_sid: CallSid,
            transcript_status: TranscriptionStatus || 'completed',
            conversation_message_id: transcriptResult.message?.id || null,
        });

        return res.status(200).send('ok');
    } catch (error) {
        return res.status(500).send(error.message);
    }
});

/**
 * GET /phone-calls/:id
 * Get a single phone call task with details
 */
router.get('/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const task = await db.getPhoneCallById(id);

        if (!task) {
            return res.status(404).json({ success: false, error: 'Phone call task not found' });
        }

        res.json({ success: true, task });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /phone-calls/:id/claim
 * Claim a phone call task
 * Body: { assignedTo: "name" }
 */
router.post('/:id/claim', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { assignedTo } = req.body;

        const task = await db.getPhoneCallById(id);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Phone call task not found' });
        }

        if (task.status !== 'pending') {
            return res.status(409).json({
                success: false,
                error: `Task is already ${task.status}`,
                assigned_to: task.assigned_to
            });
        }

        const updated = await db.claimPhoneCall(id, assignedTo || 'unknown');
        if (!updated) {
            return res.status(409).json({ success: false, error: 'Task was already claimed' });
        }

        await db.logActivity('phone_call_claimed',
            `Phone call task ${id} claimed by ${assignedTo || 'unknown'}`,
            { case_id: task.case_id }
        );

        res.json({ success: true, message: 'Task claimed', task: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /phone-calls/:id/complete
 * Complete a phone call task
 * Body: { outcome, notes, completedBy }
 */
router.post('/:id/complete', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { outcome, notes, completedBy, checked_points } = req.body;

        const task = await db.getPhoneCallById(id);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Phone call task not found' });
        }

        if (task.status === 'completed') {
            return res.status(409).json({ success: false, error: 'Task already completed' });
        }

        // "Call later" outcomes: stay in queue at lower priority
        const RETRY_OUTCOMES = ['voicemail', 'no_answer', 'busy'];
        if (RETRY_OUTCOMES.includes(outcome)) {
            // Lower priority to move to bottom of queue, add note, keep pending
            await db.query(`
                UPDATE phone_call_queue
                SET priority = GREATEST(priority - 1, -5),
                    notes = COALESCE(notes, '') || E'\n' || $2,
                    call_outcome = $3,
                    status = 'pending',
                    updated_at = NOW()
                WHERE id = $1
            `, [id, `[${new Date().toISOString().slice(0, 16)}] ${outcome}: ${notes || 'no notes'}`, outcome]);

            await db.logActivity('phone_call_retry',
                `Phone call task ${id}: ${outcome} — staying in queue`,
                { case_id: task.case_id, outcome, notes }
            );

            return res.json({
                success: true,
                message: `${outcome} — call stays in queue for retry`,
                stays_in_queue: true,
                outcome
            });
        }

        const updated = await db.completePhoneCall(id, outcome, notes, completedBy || 'unknown');

        // Update case status based on outcome
        if (outcome === 'resolved') {
            await transitionCaseRuntimeWithRetry(task.case_id, 'CASE_RESPONDED', {
                substatus: 'Resolved via phone call',
                lastResponseDate: new Date().toISOString(),
            });
        } else if (outcome === 'connected' || outcome === 'transferred') {
            await transitionCaseRuntimeWithRetry(task.case_id, 'CASE_RECONCILED', {
                targetStatus: 'awaiting_response',
                substatus: `Phone call: ${outcome}${notes ? ' — ' + notes.substring(0, 100) : ''}`,
            });
        } else if (outcome === 'wrong_number') {
            // Clear the bad phone number
            await db.query('UPDATE phone_call_queue SET agency_phone = NULL WHERE id = $1', [id]);
        }

        await db.logActivity('phone_call_completed',
            `Phone call task ${id} completed: ${outcome}`,
            { case_id: task.case_id, outcome, notes, checked_points }
        );

        // Sync to Notion
        try {
            const notionService = require('../services/notion-service');
            await notionService.syncStatusToNotion(task.case_id);
        } catch (err) {
            console.warn('Failed to sync phone call completion to Notion:', err.message);
        }

        // Fire-and-forget: AI suggests next step based on call outcome
        let nextStepSuggestion = null;
        let callConversationSummary = null;
        let callConversationMessageId = null;
        const caseData = await db.getCaseById(task.case_id);
        if (notes && (outcome === 'connected' || outcome === 'resolved' || outcome === 'transferred')) {
            try {
                const aiService = require('../services/ai-service');
                nextStepSuggestion = await aiService.suggestNextStepAfterCall({
                    outcome,
                    notes,
                    checked_points: checked_points || [],
                    case_name: caseData?.case_name,
                    agency_name: caseData?.agency_name,
                    case_status: caseData?.status,
                });
            } catch (err) {
                console.warn('Failed to generate next step suggestion:', err.message);
            }
        }

        // Persist this phone-call outcome into the case conversation thread so it
        // appears alongside inbound/outbound correspondence in the UI.
        try {
            const aiService = require('../services/ai-service');
            callConversationSummary = await aiService.summarizePhoneCallForConversation({
                outcome,
                notes: notes || '',
                checked_points: checked_points || [],
                case_name: caseData?.case_name,
                agency_name: caseData?.agency_name,
            });

            let thread = await db.getThreadByCaseId(task.case_id);
            if (!thread) {
                const threadResult = await db.query(`
                    INSERT INTO email_threads (case_id, subject, created_at, updated_at)
                    VALUES ($1, $2, NOW(), NOW())
                    ON CONFLICT (case_id) DO UPDATE SET updated_at = NOW()
                    RETURNING *
                `, [task.case_id, `Correspondence for case ${task.case_id}`]);
                thread = threadResult.rows[0];
            }

            const callTimestamp = new Date().toISOString();
            const checkedPointsList = Array.isArray(checked_points) && checked_points.length > 0
                ? checked_points.join(', ')
                : null;

            const bodyLines = [
                `Phone call completed at ${callTimestamp}.`,
                `Outcome: ${outcome}.`,
                notes ? `Operator notes: ${notes}` : null,
                checkedPointsList ? `Talking points covered: ${checkedPointsList}` : null,
                callConversationSummary?.recommended_follow_up
                    ? `Recommended follow-up: ${callConversationSummary.recommended_follow_up}`
                    : null,
            ].filter(Boolean);

            const conversationMessage = await db.createMessage({
                thread_id: thread.id,
                case_id: task.case_id,
                message_id: `phone-call:${id}:${Date.now()}`,
                sendgrid_message_id: null,
                direction: 'inbound',
                from_email: task.agency_name || 'Agency Contact',
                to_email: 'Our Team',
                subject: `Phone call update — ${outcome.replace(/_/g, ' ')}`,
                body_text: bodyLines.join('\n\n'),
                body_html: null,
                message_type: 'phone_call',
                portal_notification: false,
                sent_at: null,
                received_at: new Date(),
                summary: callConversationSummary?.summary || null,
                metadata: {
                    source: 'phone_call_queue',
                    phone_call_task_id: id,
                    agency_phone: task.agency_phone || null,
                    contact_phone: task.agency_phone || null,
                    outcome,
                    completed_by: completedBy || 'unknown',
                    checked_points: checked_points || [],
                    ai_summary: callConversationSummary || null,
                    next_step: nextStepSuggestion || null,
                },
            });
            callConversationMessageId = conversationMessage?.id || null;
        } catch (err) {
            console.warn('Failed to write phone call summary into conversation:', err.message);
        }

        res.json({
            success: true,
            message: 'Task completed',
            task: updated,
            next_step: nextStepSuggestion,
            call_summary: callConversationSummary,
            conversation_message_id: callConversationMessageId,
            outcome
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /phone-calls/:id/skip
 * Skip/defer a phone call task
 * Body: { notes }
 */
router.post('/:id/skip', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { notes } = req.body;

        const task = await db.getPhoneCallById(id);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Phone call task not found' });
        }

        const updated = await db.skipPhoneCall(id, notes);

        await db.logActivity('phone_call_skipped',
            `Phone call task ${id} skipped: ${notes || 'no reason'}`,
            { case_id: task.case_id }
        );

        res.json({ success: true, message: 'Task skipped', task: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /phone-calls/:id/select-phone
 * Select a phone number from phone_options
 * Body: { phone, source }
 */
router.post('/:id/select-phone', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { phone, source } = req.body;

        if (!phone) {
            return res.status(400).json({ success: false, error: 'Phone number is required' });
        }

        const task = await db.getPhoneCallById(id);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Phone call task not found' });
        }

        await db.query(
            'UPDATE phone_call_queue SET agency_phone = $1, updated_at = NOW() WHERE id = $2',
            [phone, id]
        );

        await db.logActivity('phone_number_selected',
            `Phone number selected for task ${id}: ${phone} (source: ${source || 'manual'})`,
            { case_id: task.case_id }
        );

        res.json({ success: true, message: 'Phone number updated', phone });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /phone-calls/:id/find-phone
 * Run phone number lookup (Notion PD card + GPT web search + Firecrawl)
 * Returns the found phone number and all options
 */
router.post('/:id/find-phone', async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        const task = await db.getPhoneCallById(id);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Phone call task not found' });
        }

        const caseData = await db.getCaseById(task.case_id);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        const notionService = require('../services/notion-service');
        const pdContactService = require('../services/pd-contact-service');

        // Run all lookups in parallel:
        // 1. Notion PD card (via case's notion_page_id relation)
        // 2. GPT web search
        // 3. Firecrawl deep search (also returns email, portal, etc.)
        const [notionResult, webResult, firecrawlResult] = await Promise.allSettled([
            caseData.notion_page_id
                ? notionService.lookupPhoneFromNotion(caseData.notion_page_id)
                : Promise.resolve({ phone: null, pdPageId: null }),
            caseData.agency_name
                ? notionService.searchForAgencyPhone(caseData.agency_name, caseData.state)
                : Promise.resolve({ phone: null, confidence: 'low', reasoning: 'No agency name' }),
            caseData.agency_name
                ? pdContactService.lookupContact(caseData.agency_name, caseData.state, { forceSearch: true })
                : Promise.resolve(null)
        ]);

        const notion = notionResult.status === 'fulfilled' ? notionResult.value : { phone: null };
        const web = webResult.status === 'fulfilled' ? webResult.value : { phone: null };
        const firecrawl = firecrawlResult.status === 'fulfilled' ? firecrawlResult.value : null;

        // Build phone_options
        const phoneOptions = {
            notion: {
                phone: notion.phone || null,
                source: 'Notion PD Card',
                pd_page_id: notion.pdPageId || null,
                pd_page_url: notion.pdPageId
                    ? `https://www.notion.so/${notion.pdPageId.replace(/-/g, '')}`
                    : null
            },
            web_search: {
                phone: web.phone || null,
                source: 'Web Search (Firecrawl+AI)',
                confidence: web.confidence || null,
                reasoning: web.reasoning || null
            },
            firecrawl: firecrawl ? {
                phone: firecrawl.contact_phone || null,
                source: 'Firecrawl Deep Search',
                confidence: firecrawl.confidence || null,
                portal_url: firecrawl.portal_url || null,
                contact_email: firecrawl.contact_email || null,
                records_officer: firecrawl.records_officer || null
            } : null
        };

        // Pick best phone: Notion > Firecrawl > Web Search
        const bestPhone = notion.phone
            || firecrawl?.contact_phone
            || web.phone
            || null;

        // Update phone_call_queue
        const setClauses = ['phone_options = $1', 'updated_at = NOW()'];
        const values = [JSON.stringify(phoneOptions)];
        let paramIdx = 2;

        if (bestPhone) {
            setClauses.push(`agency_phone = $${paramIdx}`);
            values.push(bestPhone);
            paramIdx++;
        }

        values.push(id);
        await db.query(
            `UPDATE phone_call_queue SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
            values
        );

        // Also update agencies table if we found a phone
        if (bestPhone && caseData.agency_id) {
            await db.query(
                'UPDATE agencies SET phone = $1 WHERE id = $2 AND (phone IS NULL OR phone = \'\')',
                [bestPhone, caseData.agency_id]
            );
        }

        await db.logActivity('phone_lookup_completed',
            `Phone lookup for task ${id}: found=${bestPhone || 'none'} (notion=${notion.phone || 'none'}, web=${web.phone || 'none'}, firecrawl=${firecrawl?.contact_phone || 'none'})`,
            { case_id: task.case_id }
        );

        res.json({
            success: true,
            phone: bestPhone,
            phone_options: phoneOptions,
            found: !!bestPhone
        });
    } catch (error) {
        console.error('Error finding phone number:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /phone-calls/:id/briefing
 * Generate or retrieve cached AI call briefing
 * Query: ?force=true to regenerate
 */
router.post('/:id/briefing', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const force = req.query.force === 'true';

        const task = await db.getPhoneCallById(id);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Phone call task not found' });
        }

        // Return cached if available and not forcing regeneration
        if (task.ai_briefing && !force) {
            return res.json({ success: true, briefing: task.ai_briefing, cached: true });
        }

        // Load case data and messages
        const caseData = await db.getCaseById(task.case_id);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        const messages = await db.getMessagesByCaseId(task.case_id, 20);

        const aiService = require('../services/ai-service');
        const briefing = await aiService.generatePhoneCallBriefing(task, caseData, messages);

        // Cache the briefing
        await db.updatePhoneCallBriefing(id, briefing);

        res.json({ success: true, briefing, cached: false });
    } catch (error) {
        console.error('Error generating briefing:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
