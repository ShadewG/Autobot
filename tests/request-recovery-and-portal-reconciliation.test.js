const assert = require('assert');
const sinon = require('sinon');

const {
  dedupeCaseAgencies,
  filterExistingAgencyCandidates,
  extractLatestSupportedPortalUrl,
  toThreadMessage,
} = require('../routes/requests/_helpers');
const sendgridService = require('../services/sendgrid-service');
const db = require('../services/database');

describe('Request recovery helpers and portal reconciliation', function () {
  describe('request workspace helpers', function () {
    it('dedupes duplicate case agencies and keeps the richer row', function () {
      const deduped = dedupeCaseAgencies([
        {
          id: 22,
          agency_name: 'Porter County Central Communications',
          agency_email: '911audio@portercountyin.gov',
          portal_url: null,
          is_primary: false,
          is_active: true,
          notes: null,
          updated_at: '2026-03-05T00:00:00.000Z',
        },
        {
          id: 24,
          agency_name: 'Porter County Central Communications',
          agency_email: '911audio@portercountyin.gov',
          portal_url: null,
          is_primary: true,
          is_active: true,
          notes: 'Primary agency',
          updated_at: '2026-03-06T00:00:00.000Z',
        },
      ]);

      assert.strictEqual(deduped.length, 1);
      assert.strictEqual(deduped[0].id, 24);
      assert.strictEqual(deduped[0].is_primary, true);
      assert.strictEqual(deduped[0].agency_email, '911audio@portercountyin.gov');
      assert.strictEqual(deduped[0].notes, 'Primary agency');
    });

    it('filters duplicate research candidates that already exist on the case', function () {
      const candidates = filterExistingAgencyCandidates(
        [
          {
            name: 'Porter County Central Communications',
            agency_email: null,
            portal_url: null,
          },
          {
            name: 'Indiana State Police',
            agency_email: 'records@isp.in.gov',
            portal_url: null,
          },
        ],
        [
          {
            agency_name: 'Porter County Central Communications',
            agency_email: '911audio@portercountyin.gov',
            portal_url: null,
          },
        ],
        {
          agency_name: 'Porter County Central Communications',
          agency_email: '911audio@portercountyin.gov',
          portal_url: null,
        }
      );

      assert.deepStrictEqual(candidates, [
        {
          name: 'Indiana State Police',
          agency_email: 'records@isp.in.gov',
          portal_url: null,
        },
      ]);
    });

    it('recovers a supported portal URL and ignores tracking links', function () {
      const portalUrl = extractLatestSupportedPortalUrl(
        [
          { metadata: { portal_url: 'https://u8387778.ct.sendgrid.net/ls/click?upn=abc' } },
          { metadata: { portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx' } },
        ],
        [
          { portal_url: 'https://u8387778.ct.sendgrid.net/ls/click?upn=still-bad' },
        ],
        'https://u8387778.ct.sendgrid.net/ls/click?upn=last-bad'
      );

      assert.strictEqual(
        portalUrl,
        'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx'
      );
    });

    it('normalizes tracked portal links and stale agency names in thread bodies', function () {
      const threadMessage = toThreadMessage(
        {
          id: 740,
          direction: 'outbound',
          subject: 'Portal submission completed',
          body_text: [
            'Portal request submitted.',
            'Portal URL: https://u8387778.ct.sendgrid.net/ls/click?upn=abc',
            'To Stow Police Department Public Records Officer,',
          ].join('\n'),
          sent_at: '2026-03-06T00:59:26.529Z',
        },
        [],
        {
          agency_name: 'Lubbock Police Department, Texas',
          portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
        }
      );

      assert.match(threadMessage.body, /Lubbock Police Department/i);
      assert.doesNotMatch(threadMessage.body, /Stow Police Department/i);
      assert.match(
        threadMessage.body,
        /https:\/\/lubbocktx\.govqa\.us\/WEBAPP\/_rs\/SupportHome\.aspx/i
      );
      assert.doesNotMatch(threadMessage.body, /sendgrid\.net\/ls\/click/i);
    });
  });

  describe('sendgrid portal reconciliation', function () {
    let originalDbMethods;

    beforeEach(function () {
      originalDbMethods = {
        query: db.query,
        addCaseAgency: db.addCaseAgency,
        updateCaseAgency: db.updateCaseAgency,
        getCaseAgencyById: db.getCaseAgencyById,
        switchPrimaryAgency: db.switchPrimaryAgency,
        updateThread: db.updateThread,
        logActivity: db.logActivity,
      };
    });

    afterEach(function () {
      db.query = originalDbMethods.query;
      db.addCaseAgency = originalDbMethods.addCaseAgency;
      db.updateCaseAgency = originalDbMethods.updateCaseAgency;
      db.getCaseAgencyById = originalDbMethods.getCaseAgencyById;
      db.switchPrimaryAgency = originalDbMethods.switchPrimaryAgency;
      db.updateThread = originalDbMethods.updateThread;
      db.logActivity = originalDbMethods.logActivity;
      sinon.restore();
    });

    it('drops weak mailbox hints and keeps city-like tenant hints', function () {
      assert.strictEqual(sendgridService.normalizeAgencySignalHint('records'), null);
      assert.strictEqual(sendgridService.normalizeAgencySignalHint('support'), null);
      assert.strictEqual(sendgridService.normalizeAgencySignalHint('lubbocktx'), 'lubbock');
      assert.strictEqual(sendgridService.normalizeAgencySignalHint('stow'), 'stow');
    });

    it('requires a strong agency match before reconciling from portal signals', async function () {
      db.query = sinon.stub().resolves({
        rows: [
          {
            id: 12,
            name: 'Records Division',
            email_main: null,
            email_foia: null,
            portal_url: null,
            portal_url_alt: null,
            portal_provider: null,
            score: 7,
            completeness: 0,
          },
        ],
      });
      db.addCaseAgency = sinon.stub().resolves(null);
      db.updateCaseAgency = sinon.stub().resolves(null);
      db.getCaseAgencyById = sinon.stub().resolves(null);
      db.switchPrimaryAgency = sinon.stub().resolves(null);
      db.updateThread = sinon.stub().resolves();
      db.logActivity = sinon.stub().resolves();

      const result = await sendgridService.reconcileCaseAgencyFromPortalSignals(
        { id: 1, portal_url: null },
        null,
        { fromEmail: 'records@govqa.us', portalUrl: null, provider: 'govqa' }
      );

      assert.strictEqual(result, null);
      sinon.assert.calledOnce(db.query);
      sinon.assert.notCalled(db.addCaseAgency);
      sinon.assert.notCalled(db.updateCaseAgency);
      sinon.assert.notCalled(db.switchPrimaryAgency);
    });

    it('rewrites synthetic backfill rows when stronger portal signals identify the agency', async function () {
      const existingRow = {
        id: 61,
        case_id: 25207,
        agency_id: 152,
        agency_name: 'Stow Police Department',
        agency_email: 'lubbock@govqa.us',
        portal_url: null,
        portal_provider: null,
        is_primary: true,
        added_source: 'case_row_backfill',
      };
      const updatedRow = {
        ...existingRow,
        agency_id: 1365,
        agency_name: 'Lubbock Police Department, Texas',
        agency_email: 'ORR@mylubbock.us',
        portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
        portal_provider: 'govqa',
      };

      db.query = sinon.stub();
      db.query.onCall(0).resolves({
        rows: [
          {
            id: 1365,
            name: 'Lubbock Police Department, Texas',
            email_main: null,
            email_foia: 'ORR@mylubbock.us',
            portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
            portal_url_alt: null,
            portal_provider: 'govqa',
            score: 9,
            completeness: 4,
          },
        ],
      });
      db.query.onCall(1).resolves({ rows: [] });
      db.query.onCall(2).resolves({ rows: [existingRow] });
      db.addCaseAgency = sinon.stub().resolves(null);
      db.updateCaseAgency = sinon.stub().resolves(updatedRow);
      db.getCaseAgencyById = sinon.stub().resolves(updatedRow);
      db.switchPrimaryAgency = sinon.stub().resolves(updatedRow);
      db.updateThread = sinon.stub().resolves();
      db.logActivity = sinon.stub().resolves();

      const result = await sendgridService.reconcileCaseAgencyFromPortalSignals(
        { id: 25207, portal_url: null },
        null,
        { fromEmail: 'lubbock@govqa.us', portalUrl: null, provider: 'govqa' }
      );

      assert(result);
      assert.strictEqual(result.agency_id, 1365);
      assert.strictEqual(result.agency_name, 'Lubbock Police Department, Texas');
      sinon.assert.notCalled(db.addCaseAgency);
      sinon.assert.calledOnce(db.updateCaseAgency);
      sinon.assert.calledWithMatch(
        db.updateCaseAgency,
        61,
        sinon.match({
          agency_id: 1365,
          agency_name: 'Lubbock Police Department, Texas',
          agency_email: 'orr@mylubbock.us',
          portal_url: 'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
          portal_provider: 'govqa',
        })
      );
      sinon.assert.notCalled(db.switchPrimaryAgency);
    });
  });
});
