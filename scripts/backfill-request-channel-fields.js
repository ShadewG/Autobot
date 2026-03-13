const db = require('../services/database');
const { normalizeRequestChannelFields, normalizePortalUrl } = require('../utils/portal-utils');

function same(a, b) {
  return (a || null) === (b || null);
}

async function backfillTable({ tableName }) {
  const result = await db.query(
    `SELECT id, portal_url, portal_provider, manual_request_url, pdf_form_url, last_portal_status
       FROM ${tableName}
      WHERE portal_url IS NOT NULL OR manual_request_url IS NOT NULL OR pdf_form_url IS NOT NULL`
  );

  let updated = 0;
  const changedIds = [];

  for (const row of result.rows) {
    const normalized = normalizeRequestChannelFields(row);
    const currentPortalUrl = normalizePortalUrl(row.portal_url);
    const currentManualRequestUrl = normalizePortalUrl(row.manual_request_url);
    const currentPdfFormUrl = normalizePortalUrl(row.pdf_form_url);

    if (
      !same(currentPortalUrl, normalized.portal_url) ||
      !same(row.portal_provider, normalized.portal_provider) ||
      !same(currentManualRequestUrl, normalized.manual_request_url) ||
      !same(currentPdfFormUrl, normalized.pdf_form_url)
    ) {
      await db.query(
        `UPDATE ${tableName}
            SET portal_url = $2,
                portal_provider = $3,
                manual_request_url = $4,
                pdf_form_url = $5,
                updated_at = NOW()
          WHERE id = $1`,
        [row.id, normalized.portal_url, normalized.portal_provider, normalized.manual_request_url, normalized.pdf_form_url]
      );
      updated += 1;
      changedIds.push(row.id);
    }
  }

  return { updated, changedIds };
}

async function main() {
  await db.query('ALTER TABLE cases ADD COLUMN IF NOT EXISTS manual_request_url TEXT');
  await db.query('ALTER TABLE cases ADD COLUMN IF NOT EXISTS pdf_form_url TEXT');
  await db.query('ALTER TABLE IF EXISTS case_agencies ADD COLUMN IF NOT EXISTS manual_request_url TEXT');
  await db.query('ALTER TABLE IF EXISTS case_agencies ADD COLUMN IF NOT EXISTS pdf_form_url TEXT');
  await db.query('ALTER TABLE cases DROP CONSTRAINT IF EXISTS email_or_portal_required');
  await db.query('ALTER TABLE cases DROP CONSTRAINT IF EXISTS email_or_request_channel_required');
  await db.query(`ALTER TABLE cases
    ADD CONSTRAINT email_or_request_channel_required
    CHECK (
      agency_email IS NOT NULL
      OR portal_url IS NOT NULL
      OR manual_request_url IS NOT NULL
      OR pdf_form_url IS NOT NULL
    )`);

  const cases = await backfillTable({ tableName: 'cases' });
  const caseAgencies = await backfillTable({ tableName: 'case_agencies' });

  console.log(JSON.stringify({
    casesUpdated: cases.updated,
    caseIds: cases.changedIds,
    caseAgenciesUpdated: caseAgencies.updated,
    caseAgencyIds: caseAgencies.changedIds,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
