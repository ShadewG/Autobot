const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

const requestHelpers = require('../routes/requests/_helpers');
const requestRouter = require('../routes/requests/query');
const caseAgenciesRouter = require('../routes/case-agencies');
const db = require('../services/database');

describe('Request alignment regressions', function () {
  it('toRequestListItem derives state from agency name and normalizes stale portal timeout text', function () {
    const item = requestHelpers.toRequestListItem({
      id: 25152,
      subject_name: 'Roanoke case',
      requested_records: ['CAD'],
      agency_name: 'Roanoke City Police Department, Virginia',
      state: null,
      status: 'needs_human_review',
      substatus: 'Portal timed out (>30 min): Status: created',
      updated_at: '2026-03-06T00:00:00.000Z',
      created_at: '2026-03-05T00:00:00.000Z',
      requires_human: true,
      active_run_status: null,
      active_proposal_status: 'PENDING_APPROVAL',
      active_portal_task_status: null,
      active_portal_task_type: null,
      pause_reason: null,
      autopilot_mode: 'SUPERVISED',
      due_info_jsonb: null,
      fee_quote_jsonb: null,
      last_fee_quote_amount: null,
      last_response_date: null,
      next_due_at: null,
    });

    assert.strictEqual(item.state, 'VA');
    assert.strictEqual(
      item.substatus,
      'Portal timed out (>30 min): No active submit-portal run; last portal task status was created'
    );
  });

  it('toRequestListItem prefers an explicit agency-state label over stale case state', function () {
    const item = requestHelpers.toRequestListItem({
      id: 25210,
      subject_name: 'Lubbock case',
      requested_records: ['Body camera footage'],
      agency_name: 'Lubbock Police Department, Texas',
      state: 'GA',
      status: 'needs_human_review',
      substatus: 'Portal account locked — manual login needed',
      updated_at: '2026-03-06T00:00:00.000Z',
      created_at: '2026-03-05T00:00:00.000Z',
      requires_human: true,
      active_run_status: null,
      active_proposal_status: null,
      active_portal_task_status: null,
      active_portal_task_type: null,
      pause_reason: null,
      autopilot_mode: 'SUPERVISED',
      due_info_jsonb: null,
      fee_quote_jsonb: null,
      last_fee_quote_amount: null,
      last_response_date: null,
      next_due_at: null,
    });

    assert.strictEqual(item.state, 'TX');
  });

  it('extractAgencyCandidatesFromResearchNotes falls back to execution suggested agency', function () {
    const candidates = requestHelpers.extractAgencyCandidatesFromResearchNotes(JSON.stringify({
      brief: {
        researchFailed: true,
        suggested_agencies: [],
        summary: 'Research failed: Request was aborted.. Manual agency lookup needed.',
      },
      execution: {
        suggested_agency: "Barrow County Sheriff's Office",
        research_failure_reason: 'Research failed: Request was aborted.. Manual agency lookup needed.',
      },
    }));

    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].name, "Barrow County Sheriff's Office");
    assert.strictEqual(candidates[0].source, 'execution.suggested_agency');
  });

  it('GET /api/requests prefers research suggested agency over placeholder backfill rows', async function () {
    const originalQuery = requestHelpers.db.query;

    requestHelpers.db.query = async (sql) => {
      if (sql.includes('FROM cases c') && sql.includes('LEFT JOIN LATERAL')) {
        return {
          rows: [
            {
              id: 25243,
              subject_name: null,
              requested_records: [],
              case_name: 'Father of Georgia school shooter found guilty',
              agency_id: null,
              agency_name: 'Stow Police Department',
              agency_email: 'pending-research@placeholder.invalid',
              state: 'GA',
              portal_url: null,
              portal_provider: null,
              contact_research_notes: JSON.stringify({
                brief: { researchFailed: true, suggested_agencies: [], summary: 'Research failed' },
                execution: { suggested_agency: "Barrow County Sheriff's Office", research_failure_reason: 'Research failed' },
              }),
              status: 'needs_human_review',
              requires_human: true,
              updated_at: '2026-03-06T00:00:00.000Z',
              created_at: '2026-03-05T00:00:00.000Z',
              next_due_at: null,
              last_response_date: null,
              active_run_status: null,
              active_run_trigger_type: null,
              active_run_started_at: null,
              active_run_trigger_run_id: null,
              active_portal_task_status: null,
              active_portal_task_type: null,
              active_proposal_status: 'PENDING_APPROVAL',
              autopilot_mode: 'SUPERVISED',
              substatus: 'agency_research_complete',
            },
          ],
        };
      }

      if (sql.includes('SELECT DISTINCT ON (ca.case_id)')) {
        return {
          rows: [
            {
              case_id: 25243,
              agency_id: 152,
              agency_name: 'Stow Police Department',
              agency_email: 'pending-research@placeholder.invalid',
              portal_url: null,
              portal_provider: null,
              added_source: 'case_row_backfill',
              canonical_agency_name: 'Stow Police Department',
              canonical_state: 'OH',
              canonical_email_main: null,
              canonical_email_foia: null,
              canonical_portal_url: null,
              canonical_portal_url_alt: null,
              canonical_portal_provider: null,
            },
          ],
        };
      }

      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
        if (sql.includes("Barrow County Sheriff's Office")) {
          return {
            rows: [
              {
                id: 2001,
                name: "Barrow County Sheriff's Office",
                state: 'GA',
                email_main: null,
                email_foia: null,
                portal_url: null,
                portal_url_alt: null,
                portal_provider: null,
                score: 9,
                completeness: 1,
              },
            ],
          };
        }
        return { rows: [] };
      }

      if (sql.includes("WHERE c.status IN ('completed', 'cancelled')")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query in request alignment test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.requests[0].agency_name, "Barrow County Sheriff's Office");
      assert.strictEqual(response.body.requests[0].state, 'GA');
    } finally {
      requestHelpers.db.query = originalQuery;
    }
  });

  it('GET /api/requests does not discard primary referral rows just because they are inactive', async function () {
    const originalQuery = requestHelpers.db.query;

    requestHelpers.db.query = async (sql) => {
      if (sql.includes('FROM cases c') && sql.includes('LEFT JOIN LATERAL')) {
        return {
          rows: [
            {
              id: 25206,
              subject_name: 'Iowa case',
              requested_records: ['Body camera footage'],
              case_name: 'Iowa case',
              agency_id: null,
              agency_name: 'Alaska State Troopers',
              agency_email: 'milfordpd@milford.ia.us',
              state: 'IA',
              portal_url: 'https://milford.ia.us/city-of-milford-contact/',
              portal_provider: null,
              contact_research_notes: null,
              status: 'responded',
              requires_human: false,
              updated_at: '2026-03-06T00:00:00.000Z',
              created_at: '2026-03-05T00:00:00.000Z',
              next_due_at: null,
              last_response_date: null,
              active_run_status: null,
              active_run_trigger_type: null,
              active_run_started_at: null,
              active_run_trigger_run_id: null,
              active_portal_task_status: null,
              active_portal_task_type: null,
              active_proposal_status: null,
              autopilot_mode: 'SUPERVISED',
              substatus: 'Reset to inbound #685; reprocessing',
            },
          ],
        };
      }

      if (sql.includes('SELECT DISTINCT ON (ca.case_id)')) {
        assert.doesNotMatch(sql, /COALESCE\(ca\.is_active, true\)\s*=\s*true/);
        return {
          rows: [
            {
              case_id: 25206,
              agency_id: 896,
              agency_name: 'Iowa Division of Criminal Investigation (DCI)',
              agency_email: 'recordsrequest@dps.state.ia.us',
              portal_url: 'https://dps.iowa.gov/contact-dps/pio',
              portal_provider: null,
              added_source: 'research',
              canonical_agency_name: 'Iowa Division of Criminal Investigation (DCI)',
              canonical_state: 'IA',
              canonical_email_main: 'recordsrequest@dps.state.ia.us',
              canonical_email_foia: null,
              canonical_portal_url: 'https://dps.iowa.gov/contact-dps/pio',
              canonical_portal_url_alt: null,
              canonical_portal_provider: null,
            },
          ],
        };
      }

      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
        return { rows: [] };
      }

      if (sql.includes("WHERE c.status IN ('completed', 'cancelled')")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query in inactive-primary test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.requests[0].agency_name, 'Iowa Division of Criminal Investigation (DCI)');
      assert.strictEqual(response.body.requests[0].state, 'IA');
    } finally {
      requestHelpers.db.query = originalQuery;
    }
  });

  it('GET /api/requests ignores wrong_agency_referral rows for display identity', async function () {
    const originalQuery = requestHelpers.db.query;

    requestHelpers.db.query = async (sql) => {
      if (sql.includes('FROM cases c') && sql.includes('LEFT JOIN LATERAL')) {
        return {
          rows: [
            {
              id: 25206,
              subject_name: 'Iowa case',
              requested_records: ['Body camera footage'],
              case_name: 'Iowa case',
              agency_id: 896,
              agency_name: 'Iowa Division of Criminal Investigation (DCI)',
              agency_email: null,
              state: 'IA',
              portal_url: null,
              portal_provider: null,
              contact_research_notes: null,
              status: 'responded',
              requires_human: false,
              updated_at: '2026-03-06T00:00:00.000Z',
              created_at: '2026-03-05T00:00:00.000Z',
              next_due_at: null,
              last_response_date: null,
              active_run_status: null,
              active_run_trigger_type: null,
              active_run_started_at: null,
              active_run_trigger_run_id: null,
              active_portal_task_status: null,
              active_portal_task_type: null,
              active_proposal_status: null,
              autopilot_mode: 'SUPERVISED',
              substatus: 'Reset to inbound #685; reprocessing',
            },
          ],
        };
      }

      if (sql.includes('SELECT DISTINCT ON (ca.case_id)')) {
        return {
          rows: [
            {
              case_id: 25206,
              agency_id: 1736,
              agency_name: 'Alaska State Troopers',
              agency_email: 'recordsrequest@dps.state.ia.us',
              portal_url: 'https://dps.iowa.gov/contact-dps/pio',
              portal_provider: null,
              added_source: 'wrong_agency_referral',
              canonical_agency_name: 'Alaska State Troopers',
              canonical_state: 'AK',
              canonical_email_main: 'dps.publicinforequest@alaska.gov',
              canonical_email_foia: null,
              canonical_portal_url: 'https://dpsalaska.justfoia.com/publicportal/home/newrequest.',
              canonical_portal_url_alt: null,
              canonical_portal_provider: null,
            },
          ],
        };
      }

      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
        return { rows: [] };
      }

      if (sql.includes("WHERE c.status IN ('completed', 'cancelled')")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query in wrong agency referral display test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.requests[0].agency_name, 'Iowa Division of Criminal Investigation (DCI)');
      assert.strictEqual(response.body.requests[0].state, 'IA');
    } finally {
      requestHelpers.db.query = originalQuery;
    }
  });

  it('GET /api/requests ignores {} canonical state placeholders and keeps the real case state', async function () {
    const originalQuery = requestHelpers.db.query;

    requestHelpers.db.query = async (sql) => {
      if (sql.includes('FROM cases c') && sql.includes('LEFT JOIN LATERAL')) {
        return {
          rows: [
            {
              id: 25249,
              subject_name: null,
              requested_records: [],
              case_name: 'Montana case',
              agency_id: null,
              agency_name: 'Stow Police Department',
              agency_email: 'pending-research@placeholder.invalid',
              state: 'MT',
              portal_url: null,
              portal_provider: null,
              contact_research_notes: null,
              status: 'needs_human_review',
              requires_human: true,
              updated_at: '2026-03-06T00:00:00.000Z',
              created_at: '2026-03-05T00:00:00.000Z',
              next_due_at: null,
              last_response_date: null,
              active_run_status: null,
              active_run_trigger_type: null,
              active_run_started_at: null,
              active_run_trigger_run_id: null,
              active_portal_task_status: null,
              active_portal_task_type: null,
              active_proposal_status: 'PENDING_APPROVAL',
              autopilot_mode: 'SUPERVISED',
              substatus: 'agency_research_complete',
            },
          ],
        };
      }

      if (sql.includes('SELECT DISTINCT ON (ca.case_id)')) {
        return {
          rows: [
            {
              case_id: 25249,
              agency_id: 152,
              agency_name: 'Stow Police Department',
              agency_email: 'pending-research@placeholder.invalid',
              portal_url: null,
              portal_provider: null,
              added_source: 'case_row_backfill',
              canonical_agency_name: 'Stow Police Department',
              canonical_state: '{}',
              canonical_email_main: 'stowpd@stow.oh.us',
              canonical_email_foia: null,
              canonical_portal_url: null,
              canonical_portal_url_alt: null,
              canonical_portal_provider: null,
            },
          ],
        };
      }

      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
        return { rows: [] };
      }

      if (sql.includes("WHERE c.status IN ('completed', 'cancelled')")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query in canonical state placeholder test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.requests[0].state, 'MT');
    } finally {
      requestHelpers.db.query = originalQuery;
    }
  });

  it('GET /api/requests masks unresolved synthetic placeholder agencies as unknown', async function () {
    const originalQuery = requestHelpers.db.query;

    requestHelpers.db.query = async (sql) => {
      if (sql.includes('FROM cases c') && sql.includes('LEFT JOIN LATERAL')) {
        return {
          rows: [
            {
              id: 25249,
              subject_name: null,
              requested_records: [],
              case_name: 'Montana case',
              agency_id: null,
              agency_name: 'Stow Police Department',
              agency_email: 'pending-research@placeholder.invalid',
              state: 'MT',
              portal_url: null,
              portal_provider: null,
              contact_research_notes: JSON.stringify({
                brief: {
                  researchFailed: true,
                  suggested_agencies: [],
                  summary: 'Research failed: Request was aborted.. Manual agency lookup needed.',
                  next_steps: 'Manually research correct agency for this jurisdiction',
                },
                execution: {
                  research_failed: true,
                  suggested_agency: 'Unknown — needs research',
                  research_failure_reason: 'Research failed: Request was aborted.. Manual agency lookup needed.',
                },
              }),
              status: 'needs_human_review',
              requires_human: true,
              updated_at: '2026-03-06T00:00:00.000Z',
              created_at: '2026-03-05T00:00:00.000Z',
              next_due_at: null,
              last_response_date: null,
              active_run_status: null,
              active_run_trigger_type: null,
              active_run_started_at: null,
              active_run_trigger_run_id: null,
              active_portal_task_status: null,
              active_portal_task_type: null,
              active_proposal_status: 'PENDING_APPROVAL',
              autopilot_mode: 'SUPERVISED',
              substatus: 'agency_research_complete',
            },
          ],
        };
      }

      if (sql.includes('SELECT DISTINCT ON (ca.case_id)')) {
        return {
          rows: [
            {
              case_id: 25249,
              agency_id: 152,
              agency_name: 'Stow Police Department',
              agency_email: 'pending-research@placeholder.invalid',
              portal_url: null,
              portal_provider: null,
              added_source: 'case_row_backfill',
              canonical_agency_name: 'Stow Police Department',
              canonical_state: '{}',
              canonical_email_main: null,
              canonical_email_foia: null,
              canonical_portal_url: null,
              canonical_portal_url_alt: null,
              canonical_portal_provider: null,
            },
          ],
        };
      }

      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
        return { rows: [] };
      }

      if (sql.includes("WHERE c.status IN ('completed', 'cancelled')")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query in unresolved placeholder masking test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.requests[0].agency_name, 'Unknown agency');
      assert.strictEqual(response.body.requests[0].state, 'MT');
    } finally {
      requestHelpers.db.query = originalQuery;
    }
  });

  it('GET /api/requests keeps the corrected agency and drops stale wrong-jurisdiction channels', async function () {
    const originalQuery = requestHelpers.db.query;

    requestHelpers.db.query = async (sql) => {
      if (sql.includes('FROM cases c') && sql.includes('LEFT JOIN LATERAL')) {
        return {
          rows: [
            {
              id: 25210,
              subject_name: 'Norcross case',
              requested_records: ['Body camera footage'],
              case_name: 'Norcross case',
              agency_id: null,
              agency_name: 'Gwinnett County Police Department (GA) – Records Unit / Open Records',
              agency_email: 'ORR@mylubbock.us',
              state: 'GA',
              portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
              portal_provider: 'govqa',
              additional_details: '**Police Department:** Gwinnett County Police Department, Georgia',
              contact_research_notes: JSON.stringify({
                brief: {
                  suggested_agencies: [
                    {
                      name: 'Gwinnett County Police Department (GA) – Records Unit / Open Records',
                      confidence: 0.8,
                    },
                  ],
                },
              }),
              status: 'needs_human_review',
              requires_human: true,
              updated_at: '2026-03-06T00:00:00.000Z',
              created_at: '2026-03-05T00:00:00.000Z',
              next_due_at: null,
              last_response_date: null,
              active_run_status: null,
              active_run_trigger_type: null,
              active_run_started_at: null,
              active_run_trigger_run_id: null,
              active_portal_task_status: null,
              active_portal_task_type: null,
              active_proposal_status: 'PENDING_APPROVAL',
              autopilot_mode: 'SUPERVISED',
              substatus: 'Resolving: custom',
            },
          ],
        };
      }

      if (sql.includes('SELECT DISTINCT ON (ca.case_id)')) {
        return {
          rows: [
            {
              case_id: 25210,
              agency_id: 1365,
              agency_name: 'Lubbock Police Department, Texas',
              agency_email: 'ORR@mylubbock.us',
              portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
              portal_provider: 'govqa',
              added_source: 'case_row_backfill',
              canonical_agency_name: 'Lubbock Police Department, Texas',
              canonical_state: 'TX',
              canonical_email_main: null,
              canonical_email_foia: 'ORR@mylubbock.us',
              canonical_portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
              canonical_portal_url_alt: null,
              canonical_portal_provider: 'govqa',
            },
          ],
        };
      }

      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
        if (sql.includes('Gwinnett County Police Department')) {
          return { rows: [] };
        }
        if (sql.includes('Lubbock Police Department') || sql.includes('ORR@mylubbock.us')) {
          return {
            rows: [
              {
                id: 1365,
                name: 'Lubbock Police Department, Texas',
                state: 'TX',
                email_main: null,
                email_foia: 'ORR@mylubbock.us',
                portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
                portal_url_alt: null,
                portal_provider: 'govqa',
                score: 12,
                completeness: 3,
              },
            ],
          };
        }
        return { rows: [] };
      }

      if (sql.includes("WHERE c.status IN ('completed', 'cancelled')")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query in wrong-jurisdiction display test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.requests[0].agency_name, 'Gwinnett County Police Department (GA) – Records Unit / Open Records');
      assert.strictEqual(response.body.requests[0].state, 'GA');
      assert.strictEqual(response.body.requests[0].agency_email ?? null, null);
      assert.strictEqual(response.body.requests[0].portal_url ?? null, null);
    } finally {
      requestHelpers.db.query = originalQuery;
    }
  });

  it('GET /api/requests/:id/workspace suppresses synthetic placeholder backfill agencies when research did not confirm one', async function () {
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
      id: 25243,
      subject_name: 'Georgia case',
      case_name: 'Georgia case',
      agency_id: null,
      agency_name: 'Stow Police Department',
      agency_email: 'pending-research@placeholder.invalid',
      portal_url: null,
      portal_provider: null,
      state: 'GA',
      status: 'awaiting_response',
      requires_human: false,
      pause_reason: null,
      substatus: 'Resolving: custom',
      contact_research_notes: JSON.stringify({
        cleared: true,
        retryReason: 'user_retry',
      }),
      additional_details: 'Title: Father of Georgia school shooter found guilty',
      requested_records: [],
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-05T00:00:00.000Z',
      updated_at: '2026-03-06T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
    });
    db.getCaseAgencies = async () => ([
      {
        id: 65,
        case_id: 25243,
        agency_id: 152,
        agency_name: 'Stow Police Department',
        agency_email: 'pending-research@placeholder.invalid',
        portal_url: null,
        portal_provider: null,
        is_primary: true,
        is_active: true,
        added_source: 'case_row_backfill',
        status: 'active',
        created_at: '2026-03-05T00:00:00.000Z',
        updated_at: '2026-03-06T00:00:00.000Z',
      },
    ]);
    db.getThreadsByCaseId = async () => [];
    db.getMessagesByThreadId = async () => [];
    db.getAttachmentsByCaseId = async () => [];
    db.getUserById = async () => null;
    db.query = async (sql) => {
      if (sql.includes('FROM portal_tasks')) return { rows: [] };
      if (sql.includes('FROM activity_log')) return { rows: [] };
      if (sql.includes('FROM auto_reply_queue')) return { rows: [] };
      if (sql.includes('FROM proposals')) return { rows: [] };
      if (sql.includes('FROM agent_decisions')) return { rows: [] };
      if (sql.includes('FROM agent_runs')) return { rows: [] };
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) return { rows: [] };
      throw new Error(`Unexpected workspace query in placeholder suppression test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/25243/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.request.agency_name, 'Unknown agency');
      assert.strictEqual(response.body.request.agency_email, null);
      assert.strictEqual(response.body.request.portal_url, null);
      assert.strictEqual(response.body.agency_summary.name, 'Unknown agency');
      assert.strictEqual(response.body.agency_summary.submission_method, 'UNKNOWN');
      assert.strictEqual(response.body.case_agencies[0].agency_name, 'Unknown agency');
      assert.strictEqual(response.body.case_agencies[0].agency_email, null);
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

  it('GET /api/cases/:id/agencies rewrites synthetic placeholder agency rows to the research suggested agency', async function () {
    const originalGetCaseById = db.getCaseById;
    const originalGetCaseAgencies = db.getCaseAgencies;
    const originalQuery = db.query;

    db.getCaseById = async () => ({
      id: 25252,
      agency_name: 'Stow Police Department',
      agency_email: 'pending-research@placeholder.invalid',
      portal_url: null,
      state: 'FL',
      contact_research_notes: JSON.stringify({
        brief: { researchFailed: true, suggested_agencies: [], summary: 'Research failed' },
        execution: { suggested_agency: "Marion County Sheriff's Office", research_failure_reason: 'Research failed' },
      }),
    });
    db.getCaseAgencies = async () => ([{
      id: 63,
      case_id: 25252,
      agency_id: 152,
      agency_name: 'Stow Police Department',
      agency_email: 'pending-research@placeholder.invalid',
      portal_url: null,
      portal_provider: null,
      added_source: 'case_row_backfill',
      is_primary: true,
      is_active: true,
    }]);
    db.query = async (sql, params) => {
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
        if (params && params.includes("Marion County Sheriff's Office")) {
          return {
            rows: [
              {
                id: 3001,
                name: "Marion County Sheriff's Office",
                state: 'FL',
                email_main: null,
                email_foia: null,
                portal_url: null,
                portal_url_alt: null,
                portal_provider: null,
                score: 9,
                completeness: 1,
              },
            ],
          };
        }
        return { rows: [] };
      }
      throw new Error(`Unexpected query in case agencies alignment test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/cases', caseAgenciesRouter);
      const response = await supertest(app).get('/api/cases/25252/agencies');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.agencies[0].agency_name, "Marion County Sheriff's Office");
      assert.strictEqual(response.body.agencies[0].agency_email, null);
    } finally {
      db.getCaseById = originalGetCaseById;
      db.getCaseAgencies = originalGetCaseAgencies;
      db.query = originalQuery;
    }
  });

  it('GET /api/cases/:id/agencies masks unresolved synthetic placeholder agencies as unknown', async function () {
    const originalGetCaseById = db.getCaseById;
    const originalGetCaseAgencies = db.getCaseAgencies;
    const originalQuery = db.query;

    db.getCaseById = async () => ({
      id: 25249,
      agency_name: 'Stow Police Department',
      agency_email: 'pending-research@placeholder.invalid',
      portal_url: null,
      state: 'MT',
      contact_research_notes: JSON.stringify({
        brief: {
          researchFailed: true,
          suggested_agencies: [],
          summary: 'Research failed: Request was aborted.. Manual agency lookup needed.',
          next_steps: 'Manually research correct agency for this jurisdiction',
        },
        execution: {
          research_failed: true,
          suggested_agency: 'Unknown — needs research',
          research_failure_reason: 'Research failed: Request was aborted.. Manual agency lookup needed.',
        },
      }),
    });
    db.getCaseAgencies = async () => ([{
      id: 62,
      case_id: 25249,
      agency_id: 152,
      agency_name: 'Stow Police Department',
      agency_email: 'pending-research@placeholder.invalid',
      portal_url: null,
      portal_provider: null,
      added_source: 'case_row_backfill',
      is_primary: true,
      is_active: true,
    }]);
    db.query = async (sql) => {
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query in unresolved case agencies masking test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/cases', caseAgenciesRouter);
      const response = await supertest(app).get('/api/cases/25249/agencies');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.agencies[0].agency_id, null);
      assert.strictEqual(response.body.agencies[0].agency_name, 'Unknown agency');
      assert.strictEqual(response.body.agencies[0].agency_email, null);
    } finally {
      db.getCaseById = originalGetCaseById;
      db.getCaseAgencies = originalGetCaseAgencies;
      db.query = originalQuery;
    }
  });

  it('GET /api/cases/:id/agencies does not keep a stale synthetic agency_id when only research display is available', async function () {
    const originalGetCaseById = db.getCaseById;
    const originalGetCaseAgencies = db.getCaseAgencies;
    const originalQuery = db.query;

    db.getCaseById = async () => ({
      id: 25243,
      agency_name: 'Stow Police Department',
      agency_email: 'pending-research@placeholder.invalid',
      portal_url: null,
      state: 'GA',
      contact_research_notes: JSON.stringify({
        brief: { researchFailed: true, suggested_agencies: [], summary: 'Research failed' },
        execution: { suggested_agency: "Barrow County Sheriff's Office", research_failure_reason: 'Research failed' },
      }),
    });
    db.getCaseAgencies = async () => ([{
      id: 65,
      case_id: 25243,
      agency_id: 152,
      agency_name: 'Stow Police Department',
      agency_email: 'pending-research@placeholder.invalid',
      portal_url: null,
      portal_provider: null,
      added_source: 'case_row_backfill',
      is_primary: true,
      is_active: true,
    }]);
    db.query = async (sql) => {
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query in research display agency id test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/cases', caseAgenciesRouter);
      const response = await supertest(app).get('/api/cases/25243/agencies');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.agencies[0].agency_name, "Barrow County Sheriff's Office");
      assert.strictEqual(response.body.agencies[0].agency_id, null);
    } finally {
      db.getCaseById = originalGetCaseById;
      db.getCaseAgencies = originalGetCaseAgencies;
      db.query = originalQuery;
    }
  });
});
