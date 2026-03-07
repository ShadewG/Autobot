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
});
