const db = require('../services/database');
const dns = require('dns').promises;

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function validateCase(caseData) {
  const warnings = [];
  if (caseData.agency_email) {
    if (!isValidEmail(caseData.agency_email)) {
      warnings.push({ type: 'INVALID_EMAIL_FORMAT', message: `Agency email "${caseData.agency_email}" has invalid format`, field: 'agency_email' });
    } else {
      try {
        const domain = caseData.agency_email.split('@')[1];
        await dns.resolveMx(domain);
      } catch (err) {
        warnings.push({ type: 'NO_MX_RECORD', message: `No MX records for domain "${caseData.agency_email.split('@')[1]}"`, field: 'agency_email' });
      }
    }
  } else if (!caseData.portal_url) {
    warnings.push({ type: 'MISSING_EMAIL', message: 'No agency email and no portal URL — case cannot be sent', field: 'agency_email' });
  }

  if (caseData.agency_name) {
    const agency = await db.findAgencyByName(caseData.agency_name, caseData.state);
    if (!agency) {
      warnings.push({ type: 'AGENCY_NOT_IN_DIRECTORY', message: `Agency "${caseData.agency_name}" not found in directory`, field: 'agency_name' });
    } else if (caseData.state && agency.state && agency.state !== '{}' && agency.state !== caseData.state) {
      warnings.push({ type: 'STATE_MISMATCH', message: `Case state "${caseData.state}" does not match agency state "${agency.state}"`, field: 'state' });
    }
  }
  return warnings.length > 0 ? warnings : null;
}

async function backfill() {
  await db.initialize();
  const cases = await db.query('SELECT id, agency_email, agency_name, state, portal_url FROM cases WHERE import_warnings IS NULL');
  console.log('Processing', cases.rows.length, 'cases...');
  let updated = 0, withWarnings = 0;
  for (const c of cases.rows) {
    try {
      const warnings = await validateCase(c);
      if (warnings) {
        await db.query('UPDATE cases SET import_warnings = $1 WHERE id = $2', [JSON.stringify(warnings), c.id]);
        withWarnings++;
      }
      updated++;
    } catch (err) {
      console.error('Error validating case', c.id, err.message);
    }
  }
  console.log('Processed:', updated, 'With warnings:', withWarnings);
  process.exit(0);
}
backfill();
