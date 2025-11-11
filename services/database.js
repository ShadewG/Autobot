const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DatabaseService {
    constructor() {
        this.pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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
            console.log('Database schema initialized successfully');
            return true;
        } catch (error) {
            console.error('Failed to initialize database:', error);
            throw error;
        }
    }

    // Cases
    async createCase(caseData) {
        const query = `
            INSERT INTO cases (
                notion_page_id, case_name, subject_name, agency_name, agency_email,
                state, incident_date, incident_location, requested_records,
                additional_details, status, deadline_date
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
            caseData.deadline_date
        ];
        const result = await this.query(query, values);
        return result.rows[0];
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
        return result.rows[0];
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
            last_portal_account_email: portalData.last_portal_account_email
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
        return result.rows[0];
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
        return result.rows[0];
    }

    // Email Threads
    async createEmailThread(threadData) {
        const query = `
            INSERT INTO email_threads (case_id, thread_id, subject, agency_email, initial_message_id, status)
            VALUES ($1, $2, $3, $4, $5, $6)
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
                portal_notification_type, portal_notification_provider, sent_at, received_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
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
            messageData.received_at || null
        ];
        const result = await this.query(query, values);
        return result.rows[0];
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

    // Response Analysis
    async createResponseAnalysis(analysisData) {
        const query = `
            INSERT INTO response_analysis (
                message_id, case_id, intent, confidence_score, sentiment,
                key_points, extracted_deadline, extracted_fee_amount,
                requires_action, suggested_action, full_analysis_json
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
                lm.sent_at AS last_message_sent_at
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
            WHERE c.status = ANY($1)
            ORDER BY c.updated_at DESC
            LIMIT $2
        `;

        const result = await this.query(query, [reviewStatuses, limit]);
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
            INSERT INTO activity_log (event_type, case_id, message_id, description, metadata)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `;
        const values = [
            eventType,
            metadata.case_id || null,
            metadata.message_id || null,
            description,
            metadata
        ];
        const result = await this.query(query, values);
        return result.rows[0];
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

        query += ' AND account_status = \'active\' ORDER BY created_at DESC LIMIT 1';

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
}

module.exports = new DatabaseService();
