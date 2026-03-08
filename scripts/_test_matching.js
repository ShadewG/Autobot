#!/usr/bin/env node
/**
 * Test the agency matching logic against real-world NextRequest name formats.
 */

// Replicate the agencyMatchesCase logic from sendgrid-service.js
function agencyMatchesCase(sigAgencyName, caseAgencyName) {
    if (!sigAgencyName || !caseAgencyName) return true;
    const sigAgency = sigAgencyName.toLowerCase();
    const caseAgency = caseAgencyName.toLowerCase();
    if (caseAgency.includes(sigAgency) || sigAgency.includes(caseAgency)) return true;
    const filler = /\b(the|of|and|via|for|public|records|request|police|pd|department|dept|sheriff|sheriffs|office|county|city|town|township|state|district|division|bureau)\b/g;
    const toCore = (s) => s.replace(filler, '').replace(/[^a-z\s]/g, ' ').trim().split(/\s+/).filter(w => w.length >= 3);
    const sigCore = toCore(sigAgency);
    const caseCore = toCore(caseAgency);
    if (sigCore.length === 0 || caseCore.length === 0) return true;
    return sigCore.some(w => caseCore.includes(w));
}

const tests = [
    // Should MATCH — same agency, different format
    { sig: 'Winnebago County - Sheriff, WI', case_: 'Winnebago County Sheriff\'s Office, Wisconsin', expect: true, desc: 'Winnebago NR subject vs case' },
    { sig: 'Augusta, Georgia', case_: 'Augusta Police Department, Georgia', expect: true, desc: 'Augusta NR subject vs case' },
    { sig: 'Shreveport, LA', case_: 'Shreveport Police Department, Louisiana', expect: true, desc: 'Shreveport NR subject vs case' },
    { sig: 'City of Raleigh', case_: 'Raleigh Police Department, NC', expect: true, desc: 'Raleigh with City prefix' },
    { sig: 'Fort Collins Police Services', case_: 'Fort Collins Police Department, Colorado', expect: true, desc: 'Fort Collins with Services vs Department' },
    { sig: 'Austin TX Public Records', case_: 'City of Austin Police Department, Texas', expect: true, desc: 'Austin with state suffix' },

    // Should NOT MATCH — different agencies
    { sig: 'Augusta, Georgia', case_: 'Winnebago County Sheriff\'s Office, Wisconsin', expect: false, desc: 'Augusta email vs Winnebago case' },
    { sig: 'Shreveport, LA', case_: 'Augusta Police Department, Georgia', expect: false, desc: 'Shreveport email vs Augusta case' },
    { sig: 'Winnebago County - Sheriff, WI', case_: 'Shreveport Police Department, Louisiana', expect: false, desc: 'Winnebago email vs Shreveport case' },
    { sig: 'Raleigh NC', case_: 'Augusta Police Department, Georgia', expect: false, desc: 'Raleigh email vs Augusta case' },

    // Edge cases
    { sig: null, case_: 'Some Agency', expect: true, desc: 'Null signal agency → accept' },
    { sig: 'Some Agency', case_: null, expect: true, desc: 'Null case agency → accept' },
    { sig: 'PD', case_: 'Police Department', expect: true, desc: 'All filler → accept (cannot verify)' },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
    const result = agencyMatchesCase(t.sig, t.case_);
    const ok = result === t.expect;
    if (ok) {
        passed++;
        console.log(`  PASS: ${t.desc}`);
    } else {
        failed++;
        console.log(`  FAIL: ${t.desc}`);
        console.log(`    Signal: "${t.sig}" vs Case: "${t.case_}"`);
        console.log(`    Expected: ${t.expect}, Got: ${result}`);
    }
}

console.log(`\n${passed} passed, ${failed} failed out of ${tests.length} tests`);
process.exit(failed > 0 ? 1 : 0);
