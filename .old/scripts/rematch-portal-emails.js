#!/usr/bin/env node
/**
 * Dry-run script: attempts to match unmatched inbound portal emails
 * using the new Tier 1.5 portal matching logic.
 *
 * Usage:
 *   node scripts/rematch-portal-emails.js          # dry run (read-only)
 *   node scripts/rematch-portal-emails.js --apply   # actually update case_id
 */
const { Pool } = require('pg');
const { PORTAL_EMAIL_DOMAINS } = require('../utils/portal-utils');

const DB_URL = process.env.DATABASE_PUBLIC_URL
    || process.env.DATABASE_URL
    || 'postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway';

const pool = new Pool({ connectionString: DB_URL });
const applyMode = process.argv.includes('--apply');

function extractEmail(emailString) {
    if (!emailString) return null;
    const match = emailString.match(/<(.+?)>/);
    return match ? match[1] : emailString;
}

function detectPortalProviderFromEmail(fromEmail) {
    if (!fromEmail) return null;
    const atIndex = fromEmail.indexOf('@');
    if (atIndex === -1) return null;
    const localPart = fromEmail.substring(0, atIndex).toLowerCase();
    const domain = fromEmail.substring(atIndex + 1).toLowerCase();

    for (const [emailDomain, config] of Object.entries(PORTAL_EMAIL_DOMAINS)) {
        if (domain === emailDomain || domain.endsWith('.' + emailDomain)) {
            const subdomain = config.subdomainFromLocalPart ? localPart : null;
            return { provider: config.provider, subdomain };
        }
    }
    return null;
}

