#!/usr/bin/env node
/**
 * Test suggestedAction normalization for freeform AI outputs.
 */

// Extract the normalization logic inline (same as in classify-inbound.js)
function normalizeSuggestedAction(suggestedAction) {
  if (!suggestedAction || suggestedAction.length <= 30) return suggestedAction;
  const sa = suggestedAction.toLowerCase();
  if (sa.includes('rebuttal') || sa.includes('challenge') || sa.includes('appeal')) return 'send_rebuttal';
  if (sa.includes('portal') || sa.includes('submit')) return 'use_portal';
  if (sa.includes('negotiate') || sa.includes('fee')) return 'negotiate_fee';
  if (sa.includes('wait') || sa.includes('monitor')) return 'wait';
  if (sa.includes('respond') || sa.includes('reply')) return 'respond';
  return 'respond';
}

const tests = [
  // Short values pass through unchanged
  { input: 'send_rebuttal', expect: 'send_rebuttal', desc: 'Short value passes through' },
  { input: 'wait', expect: 'wait', desc: 'Short wait passes through' },
  { input: null, expect: null, desc: 'Null passes through' },

  // Freeform strings get normalized
  {
    input: 'Maintain stance that portal use is not required; request email or alternative delivery and cite NC Public Records Law',
    expect: 'use_portal',
    desc: 'Long portal instruction → use_portal'
  },
  {
    input: 'Reply confirming you agree to the $45 total and ask for payment instructions and delivery method/format',
    expect: 'respond',
    desc: 'Long reply instruction → respond'
  },
  {
    input: 'Resubmit the full request through the Raleigh NextRequest portal using the same details',
    expect: 'use_portal',
    desc: 'Resubmit via portal → use_portal'
  },
  {
    input: 'Submit the request through https://raleighnc.nextrequest.com/ with the same details and priorities',
    expect: 'use_portal',
    desc: 'Submit through portal URL → use_portal'
  },
  {
    input: 'Reply requesting processing via email citing NC Public Records Law; ask for confirmation they will proceed',
    expect: 'respond',
    desc: 'Reply requesting email → respond'
  },
  {
    input: 'Challenge the denial and appeal citing state public records law requirements for disclosure',
    expect: 'send_rebuttal',
    desc: 'Challenge/appeal → send_rebuttal'
  },
  {
    input: 'Submit the request via the Odessa portal using the provided link, copying the original details',
    expect: 'use_portal',
    desc: 'Submit via Odessa portal → use_portal'
  },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
  const result = normalizeSuggestedAction(t.input);
  const ok = result === t.expect;
  if (ok) {
    passed++;
    console.log(`  PASS: ${t.desc}`);
  } else {
    failed++;
    console.log(`  FAIL: ${t.desc}`);
    console.log(`    Input: "${(t.input || '').slice(0, 60)}..."`);
    console.log(`    Expected: ${t.expect}, Got: ${result}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed out of ${tests.length} tests`);
process.exit(failed > 0 ? 1 : 0);
