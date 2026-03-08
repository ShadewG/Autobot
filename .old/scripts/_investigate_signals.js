const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
    const signals = await pool.query(`
        SELECT ups.id, ups.from_email, ups.subject, ups.portal_provider,
               ups.detected_request_number, ups.portal_subdomain,
               ups.matched_case_id, ups.message_id, ups.created_at,
               m.case_id as msg_case_id
        FROM unmatched_portal_signals ups
        LEFT JOIN messages m ON ups.message_id = m.id
        ORDER BY ups.created_at DESC
    `);

    console.log('Total portal signals: ' + signals.rows.length);

    let unresolved = 0;
    for (const s of signals.rows) {
        const resolved = s.matched_case_id || s.msg_case_id;
        if (!resolved) unresolved++;
        const tag = resolved ? 'RESOLVED' : 'UNRESOLVED';
        console.log(`${tag} Signal #${s.id} | provider:${s.portal_provider || '?'} | reqNum:${s.detected_request_number || 'none'} | agency:${s.portal_subdomain || '?'} | matchedCase:${s.matched_case_id || s.msg_case_id || 'NONE'} | msg:${s.message_id || '?'}`);
        if (!resolved) {
            console.log(`  Subject: ${(s.subject || '').substring(0, 80)}`);
            console.log(`  From: ${s.from_email}`);
        }
    }

    console.log(`\nUnresolved: ${unresolved}/${signals.rows.length}`);

    // For unresolved ones, try to find matching cases
    const unresolvedSignals = signals.rows.filter(s => !s.matched_case_id && !s.msg_case_id);
    if (unresolvedSignals.length > 0) {
        console.log('\n=== ATTEMPTING MATCHES FOR UNRESOLVED ===');
        for (const s of unresolvedSignals) {
            if (s.detected_request_number) {
                const byReqNum = await pool.query(
                    'SELECT id, agency_name, portal_request_number FROM cases WHERE portal_request_number = $1',
                    [s.detected_request_number]
                );
                if (byReqNum.rows.length > 0) {
                    console.log(`  Signal #${s.id} reqNum ${s.detected_request_number} -> Case #${byReqNum.rows[0].id} ${byReqNum.rows[0].agency_name}`);
                } else {
                    const partial = await pool.query(
                        `SELECT id, agency_name, portal_request_number FROM cases WHERE portal_request_number LIKE '%' || $1 || '%'`,
                        [s.detected_request_number]
                    );
                    if (partial.rows.length > 0) {
                        console.log(`  Signal #${s.id} PARTIAL match: ${partial.rows.map(r => `Case #${r.id} (${r.portal_request_number})`).join(', ')}`);
                    } else {
                        console.log(`  Signal #${s.id} reqNum ${s.detected_request_number} -> NO MATCH`);
                    }
                }
            }

            if (s.portal_subdomain) {
                // Try to find cases by portal domain/subdomain
                const byPortal = await pool.query(
                    `SELECT id, agency_name, status, portal_url, portal_request_number FROM cases WHERE portal_url ILIKE '%' || $1 || '%' LIMIT 5`,
                    [s.portal_subdomain]
                );
                if (byPortal.rows.length > 0) {
                    console.log(`  Signal #${s.id} subdomain "${s.portal_subdomain}" -> ${byPortal.rows.map(r => `Case #${r.id} ${r.agency_name} (${r.status}) reqNum:${r.portal_request_number || 'none'}`).join('; ')}`);
                }
            }
        }
    }

    // Also check: are there messages that were matched but the portal_signals entry wasn't updated?
    console.log('\n=== SIGNALS WHERE MESSAGE WAS MATCHED BUT SIGNAL NOT ===');
    const orphanSignals = await pool.query(`
        SELECT ups.id, ups.message_id, ups.detected_request_number, ups.portal_subdomain,
               m.case_id, c.agency_name
        FROM unmatched_portal_signals ups
        JOIN messages m ON ups.message_id = m.id
        JOIN cases c ON c.id = m.case_id
        WHERE ups.matched_case_id IS NULL AND m.case_id IS NOT NULL
    `);
    if (orphanSignals.rows.length > 0) {
        for (const o of orphanSignals.rows) {
            console.log(`  Signal #${o.id} msg #${o.message_id} -> already matched to Case #${o.case_id} ${o.agency_name} (signal not updated)`);
        }
    } else {
        console.log('  None');
    }

    await pool.end();
})();
