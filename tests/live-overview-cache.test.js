const assert = require('assert');
const path = require('path');
const express = require('express');
const supertest = require('supertest');
const sinon = require('sinon');

describe('Live overview cache fallback', function () {
  const actualNormalization = require('../utils/request-normalization.js');

  function loadOverviewRouter(dbStub, normalizationOverrides = {}) {
    const routePath = path.resolve(__dirname, '../routes/monitor/overview.js');
    const helpersPath = path.resolve(__dirname, '../routes/monitor/_helpers.js');
    const caseTruthPath = path.resolve(__dirname, '../lib/case-truth.js');
    const normalizationPath = path.resolve(__dirname, '../utils/request-normalization.js');

    const originals = {
      route: require.cache[routePath],
      helpers: require.cache[helpersPath],
      caseTruth: require.cache[caseTruthPath],
      normalization: require.cache[normalizationPath],
    };

    require.cache[helpersPath] = {
      id: helpersPath,
      filename: helpersPath,
      loaded: true,
      exports: {
        db: dbStub,
        normalizeProposalReasoning: (row) => row.reasoning || null,
        extractAttachmentInsights: () => [],
      },
    };
    require.cache[caseTruthPath] = {
      id: caseTruthPath,
      filename: caseTruthPath,
      loaded: true,
      exports: {
        HUMAN_REVIEW_PROPOSAL_STATUSES_SQL: "'PENDING_APPROVAL','BLOCKED','DECISION_RECEIVED','PENDING_PORTAL'",
        buildCaseTruth: () => ({ review_state: 'needs_review' }),
      },
    };
    require.cache[normalizationPath] = {
      id: normalizationPath,
      filename: normalizationPath,
      loaded: true,
      exports: {
        evaluateImportAutoDispatchSafety: () => ({ shouldBlockAutoDispatch: false }),
        extractResearchSuggestedAgency: () => null,
        filterStaleImportWarnings: actualNormalization.filterStaleImportWarnings,
        normalizePortalTimeoutSubstatus: (value) => value,
        shouldSuppressPlaceholderAgencyDisplay: () => false,
        sanitizeStaleResearchHandoffDraft: (value) => value,
        sanitizeStaleResearchHandoffReasoning: (value) => value,
        ...normalizationOverrides,
      },
    };
    delete require.cache[routePath];

    const router = require(routePath);

    return {
      router,
      restore() {
        if (originals.route) require.cache[routePath] = originals.route;
        else delete require.cache[routePath];
        if (originals.helpers) require.cache[helpersPath] = originals.helpers;
        else delete require.cache[helpersPath];
        if (originals.caseTruth) require.cache[caseTruthPath] = originals.caseTruth;
        else delete require.cache[caseTruthPath];
        if (originals.normalization) require.cache[normalizationPath] = originals.normalization;
        else delete require.cache[normalizationPath];
      },
    };
  }

  it('serves cached overview data when a refresh query fails', async function () {
    const queryStub = sinon.stub();
    queryStub.onCall(0).resolves({ rows: [{ inbound_24h: '1', unmatched_inbound_total: '0', unprocessed_inbound_total: '0' }] });
    queryStub.onCall(1).resolves({ rows: [{ portal_hard_timeout_total_1h: 0, portal_soft_timeout_total_1h: 0 }] });
    queryStub.onCall(2).resolves({ rows: [{ process_inbound_superseded_total_1h: 0 }] });
    queryStub.onCall(3).resolves({ rows: [] });
    queryStub.onCall(4).resolves({ rows: [] });
    queryStub.onCall(5).resolves({ rows: [] });
    queryStub.onCall(6).resolves({ rows: [] });
    queryStub.onCall(7).resolves({ rows: [] });
    queryStub.onCall(8).resolves({ rows: [] });

    const dbStub = {
      query: queryStub,
      getUserById: async () => null,
    };

    const { router, restore } = loadOverviewRouter(dbStub, {
      evaluateImportAutoDispatchSafety: actualNormalization.evaluateImportAutoDispatchSafety,
    });
    let now = 1_000;
    const clock = sinon.stub(Date, 'now').callsFake(() => now);

    try {
      const app = express();
      app.use('/api/monitor', router);

      const first = await supertest(app).get('/api/monitor/live-overview');
      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.body.success, true);
      assert.strictEqual(first.body.summary.inbound_24h, 1);
      assert.strictEqual(queryStub.callCount, 9);

      queryStub.resetHistory();
      queryStub.resetBehavior();
      queryStub.rejects(new Error('Connection terminated due to connection timeout'));
      now = 20_000;

      const second = await supertest(app).get('/api/monitor/live-overview');
      assert.strictEqual(second.status, 200);
      assert.strictEqual(second.body.success, true);
      assert.strictEqual(second.body.cache_state, 'stale');
      assert.match(second.body.warning, /Serving cached live overview/i);
      assert.strictEqual(second.body.summary.inbound_24h, 1);
      assert.ok(queryStub.called);
    } finally {
      clock.restore();
      restore();
    }
  });

  it('filters blocked import-review proposals out of pending approvals', async function () {
    const dbStub = {
      query: async (sql) => {
        if (sql.includes('COUNT(*) FILTER') && sql.includes('FROM messages m')) {
          return { rows: [{ inbound_24h: '0', unmatched_inbound_total: '0', unprocessed_inbound_total: '0' }] };
        }
        if (sql.includes('portal_hard_timeout_total_1h')) {
          return { rows: [{ portal_hard_timeout_total_1h: 0, portal_soft_timeout_total_1h: 0 }] };
        }
        if (sql.includes('process_inbound_superseded_total_1h')) {
          return { rows: [{ process_inbound_superseded_total_1h: 0 }] };
        }
        if (sql.includes('FROM proposals p') && sql.includes('LEFT JOIN cases c ON c.id = p.case_id')) {
          return {
            rows: [{
              id: 1940,
              case_id: 26636,
              action_type: 'SUBMIT_PORTAL',
              proposal_status: 'PENDING_APPROVAL',
              confidence: '0.80',
              created_at: '2026-03-10T00:00:00.000Z',
              trigger_message_id: null,
              reasoning: ['Generated initial FOIA request'],
              draft_subject: 'Public Records Request - Jose Sandoval-Romero',
              draft_body_text: 'Hello Denver Police Department Records Unit',
              proposal_pause_reason: null,
              risk_flags: [],
              warnings: [],
              gate_options: null,
              case_name: 'Granddaughter of Manson Family Victim Brutally Stabbed in Denver',
              subject_name: 'Jose Sandoval-Romero',
              agency_name: 'Lubbock Police Department, Texas',
              state: 'CO',
              case_status: 'needs_human_review',
              case_substatus: 'Proposal #1940 pending review',
              portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
              agency_email: 'ORR@mylubbock.us',
              additional_details: 'PD: The **Denver Police Department** in Colorado',
              import_warnings: [],
              deadline_date: null,
              contact_research_notes: null,
              effective_agency_email: 'ORR@mylubbock.us',
              user_id: null,
              case_pause_reason: 'INITIAL_REQUEST',
              last_fee_quote_amount: null,
              message_count: '0',
              inbound_count: 0,
              last_inbound_preview: null,
              last_inbound_subject: null,
              last_inbound_from_email: null,
              last_inbound_date: null,
            }],
          };
        }
        if (sql.includes('SELECT DISTINCT ON (p.case_id)')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT DISTINCT ON (ca.case_id)')) {
          return { rows: [] };
        }
        if (sql.includes('FROM agent_runs r') || sql.includes('FROM messages m') || sql.includes('FROM cases c') || sql.includes('FROM attachments a')) {
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL in import-review pending filter test: ${sql}`);
      },
      getUserById: async () => null,
    };

    const { router, restore } = loadOverviewRouter(dbStub, {
      evaluateImportAutoDispatchSafety: actualNormalization.evaluateImportAutoDispatchSafety,
    });
    try {
      const app = express();
      app.use('/api/monitor', router);

      const response = await supertest(app).get('/api/monitor/live-overview');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.summary.pending_approvals_total, 0);
      assert.deepStrictEqual(response.body.pending_approvals, []);
    } finally {
      restore();
    }
  });

  it('suppresses stale AGENCY_NOT_IN_DIRECTORY warnings in pending approvals when a canonical agency is linked', async function () {
    const dbStub = {
      query: async (sql) => {
        if (sql.includes('COUNT(*) FILTER') && sql.includes('FROM messages m')) {
          return { rows: [{ inbound_24h: '0', unmatched_inbound_total: '0', unprocessed_inbound_total: '0' }] };
        }
        if (sql.includes('portal_hard_timeout_total_1h')) {
          return { rows: [{ portal_hard_timeout_total_1h: 0, portal_soft_timeout_total_1h: 0 }] };
        }
        if (sql.includes('process_inbound_superseded_total_1h')) {
          return { rows: [{ process_inbound_superseded_total_1h: 0 }] };
        }
        if (sql.includes('FROM proposals p') && sql.includes('LEFT JOIN cases c ON c.id = p.case_id')) {
          return {
            rows: [{
              id: 1981,
              case_id: 25150,
              action_type: 'SEND_STATUS_UPDATE',
              proposal_status: 'PENDING_APPROVAL',
              confidence: '0.82',
              created_at: '2026-03-10T00:00:00.000Z',
              trigger_message_id: null,
              reasoning: ['Status update requested'],
              draft_subject: 'Status update',
              draft_body_text: 'Hello Records Unit',
              proposal_pause_reason: null,
              risk_flags: [],
              warnings: [],
              gate_options: null,
              case_name: 'Christopher Malik Todd',
              subject_name: 'Christopher Malik Todd',
              agency_name: 'South St. Paul Police Department, Minnesota',
              agency_id: 1015,
              state: 'MN',
              case_status: 'needs_human_review',
              case_substatus: 'Proposal #1981 pending review',
              portal_url: 'https://www.southstpaulmn.gov/FormCenter/Police-8/Request-for-Police-Data-67',
              agency_email: 'clerical@sspmn.org',
              additional_details: 'Police Department: South St. Paul Police Department, Minnesota',
              import_warnings: [{
                type: 'AGENCY_NOT_IN_DIRECTORY',
                message: 'Agency "South St. Paul Police Department, Minnesota" not found in directory',
              }],
              deadline_date: null,
              contact_research_notes: null,
              effective_agency_email: 'clerical@sspmn.org',
              user_id: 3,
              case_pause_reason: 'STATUS_UPDATE',
              last_fee_quote_amount: null,
              message_count: '0',
              inbound_count: 0,
              last_inbound_preview: null,
              last_inbound_subject: null,
              last_inbound_from_email: null,
              last_inbound_date: null,
            }],
          };
        }
        if (sql.includes('SELECT DISTINCT ON (p.case_id)')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT DISTINCT ON (ca.case_id)')) {
          return {
            rows: [{
              case_id: 25150,
              agency_id: 1015,
              agency_name: 'South St. Paul Police Department, Minnesota',
              agency_email: 'clerical@sspmn.org',
              portal_url: 'https://www.southstpaulmn.gov/FormCenter/Police-8/Request-for-Police-Data-67',
              added_source: 'notion_import',
            }],
          };
        }
        if (sql.includes('FROM agent_runs r') || sql.includes('FROM messages m') || sql.includes('FROM cases c') || sql.includes('FROM attachments a')) {
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL in stale warning suppression test: ${sql}`);
      },
      getUserById: async () => null,
    };

    const { router, restore } = loadOverviewRouter(dbStub, {
      evaluateImportAutoDispatchSafety: actualNormalization.evaluateImportAutoDispatchSafety,
      filterStaleImportWarnings: actualNormalization.filterStaleImportWarnings,
    });

    try {
      const app = express();
      app.use('/api/monitor', router);

      const response = await supertest(app).get('/api/monitor/live-overview');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.pending_approvals.length, 1);
      assert.strictEqual(response.body.pending_approvals[0].import_warnings, null);
    } finally {
      restore();
    }
  });

  it('suppresses stale queue warnings when a canonical agency can be inferred from the case row', async function () {
    const dbStub = {
      query: async (sql) => {
        if (sql.includes('COUNT(*) FILTER') && sql.includes('FROM messages m')) {
          return { rows: [{ inbound_24h: '0', unmatched_inbound_total: '0', unprocessed_inbound_total: '0' }] };
        }
        if (sql.includes('portal_hard_timeout_total_1h')) {
          return { rows: [{ portal_hard_timeout_total_1h: 0, portal_soft_timeout_total_1h: 0 }] };
        }
        if (sql.includes('process_inbound_superseded_total_1h')) {
          return { rows: [{ process_inbound_superseded_total_1h: 0 }] };
        }
        if (sql.includes('FROM proposals p') && sql.includes('LEFT JOIN cases c ON c.id = p.case_id')) {
          return {
            rows: [{
              id: 2088,
              case_id: 25155,
              action_type: 'SEND_INITIAL_REQUEST',
              proposal_status: 'PENDING_APPROVAL',
              confidence: '0.88',
              created_at: '2026-03-10T00:00:00.000Z',
              trigger_message_id: null,
              reasoning: ['Ready to send'],
              draft_subject: 'Public records request',
              draft_body_text: 'Hello records unit',
              proposal_pause_reason: null,
              risk_flags: [],
              warnings: [],
              gate_options: null,
              case_name: 'Santa Rosa case',
              subject_name: 'Santa Rosa case',
              agency_name: 'Santa Rosa County Sheriff’s Office',
              agency_id: null,
              state: 'FL',
              case_status: 'needs_human_review',
              case_substatus: 'Proposal #2088 pending review',
              portal_url: null,
              agency_email: null,
              additional_details: null,
              import_warnings: [{
                type: 'AGENCY_NOT_IN_DIRECTORY',
                message: 'Agency \"Santa Rosa County Sheriff’s Office\" not found in directory',
              }],
              deadline_date: null,
              contact_research_notes: null,
              effective_agency_email: null,
              user_id: null,
              case_pause_reason: 'INITIAL_REQUEST',
              last_fee_quote_amount: null,
              message_count: '0',
              inbound_count: 0,
              last_inbound_preview: null,
              last_inbound_subject: null,
              last_inbound_from_email: null,
              last_inbound_date: null,
            }],
          };
        }
        if (sql.includes('SELECT DISTINCT ON (p.case_id)')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT DISTINCT ON (ca.case_id)')) {
          return {
            rows: [{
              case_id: 25155,
              agency_id: null,
              agency_name: 'Santa Rosa County Sheriff’s Office',
              agency_email: null,
              portal_url: null,
              added_source: 'notion_import',
            }],
          };
        }
        if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
          return {
            rows: [{
              id: 1102,
              name: 'Santa Rosa County Sheriff’s Office, Florida',
              state: null,
              portal_url: 'https://srsofl.justfoia.com/publicportal',
              email_main: null,
              score: 8,
            }],
          };
        }
        if (sql.includes('FROM agent_runs r') || sql.includes('FROM messages m') || sql.includes('FROM cases c') || sql.includes('FROM attachments a')) {
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL in inferred canonical warning suppression test: ${sql}`);
      },
      getUserById: async () => null,
    };

    const { router, restore } = loadOverviewRouter(dbStub, {
      evaluateImportAutoDispatchSafety: actualNormalization.evaluateImportAutoDispatchSafety,
      filterStaleImportWarnings: actualNormalization.filterStaleImportWarnings,
    });

    try {
      const app = express();
      app.use('/api/monitor', router);

      const response = await supertest(app).get('/api/monitor/live-overview');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.pending_approvals.length, 1);
      assert.strictEqual(response.body.pending_approvals[0].import_warnings, null);
      assert.strictEqual(response.body.pending_approvals[0].agency_name, 'Santa Rosa County Sheriff’s Office, Florida');
    } finally {
      restore();
    }
  });
});
