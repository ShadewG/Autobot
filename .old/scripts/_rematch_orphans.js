#!/usr/bin/env node
/**
 * Rematch orphaned inbound messages to their correct cases using NR + agency verification.
 * NRs are NOT globally unique on NextRequest — different agencies share the same
 * sequential numbering. So we verify the email's agency matches the case's agency.
 *
 * Usage:
 *   node scripts/_rematch_orphans.js           # dry run
 *   node scripts/_rematch_orphans.js --apply   # actually update
 */
const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_PUBLIC_URL
    || process.env.DATABASE_URL
    || 'postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway';

const pool = new Pool({ connectionString: DB_URL });
const applyMode = process.argv.includes('--apply');

function extractNR(subject) {
    if (!subject) return null;
    const match = subject.match(/#([A-Za-z0-9]+-\d+|\d{3,})/);
    return match ? match[1] : null;
}

function extractAgencyFromSubject(subject) {
    if (!subject) return null;
    // NextRequest format: "Your Augusta, Georgia public records request #26-428"
    const match = subject.match(/Your\s+(.+?)\s+public\s+records\s+request/i);
    if (match) return match[1].trim();
    // "[External Message Added] Shreveport, LA  public records request #26-825"
    const match2 = subject.match(/\]\s+(.+?)\s+public\s+records\s+request/i);
    if (match2) return match2[1].trim();
    return null;
}

function agencyMatches(emailAgency, caseAgency) {
    if (!emailAgency || !caseAgency) return false;
    const ea = emailAgency.toLowerCase().replace(/[,\s]+/g, ' ').trim();
    const ca = caseAgency.toLowerCase().replace(/[,\s]+/g, ' ').trim();
    // Check if one contains the other, or significant word overlap
    if (ca.includes(ea) || ea.includes(ca)) return true;
    // Check first significant word match (e.g. "Shreveport" in both)
    const eaWords = ea.split(' ').filter(w => w.length > 3);
    const caWords = ca.split(' ').filter(w => w.length > 3);
    const overlap = eaWords.filter(w => caWords.includes(w));
    return overlap.length >= 1 && overlap.length >= eaWords.length * 0.5;
}

async function run() {
    const orphaned = await pool.query(`
        SELECT id, from_email, subject, created_at, body_text
        FROM messages
        WHERE direction = 'inbound' AND thread_id IS NULL
        ORDER BY created_at DESC
    `);

    console.log(`=== Rematching ${orphaned.rows.length} orphaned inbound messages (${applyMode ? 'APPLY' : 'DRY RUN'}) ===\n`);

    const nrMap = {};
    const noNR = [];
    for (const m of orphaned.rows) {
        const nr = extractNR(m.subject);
        if (nr) {
            if (!nrMap[nr]) nrMap[nr] = [];
            nrMap[nr].push(m);
        } else {
            noNR.push(m);
        }
    }

    let matched = 0;
    let noCase = 0;
    let agencyMismatch = 0;

    for (const [nr, msgs] of Object.entries(nrMap)) {
        const caseResult = await pool.query(`
            SELECT id, case_name, agency_name, status, portal_request_number
            FROM cases
            WHERE portal_request_number = $1
               OR $1 = ANY(string_to_array(REPLACE(portal_request_number, ' ', ''), ','))
        `, [nr]);

        if (caseResult.rows.length === 0) {
            console.log(`NR ${nr}: NO CASE FOUND — ${msgs.length} msgs (${msgs.map(m => '#' + m.id).join(', ')})`);
            noCase += msgs.length;
            continue;
        }

        // For each message, verify agency matches before linking
        for (const m of msgs) {
            const emailAgency = extractAgencyFromSubject(m.subject);
            let matchedCase = null;

            for (const c of caseResult.rows) {
                if (emailAgency && agencyMatches(emailAgency, c.agency_name)) {
                    matchedCase = c;
                    break;
                } else if (!emailAgency && caseResult.rows.length === 1) {
                    // No agency in subject but only one case — accept
                    matchedCase = c;
                    break;
                }
            }

            if (!matchedCase && emailAgency) {
                console.log(`NR ${nr}: MSG #${m.id} AGENCY MISMATCH — email says "${emailAgency}", cases: ${caseResult.rows.map(c => `#${c.id} (${c.agency_name})`).join(', ')}`);
                agencyMismatch++;
                continue;
            }

            if (!matchedCase) {
                console.log(`NR ${nr}: MSG #${m.id} AMBIGUOUS — multiple cases, no agency signal`);
                agencyMismatch++;
                continue;
            }

            // Find thread for this case
            const threadResult = await pool.query(
                'SELECT id FROM email_threads WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1',
                [matchedCase.id]
            );
            const threadId = threadResult.rows.length > 0 ? threadResult.rows[0].id : null;

            console.log(`NR ${nr}: MSG #${m.id} -> Case #${matchedCase.id} (${matchedCase.agency_name}) [${matchedCase.status}]`);
            console.log(`  Subject: ${(m.subject || '').slice(0, 80)}`);

            if (applyMode) {
                await pool.query(
                    'UPDATE messages SET thread_id = $1, case_id = $2 WHERE id = $3',
                    [threadId, matchedCase.id, m.id]
                );
                console.log(`  -> Linked to case #${matchedCase.id}, thread ${threadId || 'NULL'}`);
            }
            matched++;
        }
    }

    console.log(`\n=== ${noNR.length} messages with no NR (cannot auto-rematch) ===`);
    for (const m of noNR) {
        console.log(`  MSG #${m.id} [${m.created_at.toISOString().slice(0, 16)}]: ${(m.subject || '').slice(0, 80)}`);
        console.log(`    From: ${m.from_email}`);
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`Total orphaned: ${orphaned.rows.length}`);
    console.log(`Matchable (NR + agency verified): ${matched}`);
    console.log(`No case found for NR: ${noCase}`);
    console.log(`Agency mismatch (rejected): ${agencyMismatch}`);
    console.log(`No NR in subject: ${noNR.length}`);

    if (!applyMode && matched > 0) {
        console.log(`\nRe-run with --apply to update the database.`);
    }

    await pool.end();
}

run().catch(err => {
    console.error(err);
    pool.end();
    process.exit(1);
});
