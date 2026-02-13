#!/usr/bin/env node
/**
 * Diagnose unmatched inbound emails by running them through the matching logic
 * and explaining why each one failed or partially matched.
 */
require('dotenv').config();
const db = require('../services/database');
const sendgridService = require('../services/sendgrid-service');

const MSG_IDS = [317, 316, 311, 319, 318, 314, 313, 312, 310, 309];

async function diagnose() {
  for (const msgId of MSG_IDS) {
    const msg = (await db.query('SELECT * FROM messages WHERE id = $1', [msgId])).rows[0];
    if (!msg) { console.log(`MSG #${msgId}: NOT FOUND\n`); continue; }

    const status = msg.case_id == null ? 'FULLY_UNMATCHED' : 'HAS_CASE_NO_THREAD';
    console.log(`\n${'='.repeat(70)}`);
    console.log(`MSG #${msgId} [${status}]`);
    console.log(`  From: ${msg.from_email}`);
    console.log(`  Subject: ${msg.subject}`);
    console.log(`  Case: ${msg.case_id ?? 'NULL'} | Thread: ${msg.thread_id ?? 'NULL'}`);

    // Extract email address from "Display Name <email>" format
    const emailMatch = (msg.from_email || '').match(/<([^>]+)>/);
    const fromEmail = emailMatch ? emailMatch[1] : msg.from_email;
    const fromFull = msg.from_email;

    console.log(`  Parsed fromEmail: ${fromEmail}`);

    // Step 1: Portal detection
    const portalInfo = sendgridService.detectPortalProviderFromEmail(fromEmail);
    console.log(`  Portal detection: ${portalInfo ? JSON.stringify(portalInfo) : 'NOT a portal email'}`);

    if (portalInfo) {
      // Step 2: Signal extraction
      const signals = sendgridService.extractPortalMatchingSignals(
        portalInfo.provider, fromFull, fromEmail, msg.subject, msg.body_text
      );
      console.log(`  Signals: ${JSON.stringify(signals)}`);

      // Step 3: Try matching by signals
      const match = await sendgridService.matchCaseByPortalSignals(signals);
      if (match) {
        console.log(`  MATCH FOUND: Case #${match.id} (${match.case_name}) - status: ${match.status}`);
      } else {
        console.log(`  NO MATCH from portal signals`);

        // Diagnose WHY: check each signal path
        if (signals.subdomain) {
          const portalDomain = signals.provider === 'justfoia'
            ? `${signals.subdomain}.justfoia.com`
            : `${signals.subdomain}.`;
          const check = await db.query(
            `SELECT id, case_name, status, portal_url FROM cases WHERE LOWER(portal_url) LIKE $1 LIMIT 5`,
            [`%${portalDomain}%`]
          );
          if (check.rows.length > 0) {
            console.log(`  Subdomain "${signals.subdomain}" matches cases but wrong status:`);
            check.rows.forEach(r => console.log(`    Case #${r.id}: ${r.case_name} [${r.status}] portal: ${r.portal_url}`));
          } else {
            console.log(`  Subdomain "${signals.subdomain}" has ZERO matching portal_url in cases table`);
          }
        }

        if (signals.agencyName) {
          // Check exact
          const exactCheck = await db.query(
            `SELECT id, case_name, agency_name, status, portal_url FROM cases WHERE LOWER(agency_name) = LOWER($1) LIMIT 5`,
            [signals.agencyName]
          );
          if (exactCheck.rows.length > 0) {
            console.log(`  Agency name "${signals.agencyName}" exact matches:`);
            exactCheck.rows.forEach(r => console.log(`    Case #${r.id}: ${r.case_name} [${r.status}] agency: ${r.agency_name}`));
          } else {
            // Fuzzy
            const fuzzyCheck = await db.query(
              `SELECT id, case_name, agency_name, status FROM cases WHERE LOWER(agency_name) LIKE $1 LIMIT 5`,
              [`%${signals.agencyName.toLowerCase()}%`]
            );
            if (fuzzyCheck.rows.length > 0) {
              console.log(`  Agency name fuzzy matches for "${signals.agencyName}":`);
              fuzzyCheck.rows.forEach(r => console.log(`    Case #${r.id}: ${r.case_name} [${r.status}] agency: ${r.agency_name}`));
            } else {
              console.log(`  Agency name "${signals.agencyName}" has NO matching cases at all`);
            }
          }
        }

        if (signals.requestNumber) {
          const reqCheck = await db.query(
            `SELECT id, case_name, portal_request_number, status FROM cases WHERE portal_request_number = $1 LIMIT 5`,
            [signals.requestNumber]
          );
          if (reqCheck.rows.length > 0) {
            console.log(`  Request number "${signals.requestNumber}" found in:`);
            reqCheck.rows.forEach(r => console.log(`    Case #${r.id}: ${r.case_name} [${r.status}]`));
          } else {
            console.log(`  Request number "${signals.requestNumber}" NOT found in any case`);
          }
        }

        if (signals.bodySubdomain) {
          const bodyCheck = await db.query(
            `SELECT id, case_name, status, portal_url FROM cases WHERE LOWER(portal_url) LIKE $1 LIMIT 5`,
            [`%${signals.bodySubdomain}.nextrequest.com%`]
          );
          if (bodyCheck.rows.length > 0) {
            console.log(`  Body subdomain "${signals.bodySubdomain}" matches:`);
            bodyCheck.rows.forEach(r => console.log(`    Case #${r.id}: ${r.case_name} [${r.status}] portal: ${r.portal_url}`));
          } else {
            console.log(`  Body subdomain "${signals.bodySubdomain}" has NO matching portal_url`);
          }
        }
      }
    }

    // Step 4: Check agency email match
    const agencyEmailMatch = await db.query(
      `SELECT id, case_name, agency_email, status FROM cases WHERE LOWER(agency_email) = LOWER($1) ORDER BY updated_at DESC LIMIT 3`,
      [fromEmail]
    );
    if (agencyEmailMatch.rows.length > 0) {
      console.log(`  Agency email matches for "${fromEmail}":`);
      agencyEmailMatch.rows.forEach(r => console.log(`    Case #${r.id}: ${r.case_name} [${r.status}]`));
    }

    // For HAS_CASE_NO_THREAD: check why no thread was created
    if (msg.case_id && msg.thread_id == null) {
      const threads = (await db.query(
        'SELECT id, thread_id, initial_message_id, case_id FROM email_threads WHERE case_id = $1',
        [msg.case_id]
      )).rows;
      console.log(`  Threads for case #${msg.case_id}: ${threads.length}`);
      threads.forEach(t => console.log(`    Thread #${t.id}: thread_id=${t.thread_id}, initial_msg=${t.initial_message_id}`));
    }

    console.log();
  }

  await db.close();
}

diagnose().catch(e => { console.error(e); process.exit(1); });
