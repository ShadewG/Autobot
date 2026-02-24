const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PORTAL_ACTIVITY_EVENTS = require('../utils/portal-activity-events');
const { DRAFT_REQUIRED_ACTIONS } = require('../constants/action-types');
const { emitDataUpdate } = require('./event-bus');

class DatabaseService {
    constructor() {
        this.pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
            // Keep connections alive through Railway's proxy (prevents "Connection is closed" errors)
            keepAlive: true,
            keepAliveInitialDelayMillis: 10000,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000
        });

        this.pool.on('error', (err) => {
            console.error('Unexpected database error:', err);
        });
    }

    async query(text, params) {
        const start = Date.now();
        try {
            const res = await this.pool.query(text, params);
            const duration = Date.now() - start;
            console.log('Executed query', { text: text.substring(0, 100), duration, rows: res.rowCount });
            return res;
        } catch (error) {
            console.error('Database query error:', error);
            throw error;
        }
    }

    async initialize() {
        try {
            const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
            const schema = fs.readFileSync(schemaPath, 'utf8');

            await this.query(schema);

            // Migrations (idempotent)
            await this.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS summary TEXT');

            // Feature 2: Fee History table
            await this.query(`
                CREATE TABLE IF NOT EXISTS fee_history (
                    id SERIAL PRIMARY KEY,
                    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
                    event_type TEXT NOT NULL,
                    amount NUMERIC(10,2),
                    notes TEXT,
                    source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await this.query('CREATE INDEX IF NOT EXISTS idx_fee_history_case ON fee_history(case_id)');

            // Feature 3: Tags column on cases
            await this.query('ALTER TABLE cases ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT \'{}\'');

            // Feature 4: Priority column on cases
            await this.query('ALTER TABLE cases ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0');

            // Feature 5: User tracking on activity_log
            await this.query('ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS user_id TEXT');

            // Feature 6: Attachment persistence columns
            await this.query('ALTER TABLE attachments ADD COLUMN IF NOT EXISTS case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE');
            await this.query('ALTER TABLE attachments ADD COLUMN IF NOT EXISTS storage_path TEXT');
            await this.query('CREATE INDEX IF NOT EXISTS idx_attachments_case ON attachments(case_id)');

            // Feature 7: Unmatched portal signals for deferred email matching
            await this.query(`
                CREATE TABLE IF NOT EXISTS unmatched_portal_signals (
                    id SERIAL PRIMARY KEY,
                    message_id INTEGER REFERENCES messages(id),
                    from_email TEXT,
                    from_domain TEXT,
                    subject TEXT,
                    detected_request_number TEXT,
                    portal_provider TEXT,
                    portal_subdomain TEXT,
                    matched_case_id INTEGER REFERENCES cases(id),
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await this.query('ALTER TABLE cases ADD COLUMN IF NOT EXISTS portal_request_number TEXT');
            await this.query(`
                CREATE INDEX IF NOT EXISTS idx_unmatched_signals_request_number
                    ON unmatched_portal_signals(detected_request_number) WHERE matched_case_id IS NULL
            `);
            await this.query(`
                CREATE INDEX IF NOT EXISTS idx_cases_portal_request_number
                    ON cases(portal_request_number) WHERE portal_request_number IS NOT NULL
            `);

            // Enforce at most one PENDING_APPROVAL proposal per case (prevents race conditions)
            await this.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_one_pending_per_case
                    ON proposals (case_id) WHERE status = 'PENDING_APPROVAL'
            `);

            console.log('Database schema initialized successfully');
            return true;
        } catch (error) {
            console.error('Failed to initialize database:', error);
            throw error;
        }
    }

    // Cases
    async createCase(caseData) {
        // Try to find matching agency first
        let agencyId = caseData.agency_id || null;
        if (!agencyId && caseData.agency_name) {
            const agency = await this.findAgencyByName(caseData.agency_name, caseData.state);
            if (agency) {
                agencyId = agency.id;
                // Also use agency's email if case doesn't have one
                if (!caseData.agency_email && agency.email_main) {
                    caseData.agency_email = agency.email_main;
                }
            }
        }

        // Build scope_items_jsonb from requested_records if not provided
        let scopeItemsJsonb = caseData.scope_items_jsonb;
        if (!scopeItemsJsonb && caseData.requested_records) {
            const records = Array.isArray(caseData.requested_records)
                ? caseData.requested_records
                : [caseData.requested_records];
            scopeItemsJsonb = JSON.stringify(records.map(r => ({
                name: typeof r === 'string' ? r : (r.name || r.description || JSON.stringify(r)),
                status: 'REQUESTED',
                reason: null,
                confidence: null
            })));
        }

        const query = `
            INSERT INTO cases (
                notion_page_id, case_name, subject_name, agency_name, agency_email,
                state, incident_date, incident_location, requested_records,
                additional_details, status, deadline_date, agency_id, scope_items_jsonb,
                portal_url, portal_provider, alternate_agency_email,
                tags, priority, user_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
            RETURNING *
        `;
        const values = [
            caseData.notion_page_id,
            caseData.case_name,
            caseData.subject_name,
            caseData.agency_name,
            caseData.agency_email,
            caseData.state,
            caseData.incident_date,
            caseData.incident_location,
            caseData.requested_records,
            caseData.additional_details,
            caseData.status || 'ready_to_send',
            caseData.deadline_date,
            agencyId,
            scopeItemsJsonb,
            caseData.portal_url || null,
            caseData.portal_provider || null,
            caseData.alternate_agency_email || null,
            caseData.tags || '{}',
            caseData.priority || 0,
            caseData.user_id || null
        ];
        const result = await this.query(query, values);
        const created = result.rows[0];

        // Reactive dispatch for newly created cases
        if (created.status) {
            this._dispatchStatusAction(created.id, created.status).catch(err =>
                console.warn(`[DB] Reactive dispatch failed for new case ${created.id}:`, err.message)
            );
        }

        return created;
    }

    async getCaseById(id) {
        const result = await this.query('SELECT * FROM cases WHERE id = $1', [id]);
        return result.rows[0];
    }

    async getCaseByNotionId(notionPageId) {
        const result = await this.query('SELECT * FROM cases WHERE notion_page_id = $1', [notionPageId]);
        return result.rows[0];
    }

    async getCasesByStatus(status) {
        const result = await this.query('SELECT * FROM cases WHERE status = $1 ORDER BY created_at DESC', [status]);
        return result.rows;
    }

    async updateCaseStatus(caseId, status, additionalFields = {}) {
        const updateFields = { status, updated_at: new Date(), ...additionalFields };
        const setClause = Object.keys(updateFields).map((key, i) => `${key} = $${i + 2}`).join(', ');
        const values = [caseId, ...Object.values(updateFields)];

        const query = `UPDATE cases SET ${setClause} WHERE id = $1 RETURNING *`;
        const result = await this.query(query, values);
        const updatedCase = result.rows[0];

        // Push real-time update to dashboard SSE clients
        if (updatedCase) {
            emitDataUpdate('case_update', {
                case_id: caseId,
                status,
                substatus: additionalFields.substatus || null,
                agency_name: updatedCase.agency_name,
                case_name: updatedCase.case_name
            });
        }

        // Fire-and-forget Notion sync on every status change (lazy require avoids circular dep)
        try {
            const notionService = require('./notion-service');
            notionService.syncStatusToNotion(caseId).catch(err =>
                console.warn(`[DB] Notion sync failed for case ${caseId}:`, err.message)
            );
        } catch (e) { /* notion service not available */ }

        // Reactive dispatch: immediately queue next action based on new status
        this._dispatchStatusAction(caseId, status).catch(err =>
            console.warn(`[DB] Reactive dispatch failed for case ${caseId} → ${status}:`, err.message)
        );

        return updatedCase;
    }

    /**
     * Reactive dispatch — when a case enters a status, immediately queue the next action.
     * Replaces cron-based discovery for state transitions.
     */
    async _dispatchStatusAction(caseId, status) {
        try {
            switch (status) {
                case 'ready_to_send': {
                    const { dispatchReadyToSend } = require('./dispatch-helper');
                    const result = await dispatchReadyToSend(caseId, { source: 'reactive' });
                    if (result.dispatched) {
                        console.log(`[reactive] Case ${caseId} → ready_to_send: dispatched run ${result.runId}`);
                    } else {
                        console.log(`[reactive] Case ${caseId} → ready_to_send: skipped (${result.reason})`);
                    }
                    break;
                }
                // Future reactive hooks can be added here:
                // case 'responded': queue analysis job
                // case 'portal_submitted': queue portal status check
            }
        } catch (err) {
            // one_active_per_case constraint = expected concurrent dispatch race
            if (err.code === '23505' && String(err.constraint || '').includes('one_active_per_case')) return;
            throw err;
        }
    }

    async updateCasePortalStatus(caseId, portalData = {}) {
        const fields = {
            portal_url: portalData.portal_url,
            portal_provider: portalData.portal_provider,
            last_portal_status: portalData.last_portal_status,
            last_portal_status_at: portalData.last_portal_status_at,
            last_portal_engine: portalData.last_portal_engine,
            last_portal_run_id: portalData.last_portal_run_id,
            last_portal_details: portalData.last_portal_details,
            last_portal_task_url: portalData.last_portal_task_url,
            last_portal_recording_url: portalData.last_portal_recording_url,
            last_portal_account_email: portalData.last_portal_account_email,
            portal_request_number: portalData.portal_request_number
        };

        const entries = Object.entries(fields).filter(([, value]) => value !== undefined);

        if (entries.length === 0) {
            return await this.getCaseById(caseId);
        }

        const setClauseParts = entries.map(([key], i) => `${key} = $${i + 2}`);
        setClauseParts.push(`updated_at = CURRENT_TIMESTAMP`);

        const values = [caseId, ...entries.map(([, value]) => value)];
        const query = `UPDATE cases SET ${setClauseParts.join(', ')} WHERE id = $1 RETURNING *`;
        const result = await this.query(query, values);
        const updatedCase = result.rows[0];

        // Emit portal_status SSE event when portal fields change
        if (updatedCase) {
            try {
                emitDataUpdate('portal_status', {
                    case_id: caseId,
                    portal_status: updatedCase.last_portal_status,
                    portal_task_url: updatedCase.last_portal_task_url,
                    portal_run_id: updatedCase.last_portal_run_id,
                    portal_recording_url: updatedCase.last_portal_recording_url,
                    portal_request_number: updatedCase.portal_request_number
                });
            } catch (_) {}
        }

        return updatedCase;
    }

    async updateCase(caseId, updates = {}) {
        if (!updates || Object.keys(updates).length === 0) {
            return await this.getCaseById(caseId);
        }

        const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
        if (entries.length === 0) {
            return await this.getCaseById(caseId);
        }

        const setClauseParts = entries.map(([key], idx) => `${key} = $${idx + 2}`);
        setClauseParts.push('updated_at = CURRENT_TIMESTAMP');

        const values = [caseId, ...entries.map(([, value]) => value)];
        const query = `UPDATE cases SET ${setClauseParts.join(', ')} WHERE id = $1 RETURNING *`;
        const result = await this.query(query, values);
        const updated = result.rows[0];
        if (updated && updates.status) {
            emitDataUpdate('case_update', {
                case_id: caseId,
                status: updated.status,
                substatus: updated.substatus,
                agency_name: updated.agency_name,
                case_name: updated.case_name
            });
        }
        return updated;
    }

    // Email Threads
    async createEmailThread(threadData) {
        const query = `
            INSERT INTO email_threads (case_id, thread_id, subject, agency_email, initial_message_id, status)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (case_id) DO UPDATE SET
              thread_id = COALESCE(EXCLUDED.thread_id, email_threads.thread_id),
              subject = COALESCE(EXCLUDED.subject, email_threads.subject),
              agency_email = COALESCE(EXCLUDED.agency_email, email_threads.agency_email),
              updated_at = NOW()
            RETURNING *
        `;
        const values = [
            threadData.case_id,
            threadData.thread_id,
            threadData.subject,
            threadData.agency_email,
            threadData.initial_message_id,
            threadData.status || 'active'
        ];
        const result = await this.query(query, values);
        return result.rows[0];
    }

    async getThreadById(id) {
        const result = await this.query('SELECT * FROM email_threads WHERE id = $1', [id]);
        return result.rows[0];
    }

    async getThreadByCaseId(caseId) {
        const result = await this.query('SELECT * FROM email_threads WHERE case_id = $1', [caseId]);
        return result.rows[0];
    }

    async updateThread(threadId, updates) {
        const updateData = { ...updates, updated_at: new Date() };
        const setClause = Object.keys(updateData).map((key, i) => `${key} = $${i + 2}`).join(', ');
        const values = [threadId, ...Object.values(updateData)];

        const query = `UPDATE email_threads SET ${setClause} WHERE id = $1 RETURNING *`;
        const result = await this.query(query, values);
        return result.rows[0];
    }

    // Messages
    async createMessage(messageData) {
        const query = `
            INSERT INTO messages (
                thread_id, case_id, message_id, sendgrid_message_id, direction,
                from_email, to_email, cc_emails, subject, body_text, body_html,
                has_attachments, attachment_count, message_type, portal_notification,
                portal_notification_type, portal_notification_provider, sent_at, received_at,
                summary
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
            ON CONFLICT (message_id) DO NOTHING
            RETURNING *
        `;
        const values = [
            messageData.thread_id,
            messageData.case_id,
            messageData.message_id,
            messageData.sendgrid_message_id,
            messageData.direction,
            messageData.from_email,
            messageData.to_email,
            messageData.cc_emails || null,
            messageData.subject,
            messageData.body_text,
            messageData.body_html,
            messageData.has_attachments || false,
            messageData.attachment_count || 0,
            messageData.message_type,
            messageData.portal_notification || false,
            messageData.portal_notification_type || null,
            messageData.portal_notification_provider || null,
            messageData.sent_at || null,
            messageData.received_at || null,
            messageData.summary || null
        ];
        const result = await this.query(query, values);
        if (result.rows.length > 0) {
            const msg = result.rows[0];
            emitDataUpdate('message_new', {
                id: msg.id,
                case_id: msg.case_id,
                direction: msg.direction,
                from_email: msg.from_email,
                to_email: msg.to_email,
                subject: msg.subject,
                message_type: msg.message_type,
                received_at: msg.received_at,
                sent_at: msg.sent_at
            });
            return msg;
        }

        // Fetch existing message when conflict occurred
        return await this.getMessageByMessageIdentifier(messageData.message_id);
    }

    async getMessageByMessageIdentifier(messageIdentifier) {
        const result = await this.query(
            'SELECT * FROM messages WHERE message_id = $1 LIMIT 1',
            [messageIdentifier]
        );
        return result.rows[0];
    }

    async getMessagesByThreadId(threadId) {
        const result = await this.query(
            'SELECT * FROM messages WHERE thread_id = $1 ORDER BY created_at ASC',
            [threadId]
        );
        return result.rows;
    }

    async getMessageById(id) {
        const result = await this.query('SELECT * FROM messages WHERE id = $1', [id]);
        return result.rows[0];
    }

    async markMessagePortalNotification(messageId, notificationData = {}) {
        const query = `
            UPDATE messages
            SET portal_notification = true,
                portal_notification_type = COALESCE($2, portal_notification_type),
                portal_notification_provider = COALESCE($3, portal_notification_provider)
            WHERE id = $1
            RETURNING *
        `;
        const values = [
            messageId,
            notificationData.type || null,
            notificationData.provider || null
        ];
        const result = await this.query(query, values);
        return result.rows[0];
    }

    // Response Analysis - uses UPSERT to allow AI analysis to update existing records
    async createResponseAnalysis(analysisData) {
        const query = `
            INSERT INTO response_analysis (
                message_id, case_id, intent, confidence_score, sentiment,
                key_points, extracted_deadline, extracted_fee_amount,
                requires_action, suggested_action, full_analysis_json
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (message_id) DO UPDATE SET
                intent = COALESCE(EXCLUDED.intent, response_analysis.intent),
                confidence_score = COALESCE(EXCLUDED.confidence_score, response_analysis.confidence_score),
                sentiment = COALESCE(EXCLUDED.sentiment, response_analysis.sentiment),
                key_points = COALESCE(EXCLUDED.key_points, response_analysis.key_points),
                extracted_deadline = COALESCE(EXCLUDED.extracted_deadline, response_analysis.extracted_deadline),
                extracted_fee_amount = COALESCE(EXCLUDED.extracted_fee_amount, response_analysis.extracted_fee_amount),
                requires_action = COALESCE(EXCLUDED.requires_action, response_analysis.requires_action),
                suggested_action = COALESCE(EXCLUDED.suggested_action, response_analysis.suggested_action),
                full_analysis_json = COALESCE(EXCLUDED.full_analysis_json, response_analysis.full_analysis_json),
                updated_at = NOW()
            RETURNING *
        `;
        const values = [
            analysisData.message_id,
            analysisData.case_id,
            analysisData.intent,
            analysisData.confidence_score,
            analysisData.sentiment,
            analysisData.key_points,
            analysisData.extracted_deadline,
            analysisData.extracted_fee_amount,
            analysisData.requires_action,
            analysisData.suggested_action,
            analysisData.full_analysis_json
        ];
        const result = await this.query(query, values);
        return result.rows[0];
    }

    async getAnalysisByMessageId(messageId) {
        const result = await this.query(
            'SELECT * FROM response_analysis WHERE message_id = $1',
            [messageId]
        );
        return result.rows[0];
    }

    // Auto reply queue helpers
    async createAutoReplyQueueEntry(entry) {
        const query = `
            INSERT INTO auto_reply_queue (
                message_id,
                case_id,
                generated_reply,
                confidence_score,
                status,
                requires_approval,
                response_type,
                metadata,
                last_regenerated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (message_id) DO UPDATE SET
                generated_reply = EXCLUDED.generated_reply,
                confidence_score = COALESCE(EXCLUDED.confidence_score, auto_reply_queue.confidence_score),
                status = 'pending',
                requires_approval = EXCLUDED.requires_approval,
                response_type = EXCLUDED.response_type,
                metadata = EXCLUDED.metadata,
                last_regenerated_at = EXCLUDED.last_regenerated_at
            RETURNING *
        `;

        const values = [
            entry.message_id,
            entry.case_id,
            entry.generated_reply,
            entry.confidence_score || null,
            entry.status || 'pending',
            entry.requires_approval !== false,
            entry.response_type || 'general',
            entry.metadata || null,
            entry.last_regenerated_at || null
        ];

        const result = await this.query(query, values);
        return result.rows[0];
    }

    async getHumanReviewCases(limit = 50) {
        const reviewStatuses = ['needs_human_review', 'needs_human_fee_approval'];

        const query = `
            SELECT
                c.*,
                la.description AS last_activity_description,
                la.created_at AS last_activity_at,
                lm.subject AS last_message_subject,
                lm.body_text AS last_message_body,
                lm.received_at AS last_message_received_at,
                lm.sent_at AS last_message_sent_at,
                portal_events.portal_events
            FROM cases c
            LEFT JOIN LATERAL (
                SELECT description, created_at
                FROM activity_log
                WHERE case_id = c.id
                ORDER BY created_at DESC
                LIMIT 1
            ) la ON true
            LEFT JOIN LATERAL (
                SELECT subject, body_text, received_at, sent_at
                FROM messages
                WHERE case_id = c.id
                ORDER BY COALESCE(received_at, sent_at, created_at) DESC
                LIMIT 1
            ) lm ON true
            LEFT JOIN LATERAL (
                SELECT json_agg(events ORDER BY events.created_at DESC) AS portal_events
                FROM (
                    SELECT event_type, description, created_at, metadata
                    FROM activity_log
                    WHERE case_id = c.id
                      AND event_type = ANY($3::text[])
                    ORDER BY created_at DESC
                    LIMIT 10
                ) events
            ) portal_events ON true
            WHERE c.status = ANY($1)
            ORDER BY c.updated_at DESC
            LIMIT $2
        `;

        const result = await this.query(query, [reviewStatuses, limit, PORTAL_ACTIVITY_EVENTS]);
        return result.rows;
    }

    async getAutoReplyQueueEntryById(id) {
        const result = await this.query(
            'SELECT * FROM auto_reply_queue WHERE id = $1',
            [id]
        );
        return result.rows[0];
    }

    async updateAutoReplyQueueEntry(id, updates = {}) {
        if (!updates || Object.keys(updates).length === 0) {
            return await this.getAutoReplyQueueEntryById(id);
        }

        const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
        if (entries.length === 0) {
            return await this.getAutoReplyQueueEntryById(id);
        }

        const setClauseParts = entries.map(([key], idx) => `${key} = $${idx + 2}`);

        const values = [id, ...entries.map(([, value]) => value)];
        const query = `UPDATE auto_reply_queue SET ${setClauseParts.join(', ')} WHERE id = $1 RETURNING *`;
        const result = await this.query(query, values);
        return result.rows[0];
    }

    // Follow-up Schedule
    async createFollowUpSchedule(scheduleData) {
        const query = `
            INSERT INTO follow_up_schedule (
                case_id, thread_id, next_followup_date, followup_count,
                auto_send, status
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `;
        const values = [
            scheduleData.case_id,
            scheduleData.thread_id,
            scheduleData.next_followup_date,
            scheduleData.followup_count || 0,
            scheduleData.auto_send !== false,
            scheduleData.status || 'scheduled'
        ];
        const result = await this.query(query, values);
        return result.rows[0];
    }

    async getDueFollowUps(date = new Date()) {
        const result = await this.query(
            `SELECT * FROM follow_up_schedule
             WHERE next_followup_date <= $1
             AND status = 'scheduled'
             AND auto_send = true
             ORDER BY next_followup_date ASC`,
            [date]
        );
        return result.rows;
    }

    async updateFollowUpSchedule(id, updates) {
        const updateData = { ...updates, updated_at: new Date() };
        const setClause = Object.keys(updateData).map((key, i) => `${key} = $${i + 2}`).join(', ');
        const values = [id, ...Object.values(updateData)];

        const query = `UPDATE follow_up_schedule SET ${setClause} WHERE id = $1 RETURNING *`;
        const result = await this.query(query, values);
        return result.rows[0];
    }

    // Generated Requests
    async createGeneratedRequest(requestData) {
        const query = `
            INSERT INTO generated_requests (
                case_id, request_text, ai_model, generation_metadata, status
            ) VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `;
        const values = [
            requestData.case_id,
            requestData.request_text,
            requestData.ai_model,
            requestData.generation_metadata,
            requestData.status || 'draft'
        ];
        const result = await this.query(query, values);
        return result.rows[0];
    }

    async getGeneratedRequestByCaseId(caseId) {
        const result = await this.query(
            'SELECT * FROM generated_requests WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1',
            [caseId]
        );
        return result.rows[0];
    }

    // Activity Log
    async logActivity(eventType, description, metadata = {}) {
        const query = `
            INSERT INTO activity_log (event_type, case_id, message_id, description, metadata, user_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `;
        const values = [
            eventType,
            metadata.case_id || null,
            metadata.message_id || null,
            description,
            metadata,
            metadata.user_id || null
        ];
        const result = await this.query(query, values);
        const row = result.rows[0];
        if (row) {
            emitDataUpdate('activity_new', {
                id: row.id,
                event_type: row.event_type,
                case_id: row.case_id,
                description: row.description,
                metadata: row.metadata,
                created_at: row.created_at
            });
        }
        return row;
    }

    async getRecentActivity(limit = 50) {
        const result = await this.query(
            'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT $1',
            [limit]
        );
        return result.rows;
    }

    async getRecentAgentDecisions(limit = 50) {
        const result = await this.query(
            `
            SELECT 
                ad.id,
                ad.case_id,
                c.case_name,
                c.agency_name,
                c.status AS case_status,
                ad.reasoning,
                ad.action_taken,
                ad.confidence,
                ad.trigger_type,
                ad.outcome,
                ad.created_at
            FROM agent_decisions ad
            JOIN cases c ON ad.case_id = c.id
            ORDER BY ad.created_at DESC
            LIMIT $1
            `,
            [limit]
        );
        return result.rows;
    }

    // State Deadlines
    async getStateDeadline(stateCode) {
        const result = await this.query(
            'SELECT * FROM state_deadlines WHERE state_code = $1',
            [stateCode]
        );
        return result.rows[0];
    }

    // Portal Accounts - Password Encryption Helpers
    _getEncryptionKey() {
        // Use environment variable or fallback (in production, ALWAYS use env var)
        const key = process.env.PORTAL_ENCRYPTION_KEY || 'default-key-change-in-production-32';
        return crypto.createHash('sha256').update(key).digest();
    }

    _encryptPassword(password) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', this._getEncryptionKey(), iv);
        let encrypted = cipher.update(password, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return iv.toString('hex') + ':' + encrypted;
    }

    _decryptPassword(encrypted) {
        const parts = encrypted.split(':');
        const iv = Buffer.from(parts[0], 'hex');
        const encryptedText = parts[1];
        const decipher = crypto.createDecipheriv('aes-256-cbc', this._getEncryptionKey(), iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    _extractDomain(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.hostname;
        } catch (error) {
            // If URL parsing fails, try to extract domain manually
            const match = url.match(/(?:https?:\/\/)?(?:www\.)?([^\/]+)/);
            return match ? match[1] : url;
        }
    }

    // Portal Accounts CRUD
    async createPortalAccount(accountData) {
        const query = `
            INSERT INTO portal_accounts (
                portal_url, portal_domain, portal_type, email, password_encrypted,
                first_name, last_name, additional_info, account_status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, portal_url, portal_domain, portal_type, email, first_name, last_name,
                      additional_info, account_status, created_at, updated_at
        `;
        const domain = this._extractDomain(accountData.portal_url);
        const encryptedPassword = this._encryptPassword(accountData.password);

        const values = [
            accountData.portal_url,
            domain,
            accountData.portal_type || null,
            accountData.email,
            encryptedPassword,
            accountData.first_name || null,
            accountData.last_name || null,
            accountData.additional_info || null,
            accountData.account_status || 'active'
        ];

        const result = await this.query(query, values);
        return result.rows[0];
    }

    async getPortalAccountByDomain(domain, email = null) {
        let query = 'SELECT * FROM portal_accounts WHERE portal_domain = $1';
        const params = [domain];

        if (email) {
            query += ' AND email = $2';
            params.push(email);
        }

        query += ' AND account_status IN (\'active\', \'no_account_needed\') ORDER BY created_at DESC LIMIT 1';

        const result = await this.query(query, params);
        if (result.rows.length > 0) {
            const account = result.rows[0];
            // Decrypt password for use
            account.password = this._decryptPassword(account.password_encrypted);
            delete account.password_encrypted; // Don't expose encrypted version
            return account;
        }
        return null;
    }

    async getPortalAccountByUrl(portalUrl) {
        const domain = this._extractDomain(portalUrl);
        return await this.getPortalAccountByDomain(domain);
    }

    async updatePortalAccountLastUsed(accountId) {
        const query = `
            UPDATE portal_accounts
            SET last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *
        `;
        const result = await this.query(query, [accountId]);
        return result.rows[0];
    }

    async updatePortalAccountStatus(accountId, status) {
        const query = `
            UPDATE portal_accounts
            SET account_status = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *
        `;
        const result = await this.query(query, [accountId, status]);
        return result.rows[0];
    }

    async getAllPortalAccounts() {
        const result = await this.query(
            'SELECT id, portal_url, portal_domain, portal_type, email, first_name, last_name, account_status, last_used_at, created_at FROM portal_accounts ORDER BY created_at DESC'
        );
        return result.rows;
    }

    // =========================================================================
    // Users
    // =========================================================================

    async createUser({ name, email_handle }) {
        const result = await this.query(
            `INSERT INTO users (name, email_handle)
             VALUES ($1, $2)
             RETURNING *`,
            [name, email_handle]
        );
        return result.rows[0];
    }

    async getUserById(id) {
        const result = await this.query('SELECT * FROM users WHERE id = $1', [id]);
        return result.rows[0];
    }

    async getUserByName(name) {
        const result = await this.query('SELECT * FROM users WHERE LOWER(name) = LOWER($1) AND active = true', [name]);
        return result.rows[0];
    }

    async getUserByHandle(handle) {
        const result = await this.query('SELECT * FROM users WHERE email_handle = $1', [handle]);
        return result.rows[0];
    }

    async getUserByEmail(email) {
        const result = await this.query('SELECT * FROM users WHERE email = $1', [email]);
        return result.rows[0];
    }

    async listUsers(activeOnly = true) {
        const query = activeOnly
            ? 'SELECT * FROM users WHERE active = true ORDER BY created_at DESC'
            : 'SELECT * FROM users ORDER BY created_at DESC';
        const result = await this.query(query);
        return result.rows;
    }

    async updateUser(id, updates) {
        const allowed = ['name', 'email_handle', 'active', 'signature_name', 'signature_title', 'signature_phone', 'signature_organization', 'address_street', 'address_street2', 'address_city', 'address_state', 'address_zip'];
        const entries = Object.entries(updates).filter(([key]) => allowed.includes(key));
        if (entries.length === 0) return this.getUserById(id);

        const setClauses = entries.map(([key], i) => `${key} = $${i + 2}`);
        setClauses.push('updated_at = CURRENT_TIMESTAMP');
        const values = [id, ...entries.map(([, v]) => v)];

        const result = await this.query(
            `UPDATE users SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
            values
        );
        return result.rows[0];
    }

    async deactivateUser(id) {
        return this.updateUser(id, { active: false });
    }

    // =========================================================================
    // Execution Idempotency (Deliverable 1)
    // =========================================================================

    /**
     * Atomically claim an execution slot for a proposal.
     * Returns the claimed proposal if successful, null if already claimed.
     * Uses WHERE execution_key IS NULL to prevent duplicate claims.
     */
    async claimProposalExecution(proposalId, executionKey) {
        const query = `
            UPDATE auto_reply_queue
            SET execution_key = $2,
                status = 'approved'
            WHERE id = $1
              AND execution_key IS NULL
              AND status IN ('pending', 'approved')
            RETURNING *
        `;
        const result = await this.query(query, [proposalId, executionKey]);
        return result.rows[0] || null;
    }

    /**
     * Mark a proposal as executed with the email job ID.
     */
    /**
     * Dismiss pending proposals for a case.
     * @param {number} caseId
     * @param {string} reason
     * @param {string[]|null} actionTypes - When provided, only dismiss matching action_type values.
     *                                       When null/omitted, dismiss ALL pending proposals.
     */
    async dismissPendingProposals(caseId, reason = 'Case status advanced', actionTypes = null) {
        let query, params;
        if (actionTypes && actionTypes.length > 0) {
            query = `
                UPDATE proposals
                SET status = 'DISMISSED',
                    updated_at = NOW()
                WHERE case_id = $1
                  AND status IN ('PENDING_APPROVAL', 'DRAFT')
                  AND action_type = ANY($2)
                RETURNING id, action_type
            `;
            params = [caseId, actionTypes];
        } else {
            query = `
                UPDATE proposals
                SET status = 'DISMISSED',
                    updated_at = NOW()
                WHERE case_id = $1
                  AND status IN ('PENDING_APPROVAL', 'DRAFT')
                RETURNING id, action_type
            `;
            params = [caseId];
        }
        const result = await this.query(query, params);
        if (result.rows.length > 0) {
            const types = actionTypes ? ` (types: ${actionTypes.join(', ')})` : ' (all)';
            console.log(`[DB] Dismissed ${result.rows.length} proposals for case ${caseId}${types}: ${reason}`);
            // Push SSE update for each dismissed proposal
            for (const row of result.rows) {
                emitDataUpdate('proposal_update', {
                    id: row.id,
                    case_id: caseId,
                    action_type: row.action_type,
                    status: 'DISMISSED'
                });
            }
        }
        return result.rows;
    }

    async markProposalExecuted(proposalId, emailJobId) {
        const query = `
            UPDATE auto_reply_queue
            SET email_job_id = $2,
                executed_at = NOW(),
                status = 'sent'
            WHERE id = $1
            RETURNING *
        `;
        const result = await this.query(query, [proposalId, emailJobId]);
        return result.rows[0];
    }

    /**
     * Check if a proposal has already been executed.
     */
    async isProposalExecuted(proposalId) {
        const query = `
            SELECT executed_at, email_job_id, execution_key
            FROM auto_reply_queue
            WHERE id = $1
        `;
        const result = await this.query(query, [proposalId]);
        if (result.rows.length === 0) return null;
        return {
            executed: !!result.rows[0].executed_at,
            emailJobId: result.rows[0].email_job_id,
            executionKey: result.rows[0].execution_key
        };
    }

    // =========================================================================
    // Proposal Idempotency (Deliverable 3)
    // =========================================================================

    /**
     * Generate a deterministic proposal key for idempotent creation.
     * Format: {caseId}:{messageId}:{actionType}:{attempt}
     */
    generateProposalKey(caseId, messageId, actionType, attempt = 0) {
        const msgPart = messageId || 'no-msg';
        return `${caseId}:${msgPart}:${actionType}:${attempt}`;
    }

    /**
     * Create or update a proposal using UPSERT on proposal_key.
     * Preserves status if already 'sent' or 'approved'.
     */
    async createOrUpdateProposal(entry) {
        const proposalKey = entry.proposal_key || this.generateProposalKey(
            entry.case_id,
            entry.message_id,
            entry.action_type || 'SEND_EMAIL',
            entry.attempt || 0
        );

        const query = `
            INSERT INTO auto_reply_queue (
                message_id,
                case_id,
                generated_reply,
                confidence_score,
                status,
                requires_approval,
                response_type,
                metadata,
                last_regenerated_at,
                proposal_key,
                action_type,
                proposal_short,
                reasoning_jsonb,
                warnings_jsonb,
                constraints_applied_jsonb
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT (proposal_key) WHERE proposal_key IS NOT NULL
            DO UPDATE SET
                generated_reply = CASE
                    WHEN auto_reply_queue.status IN ('sent', 'approved') THEN auto_reply_queue.generated_reply
                    ELSE EXCLUDED.generated_reply
                END,
                confidence_score = CASE
                    WHEN auto_reply_queue.status IN ('sent', 'approved') THEN auto_reply_queue.confidence_score
                    ELSE COALESCE(EXCLUDED.confidence_score, auto_reply_queue.confidence_score)
                END,
                status = CASE
                    WHEN auto_reply_queue.status IN ('sent', 'approved') THEN auto_reply_queue.status
                    ELSE COALESCE(EXCLUDED.status, auto_reply_queue.status)
                END,
                requires_approval = CASE
                    WHEN auto_reply_queue.status IN ('sent', 'approved') THEN auto_reply_queue.requires_approval
                    ELSE EXCLUDED.requires_approval
                END,
                response_type = COALESCE(EXCLUDED.response_type, auto_reply_queue.response_type),
                metadata = COALESCE(EXCLUDED.metadata, auto_reply_queue.metadata),
                last_regenerated_at = CASE
                    WHEN auto_reply_queue.status IN ('sent', 'approved') THEN auto_reply_queue.last_regenerated_at
                    ELSE EXCLUDED.last_regenerated_at
                END,
                proposal_short = COALESCE(EXCLUDED.proposal_short, auto_reply_queue.proposal_short),
                reasoning_jsonb = CASE
                    WHEN auto_reply_queue.status IN ('sent', 'approved') THEN auto_reply_queue.reasoning_jsonb
                    ELSE COALESCE(EXCLUDED.reasoning_jsonb, auto_reply_queue.reasoning_jsonb)
                END,
                warnings_jsonb = COALESCE(EXCLUDED.warnings_jsonb, auto_reply_queue.warnings_jsonb),
                constraints_applied_jsonb = COALESCE(EXCLUDED.constraints_applied_jsonb, auto_reply_queue.constraints_applied_jsonb)
            RETURNING *
        `;

        const values = [
            entry.message_id,
            entry.case_id,
            entry.generated_reply,
            entry.confidence_score || null,
            entry.status || 'pending',
            entry.requires_approval !== false,
            entry.response_type || 'general',
            entry.metadata || null,
            entry.last_regenerated_at || null,
            proposalKey,
            entry.action_type || 'SEND_EMAIL',
            entry.proposal_short || null,
            entry.reasoning_jsonb || null,
            entry.warnings_jsonb || null,
            entry.constraints_applied_jsonb || null
        ];

        const result = await this.query(query, values);
        return result.rows[0];
    }

    /**
     * Block a proposal with a reason.
     */
    async blockProposal(proposalId, reason) {
        const query = `
            UPDATE auto_reply_queue
            SET status = 'blocked',
                blocked_reason = $2
            WHERE id = $1
            RETURNING *
        `;
        const result = await this.query(query, [proposalId, reason]);
        return result.rows[0];
    }

    // =========================================================================
    // Agent Runs (Deliverable 5)
    // =========================================================================

    /**
     * Create a new agent run record.
     */
    async createAgentRun(caseId, triggerType, metadata = {}) {
        const query = `
            INSERT INTO agent_runs (case_id, trigger_type, metadata)
            VALUES ($1, $2, $3)
            RETURNING *
        `;
        const result = await this.query(query, [caseId, triggerType, JSON.stringify(metadata)]);
        return result.rows[0];
    }

    /**
     * Update an agent run record.
     */
    async updateAgentRun(runId, updates) {
        if (!updates || Object.keys(updates).length === 0) {
            return await this.getAgentRunById(runId);
        }

        const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
        if (entries.length === 0) {
            return await this.getAgentRunById(runId);
        }

        const setClauseParts = entries.map(([key], idx) => {
            if (key === 'metadata') {
                return `${key} = $${idx + 2}::jsonb`;
            }
            return `${key} = $${idx + 2}`;
        });

        const values = [runId, ...entries.map(([key, value]) => {
            if (key === 'metadata') {
                return JSON.stringify(value);
            }
            return value;
        })];

        const query = `UPDATE agent_runs SET ${setClauseParts.join(', ')} WHERE id = $1 RETURNING *`;
        const result = await this.query(query, values);
        const updatedRun = result.rows[0];

        // Emit run_status SSE event when status changes
        if (updatedRun && updates.status) {
            try {
                emitDataUpdate('run_status', {
                    run_id: updatedRun.id,
                    case_id: updatedRun.case_id,
                    status: updatedRun.status,
                    current_node: updatedRun.metadata?.current_node || null,
                    started_at: updatedRun.started_at,
                    ended_at: updatedRun.ended_at
                });
            } catch (_) {}
        }

        return updatedRun;
    }

    /**
     * Get an agent run by ID.
     */
    async getAgentRunById(runId) {
        const result = await this.query('SELECT * FROM agent_runs WHERE id = $1', [runId]);
        return result.rows[0];
    }

    /**
     * Update node progress for an agent run (for debugging stuck runs).
     * Merges node tracking info into the metadata JSONB column.
     *
     * @param {number} runId - The agent run ID
     * @param {string} nodeName - Current node being processed
     * @param {number} iteration - Current iteration count (optional)
     */
    async updateAgentRunNodeProgress(runId, nodeName, iteration = null) {
        const nodeProgress = {
            current_node: nodeName,
            node_started_at: new Date().toISOString(),
            iteration_count: iteration
        };

        const query = `
            UPDATE agent_runs
            SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
            WHERE id = $1
            RETURNING *
        `;
        const result = await this.query(query, [runId, JSON.stringify(nodeProgress)]);
        const updatedRun = result.rows[0];

        // Emit run_status for live node-progress updates
        if (updatedRun) {
            try {
                emitDataUpdate('run_status', {
                    run_id: updatedRun.id,
                    case_id: updatedRun.case_id,
                    status: updatedRun.status,
                    current_node: nodeName,
                    started_at: updatedRun.started_at,
                    ended_at: updatedRun.ended_at
                });
            } catch (_) {}
        }

        return updatedRun;
    }

    /**
     * Get agent runs for a case with optional limit.
     */
    async getAgentRunsByCaseId(caseId, limit = 20) {
        const query = `
            SELECT
                ar.*,
                arq.generated_reply AS proposal_content,
                arq.action_type AS proposal_action_type,
                arq.status AS proposal_status
            FROM agent_runs ar
            LEFT JOIN auto_reply_queue arq ON ar.proposal_id = arq.id
            WHERE ar.case_id = $1
            ORDER BY ar.started_at DESC
            LIMIT $2
        `;
        const result = await this.query(query, [caseId, limit]);
        return result.rows;
    }

    /**
     * Check if there's an active (running) agent run for a case.
     */
    async hasActiveAgentRun(caseId) {
        const query = `
            SELECT id FROM agent_runs
            WHERE case_id = $1 AND status = 'running'
            LIMIT 1
        `;
        const result = await this.query(query, [caseId]);
        return result.rows.length > 0;
    }

    /**
     * Mark an agent run as completed.
     */
    async completeAgentRun(runId, proposalId = null, error = null) {
        const status = error ? 'failed' : 'completed';
        const query = `
            UPDATE agent_runs
            SET status = $2,
                ended_at = NOW(),
                proposal_id = COALESCE($3, proposal_id),
                error = $4
            WHERE id = $1
            RETURNING *
        `;
        const result = await this.query(query, [runId, status, proposalId, error]);
        return result.rows[0];
    }

    /**
     * Mark an agent run as skipped due to lock contention.
     */
    async skipAgentRun(runId, reason = 'Case locked by another agent run') {
        const query = `
            UPDATE agent_runs
            SET status = 'skipped_locked',
                ended_at = NOW(),
                error = $2
            WHERE id = $1
            RETURNING *
        `;
        const result = await this.query(query, [runId, reason]);
        return result.rows[0];
    }

    // =========================================================================
    // LangGraph Proposals (new proposals table)
    // =========================================================================

    /**
     * Upsert a proposal using proposal_key for idempotency.
     * P0 FIX #2: Safe to re-run after interrupt resume.
     */
    async upsertProposal(proposalData) {
        // CRITICAL: Ensure action_type is never null on insert
        if (!proposalData.actionType) {
            // Try to extract from proposal_key if available
            if (proposalData.proposalKey) {
                // Keys can be: caseId:msg:action:adj OR caseId:msg:ca<id>:action:adj
                // Find the first part that looks like an action type (all uppercase with underscores)
                const parts = proposalData.proposalKey.split(':');
                const actionPart = parts.find(p => /^[A-Z][A-Z_]+$/.test(p));
                if (actionPart) {
                    proposalData.actionType = actionPart;
                    console.warn(`[DB] Recovered actionType from proposal_key: ${proposalData.actionType}`);
                }
            }
            // Final fallback - should never happen but prevents DB error
            if (!proposalData.actionType) {
                proposalData.actionType = 'UNKNOWN';
                console.error(`[DB] WARNING: No actionType provided for proposal, using UNKNOWN`);
            }
        }

        // DRAFT VALIDATION: Block proposals for email actions that have no draft
        const incomingStatus = proposalData.status || 'PENDING_APPROVAL';
        const draftBody = typeof proposalData.draftBodyText === 'string' ? proposalData.draftBodyText.trim() : '';
        if (DRAFT_REQUIRED_ACTIONS.includes(proposalData.actionType)
            && incomingStatus === 'PENDING_APPROVAL'
            && !draftBody) {
            const originalAction = proposalData.actionType;
            console.warn(`[DB] Blocking ${originalAction} proposal for case ${proposalData.caseId}: empty draft body`);
            proposalData.actionType = 'ESCALATE';
            proposalData.requiresHuman = true;
            proposalData.canAutoExecute = false;
            proposalData.draftSubject = proposalData.draftSubject || `Action needed: case ${proposalData.caseId}`;
            proposalData.draftBodyText = `Original action ${originalAction} blocked — no draft body generated. Needs manual review.`;
        }

        // DEDUP GUARD: Prevent duplicate PENDING_APPROVAL proposals for the same case.
        // Multiple code paths (LangGraph, cron sweeps, portal failures) create proposals
        // with different proposal_key formats, so ON CONFLICT alone isn't sufficient.
        // Only blocks when the INCOMING proposal would be PENDING_APPROVAL — allows
        // EXECUTED/APPROVED audit records through even if a pending proposal exists.
        if (proposalData.caseId && incomingStatus === 'PENDING_APPROVAL') {
            const existing = await this.query(
                `SELECT id, action_type, proposal_key FROM proposals
                 WHERE case_id = $1 AND status = 'PENDING_APPROVAL'
                 LIMIT 1`,
                [proposalData.caseId]
            );

            if (existing.rows.length > 0) {
                const first = existing.rows[0];
                console.log(`[DB] Skipping proposal for case ${proposalData.caseId}: ` +
                    `${proposalData.actionType} not created — ${first.action_type} already pending ` +
                    `(proposal #${first.id}, key: ${first.proposal_key})`);
                return await this.getProposalById(first.id);
            }
        }

        const query = `
            INSERT INTO proposals (
                proposal_key, case_id, run_id, trigger_message_id, action_type,
                draft_subject, draft_body_text, draft_body_html,
                reasoning, confidence, risk_flags, warnings,
                can_auto_execute, requires_human, status,
                langgraph_thread_id, adjustment_count, lessons_applied
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
            ON CONFLICT (proposal_key) DO UPDATE SET
                -- ONLY update when existing row is PENDING_APPROVAL.
                -- All other statuses are fully immutable — prevents resurrection,
                -- overwriting in-flight states (PENDING_PORTAL, DECISION_RECEIVED, etc.),
                -- and corruption of terminal records (EXECUTED, DISMISSED, etc.).
                run_id = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN COALESCE(EXCLUDED.run_id, proposals.run_id)
                    ELSE proposals.run_id
                END,
                action_type = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' AND EXCLUDED.action_type IS NOT NULL THEN EXCLUDED.action_type
                    ELSE proposals.action_type
                END,
                draft_subject = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN EXCLUDED.draft_subject
                    ELSE proposals.draft_subject
                END,
                draft_body_text = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN EXCLUDED.draft_body_text
                    ELSE proposals.draft_body_text
                END,
                draft_body_html = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN EXCLUDED.draft_body_html
                    ELSE proposals.draft_body_html
                END,
                reasoning = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN EXCLUDED.reasoning
                    ELSE proposals.reasoning
                END,
                confidence = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN EXCLUDED.confidence
                    ELSE proposals.confidence
                END,
                risk_flags = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN COALESCE(EXCLUDED.risk_flags, proposals.risk_flags)
                    ELSE proposals.risk_flags
                END,
                warnings = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN COALESCE(EXCLUDED.warnings, proposals.warnings)
                    ELSE proposals.warnings
                END,
                can_auto_execute = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN EXCLUDED.can_auto_execute
                    ELSE proposals.can_auto_execute
                END,
                requires_human = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN EXCLUDED.requires_human
                    ELSE proposals.requires_human
                END,
                status = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN EXCLUDED.status
                    ELSE proposals.status
                END,
                langgraph_thread_id = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN COALESCE(EXCLUDED.langgraph_thread_id, proposals.langgraph_thread_id)
                    ELSE proposals.langgraph_thread_id
                END,
                adjustment_count = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN COALESCE(EXCLUDED.adjustment_count, proposals.adjustment_count)
                    ELSE proposals.adjustment_count
                END,
                lessons_applied = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN COALESCE(EXCLUDED.lessons_applied, proposals.lessons_applied)
                    ELSE proposals.lessons_applied
                END,
                updated_at = CASE
                    WHEN proposals.status = 'PENDING_APPROVAL' THEN CURRENT_TIMESTAMP
                    ELSE proposals.updated_at
                END
            RETURNING *
        `;

        // Serialize JSONB fields properly
        const reasoningJson = proposalData.reasoning
            ? JSON.stringify(proposalData.reasoning)
            : null;

        const values = [
            proposalData.proposalKey,
            proposalData.caseId,
            proposalData.runId || null,  // Link proposal to agent_runs.id
            proposalData.triggerMessageId || null,
            proposalData.actionType,
            proposalData.draftSubject || null,
            proposalData.draftBodyText || null,
            proposalData.draftBodyHtml || null,
            reasoningJson,
            proposalData.confidence || 0.8,
            proposalData.riskFlags || [],
            proposalData.warnings || [],
            proposalData.canAutoExecute || false,
            proposalData.requiresHuman || true,
            proposalData.status || 'PENDING_APPROVAL',
            proposalData.langgraphThreadId || null,
            proposalData.adjustmentCount || 0,
            proposalData.lessonsApplied ? JSON.stringify(proposalData.lessonsApplied) : null
        ];

        try {
            const result = await this.query(query, values);
            const proposal = result.rows[0];
            if (proposal) {
                emitDataUpdate('proposal_update', {
                    id: proposal.id,
                    case_id: proposal.case_id,
                    action_type: proposal.action_type,
                    status: proposal.status,
                    created: true
                });
            }
            return proposal;
        } catch (err) {
            // Race condition: partial unique index (one PENDING_APPROVAL per case) caught a concurrent insert
            if (err.code === '23505' && err.constraint === 'idx_proposals_one_pending_per_case') {
                const existing = await this.query(
                    `SELECT id FROM proposals WHERE case_id = $1 AND status = 'PENDING_APPROVAL' LIMIT 1`,
                    [proposalData.caseId]
                );
                if (existing.rows[0]) {
                    console.log(`[DB] Race condition caught: returning existing proposal #${existing.rows[0].id} for case ${proposalData.caseId}`);
                    return await this.getProposalById(existing.rows[0].id);
                }
            }
            throw err;
        }
    }

    /**
     * Get a proposal by ID.
     */
    async getProposalById(proposalId) {
        const result = await this.query(
            'SELECT * FROM proposals WHERE id = $1',
            [proposalId]
        );
        return result.rows[0];
    }

    /**
     * Get a proposal by proposal_key.
     */
    async getProposalByKey(proposalKey) {
        const result = await this.query(
            'SELECT * FROM proposals WHERE proposal_key = $1',
            [proposalKey]
        );
        return result.rows[0];
    }

    /**
     * Get the latest pending proposal for a case.
     * Used to recover action_type when state is lost during resume.
     */
    async getLatestPendingProposal(caseId) {
        const result = await this.query(
            `SELECT * FROM proposals
             WHERE case_id = $1
             AND status IN ('PENDING_APPROVAL', 'DRAFT')
             ORDER BY created_at DESC
             LIMIT 1`,
            [caseId]
        );
        return result.rows[0];
    }

    /**
     * Update a proposal.
     */
    async updateProposal(proposalId, updates) {
        if (!updates || Object.keys(updates).length === 0) {
            return await this.getProposalById(proposalId);
        }

        // Convert camelCase to snake_case for DB
        const fieldMap = {
            executedAt: 'executed_at',
            emailJobId: 'email_job_id',
            executionKey: 'execution_key',
            humanDecision: 'human_decision',
            humanDecidedAt: 'human_decided_at',
            humanDecidedBy: 'human_decided_by',
            adjustmentCount: 'adjustment_count'
        };

        const entries = Object.entries(updates).map(([key, value]) => {
            const dbKey = fieldMap[key] || key;
            return [dbKey, value];
        });

        const setClauseParts = entries.map(([key], idx) => `${key} = $${idx + 2}`);
        setClauseParts.push('updated_at = CURRENT_TIMESTAMP');

        const values = [proposalId, ...entries.map(([, value]) => value)];
        const query = `UPDATE proposals SET ${setClauseParts.join(', ')} WHERE id = $1 RETURNING *`;
        const result = await this.query(query, values);
        const proposal = result.rows[0];
        if (proposal) {
            emitDataUpdate('proposal_update', {
                id: proposal.id,
                case_id: proposal.case_id,
                action_type: proposal.action_type,
                status: proposal.status,
                updated_at: proposal.updated_at
            });
        }
        return proposal;
    }

    /**
     * Claim execution for a proposal (P0 FIX #3: Idempotent execution).
     * Returns true if claimed, false if already claimed.
     */
    async claimProposalExecution(proposalId, executionKey) {
        const query = `
            UPDATE proposals
            SET execution_key = $2
            WHERE id = $1
              AND execution_key IS NULL
              AND status != 'EXECUTED'
            RETURNING id
        `;
        const result = await this.query(query, [proposalId, executionKey]);
        return result.rows.length > 0;
    }

    /**
     * Get pending proposals for a case.
     */
    async getPendingProposalsByCaseId(caseId) {
        const result = await this.query(
            `SELECT * FROM proposals
             WHERE case_id = $1 AND status = 'PENDING_APPROVAL'
             ORDER BY created_at DESC`,
            [caseId]
        );
        return result.rows;
    }

    /**
     * Get all proposals for a case (all statuses — for decision memory keyword extraction).
     */
    async getAllProposalsByCaseId(caseId) {
        const result = await this.query(
            `SELECT id, action_type, status, created_at FROM proposals
             WHERE case_id = $1
             ORDER BY created_at DESC`,
            [caseId]
        );
        return result.rows;
    }

    /**
     * Get all proposals needing human review.
     */
    async getProposalsNeedingReview(limit = 50) {
        const query = `
            SELECT p.*, c.case_name, c.agency_name, c.subject_name
            FROM proposals p
            JOIN cases c ON p.case_id = c.id
            WHERE p.status = 'PENDING_APPROVAL' AND p.requires_human = true
            ORDER BY p.created_at DESC
            LIMIT $1
        `;
        const result = await this.query(query, [limit]);
        return result.rows;
    }

    // =========================================================================
    // Escalations (for ESCALATE action)
    // =========================================================================

    /**
     * Upsert an escalation for a case.
     * Returns { id, wasInserted } to know if this is new.
     */
    async upsertEscalation(escalationData) {
        const query = `
            INSERT INTO escalations (
                case_id, execution_key, reason, urgency, suggested_action, status
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (execution_key) WHERE execution_key IS NOT NULL
            DO UPDATE SET
                reason = EXCLUDED.reason,
                urgency = EXCLUDED.urgency,
                suggested_action = EXCLUDED.suggested_action,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *, (xmax = 0) AS was_inserted
        `;

        const values = [
            escalationData.caseId,
            escalationData.executionKey,
            escalationData.reason,
            escalationData.urgency || 'medium',
            escalationData.suggestedAction || null,
            escalationData.status || 'OPEN'
        ];

        const result = await this.query(query, values);
        const row = result.rows[0];
        return {
            ...row,
            wasInserted: row.was_inserted
        };
    }

    /**
     * Get open escalations for a case.
     */
    async getOpenEscalationsByCaseId(caseId) {
        const result = await this.query(
            `SELECT * FROM escalations WHERE case_id = $1 AND status = 'OPEN' ORDER BY created_at DESC`,
            [caseId]
        );
        return result.rows;
    }

    /**
     * Resolve an escalation.
     */
    async resolveEscalation(escalationId, resolution) {
        const query = `
            UPDATE escalations
            SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP, resolution = $2
            WHERE id = $1
            RETURNING *
        `;
        const result = await this.query(query, [escalationId, resolution]);
        return result.rows[0];
    }

    // =========================================================================
    // Follow-up Schedule (extended)
    // =========================================================================

    /**
     * Get follow-up schedule by case ID.
     */
    async getFollowUpScheduleByCaseId(caseId) {
        const result = await this.query(
            'SELECT * FROM follow_up_schedule WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1',
            [caseId]
        );
        return result.rows[0];
    }

    /**
     * Get follow-up schedule by ID.
     */
    async getFollowUpScheduleById(followupId) {
        const result = await this.query(
            'SELECT * FROM follow_up_schedule WHERE id = $1',
            [followupId]
        );
        return result.rows[0];
    }

    /**
     * Upsert follow-up schedule for a case.
     */
    async upsertFollowUpSchedule(caseId, scheduleData) {
        const query = `
            INSERT INTO follow_up_schedule (
                case_id, thread_id, next_followup_date, followup_count,
                auto_send, status, last_followup_sent_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (case_id) WHERE case_id IS NOT NULL
            DO UPDATE SET
                next_followup_date = COALESCE(EXCLUDED.next_followup_date, follow_up_schedule.next_followup_date),
                followup_count = COALESCE(EXCLUDED.followup_count, follow_up_schedule.followup_count),
                auto_send = COALESCE(EXCLUDED.auto_send, follow_up_schedule.auto_send),
                status = COALESCE(EXCLUDED.status, follow_up_schedule.status),
                last_followup_sent_at = COALESCE(EXCLUDED.last_followup_sent_at, follow_up_schedule.last_followup_sent_at),
                updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `;

        const existing = await this.getFollowUpScheduleByCaseId(caseId);
        const threadId = scheduleData.threadId || existing?.thread_id || null;

        const values = [
            caseId,
            threadId,
            scheduleData.nextFollowupDate || null,
            scheduleData.followupCount || (existing?.followup_count || 0) + 1,
            scheduleData.autoSend !== false,
            scheduleData.status || 'scheduled',
            scheduleData.lastFollowupSentAt || null
        ];

        const result = await this.query(query, values);
        return result.rows[0];
    }

    // =========================================================================
    // Agent Decisions (for learning)
    // =========================================================================

    /**
     * Create an agent decision record for adaptive learning.
     */
    async createAgentDecision(decisionData) {
        const query = `
            INSERT INTO agent_decisions (
                case_id, reasoning, action_taken, confidence, trigger_type, outcome
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `;

        const values = [
            decisionData.caseId,
            decisionData.reasoning,
            decisionData.actionTaken,
            decisionData.confidence || 0.8,
            decisionData.triggerType,
            decisionData.outcome || 'pending'
        ];

        const result = await this.query(query, values);
        return result.rows[0];
    }

    // =========================================================================
    // Messages (extended for LangGraph)
    // =========================================================================

    /**
     * Get all messages for a case.
     */
    async getMessagesByCaseId(caseId, limit = 50) {
        const result = await this.query(
            `SELECT * FROM messages
             WHERE case_id = $1
             ORDER BY COALESCE(received_at, sent_at, created_at) DESC
             LIMIT $2`,
            [caseId, limit]
        );
        return result.rows;
    }

    /**
     * Get the latest inbound message for a case.
     */
    async getLatestInboundMessage(caseId) {
        const result = await this.query(
            `SELECT * FROM messages
             WHERE case_id = $1 AND direction = 'inbound'
             ORDER BY COALESCE(received_at, created_at) DESC
             LIMIT 1`,
            [caseId]
        );
        return result.rows[0];
    }

    // =========================================================================
    // Response Analysis (extended for LangGraph)
    // =========================================================================

    /**
     * Get latest analysis for a case.
     */
    async getAnalysisByCaseId(caseId) {
        const result = await this.query(
            `SELECT ra.* FROM response_analysis ra
             JOIN messages m ON ra.message_id = m.id
             WHERE m.case_id = $1
             ORDER BY ra.created_at DESC
             LIMIT 1`,
            [caseId]
        );
        return result.rows[0];
    }

    /**
     * Get analysis for a specific message.
     */
    async getAnalysisByMessageId(messageId) {
        const result = await this.query(
            'SELECT * FROM response_analysis WHERE message_id = $1',
            [messageId]
        );
        return result.rows[0];
    }

    // =========================================================================
    // Phone Call Queue
    // =========================================================================

    async createPhoneCallTask(data) {
        const result = await this.query(`
            INSERT INTO phone_call_queue (
                case_id, agency_name, agency_phone, agency_state,
                reason, priority, notes, days_since_sent
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `, [
            data.case_id,
            data.agency_name || null,
            data.agency_phone || null,
            data.agency_state || null,
            data.reason || 'no_email_response',
            data.priority || 0,
            data.notes || null,
            data.days_since_sent || null
        ]);
        return result.rows[0];
    }

    async getPendingPhoneCalls(limit = 50) {
        const result = await this.query(`
            SELECT pcq.*,
                c.case_name, c.subject_name, c.agency_email, c.status as case_status,
                c.send_date, c.state, c.additional_details, c.notion_page_id, c.user_id,
                COALESCE(pcq.agency_phone, a.phone) as agency_phone,
                a.phone as agency_phone_from_db, a.contact_name, a.address, a.email_foia, a.fax
            FROM phone_call_queue pcq
            JOIN cases c ON pcq.case_id = c.id
            LEFT JOIN agencies a ON c.agency_id = a.id
            WHERE pcq.status IN ('pending', 'claimed')
            ORDER BY pcq.priority DESC, pcq.days_since_sent DESC NULLS LAST, pcq.created_at ASC
            LIMIT $1
        `, [limit]);
        return result.rows;
    }

    async getPhoneCallsByStatus(status, limit = 50) {
        const result = await this.query(`
            SELECT pcq.*,
                c.case_name, c.subject_name, c.agency_email, c.status as case_status,
                c.send_date, c.state, c.additional_details, c.notion_page_id, c.user_id,
                COALESCE(pcq.agency_phone, a.phone) as agency_phone,
                a.phone as agency_phone_from_db, a.contact_name, a.address, a.email_foia, a.fax
            FROM phone_call_queue pcq
            JOIN cases c ON pcq.case_id = c.id
            LEFT JOIN agencies a ON c.agency_id = a.id
            WHERE pcq.status = $1
            ORDER BY pcq.updated_at DESC
            LIMIT $2
        `, [status, limit]);
        return result.rows;
    }

    async getPhoneCallById(id) {
        const result = await this.query(`
            SELECT pcq.*,
                c.case_name, c.subject_name, c.agency_email, c.agency_name as case_agency_name, c.status as case_status,
                c.send_date, c.state, c.additional_details, c.notion_page_id,
                COALESCE(pcq.agency_phone, a.phone) as agency_phone,
                a.phone as agency_phone_from_db, a.contact_name, a.address, a.email_foia, a.fax
            FROM phone_call_queue pcq
            JOIN cases c ON pcq.case_id = c.id
            LEFT JOIN agencies a ON c.agency_id = a.id
            WHERE pcq.id = $1
        `, [id]);
        return result.rows[0];
    }

    async claimPhoneCall(id, assignedTo) {
        const result = await this.query(`
            UPDATE phone_call_queue
            SET status = 'claimed',
                assigned_to = $2,
                claimed_at = NOW(),
                updated_at = NOW()
            WHERE id = $1 AND status = 'pending'
            RETURNING *
        `, [id, assignedTo]);
        return result.rows[0];
    }

    async completePhoneCall(id, outcome, notes, completedBy) {
        const result = await this.query(`
            UPDATE phone_call_queue
            SET status = 'completed',
                call_outcome = $2,
                call_notes = $3,
                completed_by = $4,
                completed_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
        `, [id, outcome, notes, completedBy]);
        return result.rows[0];
    }

    async skipPhoneCall(id, notes) {
        const result = await this.query(`
            UPDATE phone_call_queue
            SET status = 'skipped',
                call_notes = $2,
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
        `, [id, notes]);
        return result.rows[0];
    }

    async getPhoneCallByCaseId(caseId) {
        const result = await this.query(`
            SELECT * FROM phone_call_queue
            WHERE case_id = $1
            ORDER BY created_at DESC
            LIMIT 1
        `, [caseId]);
        return result.rows[0];
    }

    async updatePhoneCallBriefing(id, briefing) {
        const result = await this.query(`
            UPDATE phone_call_queue
            SET ai_briefing = $2, updated_at = NOW()
            WHERE id = $1
            RETURNING *
        `, [id, JSON.stringify(briefing)]);
        return result.rows[0];
    }

    async getPhoneCallQueueStats() {
        const result = await this.query(`
            SELECT
                COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                COUNT(*) FILTER (WHERE status = 'claimed') AS claimed,
                COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                COUNT(*) FILTER (WHERE status = 'skipped') AS skipped
            FROM phone_call_queue
        `);
        return result.rows[0];
    }

    // =========================================================================
    // Case Agencies (Multi-agency support)
    // =========================================================================

    async addCaseAgency(caseId, agencyData) {
        // Check if this is the first agency for this case
        const existing = await this.query(
            'SELECT COUNT(*) as cnt FROM case_agencies WHERE case_id = $1 AND is_active = true',
            [caseId]
        );
        const isFirst = parseInt(existing.rows[0].cnt) === 0;
        const isPrimary = agencyData.is_primary !== undefined ? agencyData.is_primary : isFirst;

        const result = await this.query(`
            INSERT INTO case_agencies (
                case_id, agency_id, agency_name, agency_email, portal_url, portal_provider,
                is_primary, is_active, added_source, status, notes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10)
            RETURNING *
        `, [
            caseId,
            agencyData.agency_id || null,
            agencyData.agency_name,
            agencyData.agency_email || null,
            agencyData.portal_url || null,
            agencyData.portal_provider || null,
            isPrimary,
            agencyData.added_source || 'manual',
            agencyData.status || 'pending',
            agencyData.notes || null
        ]);

        const caseAgency = result.rows[0];

        // Sync to cases table if this is the primary
        if (isPrimary) {
            await this.syncPrimaryAgencyToCase(caseId, caseAgency);
        }

        return caseAgency;
    }

    async getCaseAgencies(caseId, includeInactive = false) {
        const whereClause = includeInactive
            ? 'WHERE ca.case_id = $1'
            : 'WHERE ca.case_id = $1 AND ca.is_active = true';
        const result = await this.query(
            `SELECT ca.*, a.notion_page_id as agency_notion_page_id
             FROM case_agencies ca
             LEFT JOIN agencies a ON ca.agency_id = a.id
             ${whereClause}
             ORDER BY ca.is_primary DESC, ca.created_at ASC`,
            [caseId]
        );
        return result.rows;
    }

    async getPrimaryCaseAgency(caseId) {
        const result = await this.query(
            'SELECT * FROM case_agencies WHERE case_id = $1 AND is_primary = true AND is_active = true LIMIT 1',
            [caseId]
        );
        return result.rows[0] || null;
    }

    async getCaseAgencyById(caseAgencyId) {
        const result = await this.query(
            'SELECT * FROM case_agencies WHERE id = $1',
            [caseAgencyId]
        );
        return result.rows[0] || null;
    }

    async switchPrimaryAgency(caseId, newPrimaryCaseAgencyId) {
        // Transactional: clear old primary, set new, sync to cases
        await this.query(
            'UPDATE case_agencies SET is_primary = false, updated_at = NOW() WHERE case_id = $1 AND is_primary = true',
            [caseId]
        );
        const result = await this.query(
            'UPDATE case_agencies SET is_primary = true, updated_at = NOW() WHERE id = $1 AND case_id = $2 RETURNING *',
            [newPrimaryCaseAgencyId, caseId]
        );
        const newPrimary = result.rows[0];
        if (newPrimary) {
            await this.syncPrimaryAgencyToCase(caseId, newPrimary);
        }
        return newPrimary;
    }

    async removeCaseAgency(caseAgencyId) {
        const ca = await this.getCaseAgencyById(caseAgencyId);
        if (!ca) return null;

        // Deactivate
        await this.query(
            'UPDATE case_agencies SET is_active = false, updated_at = NOW() WHERE id = $1',
            [caseAgencyId]
        );

        // If removing primary, auto-promote next active agency
        if (ca.is_primary) {
            const nextResult = await this.query(
                'SELECT id FROM case_agencies WHERE case_id = $1 AND is_active = true AND id != $2 ORDER BY created_at ASC LIMIT 1',
                [ca.case_id, caseAgencyId]
            );
            if (nextResult.rows[0]) {
                await this.switchPrimaryAgency(ca.case_id, nextResult.rows[0].id);
            }
        }

        return ca;
    }

    async updateCaseAgency(caseAgencyId, updates) {
        if (!updates || Object.keys(updates).length === 0) {
            return this.getCaseAgencyById(caseAgencyId);
        }

        const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
        if (entries.length === 0) return this.getCaseAgencyById(caseAgencyId);

        const setClauses = entries.map(([key], i) => `${key} = $${i + 2}`);
        setClauses.push('updated_at = NOW()');
        const values = [caseAgencyId, ...entries.map(([, v]) => v)];

        const result = await this.query(
            `UPDATE case_agencies SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
            values
        );

        // If this is the primary, sync changes to cases table
        const updated = result.rows[0];
        if (updated?.is_primary) {
            await this.syncPrimaryAgencyToCase(updated.case_id, updated);
        }

        return updated;
    }

    async syncPrimaryAgencyToCase(caseId, primaryCaseAgency) {
        await this.query(`
            UPDATE cases SET
                agency_name = $2,
                agency_email = $3,
                portal_url = $4,
                portal_provider = $5,
                updated_at = NOW()
            WHERE id = $1
        `, [
            caseId,
            primaryCaseAgency.agency_name,
            primaryCaseAgency.agency_email,
            primaryCaseAgency.portal_url,
            primaryCaseAgency.portal_provider
        ]);
    }

    async getThreadByCaseAgencyId(caseAgencyId) {
        const result = await this.query(
            'SELECT * FROM email_threads WHERE case_agency_id = $1 ORDER BY created_at DESC LIMIT 1',
            [caseAgencyId]
        );
        return result.rows[0] || null;
    }

    // Utility
    async healthCheck() {
        try {
            const result = await this.query('SELECT NOW()');
            return { healthy: true, timestamp: result.rows[0].now };
        } catch (error) {
            return { healthy: false, error: error.message };
        }
    }

    async close() {
        await this.pool.end();
    }

    // =========================================================================
    // AGENCY LOOKUP (Fuzzy matching for case linking)
    // =========================================================================

    /**
     * Find agency by name with fuzzy matching
     * @param {string} agencyName - The agency name to search for
     * @param {string} state - Optional state to narrow search
     * @returns {Object|null} - Matched agency or null
     */
    async findAgencyByName(agencyName, state = null) {
        if (!agencyName) return null;

        try {
            // First try exact match
            let result = await this.query(`
                SELECT id, name, state, portal_url, email_main, default_autopilot_mode
                FROM agencies
                WHERE name = $1
                  AND ($2::text IS NULL OR state = $2)
                LIMIT 1
            `, [agencyName, state]);

            if (result.rows.length > 0) {
                return result.rows[0];
            }

            // Try normalized match (remove common suffixes)
            result = await this.query(`
                SELECT id, name, state, portal_url, email_main, default_autopilot_mode
                FROM agencies
                WHERE ($2::text IS NULL OR state = $2 OR state IS NULL)
                  AND LOWER(REGEXP_REPLACE(name, '\\s*(Police\\s*Dep(ar)?t(ment)?|PD|Sheriff.s?\\s*(Office|Dep(ar)?t(ment)?)?|Law\\s*Enforcement|LEA)\\s*$', '', 'i'))
                    = LOWER(REGEXP_REPLACE($1, '\\s*(Police\\s*Dep(ar)?t(ment)?|PD|Sheriff.s?\\s*(Office|Dep(ar)?t(ment)?)?|Law\\s*Enforcement|LEA)\\s*$', '', 'i'))
                LIMIT 1
            `, [agencyName, state]);

            if (result.rows.length > 0) {
                return result.rows[0];
            }

            // Try case-insensitive contains match as last resort
            result = await this.query(`
                SELECT id, name, state, portal_url, email_main, default_autopilot_mode
                FROM agencies
                WHERE ($2::text IS NULL OR state = $2 OR state IS NULL)
                  AND (
                    LOWER(name) LIKE LOWER('%' || $1 || '%')
                    OR LOWER($1) LIKE LOWER('%' || name || '%')
                  )
                ORDER BY LENGTH(name) ASC
                LIMIT 1
            `, [agencyName, state]);

            return result.rows[0] || null;

        } catch (error) {
            console.error('Error finding agency by name:', error);
            return null;
        }
    }

    /**
     * Link a case to its matching agency
     * @param {number} caseId - Case ID
     * @param {string} agencyName - Agency name from the case
     * @param {string} state - State from the case
     * @returns {Object|null} - Linked agency or null
     */
    async linkCaseToAgency(caseId, agencyName, state = null) {
        const agency = await this.findAgencyByName(agencyName, state);

        if (agency) {
            await this.query(
                'UPDATE cases SET agency_id = $1 WHERE id = $2 AND agency_id IS NULL',
                [agency.id, caseId]
            );
            return agency;
        }

        return null;
    }

    // === Aliases for LangGraph nodes compatibility ===

    // Alias: saveResponseAnalysis -> createResponseAnalysis
    async saveResponseAnalysis(analysisData) {
        // Map camelCase field names to snake_case for DB
        return this.createResponseAnalysis({
            message_id: analysisData.messageId,
            case_id: analysisData.caseId,
            intent: analysisData.intent,
            confidence_score: analysisData.confidenceScore,
            sentiment: analysisData.sentiment,
            key_points: analysisData.keyPoints,
            extracted_deadline: analysisData.extractedDeadline,
            extracted_fee_amount: analysisData.extractedFeeAmount,
            requires_action: analysisData.requiresAction,
            suggested_action: analysisData.suggestedAction,
            full_analysis_json: analysisData.fullAnalysisJson
        });
    }

    // Alias: getResponseAnalysisByMessageId -> getAnalysisByMessageId
    async getResponseAnalysisByMessageId(messageId) {
        return this.getAnalysisByMessageId(messageId);
    }

    // Alias: getLatestResponseAnalysis -> getAnalysisByCaseId
    async getLatestResponseAnalysis(caseId) {
        return this.getAnalysisByCaseId(caseId);
    }

    // =========================================================================
    // EXECUTIONS TABLE (Migration 019)
    // =========================================================================

    /**
     * Create an execution record with idempotency via execution_key
     */
    async createExecution(data) {
        const result = await this.query(`
            INSERT INTO executions (
                case_id, proposal_id, run_id, execution_key, action_type,
                status, provider, provider_payload
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (execution_key) DO NOTHING
            RETURNING *
        `, [
            data.case_id,
            data.proposal_id,
            data.run_id,
            data.execution_key,
            data.action_type,
            data.status || 'QUEUED',
            data.provider,
            data.provider_payload ? JSON.stringify(data.provider_payload) : null
        ]);
        return result.rows[0];
    }

    /**
     * Get execution by its unique key
     */
    async getExecutionByKey(executionKey) {
        const result = await this.query(
            'SELECT * FROM executions WHERE execution_key = $1',
            [executionKey]
        );
        return result.rows[0];
    }

    /**
     * Update execution status and payload
     */
    async updateExecution(executionId, updates) {
        const setClauses = [];
        const values = [];
        let paramIndex = 1;

        for (const [key, value] of Object.entries(updates)) {
            if (value !== undefined) {
                setClauses.push(`${key} = $${paramIndex}`);
                values.push(key.includes('payload') ? JSON.stringify(value) : value);
                paramIndex++;
            }
        }

        if (setClauses.length === 0) return null;

        values.push(executionId);
        const result = await this.query(`
            UPDATE executions
            SET ${setClauses.join(', ')}
            WHERE id = $${paramIndex}
            RETURNING *
        `, values);
        return result.rows[0];
    }

    /**
     * Mark execution as sent with provider response
     */
    async markExecutionSent(executionKey, providerPayload) {
        const result = await this.query(`
            UPDATE executions
            SET status = 'SENT',
                provider_payload = $2,
                provider_message_id = $3,
                completed_at = NOW()
            WHERE execution_key = $1
            RETURNING *
        `, [
            executionKey,
            JSON.stringify(providerPayload),
            providerPayload?.messageId || providerPayload?.message_id
        ]);
        return result.rows[0];
    }

    /**
     * Mark execution as failed
     */
    async markExecutionFailed(executionKey, errorMessage) {
        const result = await this.query(`
            UPDATE executions
            SET status = 'FAILED',
                error_message = $2,
                retry_count = retry_count + 1,
                completed_at = NOW()
            WHERE execution_key = $1
            RETURNING *
        `, [executionKey, errorMessage]);
        return result.rows[0];
    }

    /**
     * Get executions for a proposal
     */
    async getExecutionsByProposalId(proposalId) {
        const result = await this.query(
            'SELECT * FROM executions WHERE proposal_id = $1 ORDER BY created_at DESC',
            [proposalId]
        );
        return result.rows;
    }

    // =========================================================================
    // DECISION_TRACES TABLE (Migration 019)
    // =========================================================================

    /**
     * Create a decision trace record for observability
     */
    async createDecisionTrace(data) {
        const result = await this.query(`
            INSERT INTO decision_traces (
                run_id, case_id, message_id,
                classification, router_output, node_trace, gate_decision,
                started_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `, [
            data.run_id,
            data.case_id,
            data.message_id,
            data.classification ? JSON.stringify(data.classification) : null,
            data.router_output ? JSON.stringify(data.router_output) : null,
            data.node_trace ? JSON.stringify(data.node_trace) : null,
            data.gate_decision ? JSON.stringify(data.gate_decision) : null,
            data.started_at || new Date()
        ]);
        return result.rows[0];
    }

    /**
     * Update decision trace with completion data
     */
    async completeDecisionTrace(traceId, updates) {
        const result = await this.query(`
            UPDATE decision_traces
            SET classification = COALESCE($2, classification),
                router_output = COALESCE($3, router_output),
                node_trace = COALESCE($4, node_trace),
                gate_decision = COALESCE($5, gate_decision),
                completed_at = NOW(),
                duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
            WHERE id = $1
            RETURNING *
        `, [
            traceId,
            updates.classification ? JSON.stringify(updates.classification) : null,
            updates.router_output ? JSON.stringify(updates.router_output) : null,
            updates.node_trace ? JSON.stringify(updates.node_trace) : null,
            updates.gate_decision ? JSON.stringify(updates.gate_decision) : null
        ]);
        return result.rows[0];
    }

    /**
     * Get decision trace by run ID
     */
    async getDecisionTraceByRunId(runId) {
        const result = await this.query(
            'SELECT * FROM decision_traces WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1',
            [runId]
        );
        return result.rows[0];
    }

    /**
     * Get all decision traces for a case
     */
    async getDecisionTracesByCaseId(caseId, limit = 10) {
        const result = await this.query(
            'SELECT * FROM decision_traces WHERE case_id = $1 ORDER BY created_at DESC LIMIT $2',
            [caseId, limit]
        );
        return result.rows;
    }

    // =========================================================================
    // AGENT_RUNS UPDATES (Migration 019 additions)
    // =========================================================================

    /**
     * Create agent run with full context (including new fields from migration 019)
     */
    async createAgentRunFull(data) {
        const result = await this.query(`
            INSERT INTO agent_runs (
                case_id, trigger_type, langgraph_thread_id, message_id,
                scheduled_key, autopilot_mode, status, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `, [
            data.case_id,
            data.trigger_type,
            data.langgraph_thread_id,
            data.message_id,
            data.scheduled_key,
            data.autopilot_mode,
            data.status || 'created',
            data.metadata || {}  // Pass JS object directly for JSONB column
        ]);
        return result.rows[0];
    }

    /**
     * Update message as processed by a run
     */
    async markMessageProcessed(messageId, runId, error = null) {
        const result = await this.query(`
            UPDATE messages
            SET processed_at = NOW(),
                processed_run_id = $2,
                last_error = $3
            WHERE id = $1
            RETURNING *
        `, [messageId, runId, error]);
        return result.rows[0];
    }

    /**
     * Link proposal to its creating run
     */
    async linkProposalToRun(proposalId, runId, pauseReason = null) {
        const result = await this.query(`
            UPDATE proposals
            SET run_id = $2,
                pause_reason = COALESCE($3, pause_reason)
            WHERE id = $1
            RETURNING *
        `, [proposalId, runId, pauseReason]);
        return result.rows[0];
    }

    /**
     * Get active (non-completed) agent run for a case
     * Used by run-engine routes to prevent duplicate runs
     */
    async getActiveRunForCase(caseId) {
        const result = await this.query(`
            SELECT * FROM agent_runs
            WHERE case_id = $1
              AND status IN ('created', 'queued', 'running', 'paused')
            ORDER BY started_at DESC
            LIMIT 1
        `, [caseId]);
        return result.rows[0];
    }

    /**
     * Get proposals created by a specific run
     */
    async getProposalsByRunId(runId) {
        const result = await this.query(`
            SELECT * FROM proposals
            WHERE run_id = $1
            ORDER BY created_at DESC
        `, [runId]);
        return result.rows;
    }

    // =========================================================================
    // Feature 1: Outcome Tracking
    // =========================================================================

    async getOutcomeSummary() {
        const result = await this.query(`
            SELECT
                outcome_type,
                COUNT(*) as count
            FROM cases
            WHERE outcome_type IS NOT NULL
            GROUP BY outcome_type
            ORDER BY count DESC
        `);
        return result.rows;
    }

    // =========================================================================
    // Feature 2: Fee History
    // =========================================================================

    async logFeeEvent(caseId, eventType, amount = null, notes = null, sourceMessageId = null) {
        const result = await this.query(`
            INSERT INTO fee_history (case_id, event_type, amount, notes, source_message_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [caseId, eventType, amount, notes, sourceMessageId]);
        return result.rows[0];
    }

    async getFeeHistoryByCaseId(caseId) {
        const result = await this.query(`
            SELECT * FROM fee_history
            WHERE case_id = $1
            ORDER BY created_at ASC
        `, [caseId]);
        return result.rows;
    }

    // =========================================================================
    // Feature 3: Tags
    // =========================================================================

    async updateCaseTags(caseId, tags) {
        const result = await this.query(`
            UPDATE cases SET tags = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *
        `, [caseId, tags]);
        return result.rows[0];
    }

    // =========================================================================
    // Feature 6: Attachments
    // =========================================================================

    async createAttachment(data) {
        const result = await this.query(`
            INSERT INTO attachments (message_id, case_id, filename, content_type, size_bytes, storage_path, file_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `, [data.message_id, data.case_id, data.filename, data.content_type, data.size_bytes, data.storage_path, data.file_data || null]);
        return result.rows[0];
    }

    async getAttachmentsByCaseId(caseId) {
        const result = await this.query(`
            SELECT a.id, a.message_id, a.case_id, a.filename, a.content_type, a.size_bytes,
                   a.storage_path, a.storage_url, a.created_at,
                   m.subject AS message_subject, m.direction AS message_direction
            FROM attachments a
            LEFT JOIN messages m ON a.message_id = m.id
            WHERE a.case_id = $1
            ORDER BY a.created_at DESC
        `, [caseId]);
        return result.rows;
    }

    async getAttachmentById(id) {
        const result = await this.query('SELECT * FROM attachments WHERE id = $1', [id]);
        return result.rows[0];
    }

    async dismissMessage(messageId) {
        await this.query('DELETE FROM messages WHERE id = $1 AND case_id IS NULL', [messageId]);
    }

    // =========================================================================
    // Feature 7: Unmatched Portal Signals
    // =========================================================================

    async saveUnmatchedPortalSignal(data) {
        const result = await this.query(`
            INSERT INTO unmatched_portal_signals
                (message_id, from_email, from_domain, subject, detected_request_number, portal_provider, portal_subdomain)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `, [
            data.message_id || null,
            data.from_email || null,
            data.from_domain || null,
            data.subject || null,
            data.detected_request_number || null,
            data.portal_provider || null,
            data.portal_subdomain || null
        ]);
        return result.rows[0];
    }

    async getLastOutboundTime(caseId) {
        const result = await this.query(`
            SELECT sent_at FROM messages
            WHERE case_id = $1 AND direction = 'outbound'
            ORDER BY sent_at DESC
            LIMIT 1
        `, [caseId]);
        return result.rows[0]?.sent_at || null;
    }

    async findUnmatchedByRequestNumber(requestNumber) {
        const result = await this.query(`
            SELECT * FROM unmatched_portal_signals
            WHERE detected_request_number = $1
              AND matched_case_id IS NULL
            ORDER BY created_at DESC
        `, [requestNumber]);
        return result.rows;
    }

    async markUnmatchedSignalMatched(signalId, caseId) {
        const result = await this.query(`
            UPDATE unmatched_portal_signals
            SET matched_case_id = $2
            WHERE id = $1
            RETURNING *
        `, [signalId, caseId]);
        return result.rows[0];
    }
}

module.exports = new DatabaseService();
