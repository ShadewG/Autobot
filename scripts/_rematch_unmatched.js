/**
 * Re-match unmatched inbound emails using improved matching logic
 * (includes disambiguation scoring for multi-case agencies)
 */
require('dotenv').config();
const db = require('../services/database');
const sgService = require('../services/sendgrid-service');

function extractEmail(raw) {
  if (!raw) return raw;
  const match = raw.match(/<([^>]+)>/);
  if (match) return match[1].trim().toLowerCase();
  // Might already be a bare email
  if (raw.includes('@') && !raw.includes(' ')) return raw.trim().toLowerCase();
  return raw.trim().toLowerCase();
}

(async () => {
  // --- Phase 1: Re-match unmatched messages via findCaseForInbound (now with disambiguation) ---
  const unmatched = await db.query(`
    SELECT id, from_email, to_email, subject, body_text, received_at
    FROM messages
    WHERE case_id IS NULL AND direction = 'inbound'
    ORDER BY received_at DESC
  `);

  console.log(`Phase 1: Attempting to rematch ${unmatched.rows.length} unmatched emails...`);

  let matched = 0;
  for (const m of unmatched.rows) {
    const fromEmail = extractEmail(m.from_email);
    const toEmail = extractEmail(m.to_email);

    // Skip obvious spam
    if (toEmail === 'info@foib-request.com') {
      console.log(`SPAM/IRRELEVANT #${m.id} from ${fromEmail} (sent to info@)`);
      continue;
    }

    const result = await sgService.findCaseForInbound({
      toEmail,
      fromEmail,
      fromFull: m.from_email,
      subject: m.subject,
      text: m.body_text || '',
      inReplyToId: null,
      referenceIds: []
    });

    if (result) {
      let thread = await db.getThreadByCaseId(result.id);
      if (!thread) {
        thread = await db.createEmailThread({
          case_id: result.id,
          thread_id: `rematch-${m.id}`,
          subject: m.subject,
          agency_email: fromEmail,
          initial_message_id: null,
          status: 'active'
        });
      }

      await db.query('UPDATE messages SET case_id = $1, thread_id = $2 WHERE id = $3',
        [result.id, thread.id, m.id]);
      console.log(`MATCHED #${m.id} -> Case #${result.id} (${result.agency_name})`);
      matched++;
    } else {
      console.log(`UNMATCHED #${m.id} from ${fromEmail} subj: ${m.subject}`);
    }
  }

  console.log(`\nPhase 1 done: ${matched}/${unmatched.rows.length} matched`);

  // --- Phase 2: Re-process deferred unmatched_portal_signals ---
  const pendingSignals = await db.query(`
    SELECT ups.*, m.from_email as msg_from, m.to_email as msg_to, m.subject as msg_subject, m.body_text as msg_body
    FROM unmatched_portal_signals ups
    LEFT JOIN messages m ON ups.message_id = m.id
    WHERE ups.matched_case_id IS NULL
    ORDER BY ups.created_at DESC
  `);

  console.log(`\nPhase 2: Re-checking ${pendingSignals.rows.length} deferred portal signals...`);

  let signalMatched = 0;
  for (const sig of pendingSignals.rows) {
    // Try request number match first
    if (sig.detected_request_number) {
      const reqMatch = await db.query(
        `SELECT * FROM cases WHERE portal_request_number = $1 LIMIT 1`,
        [sig.detected_request_number]
      );
      if (reqMatch.rows.length > 0) {
        const caseData = reqMatch.rows[0];
        await db.markUnmatchedSignalMatched(sig.id, caseData.id);
        if (sig.message_id) {
          let thread = await db.getThreadByCaseId(caseData.id);
          if (!thread) {
            thread = await db.createEmailThread({
              case_id: caseData.id,
              thread_id: `signal-rematch-${sig.message_id}`,
              subject: sig.subject || 'Portal notification',
              agency_email: sig.from_email,
              initial_message_id: null,
              status: 'active'
            });
          }
          await db.query('UPDATE messages SET case_id = $1, thread_id = $2 WHERE id = $3 AND case_id IS NULL',
            [caseData.id, thread.id, sig.message_id]);
        }
        console.log(`SIGNAL MATCHED #${sig.id} -> Case #${caseData.id} via request number ${sig.detected_request_number}`);
        signalMatched++;
        continue;
      }
    }

    // Fallback: try full findCaseForInbound with disambiguation
    if (sig.msg_from) {
      const fromEmail = extractEmail(sig.msg_from);
      const toEmail = extractEmail(sig.msg_to);
      const result = await sgService.findCaseForInbound({
        toEmail,
        fromEmail,
        fromFull: sig.msg_from,
        subject: sig.msg_subject || sig.subject || '',
        text: sig.msg_body || '',
        inReplyToId: null,
        referenceIds: []
      });
      if (result) {
        await db.markUnmatchedSignalMatched(sig.id, result.id);
        if (sig.message_id) {
          let thread = await db.getThreadByCaseId(result.id);
          if (!thread) {
            thread = await db.createEmailThread({
              case_id: result.id,
              thread_id: `signal-rematch-${sig.message_id}`,
              subject: sig.subject || 'Portal notification',
              agency_email: fromEmail,
              initial_message_id: null,
              status: 'active'
            });
          }
          await db.query('UPDATE messages SET case_id = $1, thread_id = $2 WHERE id = $3 AND case_id IS NULL',
            [result.id, thread.id, sig.message_id]);
        }
        console.log(`SIGNAL MATCHED #${sig.id} -> Case #${result.id} (${result.agency_name}) via disambiguation`);
        signalMatched++;
      } else {
        console.log(`SIGNAL STILL UNMATCHED #${sig.id} from ${sig.from_email} reqNum=${sig.detected_request_number || 'none'}`);
      }
    }
  }

  console.log(`\nPhase 2 done: ${signalMatched}/${pendingSignals.rows.length} signals matched`);
  console.log(`\nTotal: ${matched + signalMatched} new matches`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
