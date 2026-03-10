const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

const requestRouter = require('../routes/requests/query');
const db = require('../services/database');
const { hasMissingImportDeliveryPath } = require('../routes/requests/_helpers');
const { resolveReviewState } = require('../lib/resolve-review-state');

describe('import review workspace blocking', function () {
  it('treats NO_MX_RECORD with unsupported portal as missing a real delivery path', function () {
    const result = hasMissingImportDeliveryPath({
      agency_email: 'info@boonewvsheriff.org',
      portal_url: 'https://boonewvsheriff.org',
      import_warnings: [
        { type: 'NO_MX_RECORD', message: 'No MX records found for domain "boonewvsheriff.org"' },
      ],
    });

    assert.strictEqual(result, true);
  });

  it('resolveReviewState parks import-mismatch cases with no proposal as IDLE', function () {
    const reviewState = resolveReviewState({
      caseData: {
        status: 'needs_human_review',
        requires_human: false,
        pause_reason: null,
        substatus: null,
        import_warnings: [
          { type: 'AGENCY_CITY_MISMATCH', message: 'Agency name may not match case city' },
        ],
      },
      activeProposal: null,
      activeRun: null,
    });

    assert.strictEqual(reviewState, 'IDLE');
  });

  it('GET /api/requests/:id/workspace blocks import-mismatch cases even without old pause markers', async function () {
    const originalDbMethods = {
      getCaseById: db.getCaseById,
      getCaseAgencies: db.getCaseAgencies,
      getThreadsByCaseId: db.getThreadsByCaseId,
      getMessagesByThreadId: db.getMessagesByThreadId,
      getAttachmentsByCaseId: db.getAttachmentsByCaseId,
      getUserById: db.getUserById,
      query: db.query,
    };

    db.getCaseById = async () => ({
      id: 26679,
      subject_name: 'Princeton Dad Sentenced To Life For Beating, Starving His 8-Year-Old Son To Death',
      case_name: 'Princeton Dad Sentenced To Life For Beating, Starving His 8-Year-Old Son To Death',
      agency_id: null,
      agency_name: 'Westbrook Police Department',
      agency_email: 'princetonpolicedepartment@gmail.com',
      portal_url: 'https://www.princetontx.gov/296/Submit-an-Open-Records-Request',
      portal_provider: null,
      notion_page_id: '31f87c20070a8123abcd1234567890ff',
      state: 'TX',
      status: 'needs_human_review',
      requires_human: false,
      pause_reason: null,
      substatus: null,
      contact_research_notes: null,
      requested_records: ['Incident report'],
      additional_details: [
        'City : Princeton',
        'Portal: https://www.princetontx.gov/296/Submit-an-Open-Records-Request',
        'Lead agency: Princeton Police Department',
      ].join('\n'),
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-10T00:00:00.000Z',
      updated_at: '2026-03-10T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
      user_id: null,
      import_warnings: null,
    });
    db.getCaseAgencies = async () => ([]);
    db.getThreadsByCaseId = async () => [];
    db.getMessagesByThreadId = async () => [];
    db.getAttachmentsByCaseId = async () => [];
    db.getUserById = async () => null;
    db.query = async (sql) => {
      if (sql.includes('FROM portal_tasks')) return { rows: [] };
      if (sql.includes('FROM activity_log')) return { rows: [] };
      if (sql.includes('FROM auto_reply_queue')) return { rows: [] };
      if (sql.includes('FROM agent_decisions')) return { rows: [] };
      if (sql.includes('FROM agent_runs')) return { rows: [] };
      if (sql.includes('FROM proposals')) return { rows: [] };
      if (sql.includes('UPDATE cases')) return { rows: [] };
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes("LOWER(REPLACE(COALESCE(notion_page_id, ''), '-', ''))")) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE id = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) return { rows: [] };
      if (sql.includes('FROM case_agencies')) return { rows: [] };
      throw new Error(`Unexpected workspace query in import mismatch block test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/26679/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.pending_proposal, null);
      assert.strictEqual(response.body.next_action_proposal, null);
      assert.strictEqual(response.body.request.status, 'NEEDS_HUMAN_REVIEW');
      assert.strictEqual(response.body.request.review_state, 'IDLE');
      assert.strictEqual(response.body.request.control_state, 'BLOCKED');
      assert.strictEqual(response.body.request.pause_reason, 'IMPORT_REVIEW');
      assert.match(response.body.request.substatus, /imported case/i);
    } finally {
      db.getCaseById = originalDbMethods.getCaseById;
      db.getCaseAgencies = originalDbMethods.getCaseAgencies;
      db.getThreadsByCaseId = originalDbMethods.getThreadsByCaseId;
      db.getMessagesByThreadId = originalDbMethods.getMessagesByThreadId;
      db.getAttachmentsByCaseId = originalDbMethods.getAttachmentsByCaseId;
      db.getUserById = originalDbMethods.getUserById;
      db.query = originalDbMethods.query;
    }
  });
});