function extractPortalMatchingSignals(provider, fromFull, fromEmail, subject, text) {
    const signals = { provider, subdomain: null, requestNumber: null, agencyName: null, bodySubdomain: null };
    const subjectStr = subject || '';
    const textStr = text || '';

    if (provider === 'justfoia') {
        const atIndex = (fromEmail || '').indexOf('@');
        if (atIndex > 0) signals.subdomain = fromEmail.substring(0, atIndex).toLowerCase();
        const reqMatch = subjectStr.match(/Request\s+([A-Z]{1,5}-\d{4}-\d+)/i);
        if (reqMatch) signals.requestNumber = reqMatch[1];
    } else if (provider === 'govqa') {
        const atIndex = (fromEmail || '').indexOf('@');
        if (atIndex > 0) signals.subdomain = fromEmail.substring(0, atIndex).toLowerCase();
    } else if (provider === 'nextrequest') {
        const fromFullStr = fromFull || '';
        const viaMatch = fromFullStr.match(/^["']?(.+?)\s+via\s+NextRequest/i);
        if (viaMatch) signals.agencyName = viaMatch[1].trim().replace(/^["']|["']$/g, '');

        if (!signals.agencyName) {
            const subjAgencyMatch = subjectStr.match(/Your\s+(.+?)\s+public\s+records\s+request/i);
            if (subjAgencyMatch) signals.agencyName = subjAgencyMatch[1].trim();
        }

        const reqNumMatch = subjectStr.match(/#([A-Z0-9]+-\d+|\d{3,})/i);
        if (reqNumMatch) signals.requestNumber = reqNumMatch[1];

        const urlPattern = /https?:\/\/([a-z0-9-]+)\.nextrequest\.com/gi;
        let urlMatch;
        const bodyToScan = `${subjectStr}\n${textStr}`;
        while ((urlMatch = urlPattern.exec(bodyToScan)) !== null) {
            const sub = urlMatch[1].toLowerCase();
            if (sub !== 'www' && sub !== 'api' && sub !== 'app' && sub !== 'messages') {
                signals.bodySubdomain = sub;
                break;
            }
        }
    } else if (provider === 'civicplus') {
        const reqMatch = subjectStr.match(/(?:Request|Tracking|Ref|Confirmation)[:\s#]+([A-Z]{1,5}-\d{2,4}-\d+)/i)
                      || subjectStr.match(/(?:Request|Tracking|Ref|Confirmation)[:\s#]+(\d{4,})/i)
                      || subjectStr.match(/#([A-Z0-9]+-\d+|\d{4,})/i);
        if (reqMatch) signals.requestNumber = reqMatch[1];

        const fromFullStr = fromFull || '';
        const civicMatch = fromFullStr.match(/^["']?(.+?)(?:\s+(?:via\s+)?CivicPlus|\s*<)/i);
        if (civicMatch) signals.agencyName = civicMatch[1].trim().replace(/^["']|["']$/g, '');
    }
    return signals;
}

async function tryMatch(signals) {
    const activeStatuses = [
        'sent', 'awaiting_response', 'portal_in_progress', 'needs_rebuttal',
        'pending_fee_decision', 'needs_human_review', 'responded'
    ];

    // Priority 1: Subdomain match
    if (signals.subdomain && (signals.provider === 'justfoia' || signals.provider === 'govqa')) {
        const portalDomain = signals.provider === 'justfoia'
            ? `${signals.subdomain}.justfoia.com`
            : `${signals.subdomain}.`;

        const r = await pool.query(
            `SELECT id, case_name, portal_url, status FROM cases
             WHERE LOWER(portal_url) LIKE $1 AND status = ANY($2)
             ORDER BY updated_at DESC LIMIT 1`,
            [`%${portalDomain}%`, activeStatuses]
        );
        if (r.rows.length > 0) return { method: 'subdomain', case: r.rows[0] };

        const r2 = await pool.query(
            `SELECT id, case_name, portal_url, status FROM cases
             WHERE LOWER(portal_url) LIKE $1
             ORDER BY updated_at DESC LIMIT 1`,
            [`%${portalDomain}%`]
        );
        if (r2.rows.length > 0) return { method: 'subdomain(any-status)', case: r2.rows[0] };
    }

    // Priority 2: Request number (supports comma-separated stored values)
    if (signals.requestNumber) {
        const r = await pool.query(
            `SELECT id, case_name, portal_url, status FROM cases
             WHERE (portal_request_number = $1
                    OR $1 = ANY(string_to_array(REPLACE(portal_request_number, ' ', ''), ',')))
             ORDER BY updated_at DESC LIMIT 1`,
            [signals.requestNumber]
        );
        if (r.rows.length > 0) return { method: 'request_number', case: r.rows[0] };
    }

    // Priority 3: Agency name (scoped by provider when available)
    if (signals.agencyName) {
        const r = await pool.query(
            `SELECT id, case_name, portal_url, status FROM cases
             WHERE LOWER(agency_name) = LOWER($1)
               AND ($3::text IS NULL OR portal_provider = $3)
               AND status = ANY($2)
             ORDER BY updated_at DESC LIMIT 1`,
            [signals.agencyName, activeStatuses, signals.provider || null]
        );
        if (r.rows.length > 0) return { method: 'agency_name_exact', case: r.rows[0] };

        const r2 = await pool.query(
            `SELECT id, case_name, portal_url, status FROM cases
             WHERE LOWER(agency_name) LIKE $1
               AND ($3::text IS NULL OR portal_provider = $3)
               AND status = ANY($2)
             ORDER BY updated_at DESC LIMIT 1`,
            [`%${signals.agencyName.toLowerCase()}%`, activeStatuses, signals.provider || null]
        );
        if (r2.rows.length > 0) return { method: 'agency_name_fuzzy', case: r2.rows[0] };
    }

    // Priority 4: Body URL subdomain
    if (signals.bodySubdomain) {
        const r = await pool.query(
            `SELECT id, case_name, portal_url, status FROM cases
             WHERE LOWER(portal_url) LIKE $1 AND status = ANY($2)
             ORDER BY updated_at DESC LIMIT 1`,
            [`%${signals.bodySubdomain}.nextrequest.com%`, activeStatuses]
        );
        if (r.rows.length > 0) return { method: 'body_subdomain', case: r.rows[0] };
    }

    return null;
}

async function run() {
    const msgs = await pool.query(`
        SELECT id, from_email, to_email, subject, body_text
        FROM messages
        WHERE direction = 'inbound' AND case_id IS NULL
          AND created_at > NOW() - INTERVAL '48 hours'
        ORDER BY created_at DESC
    `);

    console.log(`=== Re-matching ${msgs.rows.length} unmatched messages (${applyMode ? 'APPLY' : 'DRY RUN'}) ===\n`);

    let matched = 0;
    let unmatched = 0;
    let skipped = 0;

    for (const msg of msgs.rows) {
        const fromEmail = extractEmail(msg.from_email);
        const portalInfo = detectPortalProviderFromEmail(fromEmail);

        if (!portalInfo) {
            console.log(`MSG #${msg.id}: NOT a portal email (${fromEmail}) — skipping`);
            console.log(`  Subject: ${msg.subject}\n`);
            skipped++;
            continue;
        }

        const signals = extractPortalMatchingSignals(
            portalInfo.provider, msg.from_email, fromEmail, msg.subject, msg.body_text || ''
        );
        const result = await tryMatch(signals);

        console.log(`MSG #${msg.id}: ${portalInfo.provider.toUpperCase()}`);
        console.log(`  From: ${msg.from_email}`);
        console.log(`  Subject: ${msg.subject}`);
        console.log(`  Signals: subdomain=${signals.subdomain || '-'}, reqNum=${signals.requestNumber || '-'}, agency=${signals.agencyName || '-'}, bodySub=${signals.bodySubdomain || '-'}`);

        if (result) {
            console.log(`  MATCH via ${result.method} -> Case #${result.case.id} (${result.case.case_name}) [${result.case.status}]`);
            matched++;

            if (applyMode) {
                // Look up or create thread for this case so we set both case_id AND thread_id
                let threadId = null;
                const threadResult = await pool.query(
                    'SELECT id FROM email_threads WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1',
                    [result.case.id]
                );
                if (threadResult.rows.length > 0) {
                    threadId = threadResult.rows[0].id;
                }

                await pool.query(
                    'UPDATE messages SET case_id = $1, thread_id = $2 WHERE id = $3',
                    [result.case.id, threadId, msg.id]
                );
                console.log(`  -> Updated message case_id=${result.case.id}, thread_id=${threadId || 'NULL (no thread exists)'}`);

                if (signals.requestNumber) {
                    await pool.query(
                        `UPDATE cases SET portal_request_number = $1 WHERE id = $2 AND (portal_request_number IS NULL OR portal_request_number = '')`,
                        [signals.requestNumber, result.case.id]
                    );
                }
            }
        } else {
            console.log(`  NO MATCH`);
            unmatched++;
        }
        console.log('');
    }

    console.log(`=== Summary: ${matched} matched, ${unmatched} unmatched, ${skipped} skipped (non-portal) ===`);
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
