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

  it('toRequestListItem blocks placeholder import cases with no real delivery path', function () {
    const item = requestHelpers.toRequestListItem({
      id: 26672,
      subject_name: "Ohio sex worker guilty of killing 4 men is sentenced to 4 life terms in 'serial murder'",
      requested_records: ['Interview/interrogation recordings'],
      agency_name: '—',
      agency_email: 'pending-research@intake.autobot',
      portal_url: null,
      import_warnings: [
        { type: 'MISSING_DELIVERY_PATH' },
        { type: 'MISSING_EMAIL' },
      ],
      state: null,
      status: 'awaiting_response',
      substatus: null,
      updated_at: '2026-03-10T00:00:00.000Z',
      created_at: '2026-03-09T00:00:00.000Z',
      requires_human: false,
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

    assert.strictEqual(item.status, 'NEEDS_HUMAN_REVIEW');
    assert.strictEqual(item.review_state, 'IDLE');
    assert.strictEqual(item.control_state, 'BLOCKED');
    assert.strictEqual(item.requires_human, true);
  });

  it('toRequestListItem recovers zero-correspondence waiting cases with a real delivery path to ready-to-send', function () {
    const item = requestHelpers.toRequestListItem({
      id: 26703,
      subject_name: 'Evansville case',
      requested_records: ['Body camera'],
      agency_name: 'Evansville Police Department, Indiana',
      agency_email: 'publicaccess@evansvillepolice.com',
      portal_url: 'https://evansvillepolice.com/public-information-request-forms/',
      import_warnings: null,
      state: 'IN',
      status: 'awaiting_response',
      substatus: null,
      updated_at: '2026-03-10T00:00:00.000Z',
      created_at: '2026-03-09T00:00:00.000Z',
      requires_human: false,
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
      message_count: 0,
      outbound_count: 0,
      thread_count: 0,
      portal_submission_count: 0,
      send_date: null,
    });

    assert.strictEqual(item.status, 'READY_TO_SEND');
    assert.strictEqual(item.review_state, 'IDLE');
    assert.strictEqual(item.control_state, 'BLOCKED');
    assert.strictEqual(item.substatus, 'No correspondence exists yet. Ready to draft the initial request.');
  });

  it('toRequestListItem renders first-send pending approvals as ready-to-send while keeping the decision gate', function () {
    const item = requestHelpers.toRequestListItem({
      id: 26665,
      subject_name: 'Samuel Honey case',
      requested_records: ['Dispatch audio'],
      agency_name: 'Lee County Sheriff’s Office, Georgia',
      agency_email: 'openrecords@lee.ga.us',
      portal_url: null,
      import_warnings: null,
      state: 'GA',
      status: 'needs_human_review',
      substatus: 'Proposal #1970 pending review',
      updated_at: '2026-03-10T00:00:00.000Z',
      created_at: '2026-03-09T00:00:00.000Z',
      requires_human: true,
      active_run_status: null,
      active_proposal_status: 'PENDING_APPROVAL',
      active_portal_task_status: null,
      active_portal_task_type: null,
      pause_reason: 'INITIAL_REQUEST',
      autopilot_mode: 'SUPERVISED',
      due_info_jsonb: null,
      fee_quote_jsonb: null,
      last_fee_quote_amount: null,
      last_response_date: null,
      next_due_at: null,
      message_count: 0,
      outbound_count: 0,
      thread_count: 0,
      portal_submission_count: 0,
      send_date: null,
    });

    assert.strictEqual(item.status, 'READY_TO_SEND');
    assert.strictEqual(item.review_state, 'DECISION_REQUIRED');
    assert.strictEqual(item.control_state, 'NEEDS_DECISION');
    assert.strictEqual(item.requires_human, true);
  });

  it('toRequestListItem ignores stale waiting runs when no proposal or correspondence exists', function () {
    const item = requestHelpers.toRequestListItem({
      id: 26703,
      subject_name: 'Evansville case',
      requested_records: ['Body camera'],
      agency_name: 'Evansville Police Department, Indiana',
      agency_email: 'publicaccess@evansvillepolice.com',
      portal_url: 'https://evansvillepolice.com/public-information-request-forms/',
      import_warnings: null,
      state: 'IN',
      status: 'needs_human_review',
      substatus: 'Proposal #2047 pending review',
      updated_at: '2026-03-10T00:00:00.000Z',
      created_at: '2026-03-09T00:00:00.000Z',
      requires_human: true,
      active_run_status: 'waiting',
      active_proposal_status: null,
      active_portal_task_status: null,
      active_portal_task_type: null,
      pause_reason: 'PENDING_APPROVAL',
      autopilot_mode: 'SUPERVISED',
      due_info_jsonb: null,
      fee_quote_jsonb: null,
      last_fee_quote_amount: null,
      last_response_date: null,
      next_due_at: null,
      message_count: 0,
      outbound_count: 0,
      thread_count: 0,
      portal_submission_count: 0,
      send_date: null,
    });

    assert.strictEqual(item.status, 'READY_TO_SEND');
    assert.strictEqual(item.review_state, 'IDLE');
    assert.strictEqual(item.control_state, 'BLOCKED');
    assert.strictEqual(item.substatus, 'No correspondence exists yet. Ready to draft the initial request.');
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

  it('GET /api/requests excludes E2E and test mailbox cases from the base query', async function () {
    const originalQuery = requestHelpers.db.query;

    requestHelpers.db.query = async (sql) => {
      if (sql.includes('FROM cases c') && sql.includes('LEFT JOIN LATERAL')) {
        assert.match(sql, /test@agency\.gov/i);
        assert.match(sql, /%e2e%/i);
        return { rows: [] };
      }

      if (sql.includes("WHERE c.status IN ('completed', 'cancelled')")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query in synthetic queue filter test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests');
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.body.requests, []);
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

  it('GET /api/requests keeps a trusted current agency when research notes only suggest alternate custodians', async function () {
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
              agency_email: 'recordsrequest@dps.state.ia.us',
              state: 'IA',
              portal_url: 'https://dps.iowa.gov/contact-dps/pio',
              portal_provider: 'none',
              additional_details: '**Police Department:** Buena Vista County Sheriff’s Office, Iowa',
              contact_research_notes: JSON.stringify({
                brief: {
                  suggested_agencies: [
                    { name: 'Milford Police Department (Milford, IA)', confidence: 0.78 },
                  ],
                },
              }),
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
              substatus: 'Awaiting agency response',
            },
          ],
        };
      }

      if (sql.includes('SELECT DISTINCT ON (ca.case_id)')) {
        return {
          rows: [
            {
              case_id: 25206,
              agency_id: 896,
              agency_name: 'Iowa Division of Criminal Investigation (DCI)',
              agency_email: 'recordsrequest@dps.state.ia.us',
              portal_url: 'https://dps.iowa.gov/contact-dps/pio',
              portal_provider: 'none',
              added_source: 'wrong_agency_referral',
              canonical_agency_name: 'Iowa Division of Criminal Investigation (DCI)',
              canonical_state: 'IA',
              canonical_email_main: 'recordsrequest@dps.state.ia.us',
              canonical_email_foia: null,
              canonical_portal_url: 'https://dps.iowa.gov/contact-dps/pio',
              canonical_portal_url_alt: null,
              canonical_portal_provider: 'none',
            },
          ],
        };
      }

      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
        if (sql.includes('Milford Police Department')) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: 896,
              name: 'Iowa Division of Criminal Investigation (DCI)',
              state: 'IA',
              email_main: 'recordsrequest@dps.state.ia.us',
              email_foia: null,
              portal_url: 'https://dps.iowa.gov/contact-dps/pio',
              portal_url_alt: null,
              portal_provider: 'none',
              score: 12,
              completeness: 3,
            },
          ],
        };
      }

      if (sql.includes("WHERE c.status IN ('completed', 'cancelled')")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query in trusted current agency display test: ${sql}`);
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

  it('GET /api/requests upgrades a generic police department label from metadata and drops stale channels', async function () {
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
              agency_name: 'Police Department',
              agency_email: 'ORR@mylubbock.us',
              state: 'GA',
              portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
              portal_provider: 'govqa',
              additional_details: '**Police Department:** Gwinnett County Police Department, Georgia',
              contact_research_notes: JSON.stringify({
                cleared: true,
                retryReason: 'user_retry',
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
        return { rows: [] };
      }

      if (sql.includes("WHERE c.status IN ('completed', 'cancelled')")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query in generic agency metadata test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.requests[0].agency_name, 'Gwinnett County Police Department, Georgia');
      assert.strictEqual(response.body.requests[0].state, 'GA');
      assert.strictEqual(response.body.requests[0].agency_email ?? null, null);
      assert.strictEqual(response.body.requests[0].portal_url ?? null, null);
    } finally {
      requestHelpers.db.query = originalQuery;
    }
  });

  it('GET /api/requests uses metadata-derived agency identity when stale case-row channels contaminate the case', async function () {
    const originalQuery = requestHelpers.db.query;

    requestHelpers.db.query = async (sql) => {
      if (sql.includes('FROM cases c') && sql.includes('LEFT JOIN LATERAL')) {
        return {
          rows: [
            {
              id: 25207,
              subject_name: 'Ryan Campbell',
              requested_records: ['Body camera footage', '911 audio'],
              case_name: 'Ryan Campbell case',
              agency_id: null,
              agency_name: 'Stow Police Department',
              agency_email: 'ORR@mylubbock.us',
              state: null,
              portal_url: 'https://u8387778.ct.sendgrid.net/ls/click?upn=tracked',
              portal_provider: 'govqa',
              additional_details: [
                '**Case Summary:** Pontotoc County murder case',
                '**Police Department:** Pontotoc County Sheriff’s Office, Oklahoma',
              ].join('\n'),
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
              active_proposal_status: null,
              autopilot_mode: 'SUPERVISED',
              substatus: 'Ready to send',
            },
          ],
        };
      }

      if (sql.includes('SELECT DISTINCT ON (ca.case_id)')) {
        return {
          rows: [
            {
              case_id: 25207,
              agency_id: null,
              agency_name: 'Stow Police Department',
              agency_email: 'ORR@mylubbock.us',
              portal_url: 'https://u8387778.ct.sendgrid.net/ls/click?upn=tracked',
              portal_provider: 'govqa',
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
        return { rows: [] };
      }

      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) {
        return { rows: [] };
      }

      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) {
        return { rows: [] };
      }

      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) {
        return { rows: [] };
      }

      if (sql.includes("WHERE c.status IN ('completed', 'cancelled')")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected query in metadata correction list test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.requests[0].agency_name, "Pontotoc County Sheriff’s Office, Oklahoma");
      assert.strictEqual(response.body.requests[0].state, 'OK');
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
      import_warnings: [
        { type: 'email_validation', message: 'No MX records for domain \"placeholder.invalid\"' },
        { type: 'agency_lookup', message: 'Agency \"Stow Police Department\" not found in directory' },
      ],
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
      assert.strictEqual(response.body.request.import_warnings, null);
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

  it('GET /api/requests/:id/workspace prefers metadata-derived agency identity over contaminated synthetic backfill channels', async function () {
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
      id: 25207,
      subject_name: 'Ryan Campbell',
      case_name: 'Ryan Campbell case',
      agency_id: null,
      agency_name: 'Stow Police Department',
      agency_email: 'ORR@mylubbock.us',
      portal_url: 'https://u8387778.ct.sendgrid.net/ls/click?upn=tracked',
      portal_provider: 'govqa',
      state: null,
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: null,
      substatus: 'Ready to send',
      contact_research_notes: null,
      additional_details: [
        '**Case Summary:** Pontotoc County murder case',
        '**Police Department:** Pontotoc County Sheriff’s Office, Oklahoma',
      ].join('\n'),
      requested_records: [],
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-05T00:00:00.000Z',
      updated_at: '2026-03-06T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
    });
    db.getCaseAgencies = async () => ([
      {
        id: 61,
        case_id: 25207,
        agency_id: null,
        agency_name: 'Stow Police Department',
        agency_email: 'ORR@mylubbock.us',
        portal_url: 'https://u8387778.ct.sendgrid.net/ls/click?upn=tracked',
        portal_provider: 'govqa',
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
      throw new Error(`Unexpected workspace query in metadata correction test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/25207/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.request.agency_name, "Pontotoc County Sheriff’s Office, Oklahoma");
      assert.strictEqual(response.body.request.agency_email, null);
      assert.strictEqual(response.body.request.portal_url, null);
      assert.strictEqual(response.body.request.state, 'OK');
      assert.strictEqual(response.body.agency_summary.name, "Pontotoc County Sheriff’s Office, Oklahoma");
      assert.strictEqual(response.body.agency_summary.submission_method, 'UNKNOWN');
      assert.strictEqual(response.body.case_agencies[0].agency_name, "Pontotoc County Sheriff’s Office, Oklahoma");
      assert.strictEqual(response.body.case_agencies[0].agency_email, null);
      assert.strictEqual(response.body.case_agencies[0].portal_url, null);
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

  it('GET /api/requests/:id/workspace keeps a trusted current agency instead of replacing it with suggested alternates', async function () {
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
      id: 25206,
      subject_name: 'Christian Goyne-Yarns',
      case_name: 'Iowa case',
      agency_id: 896,
      agency_name: 'Iowa Division of Criminal Investigation (DCI)',
      agency_email: 'recordsrequest@dps.state.ia.us',
      portal_url: 'https://dps.iowa.gov/contact-dps/pio',
      portal_provider: 'none',
      state: 'IA',
      status: 'awaiting_response',
      requires_human: false,
      pause_reason: null,
      substatus: 'Awaiting agency response',
      contact_research_notes: JSON.stringify({
        brief: {
          suggested_agencies: [
            { name: 'Milford Police Department (Milford, IA)', confidence: 0.78 },
          ],
        },
      }),
      additional_details: '**Police Department:** Buena Vista County Sheriff’s Office, Iowa',
      requested_records: [],
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-05T00:00:00.000Z',
      updated_at: '2026-03-06T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
    });
    db.getCaseAgencies = async () => ([
      {
        id: 34,
        case_id: 25206,
        agency_id: 896,
        agency_name: 'Iowa Division of Criminal Investigation (DCI)',
        agency_email: 'recordsrequest@dps.state.ia.us',
        portal_url: 'https://dps.iowa.gov/contact-dps/pio',
        portal_provider: 'none',
        is_primary: true,
        is_active: true,
        added_source: 'wrong_agency_referral',
        status: 'pending',
        created_at: '2026-03-05T00:00:00.000Z',
        updated_at: '2026-03-06T00:00:00.000Z',
      },
    ]);
    db.getThreadsByCaseId = async () => [];
    db.getMessagesByThreadId = async () => [];
    db.getAttachmentsByCaseId = async () => [];
    db.getUserById = async () => null;
    db.query = async (sql, params) => {
      if (sql.includes('FROM portal_tasks')) return { rows: [] };
      if (sql.includes('FROM activity_log')) return { rows: [] };
      if (sql.includes('FROM auto_reply_queue')) return { rows: [] };
      if (sql.includes('FROM proposals')) return { rows: [] };
      if (sql.includes('FROM agent_decisions')) return { rows: [] };
      if (sql.includes('FROM agent_runs')) return { rows: [] };
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
        if (params && params.includes('Milford Police Department (Milford, IA)')) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: 896,
              name: 'Iowa Division of Criminal Investigation (DCI)',
              state: 'IA',
              email_main: 'recordsrequest@dps.state.ia.us',
              email_foia: null,
              portal_url: 'https://dps.iowa.gov/contact-dps/pio',
              portal_url_alt: null,
              portal_provider: 'none',
              score: 12,
              completeness: 3,
            },
          ],
        };
      }
      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) {
        return { rows: [{ id: 896, name: 'Iowa Division of Criminal Investigation (DCI)' }] };
      }
      if (sql.includes('FROM agencies') && sql.includes('WHERE id = $1')) {
        return { rows: [{ id: 896, name: 'Iowa Division of Criminal Investigation (DCI)' }] };
      }
      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) {
        return { rows: [{ id: 896 }] };
      }
      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) {
        return { rows: [{ id: 896 }] };
      }
      throw new Error(`Unexpected workspace query in trusted current agency workspace test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/25206/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.request.agency_name, 'Iowa Division of Criminal Investigation (DCI)');
      assert.strictEqual(response.body.request.agency_email, 'recordsrequest@dps.state.ia.us');
      assert.strictEqual(response.body.request.portal_url, 'https://dps.iowa.gov/contact-dps/pio');
      assert.strictEqual(response.body.agency_summary.name, 'Iowa Division of Criminal Investigation (DCI)');
      assert.strictEqual(response.body.agency_summary.submission_method, 'PORTAL');
      assert.strictEqual(response.body.request.state, 'IA');
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

  it('GET /api/requests/:id/workspace preserves the resolved email destination for pending PDF email proposals', async function () {
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
      id: 25169,
      subject_name: 'Conner (Lee) Kobold',
      case_name: 'Conner (Lee) Kobold case',
      agency_id: null,
      agency_name: 'Porter County Central Communications (9-1-1) Center',
      agency_email: '911audio@portercountyin.gov',
      portal_url: null,
      portal_provider: null,
      state: 'IN',
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'CLARIFICATION_REQUEST',
      substatus: 'Scope clarification needed',
      contact_research_notes: JSON.stringify({
        contactResult: {
          contact_email: '911audio@portercountyin.gov',
        },
      }),
      additional_details: '**Police Department:** Porter County Central Communications (9-1-1) Center, Indiana',
      requested_records: [],
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-02-26T00:00:00.000Z',
      updated_at: '2026-03-06T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
    });
    db.getCaseAgencies = async () => ([
      {
        id: 24,
        case_id: 25169,
        agency_id: null,
        agency_name: 'Porter County Central Communications (9-1-1) Center',
        agency_email: '911audio@portercountyin.gov',
        portal_url: null,
        portal_provider: null,
        is_primary: true,
        is_active: true,
        added_source: 'research',
        status: 'pending',
        created_at: '2026-02-26T00:00:00.000Z',
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
      if (sql.includes('FROM proposals')) {
        return {
          rows: [
            {
              id: 954,
              action_type: 'SEND_PDF_EMAIL',
              status: 'PENDING_APPROVAL',
              draft_subject: 'Completed Public Records Request Form – Conner (Lee) Kobold',
              draft_body_text: 'Attached please find my completed public records request form.',
              reasoning: ['Prepared PDF email reply'],
              confidence: '0.86',
              gate_options: ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'],
            },
          ],
        };
      }
      if (sql.includes('FROM agent_decisions')) return { rows: [] };
      if (sql.includes('FROM agent_runs')) return { rows: [] };
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) return { rows: [] };
      throw new Error(`Unexpected workspace query in PDF recipient preservation test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/25169/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.request.agency_email, '911audio@portercountyin.gov');
      assert.strictEqual(response.body.agency_summary.submission_method, 'EMAIL');
      assert.strictEqual(response.body.pending_proposal.action_type, 'SEND_PDF_EMAIL');
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

  it('GET /api/requests/:id/workspace includes portal_helper for manual portal fallback escalations', async function () {
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
      id: 25152,
      subject_name: 'Roanoke portal case',
      case_name: 'Roanoke portal case',
      agency_id: 5001,
      agency_name: 'Roanoke City Police Department, Virginia',
      agency_email: null,
      portal_url: 'https://records.roanokeva.gov/portal',
      portal_provider: 'GovQA',
      state: 'VA',
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'PORTAL_ABORTED',
      substatus: 'Portal helper required',
      contact_research_notes: null,
      additional_details: '**Police Department:** Roanoke City Police Department, Virginia',
      requested_records: ['CAD logs', 'incident report'],
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-06T00:00:00.000Z',
      updated_at: '2026-03-07T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
      user_id: null,
    });
    db.getCaseAgencies = async () => ([
      {
        id: 71,
        case_id: 25152,
        agency_id: 5001,
        agency_name: 'Roanoke City Police Department, Virginia',
        agency_email: null,
        portal_url: 'https://records.roanokeva.gov/portal',
        portal_provider: 'GovQA',
        is_primary: true,
        is_active: true,
        added_source: 'research',
        status: 'active',
        created_at: '2026-03-06T00:00:00.000Z',
        updated_at: '2026-03-07T00:00:00.000Z',
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
      if (sql.includes('FROM proposals')) {
        return {
          rows: [
            {
              id: 981,
              action_type: 'ESCALATE',
              status: 'PENDING_APPROVAL',
              draft_subject: null,
              draft_body_text: 'Portal task #162 was auto-failed after being stuck in IN_PROGRESS for more than 30 minutes with no active run.\n\nUse the Manual Submit Helper to complete the portal submission manually or adjust the submission plan before retrying.',
              reasoning: ['Manual portal fallback recommended.'],
              confidence: '0.91',
              gate_options: ['ADJUST', 'DISMISS'],
            },
          ],
        };
      }
      if (sql.includes('FROM agent_decisions')) return { rows: [] };
      if (sql.includes('FROM agent_runs')) return { rows: [] };
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE id = $1')) {
        return { rows: [{ id: 5001, name: 'Roanoke City Police Department, Virginia' }] };
      }
      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) return { rows: [] };
      throw new Error(`Unexpected workspace query in manual portal helper test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/25152/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.pending_proposal.action_type, 'ESCALATE');
      assert.strictEqual(response.body.portal_helper.portal_url, 'https://records.roanokeva.gov/portal');
      assert.strictEqual(response.body.portal_helper.case_info.subject_name, 'Roanoke portal case');
      assert.deepStrictEqual(response.body.pending_proposal.gate_options, ['ADJUST', 'DISMISS']);
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

  it('GET /api/cases/:id/agencies masks cleared synthetic placeholder agencies as unknown when no real agency was confirmed', async function () {
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
        cleared: true,
        retryReason: 'user_retry',
      }),
      additional_details: 'Title: Father of Georgia school shooter found guilty',
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
      throw new Error(`Unexpected query in cleared placeholder masking test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/cases', caseAgenciesRouter);
      const response = await supertest(app).get('/api/cases/25243/agencies');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.agencies[0].agency_id, null);
      assert.strictEqual(response.body.agencies[0].agency_name, 'Unknown agency');
      assert.strictEqual(response.body.agencies[0].agency_email, null);
      assert.strictEqual(response.body.agencies[0].portal_url, null);
    } finally {
      db.getCaseById = originalGetCaseById;
      db.getCaseAgencies = originalGetCaseAgencies;
      db.query = originalQuery;
    }
  });

  it('GET /api/requests/:id/workspace suppresses pending proposals when latest inbound manual paste mismatches the case thread', async function () {
    const originalDbMethods = {
      getCaseById: db.getCaseById,
      getCaseAgencies: db.getCaseAgencies,
      getThreadsByCaseId: db.getThreadsByCaseId,
      getMessagesByThreadId: db.getMessagesByThreadId,
      getAttachmentsByCaseId: db.getAttachmentsByCaseId,
      getAnalysisByMessageId: db.getAnalysisByMessageId,
      getUserById: db.getUserById,
      query: db.query,
    };

    db.getCaseById = async () => ({
      id: 25148,
      subject_name: 'Anthony Douglas Shoffner Jr.',
      case_name: 'Anthony Douglas Shoffner Jr.',
      agency_id: null,
      agency_name: 'Perry Police Department, Georgia',
      agency_email: 'kayla.neesmith@perry-ga.gov',
      portal_url: null,
      portal_provider: null,
      state: 'GA',
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'PENDING_APPROVAL',
      substatus: 'Proposal pending review',
      contact_research_notes: null,
      additional_details: '**Police Department:** Perry Police Department, Georgia',
      requested_records: [],
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-05T00:00:00.000Z',
      updated_at: '2026-03-06T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
    });
    db.getCaseAgencies = async () => ([{
      id: 77,
      case_id: 25148,
      agency_id: null,
      agency_name: 'Perry Police Department, Georgia',
      agency_email: 'kayla.neesmith@perry-ga.gov',
      portal_url: null,
      portal_provider: null,
      is_primary: true,
      is_active: true,
      added_source: 'research',
      status: 'active',
      created_at: '2026-03-05T00:00:00.000Z',
      updated_at: '2026-03-06T00:00:00.000Z',
    }]);
    db.getThreadsByCaseId = async () => ([{
      id: 53,
      case_id: 25148,
      agency_email: 'kayla.neesmith@perry-ga.gov',
      created_at: '2026-03-05T00:00:00.000Z',
    }]);
    db.getMessagesByThreadId = async () => ([{
      id: 990,
      thread_id: 53,
      case_id: null,
      direction: 'inbound',
      from_email: 'records@atlanta.gov',
      subject: 'Denial',
      body_text: 'This is an Atlanta denial copied onto the wrong thread.',
      body_html: null,
      raw_body: 'This is an Atlanta denial copied onto the wrong thread.',
      metadata: { source: 'manual_paste', manual_paste: true },
      received_at: '2026-03-06T00:00:00.000Z',
      created_at: '2026-03-06T00:00:00.000Z',
    }]);
    db.getAttachmentsByCaseId = async () => [];
    db.getAnalysisByMessageId = async () => null;
    db.getUserById = async () => null;
    db.query = async (sql) => {
      if (sql.includes('FROM portal_tasks')) return { rows: [] };
      if (sql.includes('FROM activity_log')) return { rows: [] };
      if (sql.includes('FROM auto_reply_queue')) return { rows: [] };
      if (sql.includes('FROM proposals')) {
        return {
          rows: [{
            id: 1183,
            action_type: 'SEND_REBUTTAL',
            status: 'PENDING_APPROVAL',
            draft_subject: 'Re: Public records request',
            draft_body_text: 'I would like to narrow the request.',
            reasoning: ['Generated from denial'],
            confidence: '0.88',
            gate_options: ['APPROVE', 'ADJUST', 'DISMISS'],
          }],
        };
      }
      if (sql.includes('FROM agent_decisions')) return { rows: [] };
      if (sql.includes('FROM agent_runs')) return { rows: [] };
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE id = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) return { rows: [] };
      throw new Error(`Unexpected workspace query in manual paste mismatch workspace test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/25148/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.next_action_proposal, null);
      assert.strictEqual(response.body.pending_proposal, null);
      assert.strictEqual(response.body.review_state, 'IDLE');
      assert.strictEqual(response.body.control_state, 'BLOCKED');
      assert.match(response.body.request.substatus, /manual review required/i);
      assert.match(response.body.request.substatus, /records@atlanta\.gov/i);
    } finally {
      db.getCaseById = originalDbMethods.getCaseById;
      db.getCaseAgencies = originalDbMethods.getCaseAgencies;
      db.getThreadsByCaseId = originalDbMethods.getThreadsByCaseId;
      db.getMessagesByThreadId = originalDbMethods.getMessagesByThreadId;
      db.getAttachmentsByCaseId = originalDbMethods.getAttachmentsByCaseId;
      db.getAnalysisByMessageId = originalDbMethods.getAnalysisByMessageId;
      db.getUserById = originalDbMethods.getUserById;
      db.query = originalDbMethods.query;
    }
  });

  it('GET /api/requests blocks stale pending proposals when latest inbound manual paste mismatches the case thread', async function () {
    const originalDbMethods = {
      query: db.query,
      getThreadsByCaseId: db.getThreadsByCaseId,
      getMessagesByThreadId: db.getMessagesByThreadId,
    };

    db.query = async (sql) => {
      if (sql.includes('FROM cases c')) {
        return {
          rows: [{
            id: 25148,
            case_name: 'Anthony Douglas Shoffner Jr.',
            subject_name: 'Anthony Douglas Shoffner Jr.',
            agency_id: 1106,
            agency_name: 'Perry Police Department, Georgia',
            agency_email: null,
            portal_url: null,
            portal_provider: null,
            state: 'GA',
            status: 'needs_human_review',
            requires_human: true,
            pause_reason: 'SENSITIVE',
            substatus: 'agency_research_complete',
            contact_research_notes: null,
            additional_details: null,
            requested_records: [],
            autopilot_mode: 'SUPERVISED',
            updated_at: '2026-03-08T23:02:47.544Z',
            created_at: '2026-03-08T22:00:00.000Z',
            active_run_status: 'waiting',
            active_run_trigger_type: 'inbound_message',
            active_run_started_at: '2026-03-08T22:10:38.734Z',
            active_run_trigger_run_id: 'run_cmmib33dz6tpb0uoee20rqqfw',
            active_portal_task_status: null,
            active_portal_task_type: null,
            active_proposal_status: 'PENDING_APPROVAL',
          }],
        };
      }
      if (sql.includes('FROM case_agencies ca')) return { rows: [] };
      if (sql.includes("SELECT c.* FROM cases c")) return { rows: [] };
      throw new Error(`Unexpected list query in manual paste mismatch test: ${sql}`);
    };
    db.getThreadsByCaseId = async () => ([{
      id: 53,
      agency_email: 'jill.jennings@perry-ga.gov',
    }]);
    db.getMessagesByThreadId = async () => ([{
      id: 990,
      direction: 'INBOUND',
      from_email: 'records@atlanta.gov',
      source: 'manual_paste',
      created_at: '2026-03-08T22:10:32.096Z',
    }]);

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.requests.length, 1);
      assert.strictEqual(response.body.requests[0].review_state, 'IDLE');
      assert.strictEqual(response.body.requests[0].control_state, 'BLOCKED');
      assert.strictEqual(response.body.requests[0].pause_reason, 'MANUAL_PASTE_MISMATCH');
      assert.ok(response.body.requests[0].substatus.includes('records@atlanta.gov'));
    } finally {
      db.query = originalDbMethods.query;
      db.getThreadsByCaseId = originalDbMethods.getThreadsByCaseId;
      db.getMessagesByThreadId = originalDbMethods.getMessagesByThreadId;
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

  it('GET /api/requests/:id/workspace defaults missing gate options for initial requests and resolves Notion relation agency names', async function () {
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
      id: 25174,
      subject_name: 'Billy Ray Marsh',
      case_name: 'Billy Ray Marsh',
      agency_id: null,
      agency_name: '20987c20-070a-81c5-80cf-c6f59abb0107',
      agency_email: null,
      portal_url: null,
      portal_provider: null,
      state: 'TX',
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'PENDING_APPROVAL',
      substatus: 'Proposal pending review',
      contact_research_notes: null,
      additional_details: "Police Department: Harrison County Sheriff's Office, Texas",
      requested_records: ['Body camera footage'],
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-07T00:00:00.000Z',
      updated_at: '2026-03-07T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
      user_id: null,
    });
    db.getCaseAgencies = async () => ([
      {
        id: 99,
        case_id: 25174,
        agency_id: null,
        agency_name: '20987c20-070a-81c5-80cf-c6f59abb0107',
        agency_email: null,
        portal_url: null,
        portal_provider: null,
        is_primary: true,
        is_active: true,
        added_source: 'case_row_backfill',
        status: 'active',
        created_at: '2026-03-07T00:00:00.000Z',
        updated_at: '2026-03-07T00:00:00.000Z',
      },
    ]);
    db.getThreadsByCaseId = async () => [];
    db.getMessagesByThreadId = async () => [];
    db.getAttachmentsByCaseId = async () => [];
    db.getUserById = async () => null;
    db.query = async (sql, params) => {
      if (sql.includes('FROM portal_tasks')) return { rows: [] };
      if (sql.includes('FROM activity_log')) return { rows: [] };
      if (sql.includes('FROM auto_reply_queue')) return { rows: [] };
      if (sql.includes('FROM proposals')) {
        return {
          rows: [
            {
              id: 1021,
              action_type: 'SEND_INITIAL_REQUEST',
              status: 'PENDING_APPROVAL',
              draft_subject: 'Public Records Request - Billy Ray Marsh',
              draft_body_text: "Hello Harrison County Sheriff's Office Records Team,\n\nPlease provide body camera footage.",
              reasoning: ['Generated initial request'],
              confidence: '0.80',
              gate_options: null,
            },
          ],
        };
      }
      if (sql.includes("FROM agent_decisions")) return { rows: [] };
      if (sql.includes("FROM agent_runs")) return { rows: [{ id: 1456, status: 'waiting', trigger_type: 'initial_request', started_at: '2026-03-07T09:19:58.153Z', trigger_run_id: 'run_local' }] };
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes("LOWER(REPLACE(COALESCE(notion_page_id, ''), '-', ''))")) {
        assert.strictEqual(params[0], '20987c20070a81c580cfc6f59abb0107');
        return {
          rows: [
            {
              id: 7001,
              name: "Harrison County Sheriff's Office, Texas",
              state: 'TX',
              email_foia: 'brandonf@co.harrison.tx.us',
              email_main: null,
              portal_url: null,
              portal_url_alt: null,
              portal_provider: null,
            },
          ],
        };
      }
      if (sql.includes('FROM agencies') && sql.includes('WHERE id = $1')) {
        return { rows: [{ id: 7001, name: "Harrison County Sheriff's Office, Texas" }] };
      }
      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) return { rows: [] };
      throw new Error(`Unexpected workspace query in notion reference test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/25174/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.request.agency_name, "Harrison County Sheriff's Office, Texas");
      assert.strictEqual(response.body.agency_summary.name, "Harrison County Sheriff's Office, Texas");
      assert.strictEqual(response.body.pending_proposal.action_type, 'SEND_INITIAL_REQUEST');
      assert.deepStrictEqual(response.body.pending_proposal.gate_options, ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW']);
      assert.deepStrictEqual(response.body.next_action_proposal.gate_options, ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW']);
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

  it('GET /api/requests/:id/workspace skips comma-separated Notion relation ids and uses later metadata agency text', async function () {
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
      id: 25158,
      subject_name: 'Casey McDonald Dye',
      case_name: 'Casey McDonald Dye',
      agency_id: null,
      agency_name: '2f087c20-070a-80bb-be19-ff0770d2906d, 2b087c20-070a-80f8-a8b7-fe38ebc6ca39',
      agency_email: null,
      portal_url: null,
      portal_provider: null,
      state: 'KS',
      status: 'responded',
      requires_human: false,
      pause_reason: null,
      substatus: null,
      contact_research_notes: JSON.stringify({
        portal_url: 'https://www.allencounty.org/word_doc/OPENREC.DOC',
        contact_email: 'coclerk@allencounty.org',
      }),
      additional_details: [
        'Police Department: 2f087c20-070a-80bb-be19-ff0770d2906d, 2b087c20-070a-80f8-a8b7-fe38ebc6ca39',
        'Police Department: Allen County Sheriff’s Office, with assistance from Kansas Bureau of Investigation (KBI) and Neosho County authorities, Kansas',
      ].join('\\n'),
      requested_records: [],
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-05T00:00:00.000Z',
      updated_at: '2026-03-06T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
      import_warnings: null,
    });
    db.getCaseAgencies = async () => ([{
      id: 28,
      case_id: 25158,
      agency_id: null,
      agency_name: '2f087c20-070a-80bb-be19-ff0770d2906d, 2b087c20-070a-80f8-a8b7-fe38ebc6ca39',
      agency_email: null,
      portal_url: null,
      portal_provider: null,
      is_primary: true,
      is_active: true,
      added_source: 'case_row_backfill',
      status: 'active',
      created_at: '2026-03-05T00:00:00.000Z',
      updated_at: '2026-03-06T00:00:00.000Z',
    }]);
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
      throw new Error(`Unexpected workspace query in multi notion relation metadata test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/25158/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(
        response.body.request.agency_name,
        'Allen County Sheriff’s Office, with assistance from Kansas Bureau of Investigation (KBI) and Neosho County authorities, Kansas'
      );
      assert.strictEqual(
        response.body.agency_summary.name,
        'Allen County Sheriff’s Office, with assistance from Kansas Bureau of Investigation (KBI) and Neosho County authorities, Kansas'
      );
      assert.strictEqual(response.body.request.state, 'KS');
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

  it('GET /api/requests/:id/workspace suppresses imported initial proposals when agency metadata conflicts with the delivery channel', async function () {
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
      id: 26636,
      subject_name: 'Ryan Campbell',
      case_name: 'Denver request',
      agency_id: null,
      agency_name: 'Police Department',
      agency_email: 'ORR@mylubbock.us',
      portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
      portal_provider: 'govqa',
      state: 'CO',
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'PENDING_APPROVAL',
      substatus: 'Proposal pending review',
      contact_research_notes: null,
      additional_details: '**Police Department:** Denver Police Department, Colorado',
      requested_records: ['Body camera footage'],
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
      user_id: null,
      import_warnings: [{ type: 'AGENCY_METADATA_MISMATCH' }],
    });
    db.getCaseAgencies = async () => ([{
      id: 301,
      case_id: 26636,
      agency_id: 1365,
      agency_name: 'Lubbock Police Department, Texas',
      agency_email: 'ORR@mylubbock.us',
      portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
      portal_provider: 'govqa',
      is_primary: true,
      is_active: true,
      added_source: 'notion_import',
      status: 'active',
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z',
    }]);
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
      if (sql.includes('FROM proposals')) {
        return {
          rows: [{
            id: 1940,
            action_type: 'SEND_INITIAL_REQUEST',
            status: 'PENDING_APPROVAL',
            draft_subject: 'Public Records Request - Ryan Campbell',
            draft_body_text: 'Draft body',
            reasoning: ['Generated initial request'],
            confidence: '0.81',
            gate_options: ['APPROVE', 'ADJUST', 'DISMISS'],
          }],
        };
      }
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes("LOWER(REPLACE(COALESCE(notion_page_id, ''), '-', ''))")) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE id = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) return { rows: [] };
      throw new Error(`Unexpected workspace query in import safety suppression test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/26636/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.pending_proposal, null);
      assert.strictEqual(response.body.next_action_proposal, null);
      assert.strictEqual(response.body.request.control_state, 'BLOCKED');
      assert.match(response.body.request.substatus, /does not match case details/i);
      assert.strictEqual(response.body.request.agency_name, 'Denver Police Department');
      assert.strictEqual(response.body.request.agency_email, null);
      assert.strictEqual(response.body.request.portal_url, null);
      assert.strictEqual(response.body.request.state, 'CO');
      assert.strictEqual(response.body.agency_summary.name, 'Denver Police Department');
      assert.strictEqual(response.body.agency_summary.submission_method, 'UNKNOWN');
      assert.strictEqual(response.body.case_agencies[0].agency_name, 'Denver Police Department');
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

  it('GET /api/requests/:id/workspace suppresses imported initial proposals when routed agency state conflicts with the case state', async function () {
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
      id: 26637,
      subject_name: 'Jose Sandoval-Romero',
      case_name: 'Granddaughter of Manson Family Victim Brutally Stabbed in Denver',
      agency_id: 1365,
      agency_name: 'Lubbock Police Department, Texas',
      agency_email: 'ORR@mylubbock.us',
      portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
      portal_provider: 'govqa',
      state: 'CO',
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'PENDING_APPROVAL',
      substatus: 'Proposal pending review',
      contact_research_notes: null,
      additional_details: 'Title: Granddaughter of Manson Family Victim Brutally Stabbed in Denver',
      requested_records: ['Body camera footage'],
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
      user_id: null,
      import_warnings: [],
    });
    db.getCaseAgencies = async () => ([{
      id: 302,
      case_id: 26637,
      agency_id: 1365,
      agency_name: 'Lubbock Police Department, Texas',
      agency_email: 'ORR@mylubbock.us',
      portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
      portal_provider: 'govqa',
      is_primary: true,
      is_active: true,
      added_source: 'notion_import',
      status: 'active',
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z',
    }]);
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
      if (sql.includes('FROM proposals')) {
        return {
          rows: [{
            id: 1941,
            action_type: 'SEND_INITIAL_REQUEST',
            status: 'PENDING_APPROVAL',
            draft_subject: 'Public Records Request - Jose Sandoval-Romero',
            draft_body_text: 'Draft body',
            reasoning: ['Generated initial request'],
            confidence: '0.81',
            gate_options: ['APPROVE', 'ADJUST', 'DISMISS'],
          }],
        };
      }
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes("LOWER(REPLACE(COALESCE(notion_page_id, ''), '-', ''))")) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE id = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) return { rows: [] };
      throw new Error(`Unexpected workspace query in state mismatch suppression test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/26637/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.pending_proposal, null);
      assert.strictEqual(response.body.next_action_proposal, null);
      assert.strictEqual(response.body.request.control_state, 'BLOCKED');
      assert.match(response.body.request.substatus, /state/i);
      assert.match(response.body.request.substatus, /routed agency state/i);
      assert.strictEqual(response.body.request.agency_name, 'Unknown agency');
      assert.strictEqual(response.body.request.agency_email, null);
      assert.strictEqual(response.body.request.portal_url, null);
      assert.strictEqual(response.body.request.state, 'CO');
      assert.strictEqual(response.body.agency_summary.name, 'Unknown agency');
      assert.strictEqual(response.body.agency_summary.submission_method, 'UNKNOWN');
      assert.strictEqual(response.body.case_agencies[0].agency_name, 'Unknown agency');
      assert.strictEqual(response.body.case_agencies[0].portal_url, null);
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

  it('GET /api/requests/:id/workspace keeps imported proposals visible when city metadata differs but the narrative names the routed agency', async function () {
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
      id: 26671,
      notion_page_id: '21387c20-070a-81cf-9d2a-f7488bc4de9f',
      subject_name: 'Jasmine Pace',
      case_name: 'Jason Chen',
      agency_id: 1541,
      agency_name: 'Chattanooga Police Department, Tennessee',
      agency_email: null,
      portal_url: 'https://chattanoogatn.mycusthelp.com/public-records',
      portal_provider: 'govqa',
      state: 'TN',
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'INITIAL_REQUEST',
      substatus: 'Proposal #1975 pending review',
      contact_research_notes: null,
      additional_details: [
        'City : Nolensville',
        '',
        '### Police Departments Involved',
        '- **Chattanooga Police Department:** Handled the initial investigation and arrest.',
      ].join('\n'),
      requested_records: ['Body camera footage'],
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
      user_id: null,
      import_warnings: null,
    });
    db.getCaseAgencies = async () => ([{
      id: 233,
      case_id: 26671,
      agency_id: 1541,
      agency_name: 'Chattanooga Police Department, Tennessee',
      agency_email: null,
      portal_url: 'https://chattanoogatn.mycusthelp.com/public-records',
      portal_provider: 'govqa',
      is_primary: true,
      is_active: true,
      added_source: 'case_row_backfill',
      status: 'active',
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z',
    }]);
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
      if (sql.includes('FROM proposals')) {
        return {
          rows: [{
            id: 1975,
            action_type: 'SUBMIT_PORTAL',
            status: 'PENDING_APPROVAL',
            draft_subject: 'Public Records Request - Jasmine Pace',
            draft_body_text: 'Draft body',
            reasoning: ['Generated initial request'],
            confidence: '0.81',
            gate_options: ['APPROVE', 'ADJUST', 'DISMISS'],
          }],
        };
      }
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes("LOWER(REPLACE(COALESCE(notion_page_id, ''), '-', ''))")) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE id = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) return { rows: [] };
      throw new Error(`Unexpected workspace query in city mismatch visibility test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/26671/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.pending_proposal.id, 1975);
      assert.strictEqual(response.body.pending_proposal.action_type, 'SUBMIT_PORTAL');
      assert.strictEqual(response.body.request.substatus, 'Proposal #1975 pending review');
      assert.strictEqual(response.body.request.agency_name, 'Chattanooga Police Department, Tennessee');
      assert.strictEqual(response.body.request.portal_url, 'https://chattanoogatn.mycusthelp.com/public-records');
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

  it('GET /api/requests/:id/workspace keeps placeholder intake imports blocked until a real delivery path exists', async function () {
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
      id: 26672,
      subject_name: "Ohio sex worker guilty of killing 4 men is sentenced to 4 life terms in 'serial murder'",
      case_name: "Ohio sex worker guilty of killing 4 men is sentenced to 4 life terms in 'serial murder'",
      agency_id: null,
      agency_name: '—',
      agency_email: 'pending-research@intake.autobot',
      portal_url: null,
      portal_provider: null,
      state: null,
      status: 'awaiting_response',
      requires_human: false,
      pause_reason: null,
      substatus: null,
      contact_research_notes: null,
      requested_records: ['Interview/interrogation recordings'],
      additional_details: 'Title: Ohio sex worker guilty of killing 4 men is sentenced to 4 life terms in serial murder',
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-10T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
      user_id: null,
      import_warnings: [
        { type: 'MISSING_DELIVERY_PATH', message: 'Case has request content but no portal URL or agency email after import research' },
        { type: 'MISSING_EMAIL', message: 'No agency email and no portal URL — case cannot be sent' },
      ],
    });
    db.getCaseAgencies = async () => ([{
      id: 242,
      case_id: 26672,
      agency_id: null,
      agency_name: '—',
      agency_email: 'pending-research@intake.autobot',
      portal_url: null,
      portal_provider: null,
      is_primary: true,
      is_active: true,
      added_source: 'case_row_backfill',
      status: 'active',
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z',
    }]);
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
      throw new Error(`Unexpected workspace query in placeholder intake block test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/26672/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.pending_proposal, null);
      assert.strictEqual(response.body.next_action_proposal, null);
      assert.strictEqual(response.body.request.status, 'NEEDS_HUMAN_REVIEW');
      assert.strictEqual(response.body.request.review_state, 'IDLE');
      assert.strictEqual(response.body.request.control_state, 'BLOCKED');
      assert.strictEqual(response.body.request.pause_reason, 'IMPORT_REVIEW');
      assert.match(response.body.request.substatus, /missing a real delivery path/i);
      assert.strictEqual(response.body.request.agency_email, null);
      assert.strictEqual(response.body.request.portal_url, null);
      assert.strictEqual(response.body.agency_summary.submission_method, 'UNKNOWN');
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

  it('GET /api/requests/:id/workspace recovers stale waiting review runs with no correspondence back to ready to send', async function () {
    const originalDbMethods = {
      getCaseById: db.getCaseById,
      getCaseAgencies: db.getCaseAgencies,
      getThreadsByCaseId: db.getThreadsByCaseId,
      getMessagesByThreadId: db.getMessagesByThreadId,
      getAttachmentsByCaseId: db.getAttachmentsByCaseId,
      getUserById: db.getUserById,
      completeAgentRun: db.completeAgentRun,
      logActivity: db.logActivity,
      query: db.query,
    };

    const completedRuns = [];
    const activityEvents = [];
    const caseUpdates = [];

    db.getCaseById = async () => ({
      id: 26703,
      subject_name: 'Charles E. Miles',
      case_name: 'Charles E. Miles',
      agency_id: null,
      agency_name: 'Evansville Police Department, Indiana',
      agency_email: 'publicaccess@evansvillepolice.com',
      portal_url: 'https://evansvillepolice.com/public-information-request-forms/',
      portal_provider: null,
      state: 'IN',
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'PENDING_APPROVAL',
      substatus: 'Proposal #2047 pending review',
      contact_research_notes: null,
      requested_records: ['Body camera footage'],
      additional_details: 'Initial request only',
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-12T00:00:00.000Z',
      updated_at: '2026-03-12T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
      user_id: null,
      import_warnings: null,
    });
    db.getCaseAgencies = async () => ([{
      id: 280,
      case_id: 26703,
      agency_id: 999,
      agency_name: 'Evansville Police Department, Indiana',
      agency_email: 'publicaccess@evansvillepolice.com',
      portal_url: 'https://evansvillepolice.com/public-information-request-forms/',
      portal_provider: null,
      is_primary: true,
      is_active: true,
      added_source: 'notion_relation',
      status: 'active',
      created_at: '2026-03-12T00:00:00.000Z',
      updated_at: '2026-03-12T00:00:00.000Z',
    }]);
    db.getThreadsByCaseId = async () => [];
    db.getMessagesByThreadId = async () => [];
    db.getAttachmentsByCaseId = async () => [];
    db.getUserById = async () => null;
    db.completeAgentRun = async (runId, proposalId, error) => {
      completedRuns.push({ runId, proposalId, error });
      return { id: runId, status: 'failed' };
    };
    db.logActivity = async (eventType, description, metadata) => {
      activityEvents.push({ eventType, description, metadata });
      return { id: 1 };
    };
    db.query = async (sql, params = []) => {
      if (sql.includes('FROM portal_tasks')) return { rows: [] };
      if (sql.includes('FROM activity_log')) return { rows: [] };
      if (sql.includes('FROM auto_reply_queue')) return { rows: [] };
      if (sql.includes('FROM agent_decisions')) return { rows: [] };
      if (sql.includes('FROM agent_runs')) {
        return {
          rows: [{
            id: 2843,
            status: 'waiting',
            trigger_type: 'initial_request',
            started_at: '2026-03-12T14:34:17.473Z',
            trigger_run_id: null,
            trigger_run_id_legacy: null,
            current_node: 'wait_human_decision',
            skyvern_task_url: null,
          }],
        };
      }
      if (sql.includes('FROM proposals')) return { rows: [] };
      if (sql.includes('UPDATE cases')) {
        caseUpdates.push(params);
        return { rows: [] };
      }
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes("LOWER(REPLACE(COALESCE(notion_page_id, ''), '-', ''))")) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE id = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) return { rows: [] };
      throw new Error(`Unexpected workspace query in stale no-correspondence recovery test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/26703/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.pending_proposal, null);
      assert.strictEqual(response.body.request.status, 'READY_TO_SEND');
      assert.strictEqual(response.body.request.review_state, 'IDLE');
      assert.strictEqual(response.body.request.control_state, 'BLOCKED');
      assert.strictEqual(response.body.request.pause_reason, 'INITIAL_REQUEST');
      assert.match(response.body.request.substatus, /ready to draft the initial request/i);
      assert.strictEqual(caseUpdates.length, 1);
      assert.strictEqual(caseUpdates[0][0], 26703);
      assert.strictEqual(caseUpdates[0][1], 'ready_to_send');
      assert.strictEqual(completedRuns.length, 1);
      assert.strictEqual(completedRuns[0].runId, 2843);
      assert.match(completedRuns[0].error, /Recovered stale waiting run without proposal/i);
      assert.strictEqual(activityEvents.length, 1);
      assert.strictEqual(activityEvents[0].eventType, 'stale_no_correspondence_recovered');
    } finally {
      db.getCaseById = originalDbMethods.getCaseById;
      db.getCaseAgencies = originalDbMethods.getCaseAgencies;
      db.getThreadsByCaseId = originalDbMethods.getThreadsByCaseId;
      db.getMessagesByThreadId = originalDbMethods.getMessagesByThreadId;
      db.getAttachmentsByCaseId = originalDbMethods.getAttachmentsByCaseId;
      db.getUserById = originalDbMethods.getUserById;
      db.completeAgentRun = originalDbMethods.completeAgentRun;
      db.logActivity = originalDbMethods.logActivity;
      db.query = originalDbMethods.query;
    }
  });

  it('GET /api/requests/:id/workspace renders first-send pending approvals as ready-to-send while preserving the approval gate', async function () {
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
      id: 26665,
      subject_name: 'Samuel Honey case',
      case_name: 'Samuel Honey case',
      agency_id: 999,
      agency_name: 'Lee County Sheriff’s Office, Georgia',
      agency_email: 'openrecords@lee.ga.us',
      portal_url: null,
      portal_provider: null,
      state: 'GA',
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: 'INITIAL_REQUEST',
      substatus: 'Proposal #1970 pending review',
      contact_research_notes: null,
      requested_records: ['Dispatch audio'],
      additional_details: 'Test details',
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-10T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
      user_id: null,
      import_warnings: null,
      message_count: 0,
      outbound_count: 0,
      thread_count: 0,
      portal_submission_count: 0,
      send_date: null,
    });
    db.getCaseAgencies = async () => ([{
      id: 901,
      case_id: 26665,
      agency_id: 999,
      agency_name: 'Lee County Sheriff’s Office, Georgia',
      agency_email: 'openrecords@lee.ga.us',
      portal_url: null,
      portal_provider: null,
      is_primary: true,
      is_active: true,
      added_source: 'directory',
      status: 'active',
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-10T00:00:00.000Z',
    }]);
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
      if (sql.includes('FROM proposals')) {
        return {
          rows: [{
            id: 1970,
            action_type: 'SEND_INITIAL_REQUEST',
            status: 'PENDING_APPROVAL',
            draft_subject: 'Public Records Request - Samuel Honey',
            draft_body_text: 'Hello Lee County Sheriff’s Office Open Records,',
            reasoning: ['Initial request ready to send'],
            confidence: '0.82',
            gate_options: ['APPROVE', 'ADJUST', 'DISMISS'],
          }],
        };
      }
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes("LOWER(REPLACE(COALESCE(notion_page_id, ''), '-', ''))")) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE id = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) return { rows: [] };
      throw new Error(`Unexpected workspace query in first-send pending review test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/26665/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.pending_proposal.id, 1970);
      assert.strictEqual(response.body.request.status, 'READY_TO_SEND');
      assert.strictEqual(response.body.request.review_state, 'DECISION_REQUIRED');
      assert.strictEqual(response.body.request.control_state, 'NEEDS_DECISION');
      assert.strictEqual(response.body.request.substatus, 'Proposal #1970 pending review');
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

  it('GET /api/requests/:id/workspace keeps import-review cases blocked when the agency is not in directory and no real delivery path exists', async function () {
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
      id: 25250,
      subject_name: "Highland Park parade mass shooter Robert Crimo sentenced to life without parole",
      case_name: "Highland Park parade mass shooter Robert Crimo sentenced to life without parole",
      agency_id: null,
      agency_name: "Highland Park Police Department",
      agency_email: null,
      portal_url: null,
      portal_provider: null,
      state: "IL",
      status: "awaiting_response",
      requires_human: false,
      pause_reason: null,
      substatus: "agency_research_complete",
      contact_research_notes: null,
      requested_records: ["Body camera footage"],
      additional_details: "Imported case for Highland Park parade shooting records",
      autopilot_mode: "SUPERVISED",
      created_at: "2026-03-09T00:00:00.000Z",
      updated_at: "2026-03-10T00:00:00.000Z",
      next_due_at: null,
      last_response_date: null,
      user_id: null,
      import_warnings: [
        { type: "AGENCY_NOT_IN_DIRECTORY", message: 'Agency "Highland Park Police Department" not found in directory' },
      ],
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
      throw new Error(`Unexpected workspace query in no-path import block test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/25250/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.pending_proposal, null);
      assert.strictEqual(response.body.next_action_proposal, null);
      assert.strictEqual(response.body.request.status, 'NEEDS_HUMAN_REVIEW');
      assert.strictEqual(response.body.request.review_state, 'IDLE');
      assert.strictEqual(response.body.request.control_state, 'BLOCKED');
      assert.strictEqual(response.body.request.pause_reason, 'IMPORT_REVIEW');
      assert.match(response.body.request.substatus, /missing a real delivery path/i);
      assert.strictEqual(response.body.request.agency_email, null);
      assert.strictEqual(response.body.request.portal_url, null);
      assert.strictEqual(response.body.agency_summary.submission_method, 'UNKNOWN');
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

  it('GET /api/requests/:id/workspace normalizes stale resolving substatus once a fresh proposal exists', async function () {
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
      id: 25159,
      subject_name: 'Paula Plemmons Garrett',
      case_name: 'Paula Plemmons Garrett',
      agency_id: 5215,
      agency_name: "Madison County Sheriff's Office, North Carolina",
      agency_email: 'mcsopublicrecordsrequest@madisoncountync.gov',
      portal_url: 'https://www.madisoncountync.gov/public-records-request.html',
      portal_provider: 'govqa',
      state: 'NC',
      status: 'needs_human_review',
      requires_human: true,
      pause_reason: null,
      substatus: 'Resolving: send_via_email',
      contact_research_notes: null,
      requested_records: ['Body camera footage'],
      additional_details: 'Imported case for Madison County Sheriff records',
      autopilot_mode: 'SUPERVISED',
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-10T00:00:00.000Z',
      next_due_at: null,
      last_response_date: null,
      user_id: null,
      import_warnings: [],
    });
    db.getCaseAgencies = async () => ([{
      id: 251,
      case_id: 25159,
      agency_id: 5215,
      agency_name: "Madison County Sheriff's Office, North Carolina",
      agency_email: 'mcsopublicrecordsrequest@madisoncountync.gov',
      portal_url: 'https://www.madisoncountync.gov/public-records-request.html',
      portal_provider: 'govqa',
      is_primary: true,
      is_active: true,
      status: 'active',
      created_at: '2026-03-10T00:00:00.000Z',
      updated_at: '2026-03-10T00:00:00.000Z',
    }]);
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
      if (sql.includes('FROM proposals')) {
        return {
          rows: [{
            id: 1980,
            action_type: 'SEND_INITIAL_REQUEST',
            status: 'PENDING_APPROVAL',
            draft_subject: 'Public Records Request - Paula Plemmons Garrett',
            draft_body_text: 'Hello Records Custodian, ...',
            reasoning: ['Human review resolution: action=send_via_email'],
            waitpoint_token: 'waitpoint_test_25159',
            pause_reason: null,
            confidence: '1.00',
            gate_options: ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'],
            action_chain: null,
            chain_id: null,
            human_decided_by: null,
            human_decided_at: null,
            original_draft_subject: 'Public Records Request - Paula Plemmons Garrett',
            original_draft_body_text: 'Hello Records Custodian, ...',
            human_edited: false,
          }],
        };
      }
      if (sql.includes('UPDATE cases')) return { rows: [] };
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes("LOWER(REPLACE(COALESCE(notion_page_id, ''), '-', ''))")) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE id = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE name = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE portal_url = $1')) return { rows: [] };
      if (sql.includes('FROM agencies') && sql.includes('WHERE LOWER(email_main) = LOWER($1)')) return { rows: [] };
      throw new Error(`Unexpected workspace query in stale resolving normalization test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests/25159/workspace');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.pending_proposal.id, 1980);
      assert.strictEqual(response.body.request.substatus, 'Proposal #1980 pending review');
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

  it('GET /api/cases/:id/agencies masks imported agency/channel mismatches behind the metadata agency hint', async function () {
    const originalGetCaseById = db.getCaseById;
    const originalGetCaseAgencies = db.getCaseAgencies;

    db.getCaseById = async () => ({
      id: 26636,
      subject_name: 'Ryan Campbell',
      case_name: 'Denver request',
      agency_id: null,
      agency_name: 'Police Department',
      agency_email: 'ORR@mylubbock.us',
      portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
      portal_provider: 'govqa',
      state: 'CO',
      additional_details: '**Police Department:** Denver Police Department, Colorado',
      import_warnings: [{ type: 'AGENCY_METADATA_MISMATCH' }],
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z',
    });
    db.getCaseAgencies = async () => ([{
      id: 301,
      case_id: 26636,
      agency_id: 1365,
      agency_name: 'Lubbock Police Department, Texas',
      agency_email: 'ORR@mylubbock.us',
      portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
      portal_provider: 'govqa',
      is_primary: true,
      is_active: true,
      added_source: 'notion_import',
      status: 'active',
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z',
    }]);

    try {
      const app = express();
      app.use('/api/cases', caseAgenciesRouter);
      const response = await supertest(app).get('/api/cases/26636/agencies');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.agencies.length, 1);
      assert.strictEqual(response.body.agencies[0].agency_name, 'Denver Police Department');
      assert.strictEqual(response.body.agencies[0].agency_id, null);
      assert.strictEqual(response.body.agencies[0].agency_email, null);
      assert.strictEqual(response.body.agencies[0].portal_url, null);
    } finally {
      db.getCaseById = originalGetCaseById;
      db.getCaseAgencies = originalGetCaseAgencies;
    }
  });

  it('GET /api/cases/:id/agencies masks routed-agency state mismatches as unknown when no safe department hint exists', async function () {
    const originalGetCaseById = db.getCaseById;
    const originalGetCaseAgencies = db.getCaseAgencies;

    db.getCaseById = async () => ({
      id: 26637,
      subject_name: 'Jose Sandoval-Romero',
      case_name: 'Granddaughter of Manson Family Victim Brutally Stabbed in Denver',
      agency_id: 1365,
      agency_name: 'Lubbock Police Department, Texas',
      agency_email: 'ORR@mylubbock.us',
      portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
      portal_provider: 'govqa',
      state: 'CO',
      additional_details: 'Title: Granddaughter of Manson Family Victim Brutally Stabbed in Denver',
      import_warnings: [],
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z',
    });
    db.getCaseAgencies = async () => ([{
      id: 302,
      case_id: 26637,
      agency_id: 1365,
      agency_name: 'Lubbock Police Department, Texas',
      agency_email: 'ORR@mylubbock.us',
      portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
      portal_provider: 'govqa',
      is_primary: true,
      is_active: true,
      added_source: 'notion_import',
      status: 'active',
      created_at: '2026-03-09T00:00:00.000Z',
      updated_at: '2026-03-09T00:00:00.000Z',
    }]);

    try {
      const app = express();
      app.use('/api/cases', caseAgenciesRouter);
      const response = await supertest(app).get('/api/cases/26637/agencies');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.agencies.length, 1);
      assert.strictEqual(response.body.agencies[0].agency_name, 'Unknown agency');
      assert.strictEqual(response.body.agencies[0].agency_id, null);
      assert.strictEqual(response.body.agencies[0].agency_email, null);
      assert.strictEqual(response.body.agencies[0].portal_url, null);
    } finally {
      db.getCaseById = originalGetCaseById;
      db.getCaseAgencies = originalGetCaseAgencies;
    }
  });

  it('GET /api/cases/:id/agencies prefers the research-suggested agency even when the placeholder row is not tagged as a backfill', async function () {
    const originalGetCaseById = db.getCaseById;
    const originalGetCaseAgencies = db.getCaseAgencies;
    const originalQuery = db.query;

    db.getCaseById = async () => ({
      id: 25253,
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
      id: 64,
      case_id: 25253,
      agency_id: 152,
      agency_name: 'Stow Police Department',
      agency_email: 'pending-research@placeholder.invalid',
      portal_url: null,
      portal_provider: null,
      added_source: 'research',
      is_primary: true,
      is_active: true,
    }]);
    db.query = async (sql, params) => {
      if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
        if (params && params.includes("Marion County Sheriff's Office")) {
          return {
            rows: [{
              id: 3002,
              name: "Marion County Sheriff's Office",
              state: 'FL',
              email_main: null,
              email_foia: null,
              portal_url: null,
              portal_url_alt: null,
              portal_provider: null,
              score: 9,
              completeness: 1,
            }],
          };
        }
        return { rows: [] };
      }
      throw new Error(`Unexpected query in non-backfill research display test: ${sql}`);
    };

    try {
      const app = express();
      app.use('/api/cases', caseAgenciesRouter);
      const response = await supertest(app).get('/api/cases/25253/agencies');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.agencies[0].agency_name, "Marion County Sheriff's Office");
      assert.strictEqual(response.body.agencies[0].agency_id, 3002);
      assert.strictEqual(response.body.agencies[0].agency_email, null);
    } finally {
      db.getCaseById = originalGetCaseById;
      db.getCaseAgencies = originalGetCaseAgencies;
      db.query = originalQuery;
    }
  });
});
