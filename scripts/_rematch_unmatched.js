/**
 * Re-match unmatched inbound emails using improved matching logic
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
  const unmatched = await db.query(`
    SELECT id, from_email, to_email, subject, body_text, received_at
    FROM messages
    WHERE case_id IS NULL AND direction = 'inbound'
    ORDER BY received_at DESC
  `);

  console.log(`Attempting to rematch ${unmatched.rows.length} emails...`);

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

  console.log(`\nDone: ${matched}/${unmatched.rows.length} matched`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
