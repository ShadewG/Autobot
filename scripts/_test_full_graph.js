#!/usr/bin/env node
/**
 * Integration test: simulate matching real emails against the production DB
 * using the updated Priority 2 logic with agency verification.
 */
const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway' });

const activeStatuses = [
    'sent', 'awaiting_response', 'portal_in_progress', 'needs_rebuttal',
    'pending_fee_decision', 'needs_human_review', 'responded'
];

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

(async () => {
    let failures = 0;

    // Test 1: NR 26-428 from Augusta should NOT match Winnebago case
    console.log('=== TEST 1: Cross-agency NR collision (Augusta vs Winnebago) ===');
    const nr = '26-428';
    const emailAgency = 'Augusta, Georgia';

    const cases = await pool.query(
        `SELECT id, agency_name, portal_request_number, status FROM cases
         WHERE (portal_request_number = $1 OR $1 = ANY(string_to_array(REPLACE(portal_request_number, ' ', ''), ',')))
         ORDER BY CASE WHEN portal_request_number = $1 THEN 0 ELSE 1 END, updated_at DESC
         LIMIT 5`,
        [nr]
    );

    let matched = null;
    for (const c of cases.rows) {
        if (agencyMatchesCase(emailAgency, c.agency_name)) {
            matched = c;
            break;
        }
        console.log(`  Rejected: Case #${c.id} (${c.agency_name}) — agency mismatch with "${emailAgency}"`);
    }
    console.log(`  Result: ${matched ? `MATCHED Case #${matched.id} (${matched.agency_name})` : 'NO MATCH (correct!)'}`);
    if (matched !== null) { failures++; console.log('  FAIL'); } else { console.log('  PASS'); }
    console.log();

    // Test 2: NR 26-428 from Winnebago SHOULD match Winnebago case
    console.log('=== TEST 2: Correct NR match (Winnebago to Winnebago) ===');
    const winnAgency = 'Winnebago County - Sheriff, WI';
    let matched2 = null;
    for (const c of cases.rows) {
        if (agencyMatchesCase(winnAgency, c.agency_name)) {
            matched2 = c;
            break;
        }
    }
    console.log(`  Result: ${matched2 ? `MATCHED Case #${matched2.id} (${matched2.agency_name})` : 'NO MATCH'}`);
    if (matched2 && matched2.id === 25167) { console.log('  PASS'); } else { failures++; console.log('  FAIL'); }
    console.log();

    // Test 3: NR with no agency signal should still match (backwards compat)
    console.log('=== TEST 3: NR match without agency signal (backwards compat) ===');
    let matched3 = null;
    for (const c of cases.rows) {
        if (agencyMatchesCase(null, c.agency_name)) {
            matched3 = c;
            break;
        }
    }
    console.log(`  Result: ${matched3 ? `MATCHED Case #${matched3.id} (${matched3.agency_name})` : 'NO MATCH'}`);
    if (matched3) { console.log('  PASS'); } else { failures++; console.log('  FAIL'); }
    console.log();

    // Test 4: All currently linked messages should still match their case agency
    console.log('=== TEST 4: Verify all existing thread messages match their case agency ===');
    const linkedMessages = await pool.query(`
        SELECT DISTINCT m.id, m.subject, c.id as case_id, c.agency_name, c.portal_request_number
        FROM messages m
        JOIN email_threads et ON et.id = m.thread_id
        JOIN cases c ON c.id = et.case_id
        WHERE m.direction = 'inbound'
          AND m.subject LIKE '%public records request%'
        ORDER BY m.id
    `);

    let allGood = true;
    for (const m of linkedMessages.rows) {
        const agencyMatch = m.subject.match(/Your\s+(.+?)\s+public\s+records\s+request/i)
                         || m.subject.match(/\]\s+(.+?)\s+public\s+records\s+request/i);
        const extractedAgency = agencyMatch ? agencyMatch[1].trim() : null;

        if (extractedAgency) {
            const matches = agencyMatchesCase(extractedAgency, m.agency_name);
            if (!matches) {
                console.log(`  FAIL: MSG #${m.id} — "${extractedAgency}" vs case #${m.case_id} "${m.agency_name}"`);
                allGood = false;
                failures++;
            }
        }
    }
    console.log(`  Checked ${linkedMessages.rows.length} linked messages`);
    if (allGood) { console.log('  PASS'); } else { console.log('  FAIL'); }
    console.log();

    await pool.end();
    console.log(`=== ${failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURES'} ===`);
    process.exit(failures > 0 ? 1 : 0);
})();
