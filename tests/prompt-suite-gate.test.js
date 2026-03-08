const assert = require('assert');
const {
  allPassStandardsMet,
  evaluateGate,
} = require('../scripts/test-prompt-suite');

describe('prompt suite deploy gate', function () {
  it('passes when threshold and standards are met', function () {
    const summary = {
      passRate: 90,
      failed: 1,
      jsonValidRate: 100,
      portalCorrectRate: 100,
      noEmailValidityRate: 100,
      noStatuteCitationsRate: 100,
    };

    const gate = evaluateGate(summary, {
      minPassRate: 90,
      requirePassStandards: true,
    });

    assert.strictEqual(allPassStandardsMet(summary), true);
    assert.strictEqual(gate.passed, true);
    assert.deepStrictEqual(gate.issues, []);
  });

  it('fails when pass rate drops below threshold', function () {
    const gate = evaluateGate(
      {
        passRate: 89,
        failed: 2,
        jsonValidRate: 100,
        portalCorrectRate: 100,
        noEmailValidityRate: 100,
        noStatuteCitationsRate: 100,
      },
      { minPassRate: 90 }
    );

    assert.strictEqual(gate.passed, false);
    assert.ok(gate.issues.some((issue) => issue.includes('below required 90%')));
  });

  it('fails when pass standards are required but not met', function () {
    const gate = evaluateGate(
      {
        passRate: 97,
        failed: 0,
        jsonValidRate: 100,
        portalCorrectRate: 95,
        noEmailValidityRate: 100,
        noStatuteCitationsRate: 100,
      },
      { minPassRate: 90, requirePassStandards: true }
    );

    assert.strictEqual(gate.passed, false);
    assert.ok(gate.issues.some((issue) => issue.includes('Pass standards not met')));
  });

  it('keeps legacy strict failure behavior without gate args', function () {
    const gate = evaluateGate(
      {
        passRate: 95,
        failed: 1,
        jsonValidRate: 100,
        portalCorrectRate: 100,
        noEmailValidityRate: 100,
        noStatuteCitationsRate: 100,
      },
      {}
    );

    assert.strictEqual(gate.passed, false);
    assert.ok(gate.issues.some((issue) => issue.includes('fixture(s) failed')));
  });
});
