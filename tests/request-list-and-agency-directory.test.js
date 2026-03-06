const assert = require('assert');
const express = require('express');
const supertest = require('supertest');

const requestHelpers = require('../routes/requests/_helpers');
const requestRouter = require('../routes/requests/query');
const agenciesDb = require('../services/database');
const agenciesRouter = require('../routes/agencies');

describe('Request list and agency directory normalization', function () {
  describe('GET /api/requests', function () {
    let originalQuery;

    beforeEach(function () {
      originalQuery = requestHelpers.db.query;
    });

    afterEach(function () {
      requestHelpers.db.query = originalQuery;
    });

    it('prefers the active primary case_agency over the stale case row in the list response', async function () {
      requestHelpers.db.query = async (sql) => {
        if (sql.includes('FROM cases c') && sql.includes('LEFT JOIN LATERAL')) {
          return {
            rows: [
              {
                id: 25207,
                subject_name: 'Ryan Campbell',
                requested_records: ['Body camera footage', '911/dispatch audio'],
                agency_id: null,
                agency_name: 'Stow Police Department',
                agency_email: null,
                state: null,
                portal_url: null,
                portal_provider: null,
                status: 'awaiting_response',
                requires_human: false,
                updated_at: '2026-03-06T00:59:26.298Z',
                created_at: '2026-03-04T18:00:00.000Z',
                next_due_at: '2026-03-14T16:06:34.337Z',
                last_response_date: '2026-02-27T19:08:47.510Z',
                active_run_status: null,
                active_run_trigger_type: null,
                active_run_started_at: null,
                active_run_trigger_run_id: null,
                active_portal_task_status: null,
                active_portal_task_type: null,
                active_proposal_status: null,
                autopilot_mode: 'SUPERVISED',
                substatus: 'Email fallback to ORR@mylubbock.us (portal failed)',
              },
            ],
          };
        }

        if (sql.includes('SELECT DISTINCT ON (ca.case_id)')) {
          return {
            rows: [
              {
                case_id: 25207,
                agency_id: 152,
                agency_name: 'Stow Police Department',
                agency_email: 'orr@mylubbock.us',
                portal_url: 'https://u8387778.ct.sendgrid.net/ls/click?abc',
                portal_provider: 'govqa',
                canonical_agency_name: 'Stow Police Department',
                canonical_state: 'OH',
                canonical_email_main: null,
                canonical_email_foia: null,
                canonical_portal_url: null,
                canonical_portal_url_alt: null,
                canonical_portal_provider: 'govqa',
              },
            ],
          };
        }

        if (sql.includes('FROM agencies a') && sql.includes('score DESC')) {
          return {
            rows: [
              {
                id: 1365,
                name: 'Lubbock Police Department, Texas',
                state: 'TX',
                email_main: null,
                email_foia: 'orr@mylubbock.us',
                portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
                portal_url_alt: null,
                portal_provider: 'govqa',
                score: 15,
                completeness: 3,
              },
            ],
          };
        }

        if (sql.includes('WHERE c.status IN (\'completed\', \'cancelled\')')) {
          return { rows: [] };
        }

        throw new Error(`Unexpected query in request list test: ${sql}`);
      };

      const app = express();
      app.use('/api/requests', requestRouter);

      const response = await supertest(app).get('/api/requests');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(response.body.requests.length, 1);
      assert.strictEqual(response.body.requests[0].agency_name, 'Lubbock Police Department, Texas');
      assert.strictEqual(response.body.requests[0].state, 'TX');
      assert.strictEqual(response.body.requests[0].status, 'AWAITING_RESPONSE');
    });
  });

  describe('GET /api/agencies', function () {
    let originalQuery;

    beforeEach(function () {
      originalQuery = agenciesDb.query;
    });

    afterEach(function () {
      agenciesDb.query = originalQuery;
    });

    it('dedupes agencies that only differ by trailing state label and derives a state code', async function () {
      agenciesDb.query = async (sql) => {
        if (sql.includes('FROM agencies a')) {
          return {
            rows: [
              {
                id: 1225,
                name: 'Rockford Police Department, IL',
                state: null,
                case_state: 'IL',
                county: null,
                portal_url: 'https://rockfordil.nextrequest.com/requests/new',
                portal_provider: null,
                email_main: null,
                email_foia: null,
                phone: null,
                default_autopilot_mode: 'SUPERVISED',
                total_requests: '1',
                completed_requests: '0',
                avg_response_days: 6,
                rating: '3',
                last_activity_at: '2026-03-05T15:17:18.665Z',
                last_info_verified_at: '2025-11-25T00:00:00.000Z',
                sync_status: 'synced',
                notion_page_id: 'abc',
                notes: 'Portal variant',
              },
              {
                id: 684,
                name: 'Rockford Police Department, Illinois',
                state: null,
                case_state: 'IL',
                county: null,
                portal_url: 'https://rockfordil.nextrequest.com/',
                portal_provider: null,
                email_main: null,
                email_foia: null,
                phone: null,
                default_autopilot_mode: 'SUPERVISED',
                total_requests: '1',
                completed_requests: '0',
                avg_response_days: 6,
                rating: '3',
                last_activity_at: '2026-03-05T15:17:18.665Z',
                last_info_verified_at: null,
                sync_status: 'synced',
                notion_page_id: 'def',
                notes: 'Portal variant 2',
              },
              {
                id: 501,
                name: 'Austin PD',
                state: 'TX',
                case_state: 'TX',
                county: null,
                portal_url: null,
                portal_provider: null,
                email_main: 'records@austintexas.gov',
                email_foia: null,
                phone: null,
                default_autopilot_mode: 'SUPERVISED',
                total_requests: '2',
                completed_requests: '1',
                avg_response_days: 2,
                rating: '4',
                last_activity_at: '2026-03-05T15:17:18.665Z',
                last_info_verified_at: null,
                sync_status: 'synced',
                notion_page_id: 'ghi',
                notes: 'Distinct agency',
              },
            ],
          };
        }

        if (sql.startsWith('SELECT COUNT(*) FROM agencies')) {
          return { rows: [{ count: '3' }] };
        }

        throw new Error(`Unexpected query in agencies test: ${sql}`);
      };

      const app = express();
      app.use('/api/agencies', agenciesRouter);

      const response = await supertest(app).get('/api/agencies');

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.success, true);
      assert.strictEqual(response.body.agencies.length, 2);

      const rockford = response.body.agencies.find((agency) => agency.name === 'Rockford Police Department');
      assert(rockford, 'expected Rockford duplicate rows to collapse');
      assert.strictEqual(rockford.state, 'IL');

      const austin = response.body.agencies.find((agency) => agency.name === 'Austin PD');
      assert(austin, 'expected distinct agency row to remain');
      assert.strictEqual(austin.state, 'TX');
    });
  });
});
