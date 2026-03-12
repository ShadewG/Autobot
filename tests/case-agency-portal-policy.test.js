const assert = require('assert');
const express = require('express');
const sinon = require('sinon');
const supertest = require('supertest');

const router = require('../routes/case-agencies');
const db = require('../services/database');

describe('case agency portal policy routes', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('confirms a portal and persists a trusted automation policy', async function () {
    sinon.stub(db, 'getCaseAgencyById').resolves({
      id: 44,
      case_id: 7001,
      agency_name: 'Example Police Department',
      agency_email: 'records@examplepd.gov',
      portal_url: 'https://example.nextrequest.com/',
      portal_provider: 'nextrequest',
    });
    const upsertStub = sinon.stub(db, 'upsertPortalAutomationPolicy').resolves({
      id: 1,
      portal_fingerprint: 'nextrequest|example.nextrequest.com|portal_entry|/',
      policy_status: 'trusted',
      decision_source: 'operator_confirmed',
      decision_reason: 'confirmed_real_portal',
      success_count: 0,
      failure_count: 0,
    });
    sinon.stub(db, 'enrichCaseAgenciesWithPortalAutomationPolicies').resolves([{
      id: 44,
      case_id: 7001,
      agency_name: 'Example Police Department',
      portal_url: 'https://example.nextrequest.com/',
      portal_provider: 'nextrequest',
      portal_automation_status: 'trusted',
      portal_automation_decision: 'allow',
      portal_automation_policy_status: 'trusted',
    }]);
    sinon.stub(db, 'logActivity').resolves();

    const app = express();
    app.use(express.json());
    app.use('/api/cases', router);

    const response = await supertest(app)
      .post('/api/cases/7001/agencies/44/portal/confirm')
      .send({});

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.case_agency.portal_automation_status, 'trusted');
    sinon.assert.calledOnce(upsertStub);
    sinon.assert.calledWithMatch(upsertStub, sinon.match({
      portalUrl: 'https://example.nextrequest.com/',
      provider: 'nextrequest',
      policyStatus: 'trusted',
      decisionSource: 'operator_confirmed',
    }));
  });

  it('marks a portal manual-only and cancels pending tasks on that case', async function () {
    sinon.stub(db, 'getCaseAgencyById').resolves({
      id: 45,
      case_id: 7002,
      agency_name: 'Custom Records Portal',
      agency_email: null,
      portal_url: 'https://records.example.gov/openrecords/form',
      portal_provider: null,
    });
    const upsertStub = sinon.stub(db, 'upsertPortalAutomationPolicy').resolves({
      id: 2,
      portal_fingerprint: 'unknown|records.example.gov|unknown_candidate|/openrecords/form',
      policy_status: 'blocked',
      decision_source: 'operator_blocked',
      decision_reason: 'manual_only',
      success_count: 0,
      failure_count: 0,
    });
    const queryStub = sinon.stub(db, 'query').resolves({ rows: [], rowCount: 1 });
    sinon.stub(db, 'enrichCaseAgenciesWithPortalAutomationPolicies').resolves([{
      id: 45,
      case_id: 7002,
      agency_name: 'Custom Records Portal',
      portal_url: 'https://records.example.gov/openrecords/form',
      portal_provider: null,
      portal_automation_status: 'blocked',
      portal_automation_decision: 'block',
      portal_automation_policy_status: 'blocked',
    }]);
    sinon.stub(db, 'logActivity').resolves();

    const app = express();
    app.use(express.json());
    app.use('/api/cases', router);

    const response = await supertest(app)
      .post('/api/cases/7002/agencies/45/portal/block')
      .send({});

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);
    assert.strictEqual(response.body.case_agency.portal_automation_status, 'blocked');
    sinon.assert.calledOnce(upsertStub);
    sinon.assert.calledWithMatch(upsertStub, sinon.match({
      portalUrl: 'https://records.example.gov/openrecords/form',
      policyStatus: 'blocked',
      decisionSource: 'operator_blocked',
    }));
    assert.ok(queryStub.calledOnce);
  });
});
