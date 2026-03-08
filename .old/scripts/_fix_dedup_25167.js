const { Client } = require('pg');

const DB_URL = 'postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway';

function classify(name) {
  const lower = name.toLowerCase();

  // The catch-all CCTV/surveillance/body-worn item
  if (lower.includes('cctv') && lower.includes('body-worn') && lower.includes('interrogation')) return 'cctv-catchall';

  // Interrogation
  if (lower.includes('interrogation')) return 'interrogation';

  // Body cam - must have 'body cam' but NOT 'body-worn' (that's the catch-all)
  if ((lower.includes('body cam') || lower.includes('body-cam') || lower.includes('bodycam')) && !lower.includes('body-worn')) return 'bodycam';

  // Crime scene footage from officers (not body cam, not interrogation)
  if (lower.includes('crime scene') || lower.includes('scene investigation') ||
    (lower.includes('officers') && lower.includes('footage') && !lower.includes('body cam') && !lower.includes('arrest') && !lower.includes('interrogation'))) return 'scene-footage';

  // CCTV
  if (lower.includes('cctv')) return 'cctv';

  // Ring/doorbell
  if (lower.includes('ring') || lower.includes('doorbell') || lower.includes('neighbor surveillance')) return 'ring';

  // 911 calls
  if (lower.includes('911') || lower.includes('call recording')) return '911';

  return null;
}

(async () => {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  const res = await client.query('SELECT scope_items_jsonb FROM cases WHERE id = 25167');
  const items = res.rows[0].scope_items_jsonb;

  console.log('=== BEFORE: ' + items.length + ' items ===\n');

  // Classify each item
  const classified = items.map((item, i) => {
    const group = classify(item.name);
    console.log(`  ${i}. [${group || 'UNKNOWN'}] ${item.name}`);
    return { ...item, group, index: i };
  });

  // Group by classification
  const groupMap = new Map();
  for (const item of classified) {
    const key = item.group || ('unique_' + item.index);
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(item);
  }

  console.log('\n=== SEMANTIC GROUPS ===');
  for (const [key, members] of groupMap) {
    console.log(`\n  Group: "${key}" (${members.length} items)`);
    for (const m of members) {
      console.log(`    - [${m.index}] ${m.name} (status=${m.status}, conf=${m.confidence})`);
    }
  }

  // Deduplicate: keep first occurrence name, use best status/confidence
  const deduped = [];
  for (const [key, members] of groupMap) {
    // The catch-all CCTV item gets merged into the main CCTV group -- skip it here
    if (key === 'cctv-catchall') continue;

    const first = members[0];

    // Pick best status/confidence: prefer highest confidence among non-null values
    let bestStatus = first.status;
    let bestConfidence = first.confidence;
    let bestReason = first.reason;

    for (const m of members) {
      if (m.confidence !== null && (bestConfidence === null || m.confidence > bestConfidence)) {
        bestConfidence = m.confidence;
        bestStatus = m.status;
        bestReason = m.reason;
      }
    }

    deduped.push({
      name: first.name,
      reason: bestReason,
      status: bestStatus,
      confidence: bestConfidence,
    });
  }

  // Handle cctv-catchall: merge its confidence into the cctv group if it's better
  const cctvCatchall = groupMap.get('cctv-catchall');
  if (cctvCatchall) {
    const cctvItem = deduped.find(d => classify(d.name) === 'cctv');
    if (cctvItem) {
      const catchallConf = cctvCatchall[0].confidence;
      console.log(`\n  Merged "cctv-catchall" into "cctv" group (catchall conf=${catchallConf}, kept conf=${cctvItem.confidence})`);
    }
  }

  console.log('\n=== AFTER: ' + deduped.length + ' items ===\n');
  console.log(JSON.stringify(deduped, null, 2));

  // UPDATE the database
  await client.query('UPDATE cases SET scope_items_jsonb = $1 WHERE id = 25167', [JSON.stringify(deduped)]);

  // Verify
  const verify = await client.query('SELECT jsonb_array_length(scope_items_jsonb) as count FROM cases WHERE id = 25167');
  console.log('\n=== VERIFIED: ' + verify.rows[0].count + ' items in database ===');
  console.log('\nBefore count: ' + items.length);
  console.log('After count:  ' + deduped.length);
  console.log('Removed:      ' + (items.length - deduped.length) + ' duplicates');

  await client.end();
})();
