const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

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
                has_attachments, attachment_count, message_type, sent_at, received_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
            messageData.cc_emails,
            messageData.subject,
            messageData.body_text,
            messageData.body_html,
            messageData.has_attachments || false,
            messageData.attachment_count || 0,
            messageData.message_type,
            messageData.sent_at,
            messageData.received_at
        ];
        const result = await this.query(query, values);
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
