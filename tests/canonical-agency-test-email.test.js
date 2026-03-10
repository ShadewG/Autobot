const { expect } = require('chai');
const { findCanonicalAgency } = require('../services/canonical-agency');

describe('findCanonicalAgency', () => {
  it('ignores the configured test inbox when scoring canonical agency matches', async () => {
    const calls = [];
    const fakeDb = {
      async query(sql, params) {
        calls.push(params);
        return { rows: [] };
      },
    };

    await findCanonicalAgency(fakeDb, {
      portalUrl: null,
      portalMailbox: 'shadewofficial@gmail.com',
      agencyEmail: 'shadewofficial@gmail.com',
      agencyName: 'Synthetic QA Records Unit',
      stateHint: 'CA',
    });

    expect(calls).to.have.length(1);
    expect(calls[0][1]).to.equal(null);
    expect(calls[0][2]).to.equal(null);
    expect(calls[0][5]).to.equal('Synthetic QA Records Unit');
  });

  it('matches exact agency names even when state is missing', async () => {
    const fakeDb = {
      async query() {
        return {
          rows: [{
            id: 1015,
            name: 'South St. Paul Police Department, Minnesota',
            state: null,
            score: 10,
          }],
        };
      },
    };

    const result = await findCanonicalAgency(fakeDb, {
      portalUrl: null,
      portalMailbox: null,
      agencyEmail: null,
      agencyName: 'South St. Paul Police Department, Minnesota',
      stateHint: null,
    });

    expect(result?.id).to.equal(1015);
    expect(result?.name).to.equal('South St. Paul Police Department, Minnesota');
  });

  it('passes the state hint through for suffix/state disambiguation', async () => {
    let observedParams = null;
    const fakeDb = {
      async query(_sql, params) {
        observedParams = params;
        return {
          rows: [{
            id: 1102,
            name: 'Santa Rosa County Sheriff’s Office, Florida',
            state: null,
            score: 8,
          }],
        };
      },
    };

    const result = await findCanonicalAgency(fakeDb, {
      portalUrl: null,
      portalMailbox: null,
      agencyEmail: null,
      agencyName: 'Santa Rosa County Sheriff’s Office',
      stateHint: 'FL',
    });

    expect(result?.id).to.equal(1102);
    expect(observedParams[8]).to.equal('FL');
    expect(observedParams[9]).to.equal('florida');
  });
});
