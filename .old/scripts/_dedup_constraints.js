const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway',
});

const CANONICAL = {
  RECORDS_NOT_HELD: 'NOT_HELD',
  NO_FINANCIAL_GAIN_CERT_REQUIRED: 'CERTIFICATION_NO_FINANCIAL_GAIN_REQUIRED',
  CERTIFICATION_REQUIRED_NONCOMMERCIAL_USE: 'CERTIFICATION_NO_FINANCIAL_GAIN_REQUIRED',
  IN_PERSON_INSPECTION_OPTION: 'IN_PERSON_VIEWING_OPTION',
  VIEW_IN_PERSON_OPTION: 'IN_PERSON_VIEWING_OPTION',
  SCOPE_NARROW_SUGGESTED: 'SCOPE_NARROWING_SUGGESTED',
  SCOPE_NARROWING_OPTION: 'SCOPE_NARROWING_SUGGESTED',
  DEADLINE_10_BUSINESS_DAYS: 'RESPONSE_DEADLINE_10_BUSINESS_DAYS',
  RESPONSE_DEADLINE: 'RESPONSE_DEADLINE_10_BUSINESS_DAYS',
  AUTO_WITHDRAW_10_BUSINESS_DAYS: 'WITHDRAWAL_IF_NO_RESPONSE_10_BUSINESS_DAYS',
  FEE_ESTIMATE_PROVIDED: 'FEE_REQUIRED',
  NO_FINANCIAL_GAIN_CERT: 'CERTIFICATION_NO_FINANCIAL_GAIN_REQUIRED',
  PREPAY_REQUIRED: 'PREPAYMENT_REQUIRED',
};

function dedup(constraints) {
  const seen = new Set();
  const result = [];
  for (const c of constraints) {
    const canonical = CANONICAL[c] || c;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  }
  return result;
}

async function main() {
  await client.connect();

  const res = await client.query(
    'SELECT id, constraints_jsonb FROM cases WHERE id IN (25161, 25167) ORDER BY id'
  );

  for (const row of res.rows) {
    const before = row.constraints_jsonb || [];
    const after = dedup(before);

    console.log('=== Case ' + row.id + ' ===');
    console.log('BEFORE (' + before.length + '):', JSON.stringify(before));
    console.log('AFTER  (' + after.length + '):', JSON.stringify(after));
    console.log('Removed: ' + (before.length - after.length) + ' duplicates');
    console.log('');

    await client.query('UPDATE cases SET constraints_jsonb = $1 WHERE id = $2', [
      JSON.stringify(after),
      row.id,
    ]);
    console.log('Case ' + row.id + ' updated successfully.');
    console.log('');
  }

  console.log('=== VERIFICATION ===');
  const verify = await client.query(
    'SELECT id, constraints_jsonb FROM cases WHERE id IN (25161, 25167) ORDER BY id'
  );
  for (const row of verify.rows) {
    console.log(
      'Case ' + row.id + ' - final count: ' + row.constraints_jsonb.length + ' - ' + JSON.stringify(row.constraints_jsonb)
    );
  }

  await client.end();
}

main().catch(function(e) {
  console.error(e);
  process.exit(1);
});
